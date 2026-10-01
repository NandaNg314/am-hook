//! Apple Music 目录接口（amp-api）代理。
//!
//! music.apple.com 的搜索页直接请求 `amp-api-edge.music.apple.com/v1/catalog/...`，
//! 需要 `Authorization: Bearer <developer token>`，且只对 `Origin: https://music.apple.com` 放行跨域，
//! 浏览器无法从本站直接调用。这里由服务端代为请求：developer token 取自 music.apple.com
//! 前端脚本中内嵌的 JWT（与网页版相同），缓存后复用，遇到 401/403 时重新获取一次。
//!
//! 为了让页面请求 `/amp` 时立即得到结果，请求路径上尽量不做任何"首次"工作：
//! - 专用 HTTP 客户端：经 ALPN 协商 HTTP/2，所有请求复用一条已握手的连接；浏览器中断请求（如输入联想被新输入取代）
//!   只重置对应 stream，不会像 HTTP/1.1 那样连带关闭连接。启用 gzip / br 压缩传输，空闲连接不主动淘汰，并发送 HTTP/2 PING 保活。
//! - 后台预热（[`run_warmer`]）：启动即获取 token、建立连接并预取地区表；之后连接空闲时定期发送轻量请求保持连接，
//!   token 按 JWT 的 `exp` 在过期前于后台刷新，刷新期间请求继续使用旧 token。
//! - 响应缓存：成功的响应按 URL 缓存（目录 5 分钟、地区表 24 小时，按字节计量的 LRU）。同一 URL 的并发请求共享一次上游请求，
//!   上游请求在独立任务中执行，浏览器中断后仍会完成并写入缓存，紧接着的相同请求直接命中。
//! - 响应头 `Server-Timing` 标明缓存命中情况与上游耗时，可在浏览器开发者工具中查看。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use base64::Engine;
use bytes::Bytes;
use futures::future::{BoxFuture, FutureExt, Shared};
use lru::LruCache;
use regex::Regex;
use reqwest::Client;
use serde_json::json;
use tracing::{debug, info, warn};

use crate::log;
use crate::state::AppState;

const WEB_ORIGIN: &str = "https://music.apple.com";
const API_ORIGIN: &str = "https://amp-api-edge.music.apple.com";
/// 网页版每次发布都会换 token，至少按此周期重新抓取；JWT 带 `exp` 时在过期前提前刷新
const TOKEN_TTL: Duration = Duration::from_secs(12 * 3600);
const TOKEN_EXPIRY_MARGIN: Duration = Duration::from_secs(3600);
const MAX_QUERY_LEN: usize = 4096;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);
/// 目录与搜索结果的缓存时间，与返回给浏览器的 `max-age` 一致
const CATALOG_TTL: Duration = Duration::from_secs(300);
/// 地区表几乎不变
const STOREFRONTS_TTL: Duration = Duration::from_secs(24 * 3600);
/// 保活请求：响应很小，同时能验证 token 仍然有效
const PING_PATH: &str = "/v1/storefronts/us";
/// 未开启保活时，后台检查 token 是否需要刷新的周期
const TOKEN_CHECK_INTERVAL: Duration = Duration::from_secs(60);

static SCRIPT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"src="(/assets/index[~-][0-9A-Za-z_-]+\.js)""#).unwrap());
static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}").unwrap());

/// amp-api 代理：专用连接、developer token 与响应缓存
pub struct Amp {
    client: Client,
    token: DeveloperToken,
    cache: ResponseCache,
    epoch: Instant,
    /// 最近一次 amp-api 请求（含保活）开始的时间（相对 `epoch` 的毫秒数），保活只在连接空闲时发送
    last_request_ms: AtomicU64,
}

impl Amp {
    /// `cache_bytes` 为 0 时不缓存响应，但并发的相同请求仍只请求一次上游
    pub fn new(cache_bytes: usize) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(None)
            .http2_keep_alive_interval(Duration::from_secs(20))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .build()
            .expect("Failed to build amp-api HTTP client");
        Self {
            client,
            token: DeveloperToken::default(),
            cache: ResponseCache::new(cache_bytes),
            epoch: Instant::now(),
            last_request_ms: AtomicU64::new(0),
        }
    }

    fn idle_for(&self) -> Duration {
        let now = self.epoch.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_request_ms.load(Ordering::Relaxed)))
    }

    /// 取得 `url` 的响应：先查缓存，再加入同一 URL 进行中的请求，都没有时在独立任务中发起请求
    async fn fetch(self: &Arc<Self>, url: String, ttl: Duration) -> (Lookup, Result<Arc<Upstream>, String>) {
        if let Some(hit) = self.cache.get(&url) {
            return (Lookup::Hit, Ok(hit));
        }
        let (pending, lookup) = {
            let mut inflight = self.cache.inflight.lock().unwrap();
            match inflight.get(&url) {
                Some(pending) => (pending.clone(), Lookup::Shared),
                None => {
                    let amp = self.clone();
                    let key = url.clone();
                    let task = tokio::spawn(async move {
                        // 持有 inflight 锁期间插入，任务结束（含 panic）时移除，因此不会删掉后来者的条目
                        let _done = InflightGuard(amp.clone(), key.clone());
                        let result = amp.request(&key, ttl).await.map(Arc::new);
                        if let Ok(upstream) = &result {
                            amp.cache.put(&key, upstream.clone());
                        }
                        result
                    });
                    let pending = task
                        .map(|joined| joined.unwrap_or_else(|e| Err(format!("amp-api task failed: {e}"))))
                        .boxed()
                        .shared();
                    inflight.insert(url, pending.clone());
                    (pending, Lookup::Miss)
                }
            }
        };
        (lookup, pending.await)
    }

    /// 带 developer token 请求 amp-api；token 失效（401/403）时重新获取一次
    async fn request(&self, url: &str, ttl: Duration) -> Result<Upstream, String> {
        let mut retried = false;
        loop {
            let token = self.token.get(&self.client).await.map_err(|e| format!("developer token unavailable: {e}"))?;
            self.last_request_ms.store(self.epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
            let started = Instant::now();
            let response = self
                .client
                .get(url)
                .bearer_auth(&*token)
                .header(reqwest::header::ORIGIN, WEB_ORIGIN)
                .header(reqwest::header::REFERER, format!("{WEB_ORIGIN}/"))
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(UPSTREAM_TIMEOUT)
                .send()
                .await
                .map_err(|e| format!("amp-api request failed: {e}"))?;
            let status = response.status();
            if matches!(status.as_u16(), 401 | 403) && !retried {
                info!(%status, "amp-api rejected the developer token, fetching a new one");
                self.token.invalidate(&token);
                retried = true;
                continue;
            }
            let version = response.version();
            let body = response.bytes().await.map_err(|e| format!("failed to read amp-api response: {e}"))?;
            return Ok(Upstream {
                status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                body,
                expires_at: Instant::now() + ttl,
                elapsed: started.elapsed(),
                version,
            });
        }
    }
}

/// 缓存查找结果，写入 `Server-Timing`
#[derive(Clone, Copy)]
enum Lookup {
    /// 命中缓存
    Hit,
    /// 加入了同一 URL 进行中的上游请求
    Shared,
    /// 发起了新的上游请求
    Miss,
}

impl Lookup {
    fn as_str(self) -> &'static str {
        match self {
            Lookup::Hit => "hit",
            Lookup::Shared => "shared",
            Lookup::Miss => "miss",
        }
    }
}

/// 一次上游响应
struct Upstream {
    status: StatusCode,
    body: Bytes,
    expires_at: Instant,
    elapsed: Duration,
    version: reqwest::Version,
}

type Pending = Shared<BoxFuture<'static, Result<Arc<Upstream>, String>>>;

/// 成功响应的按字节计量 LRU 缓存 + 同一 URL 进行中的请求
struct ResponseCache {
    lru: Mutex<(LruCache<String, Arc<Upstream>>, usize)>,
    capacity: usize,
    inflight: Mutex<HashMap<String, Pending>>,
}

impl ResponseCache {
    fn new(capacity: usize) -> Self {
        Self { lru: Mutex::new((LruCache::unbounded(), 0)), capacity, inflight: Mutex::default() }
    }

    fn get(&self, url: &str) -> Option<Arc<Upstream>> {
        let mut guard = self.lru.lock().unwrap();
        let (lru, used) = &mut *guard;
        let entry = lru.get(url)?.clone();
        if entry.expires_at > Instant::now() {
            return Some(entry);
        }
        lru.pop(url);
        *used -= entry.body.len();
        None
    }

    fn put(&self, url: &str, upstream: Arc<Upstream>) {
        if !upstream.status.is_success() || upstream.body.len() > self.capacity {
            return;
        }
        let mut guard = self.lru.lock().unwrap();
        let (lru, used) = &mut *guard;
        *used += upstream.body.len();
        if let Some(old) = lru.put(url.to_owned(), upstream) {
            *used -= old.body.len();
        }
        while *used > self.capacity {
            match lru.pop_lru() {
                Some((_, old)) => *used -= old.body.len(),
                None => break,
            }
        }
    }
}

struct InflightGuard(Arc<Amp>, String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.cache.inflight.lock().unwrap().remove(&self.1);
    }
}

struct Token {
    value: Arc<str>,
    refresh_at: Instant,
}

/// 缓存的 developer token。抓取过程持有锁，并发请求只会抓取一次；后台刷新期间请求继续使用旧 token。
#[derive(Default)]
struct DeveloperToken {
    current: RwLock<Option<Token>>,
    fetching: tokio::sync::Mutex<()>,
}

impl DeveloperToken {
    /// 已有 token 时直接返回（即使到了刷新时间，刷新由后台完成，过期则由 401 触发重新获取）
    async fn get(&self, client: &Client) -> Result<Arc<str>, String> {
        if let Some(token) = self.cached() {
            return Ok(token);
        }
        let _fetching = self.fetching.lock().await;
        if let Some(token) = self.cached() {
            return Ok(token);
        }
        self.fetch(client).await
    }

    fn cached(&self) -> Option<Arc<str>> {
        self.current.read().unwrap().as_ref().map(|t| t.value.clone())
    }

    fn needs_refresh(&self) -> bool {
        self.current.read().unwrap().as_ref().is_none_or(|t| Instant::now() >= t.refresh_at)
    }

    /// 后台刷新；其他请求在此期间继续使用旧 token
    async fn refresh(&self, client: &Client) -> Result<(), String> {
        let _fetching = self.fetching.lock().await;
        if self.needs_refresh() {
            self.fetch(client).await?;
        }
        Ok(())
    }

    /// 调用方需持有 `fetching`
    async fn fetch(&self, client: &Client) -> Result<Arc<str>, String> {
        let value: Arc<str> = fetch_developer_token(client).await?.into();
        let now_unix = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let refresh_in = refresh_delay(&value, now_unix);
        info!(refresh_in = %format!("{} min", refresh_in.as_secs() / 60), "Fetched Apple Music web developer token");
        *self.current.write().unwrap() = Some(Token { value: value.clone(), refresh_at: Instant::now() + refresh_in });
        Ok(value)
    }

    /// 丢弃失效的 token；若缓存已被其他请求换成新 token 则保留
    fn invalidate(&self, token: &str) {
        let mut current = self.current.write().unwrap();
        if current.as_ref().is_some_and(|t| &*t.value == token) {
            *current = None;
        }
    }
}

/// 距下次刷新的时间：不超过 [`TOKEN_TTL`]，JWT 带 `exp` 时提前 [`TOKEN_EXPIRY_MARGIN`]，至少 1 分钟
fn refresh_delay(token: &str, now_unix: u64) -> Duration {
    let until_expiry = token_expiry(token)
        .map(|exp| Duration::from_secs(exp.saturating_sub(now_unix)).saturating_sub(TOKEN_EXPIRY_MARGIN));
    until_expiry.map_or(TOKEN_TTL, |d| d.min(TOKEN_TTL)).max(Duration::from_secs(60))
}

/// JWT payload 中的 `exp`（Unix 秒）
fn token_expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()?.get("exp")?.as_u64()
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

/// 后台预热：启动后立即获取 token、建立到 amp-api 的连接并预取地区表（页面首次加载即会请求它）。
/// 之后每个周期检查 token 是否需要刷新；`keepalive` 非零时，连接空闲超过半个周期就发送一次轻量请求，
/// 保持连接与 TLS 会话，同时尽早发现 token 失效。
pub async fn run_warmer(amp: Arc<Amp>, keepalive: Duration) {
    let started = Instant::now();
    match amp.fetch(api_url("/v1/storefronts", ""), STOREFRONTS_TTL).await.1 {
        Ok(up) if up.status.is_success() => {
            info!(version = ?up.version, elapsed = ?started.elapsed(), "amp-api connection ready");
        }
        Ok(up) => warn!(status = %up.status, "amp-api warm-up request failed"),
        Err(e) => warn!(error = %e, "amp-api warm-up failed"),
    }

    let period = if keepalive.is_zero() { TOKEN_CHECK_INTERVAL } else { keepalive };
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut refresh_failing = false;
    loop {
        ticker.tick().await;
        if amp.token.needs_refresh() {
            match amp.token.refresh(&amp.client).await {
                Ok(()) => refresh_failing = false,
                // 持续失败（如断网）时只在第一次告警，之后每个周期静默重试
                Err(e) if !refresh_failing => {
                    refresh_failing = true;
                    warn!(error = %e, "Developer token refresh failed, retrying in the background");
                }
                Err(e) => debug!(error = %e, "Developer token refresh failed"),
            }
        }
        if !keepalive.is_zero() && amp.idle_for() >= keepalive / 2 {
            match amp.request(&api_url(PING_PATH, ""), Duration::ZERO).await {
                Ok(up) => debug!(status = %up.status, version = ?up.version, elapsed = ?up.elapsed, "amp-api keep-alive"),
                Err(e) => debug!(error = %e, "amp-api keep-alive failed"),
            }
        }
    }
}

fn api_url(path: &str, query: &str) -> String {
    let mut url = format!("{API_ORIGIN}{path}");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    url
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
    forward(&state, api_url(&format!("/v1/catalog/{path}"), query), CATALOG_TTL).await
}

/// `GET /amp/v1/storefronts?<query>` → 全部地区信息。前端据各地区的 `supportedLanguageTags` 选择 `l`：
/// 地区不支持的语言不会报错，而是静默回退到默认语言（如 cn 只支持 zh-Hans-CN / en-GB，传 en-US 返回中文）。
/// 数据几乎不变，前端取一次后缓存在 localStorage；查询参数原样转发，以便跟随分页 `next`。
pub async fn storefronts_handler(State(state): State<Arc<AppState>>, uri: Uri) -> Response<Body> {
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    forward(&state, api_url("/v1/storefronts", query), STOREFRONTS_TTL).await
}

/// 原样返回 amp-api 的状态码与 JSON；成功响应的 `max-age` 为缓存剩余时间
async fn forward(state: &AppState, url: String, ttl: Duration) -> Response<Body> {
    let (lookup, result) = state.amp.fetch(url, ttl).await;
    let upstream = match result {
        Ok(upstream) => upstream,
        Err(msg) => return error(StatusCode::BAD_GATEWAY, &msg),
    };
    let status = upstream.status;
    let cache = if status.is_success() {
        let remaining = upstream.expires_at.saturating_duration_since(Instant::now());
        format!("private, max-age={}", remaining.as_secs())
    } else {
        "no-store".to_owned()
    };
    let mut timing = format!("cache;desc={}", lookup.as_str());
    if !matches!(lookup, Lookup::Hit) {
        timing.push_str(&format!(", upstream;dur={:.1}", upstream.elapsed.as_secs_f64() * 1000.0));
    }
    let note = match lookup {
        _ if !status.is_success() => api_error_summary(&upstream.body),
        Lookup::Hit => "cached".to_owned(),
        _ => String::new(),
    };
    let response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, cache)
        .header("server-timing", timing)
        .body(Body::from(upstream.body.clone()))
        .unwrap();
    log::note(response, note)
}

/// amp-api 错误响应 `{"errors":[{"title","detail"}]}` 的首条说明，供请求日志输出
fn api_error_summary(body: &[u8]) -> String {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let first = value.pointer("/errors/0");
    let field = |key| first.and_then(|e| e.get(key)).and_then(serde_json::Value::as_str);
    field("detail").or_else(|| field("title")).unwrap_or_default().to_owned()
}

fn error(status: StatusCode, msg: &str) -> Response<Body> {
    let response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(json!({ "code": 1, "msg": msg }).to_string()))
        .unwrap();
    log::note(response, msg)
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

    fn jwt(payload: &str) -> String {
        let encode = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.signature", encode(r#"{"alg":"ES256"}"#), encode(payload))
    }

    #[test]
    fn test_refresh_delay() {
        let now = 1_000_000;
        assert_eq!(token_expiry(&jwt(r#"{"iss":"x","exp":1003600}"#)), Some(1_003_600));
        // 2 小时后过期：提前 1 小时刷新
        assert_eq!(refresh_delay(&jwt(r#"{"exp":1007200}"#), now), Duration::from_secs(3600));
        // 远期过期：不超过 12 小时
        assert_eq!(refresh_delay(&jwt(r#"{"exp":9000000}"#), now), TOKEN_TTL);
        // 即将或已经过期、没有 exp、无法解析：分别为 1 分钟下限与默认周期
        assert_eq!(refresh_delay(&jwt(r#"{"exp":1000100}"#), now), Duration::from_secs(60));
        assert_eq!(refresh_delay(&jwt(r#"{"iss":"x"}"#), now), TOKEN_TTL);
        assert_eq!(refresh_delay("not-a-jwt", now), TOKEN_TTL);
    }

    fn upstream(status: StatusCode, body: &'static [u8], ttl: Duration) -> Arc<Upstream> {
        Arc::new(Upstream {
            status,
            body: Bytes::from_static(body),
            expires_at: Instant::now() + ttl,
            elapsed: Duration::ZERO,
            version: reqwest::Version::HTTP_2,
        })
    }

    #[test]
    fn test_response_cache() {
        let cache = ResponseCache::new(10);
        cache.put("a", upstream(StatusCode::OK, b"123456", CATALOG_TTL));
        assert!(cache.get("a").is_some());

        cache.put("err", upstream(StatusCode::NOT_FOUND, b"{}", CATALOG_TTL));
        assert!(cache.get("err").is_none(), "only successful responses are cached");

        cache.put("expired", upstream(StatusCode::OK, b"12", Duration::ZERO));
        assert!(cache.get("expired").is_none());
        assert_eq!(cache.lru.lock().unwrap().1, 6, "expired entries are dropped on lookup");

        cache.put("b", upstream(StatusCode::OK, b"abcdef", CATALOG_TTL));
        assert!(cache.get("a").is_none(), "oldest entry evicted once over capacity");
        assert!(cache.get("b").is_some());

        let disabled = ResponseCache::new(0);
        disabled.put("a", upstream(StatusCode::OK, b"1", CATALOG_TTL));
        assert!(disabled.get("a").is_none());
    }
}
