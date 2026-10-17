// 歌曲页（/https://music.apple.com/{cc}/song/{slug}/{id}），由 app.mjs 挂载
import { createActions, targetOf, normalizeArtistName, toSimplified } from './actions.mjs';
import {
  tagMp4,
  fetchLyricsData as fetchLyricsDataShared,
  fetchSongMeta,
  downloadDecryptedTrack,
  saveBlob,
  saveTextFile,
} from './local-download.mjs';

const { detectMode, artistNodes, qualityBadge, qualityIcon, formatTime } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

/**
 * 进行中的浏览器端下载：adamId -> Map(group_id -> { ctl, done, total })。
 * 放在页面之外：离开歌曲页后下载继续，完成后照常保存；回到该歌曲页时接着显示进度。
 */
const downloadsBySong = new Map();
/** adamId -> 当前显示该歌曲的页面刷新下载进度的函数 */
const progressViews = new Map();
// 下载在当前标签页内进行，关闭或刷新会中断
addEventListener('beforeunload', (e) => {
  for (const downloads of downloadsBySong.values()) if (downloads.size) { e.preventDefault(); return; }
});

/**
 * 已交给浏览器保存的下载结果 { url, dispose }，同 MV 页的 result：浏览器要从 OPFS 临时文件
 * 复制到下载目录，不能保存后立即删除；开始新下载、离开歌曲页或关闭标签页时再删除。
 */
const saved = new Set();

function saveResult(result, fileName) {
  const url = URL.createObjectURL(result.file);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  saved.add({ url, dispose: result.dispose });
}

function disposeSaved() {
  const items = [...saved];
  saved.clear();
  return Promise.all(items.map(({ url, dispose }) => { URL.revokeObjectURL(url); return dispose(); }));
}
addEventListener('pagehide', disposeSaved);

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  document.title = t('song.pageTitle');
  const songUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = songUrl.match(/music\.apple\.com\/([a-z]{2})\/song\/[^/?#]+\/(\d+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const adamId = linkMatch[2];
  const $ = (id) => root.querySelector(`#${id}`);
  const probe = document.createElement('audio');
  let meta = {};
  let variants = [];
  let rows = new Map();
  /** 服务端是否以 --hook 启动（提供服务端解密地址，可用 VLC / IDM） */
  let hook = false;
  /** group_id -> { ctl, done, total }，本歌曲进行中的浏览器端下载（见 downloadsBySong） */
  if (adamId && !downloadsBySong.has(adamId)) downloadsBySong.set(adamId, new Map());
  const downloads = downloadsBySong.get(adamId) || new Map();
  /** 刷新下载进度：交给当前显示本歌曲的页面（离开后再回来时是新的页面） */
  const showDownload = (id) => progressViews.get(adamId)?.(id);

  $('source').textContent = songUrl;
  $('apple-link').href = songUrl;

  // 资料库：添加到资料库 / 从资料库中删除、添加到歌单（歌曲信息取到后可用）
  const actions = createActions({ signal, player, navigate, toast });
  const songTarget = () => (meta.resource ? targetOf(meta.resource, meta.country) : null);
  const libraryToggle = actions.libraryButton(songTarget, 'btn lib-toggle');
  const favoriteToggle = actions.favoriteButton(songTarget, 'btn lib-fav-toggle');
  const playlistBtn = actions.playlistButton(songTarget, 'btn');
  playlistBtn.disabled = true;
  $('play-best').after(libraryToggle.button, favoriteToggle.button, playlistBtn);

  const lyricsFormatSelect = $('lyrics-format-select');
  if (lyricsFormatSelect) {
    if (localStorage.getItem('am_lyrics_fmt')) {
      lyricsFormatSelect.value = localStorage.getItem('am_lyrics_fmt');
    }
    lyricsFormatSelect.addEventListener('change', () => {
      localStorage.setItem('am_lyrics_fmt', lyricsFormatSelect.value);
    });
  }

  const saveLrcToggle = $('save-lrc-toggle');
  if (saveLrcToggle) {
    if (localStorage.getItem('am_save_lrc') !== null) {
      saveLrcToggle.checked = localStorage.getItem('am_save_lrc') === 'true';
    }
    saveLrcToggle.addEventListener('change', () => {
      localStorage.setItem('am_save_lrc', String(saveLrcToggle.checked));
    });
  }

  const saveTtmlToggle = $('save-ttml-toggle');
  if (saveTtmlToggle) {
    if (localStorage.getItem('am_save_ttml') !== null) {
      saveTtmlToggle.checked = localStorage.getItem('am_save_ttml') === 'true';
    }
    saveTtmlToggle.addEventListener('change', () => {
      localStorage.setItem('am_save_ttml', String(saveTtmlToggle.checked));
    });
  }

  // 统一读取歌词交付选项（与 TG 端正交维度一致）：内嵌格式 embedMode + 外置格式数组 saveFormats
  function getLyricsOptions() {
    const fmtSelect = document.querySelector('#lyrics-format-select');
    const embedMode = fmtSelect ? fmtSelect.value : (localStorage.getItem('am_lyrics_fmt') || 'lrc');
    const lrcOn = document.querySelector('#save-lrc-toggle') ? document.querySelector('#save-lrc-toggle').checked : (localStorage.getItem('am_save_lrc') === 'true');
    const ttmlOn = document.querySelector('#save-ttml-toggle') ? document.querySelector('#save-ttml-toggle').checked : (localStorage.getItem('am_save_ttml') === 'true');
    const saveFormats = [];
    if (lrcOn) saveFormats.push('lrc');
    if (ttmlOn) saveFormats.push('ttml');
    const translateOn = document.querySelector('#translate-lyrics-toggle') ? document.querySelector('#translate-lyrics-toggle').checked : (localStorage.getItem('am_translate_lyr') === 'true');
    const rubyOn = document.querySelector('#ruby-lyrics-toggle') ? document.querySelector('#ruby-lyrics-toggle').checked : (localStorage.getItem('am_ruby_lyr') === 'true');
    const rubyMode = document.querySelector('#ruby-mode-select') ? document.querySelector('#ruby-mode-select').value : (localStorage.getItem('am_ruby_mode') || 'roman');
    return { embedMode, saveFormats, translateOn, rubyOn, rubyMode };
  }

  const rubyLyricsToggle = $('ruby-lyrics-toggle');
  const rubyLyricsLabel = $('ruby-lyrics-label');
  const rubyModeSelect = $('ruby-mode-select');
  if (rubyLyricsToggle) {
    if (localStorage.getItem('am_ruby_lyr') !== null) {
      rubyLyricsToggle.checked = localStorage.getItem('am_ruby_lyr') === 'true';
    }
    rubyLyricsToggle.addEventListener('change', () => {
      localStorage.setItem('am_ruby_lyr', String(rubyLyricsToggle.checked));
    });
  }
  if (rubyModeSelect) {
    if (localStorage.getItem('am_ruby_mode') !== null) {
      rubyModeSelect.value = localStorage.getItem('am_ruby_mode');
    }
    rubyModeSelect.addEventListener('change', () => {
      localStorage.setItem('am_ruby_mode', rubyModeSelect.value);
    });
  }

  const translateLyricsToggle = $('translate-lyrics-toggle');
  const translateLyricsLabel = $('translate-lyrics-label');
  if (translateLyricsToggle) {
    if (localStorage.getItem('am_translate_lyr') !== null) {
      translateLyricsToggle.checked = localStorage.getItem('am_translate_lyr') === 'true';
    }
    translateLyricsToggle.addEventListener('change', () => {
      localStorage.setItem('am_translate_lyr', String(translateLyricsToggle.checked));
    });
  }

  const gofileToggle = $('gofile-toggle');
  if (gofileToggle) {
    if (localStorage.getItem('am_gofile_upload') !== null) {
      gofileToggle.checked = localStorage.getItem('am_gofile_upload') === 'true';
    }
    gofileToggle.addEventListener('change', () => {
      localStorage.setItem('am_gofile_upload', String(gofileToggle.checked));
    });
  }

  const gofileDialog = $('gofile-dialog');
  const gofileCloseBtn = $('gofile-dialog-close');
  const gofileDoneBtn = $('gofile-done-btn');
  const gofileCopyBtn = $('gofile-copy-btn');
  const gofileLinkInput = $('gofile-link-input');
  const gofileOpenLink = $('gofile-open-link');
  const gofileSongInfo = $('gofile-song-info');

  function showGofileResult(downloadPage, trackInfoText) {
    if (!gofileDialog) return;
    gofileLinkInput.value = downloadPage;
    gofileOpenLink.href = downloadPage;
    gofileSongInfo.textContent = trackInfoText;
    gofileCopyBtn.textContent = '复制链接';
    gofileDialog.showModal();
  }

  gofileCloseBtn?.addEventListener('click', () => gofileDialog.close());
  gofileDoneBtn?.addEventListener('click', () => gofileDialog.close());
  gofileCopyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(gofileLinkInput.value);
      gofileCopyBtn.textContent = '已复制!';
      setTimeout(() => { if (gofileCopyBtn) gofileCopyBtn.textContent = '复制链接'; }, 2000);
      toast('已复制 Gofile 分享链接');
    } catch {
      gofileLinkInput.select();
      toast('请手动复制链接');
    }
  });

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
    server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
    lyrics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  /** message 可以是函数，切换语言时会重新求值 */
  let alertState = null;
  function showAlert(kind, message) {
    alertState = message ? { kind, message } : null;
    renderAlert();
  }

  function renderAlert() {
    const a = $('alert');
    a.hidden = !alertState;
    if (!alertState) return;
    a.className = `alert ${alertState.kind}`;
    a.textContent = typeof alertState.message === 'function' ? alertState.message() : alertState.message;
  }

  function formatRate(bps) {
    if (!bps) return '';
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1000)} kbps`;
  }

  /** 由 GROUP-ID / CODECS 推导展示信息 */
  function describe(v) {
    const g = v.group_id.toLowerCase();
    const tags = [];
    if (g.includes('binaural')) tags.push(t('q.binaural'));
    if (g.includes('downmix')) tags.push(t('q.downmix'));
    const variantRank = tags.length ? 1 : 0;
    if (g.includes('alac')) {
      const spec = [v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ');
      return { group: t('q.lossless'), rank: 0, kbps: 0, name: `ALAC${spec ? ' · ' + spec : ''}`, tags, sub: variantRank };
    }
    if (g.includes('atmos')) {
      // GROUP-ID 形如 atmos-2768：首位是版本号，后三位才是码率（768 kbps）
      const raw = Number((g.match(/atmos-(\d+)/) || [])[1]) || 0;
      const kbps = raw >= 1000 ? raw % 1000 : raw;
      return { group: t('q.atmos'), rank: 1, kbps, name: `Dolby Atmos${kbps ? ' · ' + kbps + ' kbps' : ''}`, tags, sub: variantRank };
    }
    if (g.includes('he-')) {
      const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
      return { group: 'HE-AAC', rank: 3, kbps, name: `HE-AAC${kbps ? ' · ' + kbps + ' kbps' : ''}`, tags, sub: variantRank };
    }
    const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
    return { group: 'AAC', rank: 2, kbps, name: kbps ? `AAC · ${kbps} kbps` : v.group_id, tags, sub: variantRank };
  }

  function hookUrl(absolute) {
    return `${location.origin}/${absolute}`;
  }

  function safeName(s) {
    return s.replace(/[\\/:*?"<>|]+/g, '_').trim();
  }

  /** doneKey：复制成功后提示的文案 key */
  function copy(text, doneKey) {
    const done = () => toast(t(doneKey));
    const fallback = () => {
      const area = el('textarea', { value: text });
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      done();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  /* ---------- 外部播放器：协议与 OpenList 相同，打开服务端解密的 media m3u8，所有音质都能播 ---------- */
  // scheme 占位符：$durl 为地址，前缀 e = encodeURIComponent、b = base64（从右往左套用）；$name 为标题
  const PLAYERS = [
    { name: 'VLC', logo: 'VLC', color: '#ff8800', os: ['windows', 'macos', 'linux', 'android', 'ios'], scheme: 'vlc://$durl' },
    { name: 'PotPlayer', logo: 'Pot', color: '#f4c20d', ink: '#1b1a19', os: ['windows'], scheme: 'potplayer://$durl' },
    { name: 'mpv', logo: 'mpv', color: '#6b2a74', os: ['windows', 'macos', 'linux', 'android'], scheme: 'mpv://$edurl' },
    { name: 'IINA', logo: 'IINA', color: '#5e5ce6', os: ['macos'], scheme: 'iina://weblink?url=$edurl' },
    { name: 'Infuse', logo: 'If', color: '#f08a24', os: ['macos', 'ios'], scheme: 'infuse://x-callback-url/play?url=$durl' },
    { name: 'nPlayer', logo: 'nP', color: '#e53935', os: ['android', 'ios'], scheme: 'nplayer-$durl' },
    { name: 'OmniPlayer', logo: 'Om', color: '#1e88e5', os: ['macos'], scheme: 'omniplayer://weblink?url=$durl' },
    { name: 'Fig Player', logo: 'Fig', color: '#12a37f', os: ['windows', 'macos'], scheme: 'figplayer://weblink?url=$durl' },
    { name: 'Vivid Player', logo: 'Vi', color: '#ff5a36', os: ['windows'], scheme: 'vividplayer://play?src=direct&u=$edurl&title=$name' },
    { name: 'Fileball', logo: 'Fb', color: '#2f80ed', os: ['macos', 'ios'], scheme: 'filebox://play?url=$durl' },
    { name: 'iPlay', logo: 'iP', color: '#8e44ad', os: ['ios'], scheme: 'iplay://play/any?type=url&url=$bdurl' },
    { name: 'MX Player', logo: 'MX', color: '#1a73e8', os: ['android'], scheme: 'intent:$durl#Intent;package=com.mxtech.videoplayer.ad;S.title=$name;end' },
    { name: 'MX Player Pro', logo: 'MX', color: '#0d47a1', os: ['android'], scheme: 'intent:$durl#Intent;package=com.mxtech.videoplayer.pro;S.title=$name;end' },
    { name: 'Android', logo: 'And', color: '#3ddc84', ink: '#0b2e1b', os: ['android'], scheme: 'intent:$durl#Intent;type=video/*;S.title=$name;end' },
  ];
  const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' };
  const OS = (() => {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return 'android';
    // iPadOS 默认伪装成 Mac，靠触点数区分
    if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/mac os x|macintosh/i.test(ua)) return 'macos';
    if (/windows/i.test(ua)) return 'windows';
    if (/linux|cros/i.test(ua)) return 'linux';
    return '';
  })();
  /** 是否展开其他平台的播放器（本页会话内记住） */
  let showAllPlayers = false;

  function playerHref(scheme, url, name) {
    return scheme
      .replace('$name', () => encodeURIComponent(name))
      .replace(/\$([eb]*)durl/, (_, ops) => [...ops].reverse().reduce((u, o) => (o === 'e' ? encodeURIComponent(u) : btoa(u)), url));
  }

  function playerTitle(v) {
    return [meta.artist, meta.title || adamId].filter(Boolean).join(' - ') + ` [${v.info.name}]`;
  }

  function formatSize(bytes) {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  /* ---------- 纯净 MP4 元数据与歌词内嵌 ----------
   * 实现已抽到 ./local-download.mjs，供 song/album/playlist/artist 四视图共用，
   * 避免各页各写一份导致「只有单曲页才有标签」这类分叉（本次修复的核心）。
   */
  function downloadLyricsFile(content, ext, artist, title) {
    if (!content || !content.trim()) return;
    const cleanArtist = safeName(normalizeArtistName(artist || ''));
    const cleanTitle = safeName(toSimplified(title || adamId || 'Track'));
    const fileName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.${ext}`;
    saveTextFile(content, fileName, ext === 'ttml' ? 'application/xml;charset=utf-8' : 'text/plain;charset=utf-8');
  }

  /* ---------- Gofile 临时网盘上传 ---------- */
  async function getGofileServer() {
    // 1. 先尝试浏览器直连 api.gofile.io（超时 2 秒）
    try {
      const res = await fetch('https://api.gofile.io/servers', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        const srv = data?.data?.servers?.[0]?.name;
        if (srv) return { server: srv, direct: true };
      }
    } catch {}
    // 2. 直连失败或国内网络阻断时，自动走 VPS 本地代理 /gofile/servers
    try {
      const res = await fetch('/gofile/servers', { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const srv = data?.data?.servers?.[0]?.name;
        if (srv) return { server: srv, direct: false };
      }
    } catch {}
    throw new Error('无法连接至 Gofile 云端服务器');
  }

  function uploadSingleFile(serverInfo, file, opts = {}) {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file, file.name || 'track.m4a');
      if (opts.folderId) formData.append('folderId', opts.folderId);
      if (opts.token) formData.append('token', opts.token);

      const url = serverInfo.direct
        ? `https://${serverInfo.server}.gofile.io/contents/uploadfile`
        : `/gofile/upload?server=${encodeURIComponent(serverInfo.server)}`;

      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => xhr.abort());
      }
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      if (xhr.upload && opts.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress(e.loaded, e.total);
        };
      }
      xhr.onload = () => {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.status === 'ok') resolve(res.data);
          else reject(new Error(res.status || 'Gofile 上传响应失败'));
        } catch {
          reject(new Error('解析 Gofile 响应失败'));
        }
      };
      xhr.onerror = () => {
        if (serverInfo.direct) {
          // 直连受阻（如跨域或连接中断），自动无缝转为 VPS 代理通道重试
          serverInfo.direct = false;
          uploadSingleFile(serverInfo, file, opts).then(resolve).catch(reject);
        } else {
          reject(new Error('Gofile 网络传输中断'));
        }
      };
      xhr.send(formData);
    });
  }

  async function uploadToGofile({ files, signal, onProgress }) {
    const srvInfo = await getGofileServer();
    let parentFolder = null;
    let guestToken = null;
    let downloadPage = '';

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const data = await uploadSingleFile(srvInfo, f, {
        folderId: parentFolder,
        token: guestToken,
        signal,
        onProgress: (loaded, total) => {
          if (onProgress) onProgress(i, files.length, loaded, total);
        },
      });
      if (data.parentFolder) parentFolder = data.parentFolder;
      if (data.guestToken) guestToken = data.guestToken;
      if (data.downloadPage) downloadPage = data.downloadPage;
    }
    return downloadPage;
  }

  /* ---------- 浏览器端下载：直连 CDN + wasm 解密 + OPFS 暂存 ---------- */
  async function startDownload(v, fileName, mode) {
    const id = v.group_id;
    if (downloads.has(id)) { toast(t('dl.busy')); return; }
    const gofileChecked = document.querySelector('#gofile-toggle')?.checked ?? false;
    const isGofile = mode === 'gofile' || (mode !== 'local' && gofileChecked);

    // ⚠️ 元数据就绪保障：本机下载的标签注入完全依赖 meta，而 meta 由 loadMeta() 异步获取，
    // 与 loadVariants() 并行发起（后者先返回并渲染出下载按钮）。若用户在元数据落定前点击下载，
    // tagMp4 收到的字段全为 undefined → atoms 为空 → 静默返回原文件，产物零标签。
    // 服务端路径（Gofile/TG）自行按 adamId 查元数据，故无此问题。此处必须等待一次。
    if (!isGofile) {
      const ready = await ensureMetaReady();
      if (!ready) {
        toast('⚠️ 元数据获取失败，无法写入歌曲标签，已取消下载');
        downloads.delete(id);
        showDownload(id);
        return;
      }
    }

    const job = { ctl: new AbortController(), done: 0, total: 0, statusText: '' };
    downloads.set(id, job);
    showDownload(id);
    // 本机下载同样消耗 VPS 出站带宽，纳入每日转存配额（owner/admin 由服务端豁免）
    if (!isGofile) {
      try {
        const consumeRes = await fetch('/api/quota/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: 1 }),
          signal: AbortSignal.timeout(8000)
        });
        if (!consumeRes.ok && consumeRes.status !== 429) throw new Error(`配额预扣失败: HTTP ${consumeRes.status}`);
        if (consumeRes.status === 429) {
          const errJson = await consumeRes.json().catch(() => null);
          toast(errJson?.error || '⚠️ 今日转存配额不足，无法进行本机下载');
          downloads.delete(id);
          return;
        }
      } catch (err) {
        toast(`⚠️ 配额预扣失败: ${err.message}`);
        downloads.delete(id);
        return;
      }
    }
    if (isGofile) {
      job.statusText = '☁️ VPS 2000M 极速转存中...';
      job.done = 10;
      job.total = 100;
      showDownload(id);
      toast('☁️ 正在通过 VPS 2000M 云端极速转存至 Gofile...');

      const lyrOpts = getLyricsOptions();
      const lyricsFormat = lyrOpts.embedMode;
      const shouldEmbedLyrics = lyrOpts.embedMode !== 'off';
      const shouldSaveLyricsFile = lyrOpts.saveFormats.length > 0;
      const shouldTranslateLyrics = lyrOpts.translateOn;
      const zipChecked = document.querySelector('#zip-toggle')?.checked ?? false;
      const coverUrl = meta.artwork ? meta.artwork.replace('600x600', '1400x1400') : '';

      const progressTimer = setInterval(() => {
        if (job.done < 85) {
          job.done += 15;
          showDownload(id);
        }
      }, 400);

      try {
        const resp = await fetch('/api/cloud-transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adamId,
            quality: v.info?.name || 'Lossless',
            hookFileUrl: v.hookFileUrl,
            meta: {
              title: meta.title,
              artist: meta.artist,
              album: meta.album,
              albumArtist: meta.albumArtist || (meta.artists && meta.artists[0]?.name) || meta.artist,
              date: meta.releaseDate,
              genre: meta.genre,
              composer: meta.composer,
              copyright: meta.copyright || meta.resource?.attributes?.copyright,
              trackNumber: meta.trackNumber || meta.resource?.attributes?.trackNumber,
              totalTracks: meta.totalTracks,
              discNumber: meta.discNumber || meta.resource?.attributes?.discNumber,
              totalDiscs: meta.totalDiscs || 1,
              coverUrl
            },
            embedLyrics: shouldEmbedLyrics,
            saveLyricsFile: shouldSaveLyricsFile,
            lyricsFormat: (lyricsFormat === 'ttml' || lyricsFormat === 'lrc') ? lyricsFormat : 'lrc',
            saveLrc: shouldSaveLyricsFile,
            saveLyricsFormats: (lyrOpts.saveFormats.length ? lyrOpts.saveFormats : (shouldSaveLyricsFile ? [lyricsFormat === 'ttml' ? 'ttml' : 'lrc'] : [])),
            translateLyrics: shouldTranslateLyrics,
            ruby: Boolean(lyrOpts.rubyOn),
            rubyMode: lyrOpts.rubyMode || 'roman',
            zip: zipChecked
          }),
          signal: job.ctl.signal
        });
        clearInterval(progressTimer);
        const resJson = await resp.json();
        if (resJson.status !== 'ok') throw new Error(resJson.error || '云端转存失败');

        job.done = 100;
        job.total = 100;
        job.statusText = '☁️ 转存完成';
        showDownload(id);

        toast('🎉 已成功转存至 Gofile！');
        showGofileResult(resJson.data.downloadPage, `${meta.artist} - ${meta.title} [${v.info.name}]`);
        return;
      } catch (err) {
        clearInterval(progressTimer);
        throw err;
      }
    }

    try {
      await disposeSaved();
      const lyrOpts = getLyricsOptions();
      const saveFormats = lyrOpts.saveFormats;

      // 遵循规范：音频为标准 .m4a 封装
      const cleanArtist = safeName(normalizeArtistName(meta.artist || 'Unknown Artist'));
      const cleanTitle = safeName(toSimplified(meta.title || adamId || 'Track'));
      const standardM4aName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.m4a`;

      job.statusText = '正在解密并内嵌官方元数据与歌词...';
      showDownload(id);

      // 解密 + 标签/封面/歌词注入统一由共享模块完成（与批量下载同一实现，杜绝分叉）
      const dl = await downloadDecryptedTrack({
        variant: v,
        meta,
        m3u8Url: v.m3u8Url,
        trackId: adamId,
        lyricsOpts: lyrOpts,
        simplify: toSimplified,
        signal: job.ctl.signal,
        onProgress: (done, total) => { job.done = done; job.total = total; showDownload(id); },
        onDefrag: () => { job.defrag = true; showDownload(id); },
      });

      if (!dl.tagged) toast('⚠️ 未能写入歌曲标签（元数据缺失），文件已下载');

      saveResult({ file: dl.blob, dispose: dl.dispose }, standardM4aName);

      // 可选保存独立外挂歌词文件（按外置格式数组多格式保存；无歌词则跳过）
      const lyricsData = dl.lyricsData;
      if (saveFormats.length && lyricsData && lyricsData.hasLyrics) {
        for (const fmt of saveFormats) {
          if (fmt === 'ttml' && lyricsData.ttml) {
            downloadLyricsFile(lyricsData.ttml, 'ttml', meta.artist, meta.title);
          } else if (fmt === 'lrc' && lyricsData.lrc) {
            downloadLyricsFile(lyricsData.lrc, 'lrc', meta.artist, meta.title);
          }
        }
      }

      toast(t('dl.done', { size: formatSize(dl.size) }));
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (err && err.name === 'AbortError') toast(t('dl.cancelled'));
      else if (signal.aborted) toast(t('dl.failed', { msg }));
      else showAlert('error', () => t('dl.failed', { msg }));
    } finally {
      downloads.delete(id);
      showDownload(id);
    }
  }

  function renderDownload(id) {
    const r = rows.get(id);
    if (!r) return;
    const job = downloads.get(id);
    r.progress.hidden = !job;
    if (!job) return;
    const ratio = job.total ? job.done / job.total : 0;
    r.progressFill.style.width = `${Math.min(100, Math.floor(ratio * 100))}%`;
    r.progressText.textContent = job.statusText
      ? job.statusText
      : job.defrag
      ? t('dl.defrag')
      : job.total
      ? t('dl.progress', { pct: Math.floor(ratio * 100), done: formatSize(job.done), total: formatSize(job.total) })
      : t('dl.preparing');
  }

  /* ---------- 下拉菜单（单例，fixed 定位，避免被列表 overflow 裁剪） ---------- */
  const menu = { el: $('menu'), trigger: null };

  function closeMenu(focusTrigger) {
    if (!menu.trigger) return;
    menu.el.hidden = true;
    menu.trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) menu.trigger.focus();
    menu.trigger = null;
  }

  /** 可聚焦的菜单项（跳过折叠中的） */
  function menuItems() {
    return [...menu.el.querySelectorAll('[role="menuitem"]')].filter((n) => !n.closest('[hidden]'));
  }

  /** items：'-' 分隔线、现成的 DOM 节点，或 { icon, label, hint, href?, download?, onSelect? } */
  function openMenu(trigger, items) {
    const reopen = menu.trigger === trigger;
    closeMenu(false);
    if (reopen) return;
    menu.el.replaceChildren(...items.map((it) => {
      if (it === '-') return el('div', { className: 'menu-sep', role: 'separator' });
      if (it instanceof Node) return it;
      const node = el(it.href ? 'a' : 'button', { className: 'menu-item', innerHTML: it.icon, tabIndex: -1 });
      if (it.href) { node.href = it.href; if (it.download) node.download = it.download; } else node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.append(el('span', { className: 'menu-text' },
        el('span', { className: 'menu-label', textContent: it.label }),
        it.hint && el('span', { className: 'menu-hint', textContent: it.hint })));
      node.addEventListener('click', () => { closeMenu(false); if (it.onSelect) it.onSelect(); });
      return node;
    }));
    menu.el.hidden = false;
    menu.trigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    positionMenu();
    menuItems()[0]?.focus({ preventScroll: true });
  }

  /**
   * 右对齐触发按钮；下方（播放条以上）放得下就向下，否则朝空间大的一侧展开。
   * 两侧都放不下时（窄屏 / 页面放大）限制高度，菜单内部滚动。
   */
  function positionMenu() {
    if (matchMedia('(max-width: 760px)').matches) {
      const viewport = window.visualViewport;
      const top = viewport ? viewport.offsetTop : 0;
      const height = viewport ? viewport.height : innerHeight;
      menu.el.style.maxHeight = `${Math.max(80, height - 32)}px`;
      menu.el.style.left = '12px';
      menu.el.style.top = `${top + height - menu.el.getBoundingClientRect().height - 16}px`;
      return;
    }
    const r = menu.trigger.getBoundingClientRect();
    menu.el.style.maxHeight = '';
    const m = menu.el.getBoundingClientRect();
    const bottom = Math.min(innerHeight, player.barTop()) - 8;
    const below = bottom - r.bottom - 6;
    const above = r.top - 6 - 8;
    const down = below >= m.height || below >= above;
    const height = Math.min(m.height, down ? below : above);
    if (height < m.height) menu.el.style.maxHeight = `${height}px`;
    menu.el.style.top = `${Math.max(8, down ? r.bottom + 6 : r.top - 6 - height)}px`;
    menu.el.style.left = `${Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8)}px`;
  }

  /** 外部播放器宫格：本平台的排在前面，其他平台折叠 */
  function playerSection(v) {
    const local = PLAYERS.filter((p) => !OS || p.os.includes(OS));
    const others = PLAYERS.filter((p) => !local.includes(p));
    const title = playerTitle(v);
    const tile = (p) => {
      const node = el('a', {
        className: 'player-tile', tabIndex: -1,
        href: playerHref(p.scheme, v.hookM3u8Url, title),
        title: `${p.name} · ${p.os.map((o) => OS_NAMES[o]).join(' / ')}`,
      }, el('span', { className: 'player-logo', textContent: p.logo }), el('span', { className: 'player-name', textContent: p.name }));
      node.style.setProperty('--logo', p.color);
      if (p.ink) node.style.setProperty('--logo-ink', p.ink);
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', () => { closeMenu(false); toast(t('toast.player', { name: p.name })); });
      return node;
    };

    const section = el('div', { className: 'menu-section' },
      el('div', { className: 'menu-caption' },
        el('span', { textContent: t('menu.players') }),
        el('span', { className: 'menu-caption-hint', textContent: t('menu.playersHint') })),
      el('div', { className: 'player-grid' }, ...local.map(tile)));
    if (!others.length) return section;

    const extra = el('div', { className: 'player-grid', hidden: !showAllPlayers }, ...others.map(tile));
    const toggle = el('button', { className: 'menu-toggle', type: 'button', tabIndex: -1 });
    toggle.setAttribute('role', 'menuitem');
    const sync = () => {
      extra.hidden = !showAllPlayers;
      toggle.textContent = t(showAllPlayers ? 'menu.lessPlayers' : 'menu.morePlayers', { n: others.length });
      toggle.setAttribute('aria-expanded', String(showAllPlayers));
    };
    toggle.addEventListener('click', () => { showAllPlayers = !showAllPlayers; sync(); positionMenu(); toggle.focus(); });
    sync();
    section.append(extra, toggle);
    return section;
  }

  /** 复制地址：一行内选择 media m3u8 或 media file */
  function copyRow(v) {
    const choice = (label, url, doneKey) => {
      const node = el('button', { className: 'seg-btn', type: 'button', tabIndex: -1, textContent: label, title: url });
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', () => { closeMenu(false); copy(url, doneKey); });
      return node;
    };
    return el('div', { className: 'menu-row', innerHTML: ICON.copy },
      el('span', { className: 'menu-text' },
        el('span', { className: 'menu-label', textContent: t('menu.copy') }),
        el('span', { className: 'menu-hint', textContent: t('menu.copyHint') })),
      el('div', { className: 'seg', role: 'group', ariaLabel: t('menu.copy') },
        choice('M3U8', v.hookM3u8Url, 'toast.copiedM3u8'),
        choice(t('menu.copyFile'), v.hookFileUrl, 'toast.copiedFile')));
  }

  menu.el.addEventListener('keydown', (e) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.trigger && !menu.el.contains(e.target) && !menu.trigger.contains(e.target)) closeMenu(false);
  }, { signal });
  addEventListener('resize', () => closeMenu(false), { signal });
  // 菜单自身的滚动（放大后内容超出、键盘聚焦自动滚动）不应关闭菜单
  addEventListener('scroll', (e) => {
    if (!menu.trigger || menu.el.contains(e.target)) return;
    if (matchMedia('(max-width: 760px)').matches) positionMenu();
    else closeMenu(false);
  }, { capture: true, signal });

  function variantMenu(v, fileName) {
    const items = [
      {
        icon: ICON.download,
        label: t('menu.download'),
        hint: t('menu.downloadHint', { file: fileName }),
        onSelect: () => startDownload(v, fileName, 'local'),
      },
      {
        icon: ICON.cloud,
        label: '转存至 Gofile',
        hint: '云端临时网盘分享，免本地占用',
        onSelect: () => startDownload(v, fileName, 'gofile'),
      },
      {
        icon: ICON.lyrics,
        label: '下载独立歌词文件',
        hint: '根据所选格式保存 .lrc 或 .ttml 歌词',
        onSelect: async () => {
          toast('正在获取歌词...');
          const o = getLyricsOptions();
          const translateOn = o.translateOn;
          const data = await fetchLyricsData(adamId, translateOn && !meta.isChinese, (s) => s, {
            ruby: Boolean(o.rubyOn),
            rubyMode: o.rubyMode || 'roman',
          });
          if (!data || !data.hasLyrics) { toast('暂无歌词或此曲为纯音乐'); return; }
          // 优先按外置格式数组下载；未选外置则按当前内嵌格式下载一个
          const fmts = o.saveFormats.length ? o.saveFormats : [(o.embedMode === 'ttml' && data.ttml) ? 'ttml' : 'lrc'];
          for (const f of fmts) {
            if (f === 'ttml' && data.ttml) downloadLyricsFile(data.ttml, 'ttml', meta.artist, meta.title);
            else if (f === 'lrc' && data.lrc) downloadLyricsFile(data.lrc, 'lrc', meta.artist, meta.title);
          }
          toast('已开始下载歌词');
        },
      },
    ];
    if (hook) {
      items.push(
        '-',
        playerSection(v),
        '-',
        copyRow(v),
      );
    }
    return items;
  }

  function playItem(v) {
    return {
      id: `${adamId}:${v.group_id}`,
      track: adamId,
      country: meta.country || country,
      codecs: v.codecs,
      m3u8Url: v.m3u8Url,
      hookM3u8Url: v.hookM3u8Url,
      hookFileUrl: v.hookFileUrl,
      label: v.info.name,
      badge: qualityBadge(v),
      title: meta.title,
      artist: meta.artist,
      artists: meta.artists,
      album: meta.album,
      href: url.pathname,
      albumHref: albumHref(),
      artwork: meta.artwork,
    };
  }

  function renderVariants() {
    const list = $('variant-list');
    rows = new Map();
    const nodes = [];
    let lastGroup = null;
    for (const v of variants) {
      if (v.info.group !== lastGroup) {
        lastGroup = v.info.group;
        nodes.push(el('div', { className: 'variant-group', textContent: lastGroup }));
      }
      const playable = !!v.mode;
      const playBtn = el('button', { className: 'play-btn', type: 'button', innerHTML: ICON.play, disabled: !playable });
      playBtn.setAttribute('aria-label', playable ? t('row.play', { name: v.info.name }) : t('row.unsupported'));
      playBtn.title = playable ? t('row.playTitle')
        : t('row.unsupportedTitle', { codecs: v.codecs, hint: t(hook ? 'player.hintExternal' : 'player.hintDownload') });
      playBtn.addEventListener('click', () => player.play(playItem(v)));

      const name = el('div', { className: 'variant-name' }, v.info.name,
        qualityIcon(qualityBadge(v)),
        ...v.info.tags.map((tag) => el('span', { className: 'badge', textContent: tag })),
        el('span', { className: `badge ${playable ? 'ok' : 'warn'}`, textContent: t(playable ? 'row.playable' : hook ? 'row.external' : 'row.downloadOnly') }));
      const detail = el('div', { className: 'variant-detail' },
        [v.codecs, formatRate(v.bandwidth), v.channels && t('row.channels', { n: v.channels })].filter(Boolean).join(' · ') + ' · ',
        el('code', { textContent: v.group_id }));

      const progressFill = el('div', { className: 'dl-fill' });
      const progressText = el('span', { className: 'dl-text' });
      const cancel = el('button', { className: 'icon-btn dl-cancel', type: 'button', title: t('row.cancel'), innerHTML: ICON.close });
      cancel.setAttribute('aria-label', t('row.cancelAria', { name: v.info.name }));
      cancel.addEventListener('click', () => { const job = downloads.get(v.group_id); if (job) job.ctl.abort(); });
      const progress = el('div', { className: 'dl', hidden: true },
        el('div', { className: 'dl-bar' }, progressFill), progressText, cancel);

      const normArtist = normalizeArtistName(meta.artist || '');
      const normTitle = toSimplified(meta.title || adamId || 'Track');
      const fileName = safeName(`${normArtist ? normArtist + ' - ' : ''}${normTitle} [${v.info.name.replace(/ · /g, ' ')}].m4a`);
      const gofileBtn = el('button', {
        className: 'icon-btn gofile-btn',
        type: 'button',
        title: '转存至 Gofile 临时网盘',
        innerHTML: ICON.cloud,
      });
      gofileBtn.setAttribute('aria-label', `转存 ${v.info.name} 至 Gofile`);
      gofileBtn.addEventListener('click', () => startDownload(v, fileName, 'gofile'));

      const more = el('button', { className: 'icon-btn more-btn', type: 'button', title: t('row.more'), innerHTML: ICON.more });
      more.setAttribute('aria-label', t('row.moreAria', { name: v.info.name }));
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => openMenu(more, variantMenu(v, fileName)));
      const actions = el('div', { className: 'variant-actions' }, gofileBtn, more);

      const row = el('div', { className: 'variant' }, playBtn, el('div', {}, name, detail, progress), actions);
      rows.set(v.group_id, { row, playBtn, progress, progressFill, progressText });
      nodes.push(row);
    }
    list.replaceChildren(...nodes);
    for (const id of downloads.keys()) renderDownload(id);
    $('count').textContent = t('song.count', { total: variants.length, playable: variants.filter((v) => v.mode).length });
    $('variants').hidden = false;
    $('play-best').disabled = !variants.some((v) => v.mode);
    $('ext-best').hidden = !hook;
    $('ext-best').disabled = variants.length === 0;
    syncRows(player.current, !player.transport().paused);
  }

  function syncRows(current, playing) {
    for (const [id, { row, playBtn }] of rows) {
      const active = current && current.id === `${adamId}:${id}`;
      row.classList.toggle('playing', !!active);
      playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
    }
  }
  player.onChange(syncRows);
  // 检测说能播但实际失败的编码：更新标记，避免再次误导
  player.onUnsupported((codecs) => {
    variants.forEach((v) => { if (v.codecs === codecs) v.mode = null; });
    renderVariants();
  });

  // 外部播放器能播所有音质，直接取最高音质
  $('ext-best').addEventListener('click', () => { if (variants[0]) openMenu($('ext-best'), [playerSection(variants[0])]); });

  $('play-best').addEventListener('click', () => {
    // 优先播放浏览器能播的最高音质
    const best = variants.find((v) => v.mode);
    if (best) player.play(playItem(best));
  });

  async function loadVariants() {
    $('reparse').disabled = true;
    showAlert('info', () => t('song.loading'));
    try {
      const res = await fetch(`/parse/song/${adamId}`, { signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.masterUrl || !Array.isArray(data.variants) || !data.variants.length) {
        if (data.msg === 'failed to get m3u8' || data.msg?.includes('无资源') || data.msg?.includes('无版权') || res.status === 404 || res.status === 500) {
          throw new Error('此歌曲在解析服务器账号所属区域（土区）无资源或未上架（可能为日区/美区独占版权），暂无法获取解密音轨');
        }
        throw new Error(data.msg || t('song.parseFailedHttp', { status: res.status }));
      }
      const base = data.masterUrl.slice(0, data.masterUrl.lastIndexOf('/') + 1);
      hook = !!data.hook;
      variants = data.variants.map((v) => ({
        ...v,
        info: describe(v),
        mode: detectMode(v.codecs, probe, hook),
        // 浏览器直连 CDN 的原始地址（浏览器端解密）
        m3u8Url: base + v.uri,
        // 服务端解密地址，仅 --hook 时可用
        hookM3u8Url: hook ? hookUrl(base + v.uri) : null,
        hookFileUrl: hook ? hookUrl(base + v.file_uri) : null,
      })).sort((a, b) => a.info.rank - b.info.rank || b.info.kbps - a.info.kbps || a.info.sub - b.info.sub || (b.bandwidth || 0) - (a.bandwidth || 0));
      renderVariants();
      showAlert('', '');
    } catch (err) {
      showAlert('error', err.message || t('song.parseFailed'));
    } finally {
      $('reparse').disabled = false;
    }
  }

  // 经服务端 /amp 代理请求 amp-api 元数据；实现见 ./local-download.mjs（四视图共用）
  async function lookupMeta() {
    try {
      return (await fetchSongMeta(adamId, { country, simplify: toSimplified })) || {};
    } catch (err) {
      console.warn('[am-hook] 元数据查询失败:', err);
      return {};
    }
  }
  /** 艺人资源 → 本站艺人页路径 */
  function artistPath(resource, cc) {
    const m = (resource.attributes?.url || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/artist\/([^/?#]+)\/(\d+)/i);
    return m ? `/https://music.apple.com/${m[1].toLowerCase()}/artist/${m[2]}/${m[3]}` : `/https://music.apple.com/${cc}/artist/_/${resource.id}`;
  }

  /** 本站专辑页路径 */
  function albumHref() {
    return meta.album && meta.albumId ? `/https://music.apple.com/${meta.country || country}/album/_/${meta.albumId}` : '';
  }

  let metaLoaded = false;

  function renderMeta() {
    if (!metaLoaded) return;
    const title = meta.title || t('song.fallbackTitle', { id: adamId });
    document.title = `${title} · am-hook`;
    $('title').textContent = title;
    $('title').classList.remove('skeleton');
    // 专辑名链接到本站专辑页
    const albumNode = albumHref() ? el('a', { href: albumHref(), textContent: meta.album }) : meta.album;
    // 艺人名链接到本站艺人页
    const parts = [meta.artist && artistNodes(meta.artist, meta.artists), albumNode].filter(Boolean);
    $('subtitle').replaceChildren(...(parts.length ? parts.flatMap((part, i) => (i ? [' — ', ...[].concat(part)] : [].concat(part))) : [t('song.noMeta')]));
    $('subtitle').classList.remove('skeleton');
    const tags = [];
    if (meta.releaseDate) tags.push(meta.releaseDate.slice(0, 4));
    if (meta.genre) tags.push(meta.genre);
    if (meta.durationMs) tags.push(formatTime(meta.durationMs / 1000));
    if (meta.explicit) tags.push('E');
    tags.push(`ID ${adamId}`);
    $('meta').replaceChildren(...tags.map((tag) => el('span', { className: 'badge', textContent: tag })));
    if (meta.artwork) $('cover').replaceChildren(el('img', { src: meta.artwork, alt: t('song.coverAlt', { title }) }));
    if (meta.url) $('apple-link').href = meta.url;
  }

  let metaSeq = 0;
  /** 进行中的元数据加载 Promise：下载前据此等待元数据就绪（见 ensureMetaReady） */
  let metaPromise = null;

  async function loadMeta() {
    // 快速切换语言时只采用最后一次请求的结果；离开页面后不再改标题
    const seq = ++metaSeq;
    const result = await lookupMeta();
    if (seq !== metaSeq || signal.aborted) return metaLoaded;
    // 切换语言后重新获取失败时保留已有信息
    if (metaLoaded && !result.title) return true;
    // ⚠️ 查询失败（result 为空对象）时不得置 metaLoaded = true，否则下载会误判"元数据已就绪"
    // 并写入零标签文件（原 bug：状态污染使 ensureMetaReady 拿到假阳性）
    if (!result || !result.title) {
      if (!metaLoaded) toast('⚠️ 歌曲元数据获取失败，下载可能缺失标签信息');
      return metaLoaded;
    }
    meta = result;
    metaLoaded = true;
    renderMeta();
    // 中文歌无需翻译：仅非中文歌曲显示"中文翻译"开关
    if (translateLyricsLabel) {
      translateLyricsLabel.style.display = meta.isChinese ? 'none' : 'inline-flex';
    }
    // 注音仅对日文歌有意义（Apple 只提供 ja-Latn 罗马音）
    if (rubyLyricsLabel) {
      const isJa = Boolean(meta.isJapanese) ||
        /[\u3040-\u309F\u30A0-\u30FF]/.test(`${meta.title || ''}${meta.artist || ''}${meta.album || ''}`) ||
        /j-pop|anime|japanese|アニメ/i.test(meta.genre || '');
      rubyLyricsLabel.style.display = isJa ? 'inline-flex' : 'none';
    }
    libraryToggle.refresh();
    favoriteToggle.refresh();
    playlistBtn.disabled = !meta.resource;
    if (rows.size) renderVariants(); // 下载文件名需要歌名
    return true;
  }

  /** 触发一次元数据加载并记录其在途 Promise（重复调用复用同一次请求） */
  function kickMeta() {
    const p = loadMeta();
    metaPromise = p;
    return p;
  }

  /**
   * 下载前的元数据就绪保障：本机下载的标签注入完全依赖 meta。
   * metaLoaded 已为真则直接放行；否则等待在途/新发起的加载（带超时兜底，避免网络悬挂卡死下载）。
   * 返回 true 表示元数据可用。
   */
  async function ensureMetaReady() {
    if (metaLoaded && meta.title) return true;
    const wait = (metaPromise || kickMeta()).catch(() => false);
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000));
    const outcome = await Promise.race([wait, timeout]);
    if (outcome === 'timeout') console.warn('[am-hook] 元数据等待超时，继续下载');
    return !!(metaLoaded && meta.title);
  }

  $('reparse').addEventListener('click', loadVariants);

  if (adamId) {
    progressViews.set(adamId, renderDownload);
    signal.addEventListener('abort', () => { if (progressViews.get(adamId) === renderDownload) progressViews.delete(adamId); });
  }

  // 切换语言：重绘所有动态生成的文字（播放、下载不受影响）；歌名等由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    closeMenu(false);
    if (!metaLoaded) document.title = t('song.pageTitle');
    renderMeta();
    if (adamId) kickMeta();
    if (variants.length) {
      variants.forEach((v) => { v.info = describe(v); });
      renderVariants();
    }
    renderAlert();
  });

  if (!adamId) {
    showAlert('error', () => t('song.badId'));
  } else {
    kickMeta();
    loadVariants();
    AmDecrypt.collectGarbage();
  }
  // 离开页面：删除已保存下载的临时文件（进行中的下载继续，完成后照常保存）
  signal.addEventListener('abort', disposeSaved, { once: true });
}
