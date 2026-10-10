// 歌曲页（/https://music.apple.com/{cc}/song/{slug}/{id}），由 app.mjs 挂载
import { createActions, targetOf, normalizeArtistName, toSimplified } from './actions.mjs';

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

  const embedToggle = $('embed-lyrics-toggle');
  if (embedToggle) {
    if (localStorage.getItem('am_embed_lyr') !== null) {
      embedToggle.checked = localStorage.getItem('am_embed_lyr') === 'true';
    }
    embedToggle.addEventListener('change', () => {
      localStorage.setItem('am_embed_lyr', String(embedToggle.checked));
    });
  }

  const saveLyricsToggle = $('save-lyrics-toggle');
  if (saveLyricsToggle) {
    if (localStorage.getItem('am_save_lyr') !== null) {
      saveLyricsToggle.checked = localStorage.getItem('am_save_lyr') === 'true';
    }
    saveLyricsToggle.addEventListener('change', () => {
      localStorage.setItem('am_save_lyr', String(saveLyricsToggle.checked));
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

  /* ---------- 纯净 MP4 元数据与同步歌词内嵌 ---------- */
  function createDataAtom(type, flags, payload) {
    // MP4 fourcc 必须精确 4 字节，非 ASCII (如 \xa9) 必须用 charCodeAt 保证单字节
    const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
    const dataHeader = new Uint8Array(16);
    const dataView = new DataView(dataHeader.buffer);
    const dataSize = 16 + payload.length;
    dataView.setUint32(0, dataSize, false);
    dataHeader.set(new TextEncoder().encode('data'), 4);
    dataView.setUint32(8, flags, false);
    dataView.setUint32(12, 0, false);

    const atomSize = 8 + dataSize;
    const atomHeader = new Uint8Array(8);
    new DataView(atomHeader.buffer).setUint32(0, atomSize, false);
    atomHeader.set(typeBytes, 4);

    const res = new Uint8Array(atomSize);
    res.set(atomHeader, 0);
    res.set(dataHeader, 8);
    res.set(payload, 24);
    return res;
  }

  function createTextAtom(name, text) {
    if (!text) return new Uint8Array(0);
    return createDataAtom(name, 1, new TextEncoder().encode(String(text)));
  }

  function createTrackAtom(trackNum, totalTracks = 0) {
    if (!trackNum) return new Uint8Array(0);
    const buf = new Uint8Array(8);
    const v = new DataView(buf.buffer);
    v.setUint16(2, Number(trackNum) || 0, false);
    v.setUint16(4, Number(totalTracks) || 0, false);
    return createDataAtom('trkn', 0, buf);
  }

  function createDiscAtom(discNum, totalDiscs = 0) {
    if (!discNum) return new Uint8Array(0);
    const buf = new Uint8Array(6);
    const v = new DataView(buf.buffer);
    v.setUint16(2, Number(discNum) || 0, false);
    v.setUint16(4, Number(totalDiscs) || 0, false);
    return createDataAtom('disk', 0, buf);
  }

  function createCoverAtom(imageBuf) {
    if (!imageBuf || !imageBuf.length) return new Uint8Array(0);
    const isPng = imageBuf[0] === 0x89 && imageBuf[1] === 0x50 && imageBuf[2] === 0x4e && imageBuf[3] === 0x47;
    const flag = isPng ? 14 : 13;
    return createDataAtom('covr', flag, imageBuf);
  }

  function tagMp4(mp4Bytes, tags) {
    const atoms = [];
    if (tags.title) atoms.push(createTextAtom('\xa9nam', tags.title));
    if (tags.artist) atoms.push(createTextAtom('\xa9ART', tags.artist));
    if (tags.album) atoms.push(createTextAtom('\xa9alb', tags.album));
    if (tags.albumArtist) atoms.push(createTextAtom('aART', tags.albumArtist));
    if (tags.date) atoms.push(createTextAtom('\xa9day', String(tags.date)));
    if (tags.genre) atoms.push(createTextAtom('\xa9gen', tags.genre));
    if (tags.composer) atoms.push(createTextAtom('\xa9wrt', tags.composer));
    if (tags.copyright) atoms.push(createTextAtom('cprt', tags.copyright));
    if (tags.lyrics) atoms.push(createTextAtom('\xa9lyr', tags.lyrics));
    if (tags.trackNumber) atoms.push(createTrackAtom(tags.trackNumber, tags.totalTracks || 0));
    if (tags.discNumber) atoms.push(createDiscAtom(tags.discNumber, tags.totalDiscs || 0));
    if (tags.cover) atoms.push(createCoverAtom(tags.cover));

    const totalPayloadLen = atoms.reduce((sum, a) => sum + a.length, 0);
    if (totalPayloadLen === 0) return mp4Bytes;

    const ilstSize = 8 + totalPayloadLen;
    const fullNewIlst = new Uint8Array(ilstSize);
    new DataView(fullNewIlst.buffer).setUint32(0, ilstSize, false);
    fullNewIlst.set(new TextEncoder().encode('ilst'), 4);
    let pos = 8;
    for (const a of atoms) {
      fullNewIlst.set(a, pos);
      pos += a.length;
    }

    const dv = new DataView(mp4Bytes.buffer, mp4Bytes.byteOffset, mp4Bytes.byteLength);
    let moovOffset = -1;
    let moovSize = 0;
    let mdatOffset = -1;
    let offset = 0;
    while (offset + 8 <= mp4Bytes.length) {
      let size = dv.getUint32(offset, false);
      const type = String.fromCharCode(...mp4Bytes.subarray(offset + 4, offset + 8));
      if (type === 'moov') {
        moovOffset = offset;
        moovSize = size;
      } else if (type === 'mdat') {
        if (mdatOffset === -1) mdatOffset = offset;
      }
      if (size === 1) {
        if (offset + 16 <= mp4Bytes.length) {
          size = Number(dv.getBigUint64(offset + 8, false));
        } else break;
      }
      if (size === 0) break;
      offset += size;
    }
    if (moovOffset === -1) return mp4Bytes;

    const moovBytes = mp4Bytes.subarray(moovOffset, moovOffset + moovSize);
    let udtaOffset = -1;
    let udtaSize = 0;
    let uOffset = 8;
    const mdv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    while (uOffset + 8 <= moovBytes.length) {
      const size = mdv.getUint32(uOffset, false);
      const type = String.fromCharCode(...moovBytes.subarray(uOffset + 4, uOffset + 8));
      if (type === 'udta') {
        udtaOffset = uOffset;
        udtaSize = size;
        break;
      }
      if (size === 0) break;
      uOffset += size;
    }

    // 标准 iTunes Metadata Handler (33 字节，所有播放器与系统属性读取器均强制要求)
    const hdlrBox = new Uint8Array([
      0x00, 0x00, 0x00, 0x21, // size: 33
      0x68, 0x64, 0x6c, 0x72, // 'hdlr'
      0x00, 0x00, 0x00, 0x00, // version & flags
      0x00, 0x00, 0x00, 0x00, // predefined
      0x6d, 0x64, 0x69, 0x72, // handler type: 'mdir'
      0x61, 0x70, 0x70, 0x6c, // handler subtype: 'appl'
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
      0x00                     // name
    ]);

    const metaSize = 12 + hdlrBox.length + fullNewIlst.length;
    const metaBox = new Uint8Array(metaSize);
    new DataView(metaBox.buffer).setUint32(0, metaSize, false);
    metaBox.set(new TextEncoder().encode('meta'), 4);
    metaBox.set(hdlrBox, 12);
    metaBox.set(fullNewIlst, 12 + hdlrBox.length);

    const udtaTotal = 8 + metaBox.length;
    const finalUdta = new Uint8Array(udtaTotal);
    new DataView(finalUdta.buffer).setUint32(0, udtaTotal, false);
    finalUdta.set(new TextEncoder().encode('udta'), 4);
    finalUdta.set(metaBox, 8);

    const newMoovSize = (udtaOffset === -1 ? moovSize : moovSize - udtaSize) + finalUdta.length;
    const newMoov = new Uint8Array(newMoovSize);
    const moovBeforeUdta = udtaOffset === -1 ? moovBytes : moovBytes.subarray(0, udtaOffset);
    const moovAfterUdta = udtaOffset === -1 ? new Uint8Array(0) : moovBytes.subarray(udtaOffset + udtaSize);

    newMoov.set(moovBeforeUdta, 0);
    newMoov.set(finalUdta, moovBeforeUdta.length);
    newMoov.set(moovAfterUdta, moovBeforeUdta.length + finalUdta.length);
    new DataView(newMoov.buffer).setUint32(0, newMoovSize, false);

    const delta = newMoovSize - moovSize;

    // 当 moov 位于 mdat 之前时，moov 扩容 delta 字节导致 mdat 整体后移 delta 字节，
    // 必须同步修正 moov 内所有 stco / co64 chunk offset
    if (delta !== 0 && mdatOffset !== -1 && mdatOffset > moovOffset) {
      const patchView = new DataView(newMoov.buffer, newMoov.byteOffset, newMoov.byteLength);
      for (let i = 0; i <= newMoov.length - 16; i++) {
        const type = String.fromCharCode(...newMoov.subarray(i + 4, i + 8));
        if (type === 'stco') {
          const boxSize = patchView.getUint32(i, false);
          const entryCount = patchView.getUint32(i + 12, false);
          if (boxSize === 16 + entryCount * 4) {
            let pos = i + 16;
            for (let e = 0; e < entryCount; e++) {
              const oldOff = patchView.getUint32(pos, false);
              patchView.setUint32(pos, oldOff + delta, false);
              pos += 4;
            }
          }
        } else if (type === 'co64') {
          const boxSize = patchView.getUint32(i, false);
          const entryCount = patchView.getUint32(i + 12, false);
          if (boxSize === 16 + entryCount * 8) {
            let pos = i + 16;
            for (let e = 0; e < entryCount; e++) {
              const oldOff = patchView.getBigUint64(pos, false);
              patchView.setBigUint64(pos, oldOff + BigInt(delta), false);
              pos += 8;
            }
          }
        }
      }
    }

    const finalMp4 = new Uint8Array(mp4Bytes.length - moovSize + newMoovSize);
    finalMp4.set(mp4Bytes.subarray(0, moovOffset), 0);
    finalMp4.set(newMoov, moovOffset);
    finalMp4.set(mp4Bytes.subarray(moovOffset + moovSize), moovOffset + newMoovSize);
    return finalMp4;
  }

  function parseTimeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const str = timeStr.trim().replace(/s$/i, '');
    if (str.includes(':')) {
      const parts = str.split(':');
      if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
      if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(str) || 0;
  }

  function formatLrcTimestamp(seconds) {
    const safeSec = Math.max(0, seconds);
    const m = Math.floor(safeSec / 60);
    const s = (safeSec % 60).toFixed(2);
    return `[${String(m).padStart(2, '0')}:${s.padStart(5, '0')}]`;
  }

  function ttmlToLrc(ttmlContent) {
    if (!ttmlContent || typeof ttmlContent !== 'string') return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    let cleaned = ttmlContent;
    cleaned = cleaned.replace(/<div[^>]*type=["']translation["'][^>]*>[\s\S]*?<\/div>/gi, '');
    cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-translation["'][^>]*>[\s\S]*?<\/span>/gi, '');
    cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-roman["'][^>]*>[\s\S]*?<\/span>/gi, '');
    cleaned = cleaned.replace(/<span[^>]*type=["']pronunciation["'][^>]*>[\s\S]*?<\/span>/gi, '');
    cleaned = cleaned.replace(/<span[^>]*\bpronunciation=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi, (match, pron, innerText) => {
      const rawText = innerText.replace(/<[^>]+>/g, '').trim();
      if (!rawText) return '';
      if (rawText.toLowerCase() === pron.trim().toLowerCase() || (/^[a-zA-Z\s'-]+$/.test(rawText) && pron)) return '';
      return innerText;
    });

    const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
    const timedLines = [];
    const plainLines = [];
    let match;
    while ((match = pRegex.exec(cleaned)) !== null) {
      const pAttrs = match[1] || '';
      let text = match[2].replace(/<[^>]+>/g, '');
      text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .trim();
      if (!text) continue;
      plainLines.push(text);
      const beginMatch = pAttrs.match(/\bbegin=["']([^"']+)["']/i);
      if (beginMatch) {
        const sec = parseTimeToSeconds(beginMatch[1]);
        timedLines.push(`${formatLrcTimestamp(sec)} ${text}`);
      }
    }
    if (plainLines.length === 0) {
      return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    }
    const isDynamic = timedLines.length > 0;
    const lrc = isDynamic ? timedLines.join('\n') : plainLines.join('\n');
    const plain = plainLines.join('\n');
    return { hasLyrics: true, isDynamic, lrc, plain, ttml: ttmlContent };
  }

  async function fetchLyricsData(trackId) {
    try {
      const res = await fetch(`/lyrics/${trackId}`);
      if (!res.ok) return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
      const rawTtml = await res.text();
      const parsed = ttmlToLrc(rawTtml);
      if (parsed.hasLyrics && meta.isChinese) {
        if (parsed.lrc) parsed.lrc = toSimplified(parsed.lrc);
        if (parsed.plain) parsed.plain = toSimplified(parsed.plain);
        if (parsed.ttml) parsed.ttml = toSimplified(parsed.ttml);
      }
      return parsed;
    } catch (err) {
      console.warn('fetchLyricsData failed:', err);
      return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    }
  }

  function downloadLyricsFile(content, ext, artist, title) {
    if (!content || !content.trim()) return;
    const cleanArtist = safeName(normalizeArtistName(artist || ''));
    const cleanTitle = safeName(toSimplified(title || adamId || 'Track'));
    const fileName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.${ext}`;
    const blob = new Blob([content], { type: ext === 'ttml' ? 'application/xml;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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

    const job = { ctl: new AbortController(), done: 0, total: 0, statusText: '' };
    downloads.set(id, job);
    showDownload(id);
    if (isGofile) {
      job.statusText = '☁️ VPS 2000M 极速转存中...';
      job.done = 10;
      job.total = 100;
      showDownload(id);
      toast('☁️ 正在通过 VPS 2000M 云端极速转存至 Gofile...');

      const fmtSelect = document.querySelector('#lyrics-format-select');
      const lyricsFormat = fmtSelect ? fmtSelect.value : (localStorage.getItem('am_lyrics_fmt') || 'lrc');
      const embedToggle = document.querySelector('#embed-lyrics-toggle');
      const shouldEmbedLyrics = embedToggle ? embedToggle.checked : (localStorage.getItem('am_embed_lyr') !== 'false');
      const saveLyrToggle = document.querySelector('#save-lyrics-toggle');
      const shouldSaveLyricsFile = saveLyrToggle ? saveLyrToggle.checked : (localStorage.getItem('am_save_lyr') !== 'false');
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
            lyricsFormat,
            saveLrc: shouldSaveLyricsFile,
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
      const track = await AmDecrypt.openTrack(v.m3u8Url, job.ctl.signal);
      job.total = track.size;
      showDownload(id);
      const result = await AmDecrypt.download(track, {
        signal: job.ctl.signal,
        onProgress: (done) => { job.done = done; showDownload(id); },
        onDefrag: () => { job.defrag = true; showDownload(id); },
      });

      // 遵循规范：音频为标准 .m4a 封装
      const cleanArtist = safeName(normalizeArtistName(meta.artist || 'Unknown Artist'));
      const cleanTitle = safeName(toSimplified(meta.title || adamId || 'Track'));
      const standardM4aName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.m4a`;

      const fmtSelect = document.querySelector('#lyrics-format-select');
      const lyricsFormat = fmtSelect ? fmtSelect.value : (localStorage.getItem('am_lyrics_fmt') || 'lrc');
      const embedToggle = document.querySelector('#embed-lyrics-toggle');
      const shouldEmbedLyrics = embedToggle ? embedToggle.checked : (localStorage.getItem('am_embed_lyr') !== 'false');
      const saveLyrToggle = document.querySelector('#save-lyrics-toggle');
      const shouldSaveLyricsFile = saveLyrToggle ? saveLyrToggle.checked : (localStorage.getItem('am_save_lyr') !== 'false');

      let finalFile = result.file;
      let lyricsData = null;
      try {
        job.statusText = '正在内嵌官方元数据与歌词...';
        showDownload(id);
        toast('正在内嵌官方元数据、高清封面与歌词...');
        const coverUrl = meta.artwork
          ? meta.artwork.replace('600x600', '1400x1400')
          : (meta.resource?.attributes?.artwork?.url
              ? meta.resource.attributes.artwork.url.replace('{w}', '1400').replace('{h}', '1400').replace('{c}', 'bb').replace('{f}', 'jpg')
              : '');

        const fetchCoverBuf = async () => {
          if (coverUrl) {
            try {
              const res = await fetch(coverUrl);
              if (res.ok) return await res.arrayBuffer();
            } catch (err) {
              console.warn('1400x1400 cover fetch failed, trying standard:', err);
            }
          }
          if (meta.artwork) {
            try {
              const res = await fetch(meta.artwork);
              if (res.ok) return await res.arrayBuffer();
            } catch (err) {
              console.warn('Fallback cover fetch failed:', err);
            }
          }
          return null;
        };

        const [lyrRes, coverBuf] = await Promise.all([
          fetchLyricsData(adamId),
          fetchCoverBuf(),
        ]);
        lyricsData = lyrRes;

        let embedLrcText = '';
        if (shouldEmbedLyrics && lyricsData && lyricsData.hasLyrics) {
          // 若有动态时间轴内嵌 LRC，无动态歌词自动降级为纯文本内嵌
          embedLrcText = lyricsData.isDynamic ? lyricsData.lrc : lyricsData.plain;
        }

        const rawBuf = await result.file.arrayBuffer();
        const taggedBytes = tagMp4(new Uint8Array(rawBuf), {
          title: toSimplified(meta.title),
          artist: normalizeArtistName(meta.artist),
          album: toSimplified(meta.album),
          albumArtist: normalizeArtistName(meta.albumArtist || (meta.artists && meta.artists[0]?.name) || meta.artist),
          date: meta.releaseDate,
          genre: meta.genre,
          composer: normalizeArtistName(meta.composer),
          copyright: meta.copyright || meta.resource?.attributes?.copyright,
          trackNumber: meta.trackNumber || meta.resource?.attributes?.trackNumber,
          totalTracks: meta.totalTracks,
          discNumber: meta.discNumber || meta.resource?.attributes?.discNumber,
          totalDiscs: meta.totalDiscs || 1,
          lyrics: embedLrcText,
          cover: coverBuf ? new Uint8Array(coverBuf) : null,
        });
        finalFile = new Blob([taggedBytes], { type: 'audio/mp4' });
      } catch (tagErr) {
        console.error('Tagging error:', tagErr);
      }

      saveResult({ file: finalFile, dispose: result.dispose }, standardM4aName);

      // 可选保存独立外挂歌词文件（无歌词则跳过）
      if (shouldSaveLyricsFile && lyricsData && lyricsData.hasLyrics) {
        if (lyricsFormat === 'ttml' && lyricsData.ttml) {
          downloadLyricsFile(lyricsData.ttml, 'ttml', meta.artist, meta.title);
        } else if (lyricsData.lrc) {
          downloadLyricsFile(lyricsData.lrc, 'lrc', meta.artist, meta.title);
        }
      }

      toast(t('dl.done', { size: formatSize(finalFile.size || result.size) }));
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
          const data = await fetchLyricsData(adamId);
          if (!data || !data.hasLyrics) { toast('暂无歌词或此曲为纯音乐'); return; }
          const fmt = lyricsFormatSelect ? lyricsFormatSelect.value : (localStorage.getItem('am_lyrics_fmt') || 'lrc');
          if (fmt === 'ttml' && data.ttml) {
            downloadLyricsFile(data.ttml, 'ttml', meta.artist, meta.title);
          } else {
            downloadLyricsFile(data.lrc, 'lrc', meta.artist, meta.title);
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

  // 经服务端 /amp 代理请求 amp-api 的 songs 资源，智能根据歌曲语言与用户偏好返回最原生、最高质量的元数据
  async function lookupMeta() {
    const preferredStorefront = (window.AmI18n?.storefront || '').toLowerCase();
    const candidateRegions = [...new Set([preferredStorefront, country, 'jp', 'cn', 'us'].filter((c) => /^[a-z]{2}$/.test(c)))];

    let rawSong = null;
    let resolvedCountry = country || 'us';

    for (const cc of candidateRegions) {
      try {
        const url = new URL(`/amp/v1/catalog/${cc}/songs/${adamId}`, location.origin);
        url.searchParams.set('include', 'albums,artists');
        const l = await AmI18n.catalogLang(cc);
        if (l) url.searchParams.set('l', l);
        let res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.status === 400 && url.searchParams.has('l')) {
          url.searchParams.delete('l');
          res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        }
        if (!res.ok) continue;
        const song = (await res.json()).data?.[0];
        if (song?.attributes) {
          rawSong = song;
          resolvedCountry = cc;
          break;
        }
      } catch {}
    }

    if (!rawSong) return {};

    const attr = rawSong.attributes;
    const audioLocale = (attr.audioLocale || '').toLowerCase();
    const genreList = attr.genreNames || [];
    const isJapanese = audioLocale === 'ja' || genreList.some((g) => /j-pop|japanese|anime|アニメ/i.test(g));
    const isChinese = audioLocale.startsWith('zh') || /[\u4e00-\u9fa5]/.test((attr.name || '') + (attr.artistName || ''));

    // 1. 日文歌逻辑：像日区（JP storefront）一样，保持日文原貌（假名/日文汉字），绝不要欧美区罗马音
    if (isJapanese && resolvedCountry !== 'jp') {
      try {
        const jpUrl = new URL(`/amp/v1/catalog/jp/songs/${adamId}`, location.origin);
        jpUrl.searchParams.set('include', 'albums,artists');
        jpUrl.searchParams.set('l', 'ja');
        const jpRes = await fetch(jpUrl, { signal: AbortSignal.timeout(6000) });
        if (jpRes.ok) {
          const jpSong = (await jpRes.json()).data?.[0];
          if (jpSong?.attributes) {
            rawSong = jpSong;
            resolvedCountry = 'jp';
          }
        }
      } catch {}
    }
    // 2. 中文歌逻辑：优先向 cn 区或传入 zh-Hans-CN 获得简体中文官方元数据
    else if (isChinese) {
      try {
        const cnTarget = resolvedCountry === 'us' ? 'cn' : resolvedCountry;
        const cnUrl = new URL(`/amp/v1/catalog/${cnTarget}/songs/${adamId}`, location.origin);
        cnUrl.searchParams.set('include', 'albums,artists');
        cnUrl.searchParams.set('l', 'zh-Hans-CN');
        const cnRes = await fetch(cnUrl, { signal: AbortSignal.timeout(6000) });
        if (cnRes.ok) {
          const cnSong = (await cnRes.json()).data?.[0];
          if (cnSong?.attributes) {
            rawSong = cnSong;
          }
        }
      } catch {}
    }

    const a = rawSong.attributes;
    const albumAttr = rawSong.relationships?.albums?.data?.[0]?.attributes;
    const simplifyIfChinese = (str) => (isChinese ? toSimplified(str || '') : (str || ''));

    return {
      country: resolvedCountry,
      audioLocale,
      isJapanese,
      isChinese,
      title: simplifyIfChinese(a.name || ''),
      artist: normalizeArtistName(a.artistName || ''),
      album: simplifyIfChinese(a.albumName || ''),
      albumArtist: normalizeArtistName(a.albumArtistName || albumAttr?.artistName || a.artistName || ''),
      albumId: rawSong.relationships?.albums?.data?.[0]?.id || '',
      trackNumber: a.trackNumber || 1,
      totalTracks: albumAttr?.trackCount || 0,
      discNumber: a.discNumber || 1,
      totalDiscs: 1,
      composer: normalizeArtistName(a.composerName || ''),
      copyright: simplifyIfChinese(albumAttr?.copyright || ''),
      artists: (rawSong.relationships?.artists?.data || []).filter((r) => r.attributes?.name).map((r) => ({
        name: normalizeArtistName(r.attributes.name),
        href: artistPath(r, resolvedCountry),
      })),
      artwork: a.artwork?.url ? a.artwork.url.replace('{w}', 600).replace('{h}', 600).replace('{c}', 'bb').replace('{f}', 'jpg') : '',
      genre: a.genreNames?.[0] || '',
      releaseDate: a.releaseDate || '',
      durationMs: a.durationInMillis,
      explicit: a.contentRating === 'explicit',
      url: a.url || '',
      resource: rawSong,
    };
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

  async function loadMeta() {
    // 快速切换语言时只采用最后一次请求的结果；离开页面后不再改标题
    const seq = ++metaSeq;
    const result = await lookupMeta();
    if (seq !== metaSeq || signal.aborted) return;
    // 切换语言后重新获取失败时保留已有信息
    if (metaLoaded && !result.title) return;
    meta = result;
    metaLoaded = true;
    renderMeta();
    libraryToggle.refresh();
    favoriteToggle.refresh();
    playlistBtn.disabled = !meta.resource;
    if (rows.size) renderVariants(); // 下载文件名需要歌名
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
    if (adamId) loadMeta();
    if (variants.length) {
      variants.forEach((v) => { v.info = describe(v); });
      renderVariants();
    }
    renderAlert();
  });

  if (!adamId) {
    showAlert('error', () => t('song.badId'));
  } else {
    loadMeta();
    loadVariants();
    AmDecrypt.collectGarbage();
  }
  // 离开页面：删除已保存下载的临时文件（进行中的下载继续，完成后照常保存）
  signal.addEventListener('abort', disposeSaved, { once: true });
}
