use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::{self, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, HeaderValue, Method, Response, StatusCode, Uri};
use bytes::Bytes;
use futures::stream::{self, StreamExt, TryStreamExt};
use tracing::{debug, info, warn};

use am_mp4::{alac_track, repair_alac_fragment, decrypt_fragment, fixed_template, patch_init_segment};

use crate::m3u8::{
    is_charts_path, is_editorial_link, is_library_path, parse_album_link, parse_artist_link, parse_media_m3u8, parse_mv_link, parse_playlist_link,
    parse_post_link, parse_song_link, to_compat_playlist,
};
use crate::log;
use crate::monitor::ensure_template;
use crate::source::{self, SourceKind};
use crate::state::{is_allowed_cdn_url, AppState, Track};
use crate::ui::app_handler;

const M3U8_TYPE: &str = "application/vnd.apple.mpegurl; charset=utf-8";
const BYTERANGE_PARAM: &str = "hook=byterange";

/// 解密代理入口（URL 前缀式：`/` 后面拼接完整的源地址，由客户端指定要访问的 CDN 文件），
/// 只处理白名单内的请求，按文件名特征分流
pub async fn handle_proxy(State(state): State<Arc<AppState>>, method: Method, uri: Uri, headers: HeaderMap) -> Response<Body> {
    let path = uri.path().strip_prefix('/').unwrap_or(uri.path());

    // Apple Music 页面路径本身也是 "https://..."：歌曲 / MV / post / 专辑 / 歌单 / 艺人页、编辑页与资料库页都返回单页应用（见 app_handler）
    if parse_song_link(path).is_ok()
        || parse_mv_link(path).is_ok()
        || parse_post_link(path).is_ok()
        || parse_album_link(path).is_ok()
        || parse_playlist_link(path).is_ok()
        || parse_artist_link(path).is_ok()
        || is_editorial_link(path)
        || is_charts_path(path)
        || is_library_path(path)
    {
        return app_handler(headers).await;
    }

    // 服务端解密默认关闭（节省服务器流量），此时不代理任何 CDN 请求，解密由浏览器完成
    if !state.config.hook {
        return text(
            StatusCode::NOT_FOUND,
            "Server-side decryption is disabled. Start am-hook with --hook to enable media m3u8 / media file URLs.\n".into(),
        );
    }

    // `hook=byterange` 是给 am-hook 自己的参数（media m3u8 保留原始 BYTERANGE 写法），不转发给 CDN
    let mut byterange = false;
    let query: Vec<&str> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let hit = *p == BYTERANGE_PARAM;
            byterange |= hit;
            !hit
        })
        .collect();
    let mut target = source::normalize_url(path);
    if !query.is_empty() {
        target.push('?');
        target.push_str(&query.join("&"));
    }

    if !is_allowed_cdn_url(&target) {
        return text(StatusCode::FORBIDDEN, "Only Apple Music audio CDN URLs are supported.\n".into());
    }

    let kind = source::classify(source::filename(&target));
    // 请求结果由请求日志输出，这里只在 debug 级别补充 Range / UA
    debug!(%method, ?kind, file = source::filename(&target), range = ?headers.get(RANGE), ua = ?headers.get(header::USER_AGENT), "Proxy request");

    match kind {
        SourceKind::MasterPlaylist => forward(&state, method, &target, None, Some(M3U8_TYPE)).await,
        SourceKind::MediaPlaylist => handle_media_m3u8(&state, &target, byterange).await,
        SourceKind::MediaFile => handle_media_file(state, method, target, &headers).await,
        SourceKind::MediaSegment => handle_media_segment(state, method, &target, &headers).await,
        SourceKind::Other => forward(&state, method, &target, headers.get(RANGE), None).await,
    }
}

/// 原样流式转发（master m3u8 与其他白名单文件）
async fn forward(
    state: &AppState,
    method: Method,
    target: &str,
    range: Option<&HeaderValue>,
    content_type: Option<&'static str>,
) -> Response<Body> {
    let mut req = state.cdn_client.request(method, target);
    if let Some(r) = range {
        req = req.header(RANGE, r);
    }
    let resp = match req.send().await {
        Ok(r) if r.status().is_redirection() => {
            return text(StatusCode::BAD_GATEWAY, "Upstream CDN redirected outside allowed domains\n".into());
        }
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Upstream request failed: {e}\n")),
    };

    let mut builder = Response::builder().status(resp.status());
    for name in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES, header::LAST_MODIFIED, header::ETAG] {
        if let Some(v) = resp.headers().get(&name) {
            builder = builder.header(name, v);
        }
    }
    if let Some(ct) = content_type {
        builder = builder.header(CONTENT_TYPE, ct);
    }
    finish_response(builder, Body::from_stream(resp.bytes_stream()))
}

async fn fetch_text(state: &AppState, url: &str) -> Result<String, String> {
    let resp = state.cdn_client.get(url).send().await.map_err(|e| format!("Failed to fetch {url}: {e}"))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(format!("Upstream CDN redirected outside allowed domains for {url}"));
    }
    if !status.is_success() {
        return Err(format!("Upstream returned HTTP {status} for {url}"));
    }
    resp.text().await.map_err(|e| format!("Failed to read {url}: {e}"))
}

/// 注册（或复用已存在的）轨道并立即触发模板拉取
async fn register_track(state: &Arc<AppState>, track: Track) -> Arc<Track> {
    let fileuri = track.fileuri.clone();
    let track = state
        .get_or_init_track(&fileuri, || async { Ok(track) })
        .await
        .expect("infallible init");
    ensure_template(state, &track);
    track
}

/// Media m3u8：补齐轨道信息，返回去掉加密标记的 m3u8。
/// 默认输出通用写法（每段独立 URL）；`byterange` 时保留原始的 EXT-X-MAP + BYTERANGE 写法。
async fn handle_media_m3u8(state: &Arc<AppState>, target: &str, byterange: bool) -> Response<Body> {
    let raw = match fetch_text(state, target).await {
        Ok(t) => t,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("{e}\n")),
    };
    let (track, cleaned) = match parse_media_m3u8(target, &raw) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to parse media m3u8: {e}\n")),
    };
    info!(
        adam_id = %track.adam_id, uri = %track.uri, fileuri = %track.fileuri,
        range1 = %track.range1, segments = track.segments.len(), "Media m3u8 parsed"
    );
    register_track(state, track).await;

    let body = if byterange { cleaned } else { to_compat_playlist(&cleaned) };
    finish_response(Response::builder().header(CONTENT_TYPE, M3U8_TYPE), Body::from(body))
}

/// 取得 media file 对应的轨道：优先内存，其次拉取对应 m3u8 补齐（并发请求只拉一次）
async fn resolve_track(state: &Arc<AppState>, target: &str) -> Result<Arc<Track>, String> {
    let fileuri = source::filename(target);
    let track = state
        .get_or_init_track(fileuri, || async {
            let m3u8_url = source::media_file_to_playlist_url(target);
            info!(%m3u8_url, "Track unknown, fetching media m3u8");
            let raw = fetch_text(state, &m3u8_url).await?;
            Ok(parse_media_m3u8(&m3u8_url, &raw)?.0)
        })
        .await?;
    ensure_template(state, &track);
    Ok(track)
}

/// Media file：按 Range 映射到 segment，拉取、解密并流式返回
async fn handle_media_file(state: Arc<AppState>, method: Method, target: String, headers: &HeaderMap) -> Response<Body> {
    let track = match resolve_track(&state, &target).await {
        Ok(t) => t,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to resolve track: {e}\n")),
    };
    let total = track.total_size;

    let (start, end, partial) = match parse_range(headers.get(RANGE), total) {
        Some(r) => r,
        None => {
            return finish_response(
                Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(CONTENT_RANGE, format!("bytes */{total}")),
                Body::empty(),
            );
        }
    };

    let mut builder = Response::builder()
        .header(CONTENT_TYPE, "video/mp4")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, end - start + 1);
    builder = if partial {
        builder.status(StatusCode::PARTIAL_CONTENT).header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
    } else {
        builder.status(StatusCode::OK)
    };
    if method == Method::HEAD {
        return finish_response(builder, Body::empty());
    }

    let segs = track.segments_overlapping(start, end);

    // 首个需要轨道模板的 segment 若就是第一块输出，先等模板就绪，失败时还能返回正常的错误码
    if segs.start >= 2 && track.template().is_none() {
        if let Err(e) = track.wait_template(state.config.template_timeout).await {
            return text(StatusCode::GATEWAY_TIMEOUT, format!("Decryption template not ready: {e}\n"));
        }
    }

    // 播放器逐段请求时，预热下一个 segment
    if partial {
        spawn_readahead(&state, &track, &target, segs.end);
    }

    let prefetch = state.config.prefetch.max(1);
    let body = stream::iter(segs)
        .map(move |idx| {
            let (state, track, target) = (state.clone(), track.clone(), target.clone());
            async move {
                let data = load_segment(&state, &track, &target, idx).await?;
                let seg = track.segments[idx];
                let lo = usize::try_from(start.saturating_sub(seg.offset)).unwrap_or(usize::MAX).min(data.len());
                let hi = usize::try_from(end.saturating_add(1).min(seg.end()).saturating_sub(seg.offset))
                    .unwrap_or(data.len())
                    .min(data.len())
                    .max(lo);
                Ok::<_, String>(data.slice(lo..hi))
            }
        })
        // 顺序输出，同时最多并发 prefetch 个 segment；客户端断开时整个流被丢弃，未完成的拉取随之取消
        .buffered(prefetch)
        .inspect_err(|e| warn!(error = %e, "Aborting media file stream"))
        .map_err(std::io::Error::other);

    finish_response(builder, Body::from_stream(body))
}

/// 通用 m3u8 的独立分片：init 段 + 第 idx 个 frag 拼接返回，播放器可逐段单独解码
async fn handle_media_segment(state: Arc<AppState>, method: Method, target: &str, headers: &HeaderMap) -> Response<Body> {
    let Some((file_target, idx)) = source::segment_to_media_file_url(target) else {
        return text(StatusCode::NOT_FOUND, "Invalid segment URL\n".into());
    };
    let track = match resolve_track(&state, &file_target).await {
        Ok(t) => t,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to resolve track: {e}\n")),
    };
    if idx == 0 || idx >= track.segments.len() {
        return text(StatusCode::NOT_FOUND, format!("Segment {idx} out of range\n"));
    }

    // box 替换保持字节长度不变，无需解密即可得知总长
    let total = track.segments[0].length.saturating_add(track.segments[idx].length);
    let Some((start, end, partial)) = parse_range(headers.get(RANGE), total) else {
        return finish_response(
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{total}")),
            Body::empty(),
        );
    };

    let mut builder = Response::builder()
        .header(CONTENT_TYPE, "video/mp4")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, end - start + 1);
    builder = if partial {
        builder.status(StatusCode::PARTIAL_CONTENT).header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
    } else {
        builder.status(StatusCode::OK)
    };
    if method == Method::HEAD {
        return finish_response(builder, Body::empty());
    }

    spawn_readahead(&state, &track, &file_target, idx + 1);
    let loaded = tokio::try_join!(
        load_segment(&state, &track, &file_target, 0),
        load_segment(&state, &track, &file_target, idx)
    );
    let (init, frag) = match loaded {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to load segment {idx}: {e}\n")),
    };
    let mut data = Vec::with_capacity(init.len().saturating_add(frag.len()));
    data.extend_from_slice(&init);
    data.extend_from_slice(&frag);
    let Ok(lo) = usize::try_from(start) else {
        return text(StatusCode::BAD_GATEWAY, "Segment offset out of range\n".into());
    };
    let Some(hi) = usize::try_from(end).ok().and_then(|e| e.checked_add(1)) else {
        return text(StatusCode::BAD_GATEWAY, "Segment range overflow\n".into());
    };
    if lo > hi || hi > data.len() {
        return text(StatusCode::BAD_GATEWAY, "Segment length mismatch\n".into());
    }
    let data = Bytes::from(data).slice(lo..hi);
    finish_response(builder, Body::from(data))
}

fn spawn_readahead(state: &Arc<AppState>, track: &Arc<Track>, target: &str, idx: usize) {
    if idx >= track.segments.len() || state.segments.contains(&(track.fileuri.clone(), idx)) {
        return;
    }
    let (state, track, target) = (state.clone(), track.clone(), target.to_string());
    tokio::spawn(async move {
        if let Err(e) = load_segment(&state, &track, &target, idx).await {
            debug!(idx, error = %e, "Readahead failed");
        }
    });
}

/// 取得解密后的 segment：命中缓存直接返回，否则下载 + 解密（同一 segment 并发只做一次）
async fn load_segment(state: &AppState, track: &Arc<Track>, target: &str, idx: usize) -> Result<Bytes, String> {
    if idx == 0 { return load_init(state, track, target).await; }
    state
        .segments
        .get_or_load((track.fileuri.clone(), idx), || async {
            let seg = track.segments[idx];
            // 下载与等待模板并行
            let (raw, init, tmpl) = tokio::try_join!(download(state, target, seg.offset, seg.length), load_init(state, track, target), async {
                if idx >= 2 {
                    track.wait_template(state.config.template_timeout).await.map(Some)
                } else {
                    Ok(None)
                }
            })?;

            // 解密是 CPU 密集操作（内部用 temari 线程池并行），不能占用 async worker
            let out = tokio::task::spawn_blocking(move || {
                let mut out = match (idx, tmpl) {
                    (1, _) => decrypt_fragment(&raw, fixed_template()),
                    (_, Some(t)) => decrypt_fragment(&raw, &t),
                    (_, None) => unreachable!("template awaited above"),
                }?;
                if let Some(codec) = alac_track(&init) { repair_alac_fragment(&mut out, &codec)?; }
                Ok::<_, String>(out)
            })
            .await
            .map_err(|e| format!("Decrypt task failed: {e}"))??;
            debug!(fileuri = %track.fileuri, idx, bytes = out.len(), "Segment decrypted");
            Ok(Bytes::from(out))
        })
        .await
}

async fn load_init(state: &AppState, track: &Track, target: &str) -> Result<Bytes, String> {
    track.init.get_or_try_init(|| async {
        let seg = track.segments.first().ok_or("Track has no init segment")?;
        let raw = download(state, target, seg.offset, seg.length).await?;
        Ok(Bytes::from(patch_init_segment(&raw)))
    }).await.cloned()
}

async fn download(state: &AppState, url: &str, offset: u64, length: u64) -> Result<Bytes, String> {
    if length == 0 {
        return Err(format!("Invalid zero-length segment @{offset}"));
    }
    let range_end = offset
        .checked_add(length - 1)
        .ok_or_else(|| format!("Segment @{offset} range overflow"))?;
    let resp = state
        .cdn_client
        .get(url)
        .header(RANGE, format!("bytes={offset}-{range_end}"))
        .send()
        .await
        .map_err(|e| format!("Failed to download segment: {e}"))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(format!("Upstream CDN redirected outside allowed domains for segment @{offset}"));
    }
    if !status.is_success() {
        return Err(format!("Upstream returned HTTP {status} for segment @{offset}"));
    }
    let mut body = resp.bytes().await.map_err(|e| format!("Failed to read segment: {e}"))?;
    if status == StatusCode::OK && body.len() as u64 > length {
        // 上游忽略了 Range，自行截取前需校验 offset + length 不越界
        let start = usize::try_from(offset).map_err(|_| format!("Segment @{offset} offset out of range"))?;
        let len = usize::try_from(length).map_err(|_| format!("Segment @{offset} length out of range"))?;
        let end = start
            .checked_add(len)
            .ok_or_else(|| format!("Segment @{offset} range overflow"))?;
        if end > body.len() {
            return Err(format!(
                "Segment @{offset} truncated 200 OK body: got {} expected at least {end}",
                body.len()
            ));
        }
        body = body.slice(start..end);
    }
    if body.len() as u64 != length {
        return Err(format!("Segment @{offset} size mismatch: got {} expected {length}", body.len()));
    }
    Ok(body)
}

/// 解析单段 Range，返回 (start, end 闭区间, 是否部分响应)；不可满足时返回 None。
/// 无法识别或多段的 Range 按规范忽略，返回整个文件。
fn parse_range(header: Option<&HeaderValue>, total: u64) -> Option<(u64, u64, bool)> {
    let full = Some((0, total.saturating_sub(1), false));
    let Some(spec) = header.and_then(|v| v.to_str().ok()).and_then(|s| s.trim().strip_prefix("bytes=")) else {
        return full;
    };
    if spec.contains(',') {
        return full;
    }
    let Some((a, b)) = spec.split_once('-') else { return full };
    let (a, b) = (a.trim(), b.trim());
    if total == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
        (start, end)
    };
    (start <= end && start < total).then_some((start, end, true))
}

fn finish_response(builder: axum::http::response::Builder, body: Body) -> Response<Body> {
    builder.body(body).unwrap_or_else(|e| {
        warn!(error = %e, "Failed to build HTTP response");
        Response::new(Body::empty())
    })
}

fn text(status: StatusCode, body: String) -> Response<Body> {
    let note = body.trim_end().to_owned();
    let response = finish_response(
        Response::builder()
            .status(status)
            .header(CONTENT_TYPE, "text/plain; charset=utf-8"),
        Body::from(body),
    );
    log::note(response, note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_range() {
        let h = |s: &'static str| HeaderValue::from_static(s);
        assert_eq!(parse_range(Some(&h("bytes=0-499")), 1000), Some((0, 499, true)));
        assert_eq!(parse_range(Some(&h("bytes=500-")), 1000), Some((500, 999, true)));
        assert_eq!(parse_range(Some(&h("bytes=-100")), 1000), Some((900, 999, true)));
        assert_eq!(parse_range(Some(&h("bytes=900-5000")), 1000), Some((900, 999, true)));
        assert_eq!(parse_range(Some(&h("bytes=0-1,5-6")), 1000), Some((0, 999, false)));
        assert_eq!(parse_range(Some(&h("bytes=1000-")), 1000), None);
        assert_eq!(parse_range(Some(&h("bytes=5-2")), 1000), None);
        assert_eq!(parse_range(None, 1000), Some((0, 999, false)));
    }

    #[tokio::test]
    async fn test_proxy_ssrf_whitelist_rejects_bypass() {
        let state = Arc::new(AppState::new("http://127.0.0.1:12340".into(), 60, 1));
        for bad in [
            "/http://127.0.0.1:12340/status?aod.itunes.apple.com/itunes-assets/",
            "/https://evil.com/aod.itunes.apple.com/itunes-assets/x.m3u8",
            "/http://aod.itunes.apple.com/itunes-assets/x.m3u8",
            "/https://aod.itunes.apple.com:8443/itunes-assets/x.m3u8",
            "/https://user@aod.itunes.apple.com/itunes-assets/x.m3u8",
        ] {
            let uri: Uri = bad.parse().unwrap();
            let resp = handle_proxy(State(state.clone()), Method::GET, uri, HeaderMap::new()).await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "expected 403 for {bad}");
        }
    }

    #[tokio::test]
    async fn test_download_rejects_short_200_ok_without_panic() {
        let app = axum::Router::new().route("/seg", axum::routing::get(|| async { "0123456789" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let state = AppState::new("http://127.0.0.1:12340".into(), 60, 1);
        let err = download(&state, &format!("http://{addr}/seg"), 8, 5).await.unwrap_err();
        assert!(err.contains("truncated 200 OK body"), "got {err}");
        server.abort();
    }
}
