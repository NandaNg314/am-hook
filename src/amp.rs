//! Apple Music 目录接口（amp-api）代理。
//!
//! music.apple.com 的搜索页直接请求 `amp-api-edge.music.apple.com/v1/catalog/...`，
//! 需要 `Authorization: Bearer <developer token>`，且只对 `Origin: https://music.apple.com` 放行跨域，
//! 浏览器无法从本站直接调用。这里由服务端代为请求：developer token 取自 music.apple.com
//! 前端脚本中内嵌的 JWT（与网页版相同），缓存后复用，遇到 401/403 时重新获取一次。

use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use regex::Regex;
use reqwest::Client;
use serde_json::json;
use tracing::{info, warn};

use crate::state::AppState;

const WEB_ORIGIN: &str = "https://music.apple.com";
const API_ORIGIN: &str = "https://amp-api-edge.music.apple.com";
/// 网页版每次发布都会换 token，定期重新抓取；失效时也会立即重新获取
const TOKEN_TTL: Duration = Duration::from_secs(12 * 3600);
const MAX_QUERY_LEN: usize = 4096;

static SCRIPT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"src="(/assets/index[~-][0-9A-Za-z_-]+\.js)""#).unwrap());
static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}").unwrap());

/// 缓存的 developer token。获取过程持有锁，并发请求只会抓取一次。
#[derive(Default)]
pub struct DeveloperToken {
    cached: tokio::sync::Mutex<Option<(Arc<str>, Instant)>>,
}

impl DeveloperToken {
    pub async fn get(&self, client: &Client) -> Result<Arc<str>, String> {
        let mut cached = self.cached.lock().await;
        if let Some((token, fetched_at)) = cached.as_ref() {
            if fetched_at.elapsed() < TOKEN_TTL {
                return Ok(token.clone());
            }
        }
        let token: Arc<str> = fetch_developer_token(client).await?.into();
        info!("Fetched Apple Music web developer token");
        *cached = Some((token.clone(), Instant::now()));
        Ok(token)
    }

    /// 丢弃失效的 token；若缓存已被其他请求换成新 token 则保留
    pub async fn invalidate(&self, token: &str) {
        let mut cached = self.cached.lock().await;
        if cached.as_ref().is_some_and(|(t, _)| &**t == token) {
            *cached = None;
        }
    }
}

/// 从 music.apple.com 页面找到主脚本 `index~<hash>.js`，取出其中内嵌的 JWT
async fn fetch_developer_token(client: &Client) -> Result<String, String> {
    let page = fetch_text(client, &format!("{WEB_ORIGIN}/us/browse")).await?;
    let script = extract_script_path(&page).ok_or("main script not found on music.apple.com")?;
    let js = fetch_text(client, &format!("{WEB_ORIGIN}{script}")).await?;
    extract_token(&js).map(str::to_owned).ok_or_else(|| "developer token not found in music.apple.com script".into())
}

async fn fetch_text(client: &Client, url: &str) -> Result<String, String> {
    client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("request to {url} failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("failed to read {url}: {e}"))
}

fn extract_script_path(html: &str) -> Option<&str> {
    SCRIPT_RE.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str())
}

/// 脚本里第一个 JWT 即网页版 MusicKit 使用的 developer token
fn extract_token(js: &str) -> Option<&str> {
    JWT_RE.find(js).map(|m| m.as_str())
}

/// 目录路径只允许 amp-api 资源路径中出现的字符，拒绝 `..`
fn valid_catalog_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.contains("..")
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.,:/".contains(&b))
}

/// `GET /amp/v1/catalog/<path>?<query>` → `amp-api-edge.music.apple.com/v1/catalog/<path>?<query>`。
/// 查询参数原样转发，前端可直接请求搜索结果里的 `next` 分页地址（加上 `/amp` 前缀）。
pub async fn catalog_handler(State(state): State<Arc<AppState>>, Path(path): Path<String>, uri: Uri) -> Response<Body> {
    if !valid_catalog_path(&path) {
        return error(StatusCode::BAD_REQUEST, "Invalid catalog path");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    let mut url = format!("{API_ORIGIN}/v1/catalog/{path}");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }

    let client = &state.http_client;
    let mut retried = false;
    loop {
        let token = match state.amp_token.get(client).await {
            Ok(token) => token,
            Err(msg) => {
                warn!(%msg, "Apple Music developer token unavailable");
                return error(StatusCode::BAD_GATEWAY, &msg);
            }
        };
        let response = client
            .get(&url)
            .bearer_auth(&*token)
            .header(reqwest::header::ORIGIN, WEB_ORIGIN)
            .header(reqwest::header::REFERER, format!("{WEB_ORIGIN}/"))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(e) => {
                warn!(error = %e, "amp-api request failed");
                return error(StatusCode::BAD_GATEWAY, "amp-api request failed");
            }
        };
        let status = response.status();
        if matches!(status.as_u16(), 401 | 403) && !retried {
            state.amp_token.invalidate(&token).await;
            retried = true;
            continue;
        }
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "Failed to read amp-api response"),
        };
        let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let cache = if status.is_success() { "private, max-age=300" } else { "no-store" };
        return Response::builder()
            .status(status)
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .header(CACHE_CONTROL, cache)
            .body(Body::from(body))
            .unwrap();
    }
}

fn error(status: StatusCode, msg: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(json!({ "code": 1, "msg": msg }).to_string()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_script_and_token() {
        let html = r#"<script type="module" crossorigin src="/assets/index~1c4278bfb3.js"></script>
            <script nomodule src="/assets/index-legacy~dc41388d00.js"></script>"#;
        assert_eq!(extract_script_path(html), Some("/assets/index~1c4278bfb3.js"));
        assert_eq!(extract_script_path(r#"<script src="/assets/index-legacy~dc41388d00.js">"#), None);

        let js = r#"const yo="2638.11.0-external",Ua="eyJ0eXAiOiJKV1QiLCJhbGci.eyJpc3MiOiJBTVBXZWJQbGF5.sig_nature-0123",b="eyJzZWNvbmQi.eyJzZWNvbmQiOjF9.abcdefghijkl";"#;
        assert_eq!(extract_token(js), Some("eyJ0eXAiOiJKV1QiLCJhbGci.eyJpc3MiOiJBTVBXZWJQbGF5.sig_nature-0123"));
        assert_eq!(extract_token("no token here"), None);
    }

    #[test]
    fn test_valid_catalog_path() {
        assert!(valid_catalog_path("us/search"));
        assert!(valid_catalog_path("cn/search/suggestions"));
        assert!(valid_catalog_path("us/songs/1468058171"));
        assert!(!valid_catalog_path(""));
        assert!(!valid_catalog_path("../me/library"));
        assert!(!valid_catalog_path("us/search?x"));
        assert!(!valid_catalog_path("us/%2e%2e/x"));
    }
}
