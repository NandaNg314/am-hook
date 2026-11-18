use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use lru::LruCache;
use temari::rounds::Template;
use tokio::sync::{watch, OnceCell};

/// 每个分片在 m3u8 中对应的加密密钥类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// `METHOD=NONE` 或无 `#EXT-X-KEY`，无需解密
    None,
    /// 预取固定模板（`skd://itunes.apple.com/P000000000/s1/e1`）
    Fixed,
    /// 轨道真实模板（需向 wrapper 请求）
    Track,
}

/// m3u8 中一个 BYTERANGE 段。`Track::segments[0]` 是 EXT-X-MAP 的 init 段，
/// 其余分片按各自 `key` 决定使用固定模板、轨道模板或明文直通；
/// `KeyKind::Track` 时 `key_index` 指向 `Track::keys` 中该分片对应的密钥
/// （多密钥轮换的 m3u8 里不同分片可能取到不同密钥）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub offset: u64,
    pub length: u64,
    pub key: KeyKind,
    pub key_index: u8,
}

impl Segment {
    pub fn end(&self) -> u64 {
        self.offset.saturating_add(self.length)
    }
}

#[derive(Default)]
struct FetchState {
    in_flight: bool,
    failures: u32,
    retry_at_ms: u64,
}

/// 一个轨道密钥（`skd://...`）对应的模板获取状态。多密钥轮换的 m3u8 中
/// 每个不同的 key URI 各占一个槽位，模板与失败退避互不影响。
pub struct KeySlot {
    uri: Arc<str>,
    template: watch::Sender<Option<Arc<Template>>>,
    fetch: Mutex<FetchState>,
}

impl KeySlot {
    pub fn new(uri: &str) -> Self {
        Self { uri: uri.into(), template: watch::Sender::new(None), fetch: Mutex::default() }
    }

    pub fn uri(&self) -> &str {
        &self.uri
    }

    pub fn template(&self) -> Option<Arc<Template>> {
        self.template.borrow().clone()
    }

    pub fn set_template(&self, template: Template) {
        self.template.send_replace(Some(Arc::new(template)));
    }

    /// 是否应当现在为该密钥发起模板请求；返回 true 时调用方负责之后调用 `end_fetch`。
    pub(crate) fn begin_fetch(&self) -> bool {
        if self.uri.is_empty() || self.template.borrow().is_some() {
            return false;
        }
        let mut f = self.fetch.lock().unwrap_or_else(|e| e.into_inner());
        if f.in_flight || now_ms() < f.retry_at_ms {
            return false;
        }
        f.in_flight = true;
        true
    }

    /// 结束一次模板请求；失败时指数退避（1s, 2s, 4s ... 最多 60s）。
    pub(crate) fn end_fetch(&self, ok: bool) -> Duration {
        let mut f = self.fetch.lock().unwrap_or_else(|e| e.into_inner());
        f.in_flight = false;
        if ok {
            f.failures = 0;
            return Duration::ZERO;
        }
        let backoff = Duration::from_secs((1u64 << f.failures.min(6)).min(60));
        f.failures += 1;
        f.retry_at_ms = now_ms() + backoff.as_millis() as u64;
        backoff
    }
}

/// 一个 media 轨道的上下文（对应一条 media m3u8 / media file）。
pub struct Track {
    pub adam_id: String,
    /// 首个轨道密钥 URI（与 `keys[0]` 一致；没有轨道密钥时为空）
    pub uri: String,
    /// 轨道密钥槽位，按 m3u8 中出现顺序排列
    pub keys: Vec<Arc<KeySlot>>,
    pub fileuri: Arc<str>,
    pub range1: String,
    pub segments: Vec<Segment>,
    pub total_size: u64,
    /// EXT-X-MAP 出现时生效的密钥；init 段按明文处理，真被加密时 load_init 报错
    pub init_key: KeyKind,
    pub(crate) init: OnceCell<Bytes>,
    last_accessed_ms: AtomicU64,
}

impl Track {
    /// 单密钥轨道（没有轨道密钥时 `uri` 传空串）
    pub fn new(adam_id: String, uri: String, fileuri: String, range1: String, segments: Vec<Segment>) -> Self {
        let keys = if uri.is_empty() { Vec::new() } else { vec![Arc::new(KeySlot::new(&uri))] };
        Self::with_keys(adam_id, fileuri, range1, keys, segments)
    }

    /// 多密钥轨道：`keys` 按 m3u8 中 key URI 出现顺序排列，分片的 `key_index` 指向它
    pub fn with_keys(
        adam_id: String,
        fileuri: String,
        range1: String,
        keys: Vec<Arc<KeySlot>>,
        segments: Vec<Segment>,
    ) -> Self {
        let total_size = segments.last().map_or(0, Segment::end);
        Self {
            adam_id,
            uri: keys.first().map(|k| k.uri().to_string()).unwrap_or_default(),
            keys,
            fileuri: fileuri.into(),
            range1,
            segments,
            total_size,
            init_key: KeyKind::None,
            init: OnceCell::new(),
            last_accessed_ms: AtomicU64::new(now_ms()),
        }
    }

    pub fn touch(&self) {
        self.last_accessed_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn is_expired(&self, ttl: Duration) -> bool {
        now_ms().saturating_sub(self.last_accessed_ms.load(Ordering::Relaxed)) > ttl.as_millis() as u64
    }

    pub fn template(&self) -> Option<Arc<Template>> {
        self.template_for(0)
    }

    /// 指定密钥槽位的模板（未就绪时为 None）
    pub fn template_for(&self, key_index: u8) -> Option<Arc<Template>> {
        self.keys.get(key_index as usize).and_then(|k| k.template())
    }

    pub fn set_template(&self, template: Template) {
        if let Some(slot) = self.keys.first() {
            slot.set_template(template);
        }
    }

    pub async fn wait_template(&self, timeout: Duration) -> Result<Arc<Template>, String> {
        self.wait_template_for(0, timeout).await
    }

    /// 等待指定密钥槽位的模板：多密钥轮换时不同分片可能对应不同密钥，必须按分片取
    pub async fn wait_template_for(&self, key_index: u8, timeout: Duration) -> Result<Arc<Template>, String> {
        let Some(slot) = self.keys.get(key_index as usize) else {
            return Err(format!("no decryption key #{key_index} (adamId={})", self.adam_id));
        };
        let mut rx = slot.template.subscribe();
        let waited = tokio::time::timeout(timeout, async {
            rx.wait_for(Option::is_some).await.map(|t| t.clone().expect("checked by wait_for"))
        })
        .await;
        match waited {
            Ok(Ok(t)) => Ok(t),
            Ok(Err(_)) => Err("template channel closed".into()),
            Err(_) => Err(format!("timed out waiting for decryption template (adamId={})", self.adam_id)),
        }
    }

    /// 是否应当现在为*首个*密钥发起模板请求（后台监控用）；返回 true 时调用方负责之后调用 `end_fetch`。
    pub(crate) fn begin_fetch(&self) -> bool {
        if self.adam_id.is_empty() {
            return false;
        }
        self.keys.first().is_some_and(|k| k.begin_fetch())
    }

    /// 结束首个密钥的模板请求；失败时指数退避（1s, 2s, 4s ... 最多 60s）。
    pub(crate) fn end_fetch(&self, ok: bool) -> Duration {
        self.keys.first().map_or(Duration::ZERO, |k| k.end_fetch(ok))
    }

    /// 与字节区间 [start, end]（闭区间）相交的 segment 下标范围。
    pub fn segments_overlapping(&self, start: u64, end: u64) -> std::ops::Range<usize> {
        let lo = self.segments.partition_point(|s| s.end() <= start);
        let hi = self.segments.partition_point(|s| s.offset <= end);
        lo..hi.max(lo)
    }
}

type TrackSlot = Arc<OnceCell<Arc<Track>>>;
pub type SegmentKey = (Arc<str>, usize);

/// `--hook` 代理同时处理的请求上限（含流式响应）
pub const HOOK_MAX_CONCURRENCY: usize = 32;

#[derive(Clone)]
pub struct Config {
    pub wrapper_url: String,
    /// 是否启用服务端解密代理（media m3u8 / media file 地址）
    pub hook: bool,
    pub cache_ttl: Duration,
    /// 单个请求内并发预取的 segment 数
    pub prefetch: usize,
    pub template_timeout: Duration,
    /// amp-api 连接空闲时的保活周期，0 表示不发送保活请求
    pub amp_keepalive: Duration,
    /// amp-api 响应缓存容量（MB），0 表示不缓存
    pub amp_cache_mb: usize,
    /// 每秒发往 wrapper-lite 的最大请求数，0 表示不限
    pub wrapper_rate: u32,
    /// 同时进行的 wrapper-lite 请求上限，0 表示不限
    pub wrapper_concurrency: usize,
    /// wrapper-lite 请求的 `Authorization` 头（已规范化），None 表示不发送
    pub wrapper_auth: Option<String>,
}

pub struct AppState {
    pub config: Config,
    pub http_client: reqwest::Client,
    /// 同 `http_client`，但重定向只允许跳到 apple.com（处理不受信任的 URL）
    pub apple_client: reqwest::Client,
    /// 专用于 `--hook` CDN 代理：重定向只允许留在 Apple CDN（apple.com / mzstatic.com HTTPS）
    pub cdn_client: reqwest::Client,
    /// 复用的 Gofile 代理客户端（无固定总时长上限，避免大文件上传 300s 断流）
    pub gofile_client: reqwest::Client,
    /// 限制并发 Gofile 流式代理上传数，防止连接/FD 耗尽
    pub gofile_upload_semaphore: Arc<tokio::sync::Semaphore>,
    /// `--hook` 代理的全局并发上限：流式响应期间一直持有许可，避免无上限拉取 CDN
    pub hook_semaphore: Arc<tokio::sync::Semaphore>,
    /// wrapper-lite 客户端（限速、限并发、鉴权）
    pub wrapper: crate::wrapper::Wrapper,
    /// fileuri -> 轨道。OnceCell 让并发请求同一轨道时只拉取/解析一次 m3u8。
    tracks: Mutex<HashMap<String, TrackSlot>>,
    pub segments: SegmentCache,
    /// amp-api（Apple Music 目录 / 搜索）代理：专用连接、developer token 与响应缓存
    pub amp: Arc<crate::amp::Amp>,
    /// `/status` 的 10 秒共用缓存
    pub status_cache: crate::ui::StatusCache,
}

impl AppState {
    /// 启用服务端解密的默认配置（测试用）
    pub fn new(wrapper_url: String, cache_ttl_secs: u64, cache_mb: usize) -> Self {
        Self::with_config(
            Config {
                wrapper_url: wrapper_url.trim_end_matches('/').to_string(),
                hook: true,
                cache_ttl: Duration::from_secs(cache_ttl_secs),
                prefetch: 4,
                template_timeout: Duration::from_secs(20),
                amp_keepalive: Duration::from_secs(30),
                amp_cache_mb: 32,
                wrapper_rate: 24,
                wrapper_concurrency: 24,
                wrapper_auth: None,
            },
            cache_mb,
        )
    }

    pub fn with_config(config: Config, cache_mb: usize) -> Self {
        // wrapper-lite 与 CDN 媒体：保持 HTTP/1.1、不请求压缩，Range 字节偏移与原始文件一致（amp-api 另用专用客户端）
        let builder = || {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(30))
                .tcp_nodelay(true)
                .pool_max_idle_per_host(32)
                .http1_only()
                .no_gzip()
                .no_brotli()
        };
        let http_client = builder().build().expect("Failed to build reqwest HTTP client");
        // 用于 MV master 地址：重定向只允许留在 apple.com 的 HTTPS 地址，最多 10 跳
        let apple_client = builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("too many redirects")
                } else if is_apple_https(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("Failed to build reqwest Apple-only HTTP client");
        // 用于 `--hook` CDN 代理：重定向只允许留在 apple.com / mzstatic.com HTTPS，最多 10 跳
        let cdn_client = builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("too many redirects")
                } else if is_apple_cdn_https(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("Failed to build reqwest CDN HTTP client");
        let gofile_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(8)
            .build()
            .expect("Failed to build Gofile HTTP client");
        let amp = Arc::new(crate::amp::Amp::new(config.amp_cache_mb * 1024 * 1024));
        let wrapper = crate::wrapper::Wrapper::new(&config);
        Self {
            config,
            http_client,
            apple_client,
            cdn_client,
            gofile_client,
            gofile_upload_semaphore: Arc::new(tokio::sync::Semaphore::new(8)),
            hook_semaphore: Arc::new(tokio::sync::Semaphore::new(HOOK_MAX_CONCURRENCY)),
            wrapper,
            tracks: Mutex::default(),
            segments: SegmentCache::new(cache_mb.max(16) * 1024 * 1024),
            amp,
            status_cache: Default::default(),
        }
    }

    pub fn get_track(&self, fileuri: &str) -> Option<Arc<Track>> {
        let track = self.tracks.lock().unwrap_or_else(|e| e.into_inner()).get(fileuri)?.get()?.clone();
        track.touch();
        Some(track)
    }

    /// 取得 fileuri 对应的轨道；不存在时用 `init` 构建，并发调用只会执行一次 `init`。
    /// 已存在的轨道会被复用（保留已获取的模板）。
    pub async fn get_or_init_track<F, Fut>(&self, fileuri: &str, init: F) -> Result<Arc<Track>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Track, String>>,
    {
        let slot = self.tracks.lock().unwrap_or_else(|e| e.into_inner()).entry(fileuri.to_string()).or_default().clone();
        let track = slot.get_or_try_init(|| async { init().await.map(Arc::new) }).await?.clone();
        track.touch();
        Ok(track)
    }

    pub fn tracks(&self) -> Vec<Arc<Track>> {
        self.tracks.lock().unwrap_or_else(|e| e.into_inner()).values().filter_map(|s| s.get().cloned()).collect()
    }

    /// 淘汰超过 TTL 未访问的轨道，以及无人等待且初始化失败的空槽。返回淘汰数量。
    pub fn evict_expired(&self) -> usize {
        let ttl = self.config.cache_ttl;
        let mut map = self.tracks.lock().unwrap_or_else(|e| e.into_inner());
        let before = map.len();
        map.retain(|_, slot| match slot.get() {
            Some(t) => !t.is_expired(ttl),
            None => Arc::strong_count(slot) > 1,
        });
        before - map.len()
    }
}

/// HTTPS、无端口、无用户名，且主机为 apple.com 或其子域名
pub fn is_apple_https(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| host == "apple.com" || host.ends_with(".apple.com"))
}

/// HTTPS、无端口、无用户名，且主机为 apple.com / mzstatic.com 或其子域名
pub fn is_apple_cdn_https(url: &reqwest::Url) -> bool {
    is_apple_https(url)
        || (url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| host == "mzstatic.com" || host.ends_with(".mzstatic.com")))
}

/// `--hook` 音频 CDN 代理白名单：严格要求 `https://aod.itunes.apple.com/itunes-assets/...`（无端口、无认证信息）
pub fn is_allowed_cdn_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some("aod.itunes.apple.com")
        && url.path().starts_with("/itunes-assets/")
}

/// 已解密 segment 的按字节计量 LRU 缓存 + 同一 segment 并发请求去重。
pub struct SegmentCache {
    lru: Mutex<(LruCache<SegmentKey, Bytes>, usize)>,
    capacity: usize,
    inflight: Mutex<HashMap<SegmentKey, Arc<OnceCell<Bytes>>>>,
}

impl SegmentCache {
    fn new(capacity: usize) -> Self {
        Self {
            lru: Mutex::new((LruCache::unbounded(), 0)),
            capacity,
            inflight: Mutex::default(),
        }
    }

    pub fn get(&self, key: &SegmentKey) -> Option<Bytes> {
        self.lru.lock().unwrap_or_else(|e| e.into_inner()).0.get(key).cloned()
    }

    pub fn contains(&self, key: &SegmentKey) -> bool {
        self.lru.lock().unwrap_or_else(|e| e.into_inner()).0.contains(key)
            || self.inflight.lock().unwrap_or_else(|e| e.into_inner()).contains_key(key)
    }

    fn put(&self, key: SegmentKey, data: Bytes) {
        if data.len() > self.capacity {
            return;
        }
        let mut guard = self.lru.lock().unwrap_or_else(|e| e.into_inner());
        let (lru, used) = &mut *guard;
        *used += data.len();
        if let Some(old) = lru.put(key, data) {
            *used -= old.len();
        }
        while *used > self.capacity {
            match lru.pop_lru() {
                Some((_, v)) => *used -= v.len(),
                None => break,
            }
        }
    }

    /// 命中缓存直接返回；否则执行 `load`。同一 key 的并发调用共享一次 `load`，
    /// 若执行 `load` 的请求被取消（客户端断开），由 `Drop` 守卫立即清理 `inflight` 条目。
    pub async fn get_or_load<F, Fut>(&self, key: SegmentKey, load: F) -> Result<Bytes, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Bytes, String>>,
    {
        if let Some(hit) = self.get(&key) {
            return Ok(hit);
        }
        let cell = self.inflight.lock().unwrap_or_else(|e| e.into_inner()).entry(key.clone()).or_default().clone();
        let _guard = SegmentInflightGuard {
            inflight: &self.inflight,
            key: key.clone(),
            cell: cell.clone(),
        };
        let result = cell.get_or_try_init(load).await.cloned();
        if let Ok(data) = &result {
            self.put(key, data.clone());
        }
        result
    }
}

struct SegmentInflightGuard<'a> {
    inflight: &'a Mutex<HashMap<SegmentKey, Arc<OnceCell<Bytes>>>>,
    key: SegmentKey,
    cell: Arc<OnceCell<Bytes>>,
}

impl Drop for SegmentInflightGuard<'_> {
    fn drop(&mut self) {
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if inflight.get(&self.key).is_some_and(|c| Arc::ptr_eq(c, &self.cell)) {
            inflight.remove(&self.key);
        }
    }
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> Track {
        Track::new(
            "123".into(),
            "skd://test".into(),
            "test_m.mp4".into(),
            "100@10".into(),
            vec![
                Segment { offset: 0, length: 10, key: KeyKind::None, key_index: 0 },
                Segment { offset: 10, length: 100, key: KeyKind::Fixed, key_index: 0 },
                Segment { offset: 110, length: 50, key: KeyKind::Track, key_index: 0 },
            ],
        )
    }

    #[test]
    fn test_multi_key_slots_are_independent() {
        let keys = vec![Arc::new(KeySlot::new("skd://a/c6")), Arc::new(KeySlot::new("skd://b/c6"))];
        let t = Track::with_keys(
            "123".into(),
            "test_m.mp4".into(),
            "100@10".into(),
            keys,
            vec![
                Segment { offset: 0, length: 10, key: KeyKind::None, key_index: 0 },
                Segment { offset: 10, length: 100, key: KeyKind::Track, key_index: 1 },
                Segment { offset: 110, length: 50, key: KeyKind::Track, key_index: 0 },
            ],
        );
        let template = || {
            temari::rounds::Template::new(
                vec![0u8; 32],
                [0u32; 2048],
                temari::rounds::R1Entry { rdx: 0, rcx: 0, rax: 0, r9: 0, rbp: 0 },
            )
        };
        assert_eq!(t.uri, "skd://a/c6", "uri 是首个密钥 URI");
        assert_eq!(t.keys.len(), 2);
        assert_eq!(t.segments[1].key_index, 1);

        t.keys[1].set_template(template());
        assert!(t.template_for(0).is_none());
        assert!(t.template_for(1).is_some(), "第二个密钥的模板独立就绪");
        assert!(t.template().is_none(), "template() 只看首个密钥");
        t.set_template(template());
        assert!(t.template_for(0).is_some());
        assert!(t.template_for(2).is_none());
    }

    #[tokio::test]
    async fn test_wait_template_for_unknown_slot_fails_fast() {
        let t = track();
        let Err(err) = t.wait_template_for(3, Duration::from_millis(10)).await else {
            panic!("expected missing slot error");
        };
        assert!(err.contains("no decryption key #3"), "got {err}");
    }

    #[test]
    fn test_track_basics() {
        let t = track();
        assert_eq!(t.total_size, 160);
        assert!(!t.is_expired(Duration::from_secs(10)));
        assert_eq!(t.segments_overlapping(0, 159), 0..3);
        assert_eq!(t.segments_overlapping(10, 109), 1..2);
        assert_eq!(t.segments_overlapping(9, 10), 0..2);
        assert_eq!(t.segments_overlapping(150, 150), 2..3);
    }

    #[test]
    fn test_fetch_backoff() {
        let t = track();
        assert!(t.begin_fetch());
        assert!(!t.begin_fetch(), "only one fetch in flight");
        assert_eq!(t.end_fetch(false), Duration::from_secs(1));
        assert!(!t.begin_fetch(), "backing off after failure");
    }

    #[tokio::test]
    async fn test_segment_cache_dedup_and_capacity() {
        let cache = SegmentCache::new(10);
        let key: SegmentKey = ("f".into(), 1);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(Bytes::from_static(b"abcdef"))
        };
        let (a, b) = tokio::join!(cache.get_or_load(key.clone(), load), cache.get_or_load(key.clone(), load));
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.get(&key).is_some());

        cache.put(("f".into(), 2), Bytes::from_static(b"123456"));
        assert!(cache.get(&key).is_none(), "oldest entry evicted once over capacity");
    }

    #[tokio::test]
    async fn test_segment_cache_cleans_inflight_on_cancel() {
        let cache = SegmentCache::new(1024);
        let key: SegmentKey = ("cancel".into(), 7);
        let fut = cache.get_or_load(key.clone(), || async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok(Bytes::from_static(b"never"))
        });
        assert!(tokio::time::timeout(Duration::from_millis(20), fut).await.is_err());
        assert!(!cache.contains(&key), "cancelled inflight key must be removed on drop");
    }

    #[test]
    fn test_url_allowlists() {
        assert!(is_allowed_cdn_url("https://aod.itunes.apple.com/itunes-assets/HLSMusic/v4/1/2/3/test.m3u8"));
        assert!(!is_allowed_cdn_url("http://aod.itunes.apple.com/itunes-assets/test.m3u8"));
        assert!(!is_allowed_cdn_url("https://aod.itunes.apple.com:8443/itunes-assets/test.m3u8"));
        assert!(!is_allowed_cdn_url("https://user@aod.itunes.apple.com/itunes-assets/test.m3u8"));
        assert!(!is_allowed_cdn_url("https://evil.com/aod.itunes.apple.com/itunes-assets/test.m3u8"));
        assert!(!is_allowed_cdn_url("http://127.0.0.1:12340/status?aod.itunes.apple.com/itunes-assets/"));
        assert!(!is_allowed_cdn_url("https://mvod.itunes.apple.com/itunes-assets/test.m4s"));
        assert!(!is_allowed_cdn_url("https://aod.itunes.apple.com/other/path.m3u8"));

        let ok = reqwest::Url::parse("https://play.itunes.apple.com/master.m3u8").unwrap();
        assert!(is_apple_https(&ok));
        let bad = reqwest::Url::parse("https://evil.com/master.m3u8").unwrap();
        assert!(!is_apple_https(&bad));
    }
}
