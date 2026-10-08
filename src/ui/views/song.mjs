// 歌曲页（/https://music.apple.com/{cc}/song/{slug}/{id}），由 app.mjs 挂载
import { createActions, targetOf } from './actions.mjs';

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
    const typeBytes = new TextEncoder().encode(type);
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
    return createDataAtom(name, 1, new TextEncoder().encode(text));
  }

  function createTrackAtom(trackNum, totalTracks = 0) {
    const buf = new Uint8Array(8);
    const v = new DataView(buf.buffer);
    v.setUint16(2, Number(trackNum) || 0, false);
    v.setUint16(4, Number(totalTracks) || 0, false);
    return createDataAtom('trkn', 0, buf);
  }

  function createDiscAtom(discNum, totalDiscs = 0) {
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
    let offset = 0;
    while (offset + 8 <= mp4Bytes.length) {
      const size = dv.getUint32(offset, false);
      const type = String.fromCharCode(...mp4Bytes.subarray(offset + 4, offset + 8));
      if (type === 'moov') {
        moovOffset = offset;
        moovSize = size;
        break;
      }
      if (size === 0) break;
      offset += size;
    }
    if (moovOffset === -1) return mp4Bytes;

    const moovBytes = new Uint8Array(mp4Bytes.subarray(moovOffset, moovOffset + moovSize));
    const moovView = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);

    let ilstOffsetInMoov = -1;
    let oldIlstSize = 0;
    for (let i = 0; i <= moovBytes.length - 8; i++) {
      const type = String.fromCharCode(...moovBytes.subarray(i + 4, i + 8));
      if (type === 'ilst') {
        ilstOffsetInMoov = i;
        oldIlstSize = moovView.getUint32(i, false);
        break;
      }
    }
    if (ilstOffsetInMoov === -1) return mp4Bytes;

    const delta = fullNewIlst.length - oldIlstSize;

    let metaOffsetInMoov = -1;
    let udtaOffsetInMoov = -1;
    for (let i = ilstOffsetInMoov - 8; i >= 0; i--) {
      const type = String.fromCharCode(...moovBytes.subarray(i + 4, i + 8));
      if (type === 'meta' && metaOffsetInMoov === -1) {
        metaOffsetInMoov = i;
      }
      if (type === 'udta' && udtaOffsetInMoov === -1 && metaOffsetInMoov !== -1) {
        udtaOffsetInMoov = i;
        break;
      }
    }

    if (udtaOffsetInMoov !== -1) {
      const oldUdtaSize = moovView.getUint32(udtaOffsetInMoov, false);
      moovView.setUint32(udtaOffsetInMoov, oldUdtaSize + delta, false);
    }
    if (metaOffsetInMoov !== -1) {
      const oldMetaSize = moovView.getUint32(metaOffsetInMoov, false);
      moovView.setUint32(metaOffsetInMoov, oldMetaSize + delta, false);
    }
    const oldMoovSize = moovView.getUint32(0, false);
    moovView.setUint32(0, oldMoovSize + delta, false);

    for (let i = 0; i <= moovBytes.length - 8; i++) {
      const type = String.fromCharCode(...moovBytes.subarray(i + 4, i + 8));
      if (type === 'stco') {
        const entryCount = moovView.getUint32(i + 12, false);
        let entryPos = i + 16;
        for (let c = 0; c < entryCount; c++) {
          const chunkOff = moovView.getUint32(entryPos, false);
          moovView.setUint32(entryPos, chunkOff + delta, false);
          entryPos += 4;
        }
      } else if (type === 'co64') {
        const entryCount = moovView.getUint32(i + 12, false);
        let entryPos = i + 16;
        for (let c = 0; c < entryCount; c++) {
          const chunkOff = moovView.getBigUint64(entryPos, false);
          moovView.setBigUint64(entryPos, chunkOff + BigInt(delta), false);
          entryPos += 8;
        }
      }
    }

    const partBeforeIlst = moovBytes.subarray(0, ilstOffsetInMoov);
    const partAfterIlst = moovBytes.subarray(ilstOffsetInMoov + oldIlstSize);
    const newMoov = new Uint8Array(partBeforeIlst.length + fullNewIlst.length + partAfterIlst.length);
    newMoov.set(partBeforeIlst, 0);
    newMoov.set(fullNewIlst, partBeforeIlst.length);
    newMoov.set(partAfterIlst, partBeforeIlst.length + fullNewIlst.length);

    const partBeforeMoov = mp4Bytes.subarray(0, moovOffset);
    const partAfterMoov = mp4Bytes.subarray(moovOffset + moovSize);
    const out = new Uint8Array(partBeforeMoov.length + newMoov.length + partAfterMoov.length);
    out.set(partBeforeMoov, 0);
    out.set(newMoov, partBeforeMoov.length);
    out.set(partAfterMoov, partBeforeMoov.length + newMoov.length);
    return out;
  }

  const T_CHARS = "\u346f\u3473\u3476\u34e8\u361a\u3704\u370f\u380f\u396e\u3a5c\u3a73\u3a75\u407b\u40ee\u42b7\u42d9\u42da\u42f9\u42fb\u4366\u43b1\u4661\u4700\u477c\u4947\u4951\u4971\u499b\u499f\u4bc0\u4c3e\u4c77\u4c7d\u4c81\u4c98\u4d09\u4e1f\u4e26\u4e7e\u4e82\u4e99\u4e9e\u4f47\u4f48\u4f54\u4f75\u4f86\u4f96\u4fb6\u4fb7\u4fc1\u4fc2\u4fd4\u4fe0\u4fe5\u4fec\u5000\u5006\u5008\u5009\u500b\u5011\u5016\u502b\u5032\u5049\u5051\u5074\u5075\u507d\u508c\u5091\u5096\u5098\u5099\u50a2\u50ad\u50af\u50b3\u50b4\u50b5\u50b7\u50be\u50c2\u50c5\u50c9\u50d1\u50d5\u50de\u50e5\u50e8\u50f1\u50f9\u5100\u5101\u5102\u5104\u5108\u5109\u510e\u5110\u5114\u5115\u5118\u511f\u512a\u5132\u5137\u5138\u513a\u513b\u513c\u5147\u514c\u5152\u5157\u5167\u5169\u518a\u5191\u51aa\u51c8\u51cd\u51dc\u51f1\u5225\u522a\u5244\u5247\u524b\u524e\u5257\u525b\u525d\u526e\u5274\u5275\u5277\u5283\u5284\u5287\u5289\u528a\u528c\u528d\u528f\u5291\u529a\u52c1\u52d5\u52d9\u52db\u52dd\u52de\u52e2\u52e9\u52f1\u52f3\u52f5\u52f8\u52fb\u532d\u532f\u5331\u5340\u5354\u5379\u537b\u537d\u5399\u53a0\u53a4\u53ad\u53b2\u53b4\u53c3\u53c4\u53e2\u5412\u5433\u5436\u5442\u54bc\u54e1\u5504\u5538\u554f\u5553\u555e\u555f\u5562\u558e\u559a\u55aa\u55ab\u55ac\u55ae\u55b2\u55c6\u55c7\u55ca\u55ce\u55da\u55e9\u55f6\u5606\u560d\u5613\u5614\u5616\u5617\u561c\u5629\u562e\u562f\u5630\u5635\u5638\u563d\u5641\u5653\u565a\u565d\u5660\u5665\u5666\u566f\u5672\u5674\u5678\u5679\u5680\u5687\u568c\u5690\u5695\u5699\u56a5\u56a6\u56a8\u56ae\u56b2\u56b3\u56b4\u56b6\u56c0\u56c1\u56c2\u56c5\u56c8\u56c9\u56cc\u56d1\u56ea\u5707\u570b\u570d\u5712\u5713\u5716\u5718\u57bb\u57e1\u57f0\u57f7\u5805\u580a\u5816\u581d\u582f\u5831\u5834\u584a\u584b\u584f\u5852\u5857\u585a\u5862\u5864\u5875\u5879\u588a\u589c\u58ae\u58b0\u58b3\u58b6\u58bb\u58be\u58c7\u58cb\u58ce\u58d3\u58d8\u58d9\u58da\u58dc\u58de\u58df\u58e0\u58e2\u58e9\u58ea\u58ef\u58fa\u58fc\u58fd\u5920\u5922\u5925\u593e\u5950\u5967\u5969\u596a\u596c\u596e\u597c\u599d\u59cd\u59e6\u5a1b\u5a41\u5a66\u5a6d\u5aa7\u5aaf\u5ab0\u5abc\u5abd\u5acb\u5ad7\u5af5\u5afa\u5afb\u5aff\u5b00\u5b03\u5b08\u5b0b\u5b0c\u5b19\u5b21\u5b24\u5b2a\u5b30\u5b38\u5b43\u5b4b\u5b4c\u5b6b\u5b78\u5b7f\u5bae\u5bc0\u5be2\u5be6\u5be7\u5be9\u5beb\u5bec\u5bf5\u5bf6\u5c07\u5c08\u5c0b\u5c0d\u5c0e\u5c37\u5c46\u5c4d\u5c53\u5c5c\u5c62\u5c64\u5c68\u5c6c\u5ca1\u5cef\u5cf4\u5cf6\u5cfd\u5d0d\u5d11\u5d17\u5d19\u5d22\u5d2c\u5d50\u5d57\u5d7e\u5d81\u5d84\u5d87\u5d94\u5d97\u5da0\u5da2\u5da7\u5da8\u5dae\u5db8\u5dba\u5dbc\u5dbd\u5dcb\u5dd2\u5dd4\u5dd6\u5df0\u5df9\u5e25\u5e2b\u5e33\u5e36\u5e40\u5e43\u5e53\u5e57\u5e58\u5e5f\u5e63\u5e6b\u5e6c\u5e77\u5e79\u5e7e\u5eab\u5ec1\u5ec2\u5ec4\u5ec8\u5ece\u5ed5\u5eda\u5edd\u5edf\u5ee0\u5ee1\u5ee2\u5ee3\u5ee9\u5eec\u5ef3\u5f12\u5f14\u5f33\u5f35\u5f37\u5f46\u5f48\u5f4c\u5f4e\u5f54\u5f59\u5f60\u5f65\u5f6b\u5f72\u5f7f\u5f8c\u5f91\u5f9e\u5fa0\u5fa9\u5fb5\u5fb9\u6046\u6065\u6085\u609e\u60b5\u60b6\u60bd\u60e1\u60f1\u60f2\u60fb\u611b\u611c\u6128\u6134\u6137\u613e\u6144\u614b\u614d\u6158\u615a\u615f\u6163\u6164\u616a\u616b\u616e\u6173\u6176\u617a\u617c\u617e\u6182\u618a\u6190\u6191\u6192\u6196\u619a\u61a4\u61ab\u61ae\u61b2\u61b6\u61c7\u61c9\u61cc\u61cd\u61de\u61df\u61e3\u61e4\u61e8\u61f2\u61f6\u61f7\u61f8\u61fa\u61fc\u61fe\u6200\u6207\u6214\u6227\u6229\u6230\u6231\u6232\u6236\u625e\u62cb\u62da\u6329\u6331\u633e\u6368\u636b\u6371\u6372\u6383\u6384\u6386\u6397\u6399\u639b\u63a1\u63c0\u63da\u63db\u63ee\u63ef\u640d\u6416\u6417\u6427\u6435\u6436\u6451\u645c\u645f\u646f\u6473\u6476\u647a\u647b\u6488\u648f\u6490\u6493\u649d\u649f\u64a3\u64a5\u64ab\u64b2\u64b3\u64bb\u64be\u64bf\u64c1\u64c4\u64c7\u64ca\u64cb\u64d3\u64d4\u64da\u64e0\u64e1\u64e3\u64ec\u64ef\u64f0\u64f1\u64f2\u64f4\u64f7\u64fa\u64fb\u64fc\u64fd\u64fe\u6504\u6506\u650f\u6514\u6516\u6519\u651b\u651c\u651d\u6522\u6523\u6524\u652a\u652c\u654e\u6553\u6557\u6558\u6575\u6578\u6582\u6583\u6586\u6595\u65ac\u65b7\u65bc\u65c2\u65e3\u6607\u6642\u6649\u665d\u6688\u6689\u6698\u66a2\u66ab\u66c4\u66c6\u66c7\u66c9\u66cf\u66d6\u66e0\u66e8\u66ec\u66f8\u6703\u6727\u672e\u6771\u67b4\u67f5\u67fa\u67fb\u687f\u6894\u6898\u689d\u689f\u68b2\u68c4\u68ca\u68d6\u68d7\u68df\u68e1\u68e7\u68f2\u68f6\u690f\u6932\u694a\u6953\u6968\u696d\u6975\u6998\u69a6\u69aa\u69ae\u69b2\u69bf\u69cb\u69cd\u69d3\u69e4\u69e7\u69e8\u69ee\u69f3\u69f6\u69fc\u6a01\u6a02\u6a05\u6a11\u6a13\u6a19\u6a1e\u6a22\u6a23\u6a27\u6a2b\u6a33\u6a38\u6a39\u6a3a\u6a3f\u6a48\u6a4b\u6a5f\u6a62\u6a6b\u6a81\u6a89\u6a94\u6a9c\u6a9f\u6aa2\u6aa3\u6aae\u6aaf\u6ab3\u6ab8\u6abb\u6ac3\u6ad3\u6ada\u6adb\u6add\u6ade\u6adf\u6ae5\u6ae7\u6ae8\u6aea\u6aeb\u6aec\u6af1\u6af3\u6af8\u6afb\u6b04\u6b05\u6b0a\u6b0f\u6b12\u6b16\u6b1e\u6b3d\u6b4e\u6b50\u6b5f\u6b61\u6b72\u6b77\u6b78\u6b7f\u6b98\u6b9e\u6ba4\u6ba8\u6bab\u6bad\u6bae\u6baf\u6bb0\u6bb2\u6bba\u6bbb\u6bbc\u6bc0\u6bc6\u6bff\u6c02\u6c08\u6c0c\u6c23\u6c2b\u6c2c\u6c33\u6c3e\u6c4e\u6c59\u6c7a\u6c92\u6c96\u6cc1\u6cdd\u6d29\u6d36\u6d79\u6d87\u6d97\u6dbc\u6dd2\u6dda\u6de5\u6de8\u6de9\u6dea\u6df5\u6df6\u6dfa\u6e19\u6e1b\u6e22\u6e26\u6e2c\u6e3e\u6e4a\u6e5e\u6e67\u6e6f\u6e88\u6e96\u6e9d\u6eab\u6eae\u6eb3\u6ebc\u6ec4\u6ec5\u6ecc\u6ece\u6ed9\u6eec\u6eef\u6ef2\u6ef7\u6ef8\u6efb\u6efe\u6eff\u6f01\u6f0a\u6f1a\u6f22\u6f23\u6f2c\u6f32\u6f35\u6f38\u6f3f\u6f41\u6f51\u6f54\u6f59\u6f5a\u6f5b\u6f64\u6f6f\u6f70\u6f77\u6f7f\u6f80\u6f86\u6f87\u6f90\u6f97\u6fa0\u6fa4\u6fa6\u6fa9\u6fae\u6fb1\u6fbe\u6fc1\u6fc3\u6fc4\u6fd5\u6fd8\u6fda\u6fdb\u6fdc\u6fdf\u6fe4\u6fe7\u6feb\u6ff0\u6ff1\u6ffa\u6ffc\u6ffe\u7002\u7005\u7006\u7007\u7009\u700b\u700f\u7015\u7018\u701d\u701f\u7020\u7026\u7027\u7028\u7030\u7032\u703e\u7043\u7044\u7051\u7055\u7058\u705d\u7061\u7063\u7064\u7067\u7069\u707d\u70ba\u70cf\u70f4\u7121\u7149\u7152\u7159\u7162\u7165\u7169\u716c\u7171\u7185\u7192\u7197\u71b1\u71b2\u71be\u71c1\u71c8\u71c9\u71d2\u71d9\u71dc\u71df\u71e6\u71ec\u71ed\u71f4\u71f6\u71fb\u71fc\u71fe\u720d\u7210\u721b\u722d\u7232\u723a\u723e\u7240\u7246\u7258\u7274\u727d\u7296\u729b\u72a2\u72a7\u72c0\u72f9\u72fd\u7319\u7336\u733b\u7341\u7343\u7344\u7345\u734e\u7368\u736a\u736b\u736e\u7370\u7371\u7372\u7375\u7377\u7378\u737a\u737b\u737c\u7380\u73fe\u7431\u743a\u743f\u744b\u7452\u7463\u7464\u7469\u746a\u7472\u7489\u74a1\u74a3\u74a6\u74ab\u74af\u74b0\u74b5\u74b8\u74bd\u74bf\u74ca\u74cf\u74d4\u74da\u750c\u7515\u7522\u7523\u755d\u7562\u756b\u7570\u7575\u7576\u7587\u758a\u75d9\u75e0\u75fe\u7602\u760b\u760d\u7613\u761e\u7621\u7627\u762e\u7632\u763a\u763b\u7642\u7646\u7647\u7649\u7652\u7658\u765f\u7661\u7662\u7664\u7665\u7667\u7669\u766c\u766d\u766e\u7670\u7671\u7672\u767c\u7681\u769a\u76b0\u76b8\u76ba\u76c3\u76dc\u76de\u76e1\u76e3\u76e4\u76e7\u76ea\u771e\u7725\u773e\u774f\u775c\u775e\u7798\u779c\u779e\u77b6\u77bc\u77c7\u77d3\u77da\u77ef\u7843\u785c\u7864\u7868\u786f\u7895\u78a9\u78ad\u78b8\u78ba\u78bc\u78bd\u78d1\u78da\u78e0\u78e3\u78e7\u78ef\u78fd\u78fe\u7904\u790e\u7919\u7926\u792a\u792b\u792c\u7931\u7955\u797f\u798d\u798e\u7995\u79a1\u79a6\u79aa\u79ae\u79b0\u79b1\u79bf\u79c8\u7a05\u7a08\u7a0f\u7a1c\u7a1f\u7a2e\u7a31\u7a40\u7a47\u7a4c\u7a4d\u7a4e\u7a60\u7a61\u7a62\u7a69\u7a6b\u7a6d\u7aa9\u7aaa\u7aae\u7aaf\u7ab5\u7ab6\u7aba\u7ac4\u7ac5\u7ac7\u7ac8\u7aca\u7aea\u7af6\u7b46\u7b4d\u7b67\u7b74\u7b87\u7b8b\u7b8f\u7b9a\u7bc0\u7bc4\u7bc9\u7bcb\u7bd4\u7be0\u7be4\u7be9\u7bf3\u7c00\u7c0d\u7c11\u7c1e\u7c21\u7c23\u7c2b\u7c39\u7c3d\u7c3e\u7c43\u7c4c\u7c54\u7c59\u7c5b\u7c5c\u7c5f\u7c60\u7c64\u7c69\u7c6a\u7c6c\u7c6e\u7c72\u7cb5\u7cc9\u7cdd\u7cde\u7ce7\u7cf0\u7cf2\u7cf4\u7cf6\u7cf9\u7cfe\u7d00\u7d02\u7d04\u7d05\u7d06\u7d07\u7d08\u7d09\u7d0b\u7d0d\u7d10\u7d13\u7d14\u7d15\u7d16\u7d17\u7d18\u7d19\u7d1a\u7d1b\u7d1c\u7d1d\u7d21\u7d2c\u7d2e\u7d30\u7d31\u7d32\u7d33\u7d35\u7d39\u7d3a\u7d3c\u7d3f\u7d40\u7d42\u7d43\u7d44\u7d45\u7d46\u7d4e\u7d50\u7d55\u7d5b\u7d5d\u7d5e\u7d61\u7d62\u7d66\u7d68\u7d70\u7d71\u7d72\u7d73\u7d76\u7d79\u7d81\u7d83\u7d86\u7d88\u7d89\u7d8c\u7d8f\u7d90\u7d91\u7d93\u7d9c\u7d9e\u7da0\u7da2\u7da3\u7dab\u7dac\u7dad\u7daf\u7db0\u7db1\u7db2\u7db3\u7db4\u7db5\u7db8\u7db9\u7dba\u7dbb\u7dbd\u7dbe\u7dbf\u7dc4\u7dc7\u7dca\u7dcb\u7dd1\u7dd2\u7dd3\u7dd4\u7dd7\u7dd8\u7dd9\u7dda\u7ddd\u7dde\u7de0\u7de1\u7de3\u7de6\u7de8\u7de9\u7dec\u7def\u7df1\u7df2\u7df4\u7df6\u7df9\u7dfb\u7dfc\u7e08\u7e09\u7e0a\u7e0b\u7e10\u7e11\u7e15\u7e17\u7e1b\u7e1d\u7e1e\u7e1f\u7e23\u7e27\u7e2b\u7e2d\u7e2e\u7e31\u7e32\u7e33\u7e34\u7e35\u7e36\u7e37\u7e39\u7e3d\u7e3e\u7e43\u7e45\u7e46\u7e52\u7e54\u7e55\u7e5a\u7e5e\u7e61\u7e62\u7e69\u7e6a\u7e6b\u7e6d\u7e6e\u7e6f\u7e70\u7e73\u7e78\u7e79\u7e7c\u7e7d\u7e7e\u7e7f\u7e87\u7e88\u7e8a\u7e8c\u7e8d\u7e8f\u7e93\u7e94\u7e96\u7e98\u7e9c\u7f3d\u7f43\u7f48\u7f4c\u7f4e\u7f70\u7f75\u7f77\u7f85\u7f86\u7f88\u7f8b\u7fa3\u7fa5\u7fa8\u7fa9\u7fb6\u7fd2\u7feb\u7fec\u7ff9\u7ffd\u802c\u802e\u8056\u805e\u806f\u8070\u8072\u8073\u8075\u8076\u8077\u8079\u807d\u807e\u8085\u8105\u8108\u811b\u8123\u8129\u812b\u8139\u814e\u8156\u8161\u8166\u816b\u8173\u8178\u8183\u8195\u819a\u819e\u81a0\u81a9\u81bd\u81be\u81bf\u81c9\u81cd\u81cf\u81d8\u81da\u81df\u81e0\u81e2\u81e5\u81e8\u81fa\u8207\u8208\u8209\u820a\u8216\u8218\u8259\u8264\u8266\u826b\u8271\u8277\u82bb\u82e7\u8332\u834a\u838a\u8396\u83a2\u83a7\u83ef\u83f4\u83f8\u8407\u840a\u842c\u8434\u8435\u8449\u8452\u8464\u8466\u846f\u8477\u8490\u8493\u8494\u8495\u849e\u84bc\u84c0\u84c6\u84cb\u84ee\u84ef\u84f4\u84fd\u8514\u8518\u851e\u8523\u8525\u8526\u852d\u8541\u8546\u854e\u8552\u8553\u8555\u8558\u8562\u8569\u856a\u856d\u8577\u8580\u8588\u858a\u858c\u8591\u8594\u8598\u859f\u85a6\u85a9\u85b4\u85b5\u85b9\u85ba\u85cd\u85ce\u85dd\u85e5\u85ea\u85ed\u85f4\u85f6\u85f9\u85fa\u8600\u8604\u8606\u8607\u860a\u860b\u861a\u861e\u8622\u862d\u863a\u863f\u8646\u8655\u865b\u865c\u865f\u8667\u866f\u86fa\u86fb\u8706\u8755\u875f\u8766\u8768\u8778\u8784\u879e\u87a2\u87ae\u87bb\u87bf\u87c4\u87c8\u87ce\u87e3\u87ec\u87ef\u87f2\u87f6\u87fb\u8801\u8805\u8806\u880d\u8810\u8811\u8814\u881f\u8823\u8828\u8831\u8836\u883b\u8846\u884a\u8853\u8855\u885a\u885b\u885d\u889e\u88b7\u88ca\u88cf\u88dc\u88dd\u88e1\u88fd\u8907\u890c\u8918\u8932\u8933\u8938\u893b\u8947\u8949\u894f\u8956\u895d\u8960\u8964\u896a\u896c\u896f\u8972\u8974\u8988\u898b\u898e\u898f\u8993\u8996\u8998\u89a1\u89a5\u89a6\u89aa\u89ac\u89af\u89b2\u89b7\u89ba\u89bd\u89bf\u89c0\u89f4\u89f6\u89f8\u8a01\u8a02\u8a03\u8a08\u8a0a\u8a0c\u8a0e\u8a10\u8a12\u8a13\u8a15\u8a16\u8a17\u8a18\u8a1b\u8a1d\u8a1f\u8a22\u8a23\u8a25\u8a29\u8a2a\u8a2d\u8a31\u8a34\u8a36\u8a3a\u8a3b\u8a3c\u8a41\u8a46\u8a4e\u8a50\u8a52\u8a54\u8a55\u8a56\u8a57\u8a58\u8a5b\u8a5e\u8a60\u8a61\u8a62\u8a63\u8a66\u8a69\u8a6b\u8a6c\u8a6d\u8a6e\u8a70\u8a71\u8a72\u8a73\u8a75\u8a7c\u8a7f\u8a84\u8a85\u8a86\u8a87\u8a8c\u8a8d\u8a91\u8a92\u8a95\u8a98\u8a9a\u8a9e\u8aa0\u8aa1\u8aa3\u8aa4\u8aa5\u8aa6\u8aa8\u8aaa\u8aac\u8ab0\u8ab2\u8ab6\u8ab9\u8abc\u8abe\u8abf\u8ac2\u8ac4\u8ac7\u8ac9\u8acb\u8acd\u8acf\u8ad1\u8ad2\u8ad6\u8ad7\u8adb\u8adc\u8add\u8ade\u8ae1\u8ae2\u8ae4\u8ae6\u8ae7\u8aeb\u8aed\u8aee\u8af1\u8af3\u8af6\u8af7\u8af8\u8afa\u8afc\u8afe\u8b00\u8b01\u8b02\u8b04\u8b05\u8b0a\u8b0e\u8b10\u8b14\u8b16\u8b17\u8b19\u8b1a\u8b1b\u8b1d\u8b20\u8b21\u8b28\u8b2b\u8b2c\u8b2d\u8b33\u8b39\u8b3e\u8b41\u8b49\u8b4e\u8b4f\u8b56\u8b58\u8b59\u8b5a\u8b5c\u8b5f\u8b6b\u8b6d\u8b6f\u8b70\u8b74\u8b77\u8b78\u8b7d\u8b7e\u8b80\u8b85\u8b8a\u8b8b\u8b8c\u8b8e\u8b92\u8b93\u8b95\u8b96\u8b9a\u8b9c\u8b9e\u8c3f\u8c48\u8c4e\u8c50\u8c54\u8c6c\u8c76\u8c8d\u8c93\u8c99\u8c9d\u8c9e\u8c9f\u8ca0\u8ca1\u8ca2\u8ca7\u8ca8\u8ca9\u8caa\u8cab\u8cac\u8caf\u8cb0\u8cb2\u8cb3\u8cb4\u8cb6\u8cb7\u8cb8\u8cba\u8cbb\u8cbc\u8cbd\u8cbf\u8cc0\u8cc1\u8cc2\u8cc3\u8cc4\u8cc5\u8cc7\u8cc8\u8cca\u8cd1\u8cd2\u8cd3\u8cd5\u8cd9\u8cda\u8cdc\u8cde\u8ce0\u8ce1\u8ce2\u8ce3\u8ce4\u8ce6\u8ce7\u8cea\u8ceb\u8cec\u8ced\u8cf0\u8cf4\u8cf5\u8cfa\u8cfb\u8cfc\u8cfd\u8cfe\u8d04\u8d05\u8d07\u8d08\u8d0a\u8d0b\u8d0d\u8d0f\u8d10\u8d13\u8d14\u8d16\u8d17\u8d1b\u8d1c\u8d6c\u8d95\u8d99\u8da8\u8db2\u8de1\u8e10\u8e30\u8e34\u8e4c\u8e55\u8e5f\u8e60\u8e63\u8e64\u8e7a\u8e82\u8e89\u8e8a\u8e8b\u8e8d\u8e8e\u8e91\u8e92\u8e93\u8e95\u8e9a\u8ea1\u8ea5\u8ea6\u8eaa\u8ec0\u8eca\u8ecb\u8ecc\u8ecd\u8ed1\u8ed2\u8ed4\u8edb\u8edf\u8ee4\u8eeb\u8ef2\u8ef8\u8ef9\u8efa\u8efb\u8efc\u8efe\u8f03\u8f05\u8f07\u8f08\u8f09\u8f0a\u8f12\u8f13\u8f14\u8f15\u8f1b\u8f1c\u8f1d\u8f1e\u8f1f\u8f25\u8f26\u8f29\u8f2a\u8f2c\u8f2f\u8f33\u8f38\u8f3b\u8f3c\u8f3e\u8f3f\u8f40\u8f42\u8f44\u8f45\u8f46\u8f49\u8f4d\u8f4e\u8f54\u8f5f\u8f61\u8f62\u8f64\u8fa6\u8fad\u8fae\u8faf\u8fb2\u8ff4\u9015\u9019\u9023\u9031\u9032\u904a\u904b\u904e\u9054\u9055\u9059\u905c\u905e\u9060\u9061\u9069\u9072\u9076\u9077\u9078\u907a\u907c\u9081\u9084\u9087\u908a\u908f\u9090\u90df\u90f5\u9106\u9109\u9112\u9114\u9116\u9127\u912d\u9130\u9132\u9134\u9136\u913a\u9147\u9148\u9183\u9196\u919c\u919e\u919f\u91a3\u91ab\u91ac\u91b1\u91c0\u91c1\u91c3\u91c5\u91cb\u91d0\u91d2\u91d3\u91d4\u91d5\u91d7\u91d8\u91d9\u91dd\u91e3\u91e4\u91e6\u91e7\u91e9\u91f5\u91f7\u91f9\u91fa\u91fe\u9200\u9201\u9203\u9204\u9205\u9208\u9209\u920d\u920e\u9210\u9211\u9212\u9214\u9215\u921e\u9221\u9223\u9225\u9226\u9227\u922e\u9230\u9233\u9234\u9237\u9238\u9239\u923a\u923d\u923e\u923f\u9240\u9245\u9246\u9248\u9249\u924b\u924d\u9251\u9255\u9257\u925a\u925b\u925e\u9262\u9264\u9266\u926c\u926d\u9273\u9276\u9278\u927a\u927b\u927f\u9280\u9283\u9285\u928d\u9291\u9293\u9296\u9298\u929a\u929b\u929c\u92a0\u92a3\u92a5\u92a6\u92a8\u92a9\u92aa\u92ab\u92ac\u92b1\u92b3\u92b7\u92b9\u92bb\u92bc\u92c1\u92c3\u92c5\u92c7\u92cc\u92cf\u92d2\u92d9\u92dd\u92df\u92e3\u92e4\u92e5\u92e6\u92e8\u92e9\u92ea\u92ed\u92ee\u92ef\u92f0\u92f1\u92f6\u92f8\u92fc\u9301\u9304\u9306\u9307\u9308\u930f\u9310\u9312\u9315\u9318\u9319\u931a\u931b\u931f\u9320\u9321\u9322\u9326\u9328\u9329\u932b\u932e\u932f\u9332\u9333\u9336\u9338\u933c\u9340\u9341\u9343\u9345\u9346\u9347\u9348\u934a\u934b\u934d\u9354\u9358\u935a\u935b\u9360\u9364\u9365\u9369\u936c\u9370\u9375\u9376\u937a\u937c\u937e\u9382\u9384\u9387\u938a\u938c\u9394\u9396\u9398\u939a\u939b\u93a1\u93a2\u93a3\u93a6\u93a7\u93a9\u93aa\u93ac\u93ad\u93ae\u93b0\u93b2\u93b3\u93b5\u93b6\u93b8\u93bf\u93c3\u93c7\u93c8\u93cc\u93cd\u93d0\u93d1\u93d7\u93d8\u93dc\u93dd\u93de\u93df\u93e1\u93e2\u93e4\u93e8\u93f0\u93f5\u93f7\u93f9\u93fa\u93fd\u9403\u940b\u9410\u9412\u9413\u9414\u9418\u9419\u941d\u9420\u9425\u9426\u9427\u9428\u942b\u942e\u942f\u9432\u9433\u9435\u9436\u9438\u943a\u943f\u9444\u944a\u944c\u9451\u9452\u9454\u9455\u945e\u9460\u9463\u9465\u946d\u9470\u9471\u9472\u9477\u9479\u947c\u947d\u947e\u947f\u9481\u9482\u9577\u9580\u9582\u9583\u9586\u9588\u9589\u958b\u958c\u958e\u958f\u9591\u9592\u9593\u9594\u9598\u95a1\u95a3\u95a4\u95a5\u95a8\u95a9\u95ab\u95ac\u95ad\u95b1\u95b2\u95b6\u95b9\u95bb\u95bc\u95bd\u95be\u95bf\u95c3\u95c6\u95c7\u95c8\u95ca\u95cb\u95cc\u95cd\u95d0\u95d2\u95d3\u95d4\u95d5\u95d6\u95dc\u95de\u95e0\u95e1\u95e2\u95e4\u95e5\u9658\u965d\u965e\u9663\u9670\u9673\u9678\u967d\u9689\u968a\u968e\u9695\u969b\u96a8\u96aa\u96af\u96b1\u96b4\u96b8\u96bb\u96cb\u96d6\u96d9\u96db\u96dc\u96de\u96e2\u96e3\u96f2\u96fb\u9711\u9722\u9727\u973d\u9742\u9744\u9746\u9748\u9749\u975a\u975c\u975d\u9766\u9768\u978f\u979d\u97a6\u97bd\u97c1\u97c3\u97c6\u97c9\u97cb\u97cc\u97cd\u97d3\u97d9\u97dc\u97dd\u97de\u97fb\u97ff\u9801\u9802\u9803\u9805\u9806\u9807\u9808\u980a\u980c\u980e\u980f\u9810\u9811\u9812\u9813\u9817\u9818\u981c\u9821\u9824\u9826\u982d\u982e\u9830\u9832\u9834\u9837\u9838\u9839\u983b\u983d\u9846\u984c\u984d\u984e\u984f\u9852\u9853\u9854\u9858\u9859\u985b\u985e\u9862\u9865\u9867\u986b\u986c\u986f\u9870\u9871\u9873\u9874\u98a8\u98ad\u98ae\u98af\u98b1\u98b3\u98b6\u98b8\u98ba\u98bb\u98bc\u98c0\u98c4\u98c6\u98c8\u98db\u98e0\u98e2\u98e3\u98e5\u98e9\u98ea\u98eb\u98ed\u98ef\u98f1\u98f2\u98f4\u98fc\u98fd\u98fe\u98ff\u9903\u9904\u9905\u9908\u9909\u990a\u990c\u990e\u990f\u9911\u9912\u9913\u9915\u9916\u9918\u991a\u991b\u991c\u991e\u9921\u9928\u992c\u9931\u9933\u9935\u9936\u9937\u993a\u993c\u993e\u993f\u9941\u9943\u9945\u9948\u9949\u994a\u994b\u994c\u9951\u9952\u9957\u995c\u995e\u9962\u99ac\u99ad\u99ae\u99b1\u99b3\u99b4\u99b9\u99c1\u99d0\u99d1\u99d2\u99d4\u99d5\u99d8\u99d9\u99db\u99dd\u99df\u99e1\u99e2\u99ed\u99f0\u99f1\u99f8\u99ff\u9a01\u9a02\u9a05\u9a0c\u9a0d\u9a0e\u9a0f\u9a16\u9a19\u9a24\u9a27\u9a2b\u9a2d\u9a2e\u9a30\u9a36\u9a37\u9a38\u9a3e\u9a40\u9a41\u9a42\u9a43\u9a44\u9a45\u9a4a\u9a4c\u9a4d\u9a4f\u9a55\u9a57\u9a5a\u9a5b\u9a5f\u9a62\u9a64\u9a65\u9a66\u9a6a\u9a6b\u9aaf\u9acf\u9ad2\u9ad4\u9ad5\u9ad6\u9aee\u9b06\u9b0d\u9b1a\u9b22\u9b25\u9b27\u9b28\u9b29\u9b2e\u9b31\u9b39\u9b4e\u9b58\u9b5a\u9b5b\u9b62\u9b68\u9b6f\u9b74\u9b77\u9b7a\u9b81\u9b83\u9b8a\u9b8b\u9b8d\u9b8e\u9b90\u9b91\u9b92\u9b93\u9b9a\u9b9c\u9b9d\u9b9e\u9ba3\u9ba6\u9baa\u9bab\u9bad\u9bae\u9bb3\u9bb6\u9bba\u9bc0\u9bc1\u9bc7\u9bc9\u9bca\u9bd2\u9bd4\u9bd5\u9bd6\u9bd7\u9bdb\u9bdd\u9be1\u9be2\u9be4\u9be7\u9be8\u9bea\u9beb\u9bf0\u9bf4\u9bf7\u9bfd\u9bff\u9c01\u9c02\u9c03\u9c06\u9c08\u9c09\u9c0c\u9c0d\u9c0f\u9c10\u9c12\u9c13\u9c1b\u9c1c\u9c1f\u9c20\u9c23\u9c25\u9c27\u9c28\u9c29\u9c2d\u9c2e\u9c31\u9c32\u9c33\u9c35\u9c37\u9c39\u9c3a\u9c3b\u9c3c\u9c3e\u9c42\u9c45\u9c48\u9c49\u9c52\u9c54\u9c56\u9c57\u9c58\u9c5d\u9c5f\u9c60\u9c63\u9c64\u9c67\u9c68\u9c6d\u9c6f\u9c77\u9c78\u9c7a\u9ce5\u9ce7\u9ce9\u9cec\u9cf2\u9cf3\u9cf4\u9cf6\u9cfe\u9d06\u9d07\u9d09\u9d12\u9d15\u9d1b\u9d1d\u9d1e\u9d1f\u9d23\u9d26\u9d28\u9d2f\u9d30\u9d34\u9d37\u9d3b\u9d3f\u9d41\u9d42\u9d43\u9d50\u9d51\u9d52\u9d53\u9d5c\u9d5d\u9d60\u9d61\u9d6a\u9d6c\u9d6e\u9d6f\u9d70\u9d72\u9d77\u9d7e\u9d84\u9d87\u9d89\u9d8a\u9d93\u9d96\u9d98\u9d9a\u9da1\u9da5\u9da9\u9daa\u9dac\u9daf\u9db2\u9db4\u9db9\u9dba\u9dbb\u9dbc\u9dbf\u9dc0\u9dc1\u9dc2\u9dc4\u9dc9\u9dca\u9dd3\u9dd6\u9dd7\u9dd9\u9dda\u9de5\u9de6\u9deb\u9def\u9df2\u9df3\u9df4\u9df8\u9df9\u9dfa\u9dfd\u9e02\u9e07\u9e0a\u9e0c\u9e0f\u9e15\u9e18\u9e1a\u9e1b\u9e1d\u9e1e\u9e75\u9e79\u9e7a\u9e7c\u9e7d\u9e97\u9ea5\u9ea9\u9eaa\u9eab\u9eaf\u9eb4\u9eb5\u9ebc\u9ebd\u9ec3\u9ecc\u9ede\u9ee8\u9ef2\u9ef4\u9ef6\u9ef7\u9efd\u9eff\u9f02\u9f09\u9f15\u9f34\u9f4a\u9f4b\u9f4e\u9f4f\u9f52\u9f54\u9f55\u9f57\u9f59\u9f5c\u9f5f\u9f60\u9f61\u9f63\u9f66\u9f67\u9f6a\u9f6c\u9f72\u9f76\u9f77\u9f8d\u9f8e\u9f90\u9f91\u9f94\u9f95\u9f9c\u9fc1\u9fd3";
const S_CHARS = "\u3454\u3447\u3439\u523e\u360e\u36af\u36e3\u37c6\u3918\u3a2b\u39d0\u64dc\u4025\u9fce\u4336\u433a\u433b\u433f\u433e\u4360\u43ac\u464c\u4727\u478d\u4982\u9fcf\u497e\u49b6\u49b7\u4bc5\u9c83\u4ca3\u4c9d\u9cda\u9ce4\u9e6e\u4e22\u5e76\u5e72\u4e71\u4e98\u4e9a\u4f2b\u5e03\u5360\u5e76\u6765\u4ed1\u4fa3\u5c40\u4fe3\u7cfb\u4f23\u4fa0\u4f21\u79c1\u4f25\u4fe9\u4feb\u4ed3\u4e2a\u4eec\u5e78\u4f26\u3448\u4f1f\u343d\u4fa7\u4fa6\u4f2a\u3437\u6770\u4f27\u4f1e\u5907\u5bb6\u4f63\u506c\u4f20\u4f1b\u503a\u4f24\u503e\u507b\u4ec5\u4f65\u4fa8\u4ec6\u4f2a\u4fa5\u507e\u96c7\u4ef7\u4eea\u4fca\u4fac\u4ebf\u4fa9\u4fed\u50a4\u50a7\u4fe6\u4faa\u5c3d\u507f\u4f18\u50a8\u4fea\u3469\u50a9\u50a5\u4fe8\u51f6\u5151\u513f\u5156\u5185\u4e24\u518c\u80c4\u5e42\u51c0\u51bb\u51db\u51ef\u522b\u5220\u522d\u5219\u514b\u5239\u522c\u521a\u5265\u5250\u5240\u521b\u94f2\u5212\u672d\u5267\u5218\u523d\u523f\u5251\u34e5\u5242\u3509\u52b2\u52a8\u52a1\u52cb\u80dc\u52b3\u52bf\u52da\u52a2\u52cb\u52b1\u529d\u5300\u5326\u6c47\u532e\u533a\u534f\u6064\u5374\u5373\u538d\u5395\u5386\u538c\u5389\u53a3\u53c2\u53c1\u4e1b\u54a4\u5434\u5450\u5415\u5459\u5458\u5457\u5ff5\u95ee\u542f\u54d1\u542f\u5521\u359e\u5524\u4e27\u5403\u4e54\u5355\u54df\u545b\u556c\u551d\u5417\u545c\u5522\u54d4\u53f9\u55bd\u556f\u5455\u5567\u5c1d\u551b\u54d7\u5520\u5578\u53fd\u54d3\u5452\u5574\u6076\u5618\u358a\u549d\u54d2\u54dd\u54d5\u55f3\u54d9\u55b7\u5428\u5f53\u549b\u5413\u54dc\u5c1d\u565c\u556e\u54bd\u5456\u5499\u5411\u4eb8\u55be\u4e25\u5624\u556d\u55eb\u56a3\u5181\u5453\u5570\u82cf\u5631\u56f1\u56f5\u56fd\u56f4\u56ed\u5706\u56fe\u56e2\u575d\u57ad\u91c7\u6267\u575a\u57a9\u57b4\u57da\u5c27\u62a5\u573a\u5757\u8314\u57b2\u57d8\u6d82\u51a2\u575e\u57d9\u5c18\u5811\u57ab\u5760\u5815\u575b\u575f\u57af\u5899\u57a6\u575b\u57b1\u57d9\u538b\u5792\u5739\u5786\u575b\u574f\u5784\u5785\u575c\u575d\u5846\u58ee\u58f6\u58f8\u5bff\u591f\u68a6\u4f19\u5939\u5942\u5965\u5941\u593a\u5956\u594b\u59f9\u5986\u59d7\u5978\u5a31\u5a04\u5987\u5a05\u5a32\u59ab\u36c0\u5aaa\u5988\u8885\u59aa\u59a9\u5a34\u5a34\u5a73\u59ab\u5aad\u5a06\u5a75\u5a07\u5af1\u5ad2\u5b37\u5ad4\u5a74\u5a76\u5a18\u36e4\u5a08\u5b59\u5b66\u5b6a\u5bab\u91c7\u5bdd\u5b9e\u5b81\u5ba1\u5199\u5bbd\u5ba0\u5b9d\u5c06\u4e13\u5bfb\u5bf9\u5bfc\u5c34\u5c4a\u5c38\u5c43\u5c49\u5c61\u5c42\u5c66\u5c5e\u5188\u5cf0\u5c98\u5c9b\u5ce1\u5d03\u6606\u5c97\u4ed1\u5ce5\u5cbd\u5c9a\u5c81\u37e5\u5d5d\u5d2d\u5c96\u5d5a\u5d02\u5ce4\u5ce3\u5cc4\u5cc3\u5d04\u5d58\u5cad\u5c7f\u5cb3\u5cbf\u5ce6\u5dc5\u5ca9\u5def\u537a\u5e05\u5e08\u5e10\u5e26\u5e27\u5e0f\u384e\u5e3c\u5e3b\u5e1c\u5e01\u5e2e\u5e31\u5e76\u5e72\u51e0\u5e93\u5395\u53a2\u53a9\u53a6\u5ebc\u836b\u53a8\u53ae\u5e99\u5382\u5e91\u5e9f\u5e7f\u5eea\u5e90\u5385\u5f11\u540a\u5f2a\u5f20\u5f3a\u522b\u5f39\u5f25\u5f2f\u5f55\u6c47\u5f5f\u5f66\u96d5\u5f68\u4f5b\u540e\u5f84\u4ece\u5f95\u590d\u5f81\u5f7b\u6052\u803b\u60a6\u60ae\u6005\u95f7\u51c4\u6076\u607c\u607d\u607b\u7231\u60ec\u60ab\u6006\u607a\u5ffe\u6817\u6001\u6120\u60e8\u60ed\u6078\u60ef\u60ab\u6004\u6002\u8651\u60ad\u5e86\u396a\u621a\u6b32\u5fe7\u60eb\u601c\u51ed\u6126\u616d\u60ee\u6124\u60af\u6003\u5baa\u5fc6\u6073\u5e94\u603f\u61d4\u8499\u603c\u61d1\u393d\u6079\u60e9\u61d2\u6000\u60ac\u5fcf\u60e7\u6151\u604b\u6206\u620b\u6217\u622c\u6218\u622f\u620f\u6237\u634d\u629b\u62fc\u635d\u6332\u631f\u820d\u626a\u6328\u5377\u626b\u62a1\u39cf\u631c\u6323\u6302\u91c7\u62e3\u626c\u6362\u6325\u6404\u635f\u6447\u6363\u6247\u63fe\u62a2\u63b4\u63bc\u6402\u631a\u62a0\u629f\u6298\u63ba\u635e\u6326\u6491\u6320\u39d1\u6322\u63b8\u62e8\u629a\u6251\u63ff\u631e\u631d\u6361\u62e5\u63b3\u62e9\u51fb\u6321\u39df\u62c5\u636e\u6324\u62ac\u6363\u62df\u6448\u62e7\u6401\u63b7\u6269\u64b7\u6446\u64de\u64b8\u39f0\u6270\u6445\u64b5\u62e2\u62e6\u6484\u6400\u64ba\u643a\u6444\u6512\u631b\u644a\u6405\u63fd\u6559\u655a\u8d25\u53d9\u654c\u6570\u655b\u6bd9\u6569\u6593\u65a9\u65ad\u4e8e\u65d7\u65e2\u5347\u65f6\u664b\u663c\u6655\u6656\u65f8\u7545\u6682\u6654\u5386\u6619\u6653\u5411\u66a7\u65f7\u663d\u6652\u4e66\u4f1a\u80e7\u672f\u4e1c\u62d0\u6805\u62d0\u67e5\u6746\u6800\u67a7\u6761\u67ad\u68c1\u5f03\u68cb\u67a8\u67a3\u680b\u3b4e\u6808\u6816\u68be\u6860\u3b4f\u6768\u67ab\u6862\u4e1a\u6781\u77e9\u5e72\u6769\u8363\u6985\u6864\u6784\u67aa\u6760\u68bf\u6920\u6901\u692e\u6868\u6922\u691d\u6869\u4e50\u679e\u6881\u697c\u6807\u67a2\u3b64\u6837\u699d\u3b74\u686a\u6734\u6811\u6866\u692b\u6861\u6865\u673a\u692d\u6a2a\u6aa9\u67fd\u6863\u6867\u69da\u68c0\u6a2f\u68bc\u53f0\u69df\u67e0\u69db\u67dc\u6a79\u6988\u6809\u691f\u6a7c\u680e\u6a71\u69e0\u680c\u67a5\u6a65\u6987\u8616\u680a\u6989\u6a31\u680f\u6989\u6743\u6924\u683e\u6984\u68c2\u94a6\u53f9\u6b27\u6b24\u6b22\u5c81\u5386\u5f52\u6b81\u6b8b\u6b92\u6b87\u3c6e\u6b9a\u50f5\u6b93\u6ba1\u3c69\u6b7c\u6740\u58f3\u58f3\u6bc1\u6bb4\u6bf5\u7266\u6be1\u6c07\u6c14\u6c22\u6c29\u6c32\u6cdb\u6cdb\u6c61\u51b3\u6ca1\u51b2\u51b5\u6eaf\u6cc4\u6c79\u6d43\u6cfe\u6d9a\u51c9\u51c4\u6cea\u6e0c\u51c0\u51cc\u6ca6\u6e0a\u6d9e\u6d45\u6da3\u51cf\u6ca8\u6da1\u6d4b\u6d51\u51d1\u6d48\u6d8c\u6c64\u6ca9\u51c6\u6c9f\u6e29\u6d49\u6da2\u6e7f\u6ca7\u706d\u6da4\u8365\u6c47\u6caa\u6ede\u6e17\u5364\u6d52\u6d50\u6eda\u6ee1\u6e14\u6e87\u6ca4\u6c49\u6d9f\u6e0d\u6da8\u6e86\u6e10\u6d46\u988d\u6cfc\u6d01\u6ca9\u3d0b\u6f5c\u6da6\u6d54\u6e83\u6ed7\u6da0\u6da9\u6d47\u6d9d\u6c84\u6da7\u6e11\u6cfd\u6eea\u6cf6\u6d4d\u6dc0\u3ce0\u6d4a\u6d53\u3ce1\u6e7f\u6cde\u6e81\u8499\u6d55\u6d4e\u6d9b\u3cd4\u6ee5\u6f4d\u6ee8\u6e85\u6cfa\u6ee4\u6f9b\u6ee2\u6e0e\u3cbf\u6cfb\u6c88\u6d4f\u6fd2\u6cf8\u6ca5\u6f47\u6f46\u6f74\u6cf7\u6fd1\u5f25\u6f4b\u6f9c\u6ca3\u6ee0\u6d12\u6f13\u6ee9\u704f\u3cd5\u6e7e\u6ee6\u6edf\u6edf\u707e\u4e3a\u4e4c\u70c3\u65e0\u70bc\u709c\u70df\u8315\u7115\u70e6\u7080\u3dbd\u7174\u8367\u709d\u70ed\u988e\u70bd\u70e8\u706f\u7096\u70e7\u70eb\u7116\u8425\u707f\u6bc1\u70db\u70e9\u3db6\u718f\u70ec\u7118\u70c1\u7089\u70c2\u4e89\u4e3a\u7237\u5c14\u5e8a\u5899\u724d\u62b5\u7275\u8366\u7266\u728a\u727a\u72b6\u72ed\u72c8\u72f0\u72b9\u72f2\u72b8\u5446\u72f1\u72ee\u5956\u72ec\u72ef\u7303\u72dd\u72de\u3e8d\u83b7\u730e\u72b7\u517d\u736d\u732e\u7315\u7321\u73b0\u96d5\u73d0\u73f2\u73ae\u739a\u7410\u7476\u83b9\u739b\u73b1\u740f\u740e\u7391\u7477\u73f0\u3ec5\u73af\u7399\u7478\u73ba\u7487\u743c\u73d1\u748e\u74d2\u74ef\u74ee\u4ea7\u4ea7\u4ea9\u6bd5\u753b\u5f02\u753b\u5f53\u7574\u53e0\u75c9\u9178\u75b4\u75d6\u75af\u75a1\u75ea\u7617\u75ae\u759f\u7606\u75ad\u7618\u7618\u7597\u75e8\u75eb\u7605\u6108\u75a0\u762a\u75f4\u75d2\u7596\u75c7\u75ac\u765e\u7663\u763f\u763e\u75c8\u762b\u766b\u53d1\u7682\u7691\u75b1\u76b2\u76b1\u676f\u76d7\u76cf\u5c3d\u76d1\u76d8\u5362\u8361\u771f\u7726\u4f17\u56f0\u7741\u7750\u770d\u4056\u7792\u7786\u7751\u8499\u772c\u77a9\u77eb\u6731\u7841\u7856\u7817\u781a\u57fc\u7855\u7800\u781c\u786e\u7801\u40b5\u7859\u7816\u7875\u789c\u789b\u77f6\u7857\u40c5\u785a\u7840\u788d\u77ff\u783a\u783e\u77fe\u783b\u79d8\u7984\u7978\u796f\u794e\u7943\u5fa1\u7985\u793c\u7962\u7977\u79c3\u7c7c\u7a0e\u79c6\u4149\u68f1\u7980\u79cd\u79f0\u8c37\u415f\u7a23\u79ef\u9896\u79fe\u7a51\u79fd\u7a33\u83b7\u7a5e\u7a9d\u6d3c\u7a77\u7a91\u7a8e\u7aad\u7aa5\u7a9c\u7a8d\u7aa6\u7076\u7a83\u7ad6\u7ade\u7b14\u7b0b\u7b15\u41f2\u4e2a\u7b3a\u7b5d\u672d\u8282\u8303\u7b51\u7ba7\u7b7c\u7b7f\u7b03\u7b5b\u7b5a\u7ba6\u7bd3\u84d1\u7baa\u7b80\u7bd1\u7bab\u7b5c\u7b7e\u5e18\u7bee\u7b79\u4264\u7b93\u7bef\u7ba8\u7c41\u7b3c\u7b7e\u7b3e\u7c16\u7bf1\u7ba9\u5401\u7ca4\u7cbd\u7cc1\u7caa\u7cae\u56e2\u7c9d\u7c74\u7c9c\u7e9f\u7ea0\u7eaa\u7ea3\u7ea6\u7ea2\u7ea1\u7ea5\u7ea8\u7eab\u7eb9\u7eb3\u7ebd\u7ebe\u7eaf\u7eb0\u7ebc\u7eb1\u7eae\u7eb8\u7ea7\u7eb7\u7ead\u7eb4\u7eba\u4337\u624e\u7ec6\u7ec2\u7ec1\u7ec5\u7ebb\u7ecd\u7ec0\u7ecb\u7ed0\u7ecc\u7ec8\u5f26\u7ec4\u4339\u7eca\u7ed7\u7ed3\u7edd\u7ee6\u7ed4\u7ede\u7edc\u7eda\u7ed9\u7ed2\u7ed6\u7edf\u4e1d\u7edb\u7edd\u7ee2\u7ed1\u7ee1\u7ee0\u7ee8\u7ee3\u7ee4\u7ee5\u433c\u6346\u7ecf\u7efc\u7f0d\u7eff\u7ef8\u7efb\u7ebf\u7ef6\u7ef4\u7ef9\u7efe\u7eb2\u7f51\u7ef7\u7f00\u5f69\u7eb6\u7efa\u7eee\u7efd\u7ef0\u7eeb\u7ef5\u7ef2\u7f01\u7d27\u7eef\u7eff\u7eea\u7eec\u7ef1\u7f03\u7f04\u7f02\u7ebf\u7f09\u7f0e\u7f14\u7f17\u7f18\u7f0c\u7f16\u7f13\u7f05\u7eac\u7f11\u7f08\u7ec3\u7f0f\u7f07\u81f4\u7f0a\u8426\u7f19\u7f22\u7f12\u7ec9\u7f23\u7f0a\u7f1e\u7f1a\u7f1c\u7f1f\u7f1b\u53bf\u7ee6\u7f1d\u7f21\u7f29\u7eb5\u7f27\u4338\u7ea4\u7f26\u7d77\u7f15\u7f25\u603b\u7ee9\u7ef7\u7f2b\u7f2a\u7f2f\u7ec7\u7f2e\u7f2d\u7ed5\u7ee3\u7f0b\u7ef3\u7ed8\u7cfb\u8327\u7f30\u7f33\u7f32\u7f34\u4341\u7ece\u7ee7\u7f24\u7f31\u4340\u98a3\u7f2c\u7ea9\u7eed\u7d2f\u7f20\u7f28\u624d\u7ea4\u7f35\u7f06\u94b5\u44e8\u575b\u7f42\u575b\u7f5a\u9a82\u7f62\u7f57\u7f74\u7f81\u8288\u7fa4\u7f9f\u7fa1\u4e49\u81bb\u4e60\u73a9\u7fda\u7fd8\u7fd9\u8027\u8022\u5723\u95fb\u8054\u806a\u58f0\u8038\u8069\u8042\u804c\u804d\u542c\u804b\u8083\u80c1\u8109\u80eb\u5507\u4fee\u8131\u80c0\u80be\u80e8\u8136\u8111\u80bf\u811a\u80a0\u817d\u8158\u80a4\u43dd\u80f6\u817b\u80c6\u810d\u8113\u8138\u8110\u8191\u814a\u80ea\u810f\u8114\u81dc\u5367\u4e34\u53f0\u4e0e\u5174\u4e3e\u65e7\u94fa\u9986\u8231\u8223\u8230\u823b\u8270\u8273\u520d\u82ce\u5179\u8346\u5e84\u830e\u835a\u82cb\u534e\u5eb5\u70df\u82cc\u83b1\u4e07\u835d\u83b4\u53f6\u836d\u836e\u82c7\u836f\u8364\u641c\u83bc\u83b3\u8480\u8385\u82cd\u836a\u5e2d\u76d6\u83b2\u82c1\u83bc\u835c\u535c\u53c2\u848c\u848b\u8471\u8311\u836b\u8368\u8487\u835e\u836c\u82b8\u83b8\u835b\u8489\u8361\u829c\u8427\u84e3\u8570\u835f\u84df\u8297\u59dc\u8537\u8359\u83b6\u8350\u8428\u82e7\u44d3\u82d4\u8360\u84dd\u8369\u827a\u836f\u85ae\u44d6\u8574\u82c8\u853c\u853a\u841a\u8572\u82a6\u82cf\u8574\u82f9\u85d3\u8539\u830f\u5170\u84e0\u841d\u8502\u5904\u865a\u864f\u53f7\u4e8f\u866c\u86f1\u8715\u86ac\u8680\u732c\u867e\u8671\u8717\u86f3\u8682\u8424\u45d6\u877c\u8780\u86f0\u8748\u87a8\u866e\u8749\u86f2\u866b\u86cf\u8681\u8683\u8747\u867f\u874e\u86f4\u877e\u869d\u8721\u86ce\u87cf\u86ca\u8695\u86ee\u4f17\u8511\u672f\u540c\u80e1\u536b\u51b2\u886e\u5939\u8885\u91cc\u8865\u88c5\u91cc\u5236\u590d\u88c8\u8886\u88e4\u88e2\u891b\u4eb5\u88e5\u88e5\u88af\u8884\u88e3\u88c6\u8934\u889c\u6446\u886c\u88ad\u8955\u6838\u89c1\u89c3\u89c4\u89c5\u89c6\u89c7\u89cb\u89cd\u89ce\u4eb2\u89ca\u89cf\u89d0\u89d1\u89c9\u89c8\u89cc\u89c2\u89de\u89ef\u89e6\u8ba0\u8ba2\u8ba3\u8ba1\u8baf\u8ba7\u8ba8\u8ba6\u8bb1\u8bad\u8baa\u8bab\u6258\u8bb0\u8bb9\u8bb6\u8bbc\u4723\u8bc0\u8bb7\u8bbb\u8bbf\u8bbe\u8bb8\u8bc9\u8bc3\u8bca\u6ce8\u8bc1\u8bc2\u8bcb\u8bb5\u8bc8\u8bd2\u8bcf\u8bc4\u8bd0\u8bc7\u8bce\u8bc5\u8bcd\u548f\u8be9\u8be2\u8be3\u8bd5\u8bd7\u8be7\u8bdf\u8be1\u8be0\u8bd8\u8bdd\u8be5\u8be6\u8bdc\u8bd9\u8bd6\u8bd4\u8bdb\u8bd3\u5938\u5fd7\u8ba4\u8bf3\u8bf6\u8bde\u8bf1\u8bee\u8bed\u8bda\u8beb\u8bec\u8bef\u8bf0\u8bf5\u8bf2\u8bf4\u8bf4\u8c01\u8bfe\u8c07\u8bfd\u8c0a\u8a1a\u8c03\u8c04\u8c06\u8c08\u8bff\u8bf7\u8be4\u8bf9\u8bfc\u8c05\u8bba\u8c02\u8c00\u8c0d\u8c1e\u8c1d\u8c25\u8be8\u8c14\u8c1b\u8c10\u8c0f\u8c15\u54a8\u8bb3\u8c19\u8c0c\u8bbd\u8bf8\u8c1a\u8c16\u8bfa\u8c0b\u8c12\u8c13\u8a8a\u8bcc\u8c0e\u8c1c\u8c27\u8c11\u8c21\u8c24\u8c26\u8c25\u8bb2\u8c22\u8c23\u8c23\u8c1f\u8c2a\u8c2c\u8c2b\u8bb4\u8c28\u8c29\u54d7\u8bc1\u8c32\u8ba5\u8c2e\u8bc6\u8c2f\u8c2d\u8c31\u566a\u8c35\u6bc1\u8bd1\u8bae\u8c34\u62a4\u8bea\u8a89\u8c2b\u8bfb\u8c09\u53d8\u8a5f\u4729\u96e0\u8c17\u8ba9\u8c30\u8c36\u8d5e\u8c20\u8c33\u6eaa\u5c82\u7ad6\u4e30\u8273\u732a\u8c6e\u72f8\u732b\u4759\u8d1d\u8d1e\u8d20\u8d1f\u8d22\u8d21\u8d2b\u8d27\u8d29\u8d2a\u8d2f\u8d23\u8d2e\u8d33\u8d40\u8d30\u8d35\u8d2c\u4e70\u8d37\u8d36\u8d39\u8d34\u8d3b\u8d38\u8d3a\u8d32\u8d42\u8d41\u8d3f\u8d45\u8d44\u8d3e\u8d3c\u8d48\u8d4a\u5bbe\u8d47\u8d52\u8d49\u8d50\u8d4f\u8d54\u8d53\u8d24\u5356\u8d31\u8d4b\u8d55\u8d28\u8d4d\u8d26\u8d4c\u4790\u8d56\u8d57\u8d5a\u8d59\u8d2d\u8d5b\u8d5c\u8d3d\u8d58\u8d5f\u8d60\u8d5e\u8d5d\u8d61\u8d62\u8d46\u8d43\u8d51\u8d4e\u8d5d\u8d63\u8d43\u8d6a\u8d76\u8d75\u8d8b\u8db1\u8ff9\u8df5\u903e\u8e0a\u8dc4\u8df8\u8ff9\u8dd6\u8e52\u8e2a\u8df7\u8df6\u8db8\u8e0c\u8dfb\u8dc3\u47e2\u8e2f\u8dde\u8e2c\u8e70\u8df9\u8e51\u8e7f\u8e9c\u8e8f\u8eaf\u8f66\u8f67\u8f68\u519b\u8f6a\u8f69\u8f6b\u8f6d\u8f6f\u8f77\u8f78\u8f71\u8f74\u8f75\u8f7a\u8f72\u8f76\u8f7c\u8f83\u8f82\u8f81\u8f80\u8f7d\u8f7e\u8f84\u633d\u8f85\u8f7b\u8f86\u8f8e\u8f89\u8f8b\u8f8d\u8f8a\u8f87\u8f88\u8f6e\u8f8c\u8f91\u8f8f\u8f93\u8f90\u8f92\u8f97\u8206\u8f92\u6bc2\u8f96\u8f95\u8f98\u8f6c\u8f99\u8f7f\u8f9a\u8f70\u8f94\u8f79\u8f73\u529e\u8f9e\u8fab\u8fa9\u519c\u56de\u5f84\u8fd9\u8fde\u5468\u8fdb\u6e38\u8fd0\u8fc7\u8fbe\u8fdd\u9065\u900a\u9012\u8fdc\u6eaf\u9002\u8fdf\u7ed5\u8fc1\u9009\u9057\u8fbd\u8fc8\u8fd8\u8fe9\u8fb9\u903b\u9026\u90cf\u90ae\u90d3\u4e61\u90b9\u90ac\u90e7\u9093\u90d1\u90bb\u90f8\u90ba\u90d0\u909d\u9142\u90e6\u814c\u915d\u4e11\u915d\u848f\u7cd6\u533b\u9171\u9166\u917f\u8845\u917e\u917d\u91ca\u5398\u9485\u9486\u9487\u948c\u948a\u9489\u948b\u9488\u9493\u9490\u6263\u948f\u9492\u9497\u948d\u9495\u948e\u497a\u94af\u94ab\u9498\u94ad\u94a5\u949a\u94a0\u949d\u94a9\u94a4\u94a3\u9491\u949e\u94ae\u94a7\u949f\u9499\u94ac\u949b\u94aa\u94cc\u94c8\u94b6\u94c3\u94b4\u94b9\u94cd\u94b0\u94b8\u94c0\u94bf\u94be\u5de8\u94bb\u94ca\u94c9\u94c7\u94cb\u94c2\u94b7\u94b3\u94c6\u94c5\u94ba\u94b5\u94a9\u94b2\u94bc\u94bd\u952b\u94cf\u94f0\u94d2\u94ec\u94ea\u94f6\u94f3\u94dc\u94da\u94e3\u94e8\u94e2\u94ed\u94eb\u94e6\u8854\u94d1\u94f7\u94f1\u94df\u94f5\u94e5\u94d5\u94ef\u94d0\u94de\u9510\u9500\u9508\u9511\u9509\u94dd\u9512\u950c\u94a1\u94e4\u94d7\u950b\u94fb\u950a\u9513\u94d8\u9504\u9503\u9514\u9507\u94d3\u94fa\u9510\u94d6\u9506\u9502\u94fd\u950d\u952f\u94a2\u951e\u5f55\u9516\u952b\u9529\u94d4\u9525\u9515\u951f\u9524\u9531\u94ee\u951b\u952c\u952d\u951c\u94b1\u9526\u951a\u9520\u9521\u9522\u9519\u5f55\u9530\u8868\u94fc\u954e\u951d\u9528\u952a\u94ab\u9494\u9534\u9533\u70bc\u9505\u9540\u9537\u94e1\u9496\u953b\u953d\u9538\u9532\u9518\u9539\u953e\u952e\u9536\u9517\u9488\u949f\u9541\u953f\u9545\u9551\u9570\u9555\u9501\u9549\u9524\u9548\u9543\u94a8\u84e5\u954f\u94e0\u94e9\u953c\u9550\u9547\u9547\u9552\u954b\u954d\u9553\u9fd4\u954c\u954e\u955e\u65cb\u94fe\u9546\u9559\u9560\u955d\u94ff\u9535\u9557\u9558\u955b\u94f2\u955c\u9556\u9542\u933e\u955a\u94e7\u9564\u956a\u497d\u9508\u94d9\u94f4\u9563\u94f9\u9566\u9561\u949f\u956b\u9562\u9568\u4985\u950e\u950f\u9544\u954c\u9570\u4983\u956f\u956d\u94c1\u956e\u94ce\u94db\u9571\u94f8\u956c\u9554\u9274\u9274\u9572\u9527\u9574\u94c4\u9573\u9565\u9567\u94a5\u9575\u9576\u954a\u9569\u9523\u94bb\u92ae\u51ff\u9562\u954b\u957f\u95e8\u95e9\u95ea\u95eb\u95ec\u95ed\u5f00\u95f6\u95f3\u95f0\u95f2\u95f2\u95f4\u95f5\u95f8\u9602\u9601\u5408\u9600\u95fa\u95fd\u9603\u9606\u95fe\u9605\u9605\u960a\u9609\u960e\u960f\u960d\u9608\u960c\u9612\u677f\u6697\u95f1\u9614\u9615\u9611\u9607\u9617\u9618\u95ff\u9616\u9619\u95ef\u5173\u961a\u9613\u9610\u8f9f\u961b\u95fc\u9649\u9655\u5347\u9635\u9634\u9648\u9646\u9633\u9667\u961f\u9636\u9668\u9645\u968f\u9669\u9666\u9690\u9647\u96b6\u53ea\u96bd\u867d\u53cc\u96cf\u6742\u9e21\u79bb\u96be\u4e91\u7535\u6cbe\u9721\u96fe\u9701\u96f3\u972d\u53c7\u7075\u53c6\u9753\u9759\u9754\u817c\u9765\u5de9\u7ef1\u79cb\u9792\u7f30\u9791\u5343\u97af\u97e6\u97e7\u97e8\u97e9\u97ea\u97ec\u97b2\u97eb\u97f5\u54cd\u9875\u9876\u9877\u9879\u987a\u9878\u987b\u987c\u9882\u9880\u9883\u9884\u987d\u9881\u987f\u9887\u9886\u988c\u9889\u9890\u988f\u5934\u9892\u988a\u988b\u9895\u9894\u9888\u9893\u9891\u9893\u9897\u9898\u989d\u989a\u989c\u9899\u989b\u989c\u613f\u98a1\u98a0\u7c7b\u989f\u98a2\u987e\u98a4\u98a5\u663e\u98a6\u9885\u989e\u98a7\u98ce\u98d0\u98d1\u98d2\u53f0\u522e\u98d3\u98d4\u98cf\u98d6\u98d5\u98d7\u98d8\u98d9\u98da\u98de\u9963\u9965\u9964\u9966\u9968\u996a\u996b\u996c\u996d\u98e7\u996e\u9974\u9972\u9971\u9970\u9973\u997a\u9978\u997c\u7ccd\u9977\u517b\u9975\u9979\u997b\u997d\u9981\u997f\u9982\u997e\u4f59\u80b4\u9984\u9983\u996f\u9985\u9986\u7cca\u7cc7\u9967\u5582\u9989\u9987\u998e\u9969\u998f\u998a\u998c\u998d\u9992\u9990\u9991\u9993\u9988\u9994\u9965\u9976\u98e8\u990d\u998b\u9995\u9a6c\u9a6d\u51af\u9a6e\u9a70\u9a6f\u9a72\u9a73\u9a7b\u9a7d\u9a79\u9a75\u9a7e\u9a80\u9a78\u9a76\u9a7c\u9a77\u9a82\u9a88\u9a87\u9a83\u9a86\u9a8e\u9a8f\u9a8b\u9a8d\u9a93\u9a94\u9a92\u9a91\u9a90\u9a9b\u9a97\u9a99\u4bc4\u9a9e\u9a98\u9a9d\u817e\u9a7a\u9a9a\u9a9f\u9aa1\u84e6\u9a9c\u9a96\u9aa0\u9aa2\u9a71\u9a85\u9a95\u9a81\u9aa3\u9a84\u9a8c\u60ca\u9a7f\u9aa4\u9a74\u9aa7\u9aa5\u9aa6\u9a8a\u9a89\u80ae\u9ac5\u810f\u4f53\u9acc\u9acb\u53d1\u677e\u80e1\u987b\u9b13\u6597\u95f9\u54c4\u960b\u9604\u90c1\u9b36\u9b49\u9b47\u9c7c\u9c7d\u9c7e\u9c80\u9c81\u9c82\u9c7f\u9c84\u9c85\u9c86\u9c8c\u9c89\u9c8f\u9c87\u9c90\u9c8d\u9c8b\u9c8a\u9c92\u9c98\u9c9e\u9c95\u4c9f\u9c96\u9c94\u9c9b\u9c91\u9c9c\u9c93\u9caa\u9c9d\u9ca7\u9ca0\u9ca9\u9ca4\u9ca8\u9cac\u9cbb\u9caf\u9cad\u9c9e\u9cb7\u9cb4\u9cb1\u9cb5\u9cb2\u9cb3\u9cb8\u9cae\u9cb0\u9cb6\u9cba\u9cc0\u9cab\u9cca\u9cc8\u9c97\u9cc2\u4ca0\u9cbd\u9cc7\u4ca1\u9cc5\u9cbe\u9cc4\u9cc6\u9cc3\u9cc1\u9cd2\u9cd1\u9ccb\u9ca5\u9ccf\u4ca2\u9cce\u9cd0\u9ccd\u9cc1\u9ca2\u9ccc\u9cd3\u9cd8\u9ca6\u9ca3\u9cb9\u9cd7\u9cdb\u9cd4\u9cc9\u9cd9\u9cd5\u9cd6\u9cdf\u9cdd\u9cdc\u9cde\u9c9f\u9cbc\u9c8e\u9c99\u9ce3\u9ce1\u9ce2\u9cbf\u9c9a\u9ce0\u9cc4\u9c88\u9ca1\u9e1f\u51eb\u9e20\u51eb\u9e24\u51e4\u9e23\u9e22\u4d13\u9e29\u9e28\u9e26\u9e30\u9e35\u9e33\u9e32\u9e2e\u9e31\u9e2a\u9e2f\u9e2d\u9e38\u9e39\u9e3b\u4d15\u9e3f\u9e3d\u4d14\u9e3a\u9e3c\u9e40\u9e43\u9e46\u9e41\u9e48\u9e45\u9e44\u9e49\u9e4c\u9e4f\u9e50\u9e4e\u96d5\u9e4a\u9e53\u9e4d\u4d16\u9e2b\u9e51\u9e52\u9e4b\u9e59\u9e55\u9e57\u9e56\u9e5b\u9e5c\u4d17\u9e27\u83ba\u9e5f\u9e64\u9e60\u9e61\u9e58\u9e63\u9e5a\u9e5a\u9e62\u9e5e\u9e21\u4d18\u9e5d\u9e67\u9e65\u9e25\u9e37\u9e68\u9e36\u9e6a\u9e54\u9e69\u9e6b\u9e47\u9e47\u9e6c\u9e70\u9e6d\u9e34\u3d89\u9e6f\u4d19\u9e71\u9e72\u9e2c\u9e74\u9e66\u9e73\u9e42\u9e3e\u5364\u54b8\u9e7e\u78b1\u76d0\u4e3d\u9ea6\u9eb8\u9762\u9762\u66f2\u66f2\u9762\u4e48\u4e48\u9ec4\u9ec9\u70b9\u515a\u9eea\u9709\u9ee1\u9ee9\u9efe\u9f0b\u9f0c\u9f0d\u51ac\u9f39\u9f50\u658b\u8d4d\u9f51\u9f7f\u9f80\u9f81\u9f82\u9f85\u9f87\u9f83\u9f86\u9f84\u51fa\u9f88\u556e\u9f8a\u9f89\u9f8b\u816d\u9f8c\u9f99\u5390\u5e9e\u4dae\u9f9a\u9f9b\u9f9f\u4724\u9fd2";

const T2S_MAP = new Map();
for (let i = 0; i < T_CHARS.length; i++) {
  T2S_MAP.set(T_CHARS[i], S_CHARS[i]);
}
T2S_MAP.set('妳', '你');
T2S_MAP.set('著', '着');
T2S_MAP.set('後', '后');

function toSimplified(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.split('').map((c) => T2S_MAP.get(c) || c).join('');
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
    if (!ttmlContent || typeof ttmlContent !== 'string') return '';
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
      const parsed = parseLyricsSong(rawTtml);
      if (parsed.hasLyrics && meta.isChinese) {
        if (parsed.lrc) parsed.lrc = toSimplified(parsed.lrc);
        if (parsed.plain) parsed.plain = toSimplified(parsed.plain);
        if (parsed.ttml) parsed.ttml = toSimplified(parsed.ttml);
      }
      return parsed;
    } catch {
      return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    }
  }

  function downloadLyricsFile(content, ext, artist, title) {
    if (!content || !content.trim()) return;
    const cleanArtist = safeName(artist || '');
    const cleanTitle = safeName(title || adamId || 'Track');
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
      const cleanArtist = safeName(meta.artist || 'Unknown Artist');
      const cleanTitle = safeName(meta.title || adamId || 'Track');
      const standardM4aName = `${cleanArtist} - ${cleanTitle}.m4a`;

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
        const coverUrl = meta.artwork ? meta.artwork.replace('600x600', '1200x1200') : '';
        const [lyrRes, coverBuf] = await Promise.all([
          fetchLyricsData(adamId),
          coverUrl
            ? fetch(coverUrl)
                .then((r) => (r.ok ? r.arrayBuffer() : null))
                .catch(() => (meta.artwork ? fetch(meta.artwork).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null))
            : (meta.artwork ? fetch(meta.artwork).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null),
        ]);
        lyricsData = lyrRes;

        let embedLrcText = '';
        if (shouldEmbedLyrics && lyricsData && lyricsData.hasLyrics) {
          // 若有动态时间轴内嵌 LRC，无动态歌词自动降级为纯文本内嵌
          embedLrcText = lyricsData.isDynamic ? lyricsData.lrc : lyricsData.plain;
        }

        const rawBuf = await result.file.arrayBuffer();
        const taggedBytes = tagMp4(new Uint8Array(rawBuf), {
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
          lyrics: embedLrcText,
          cover: coverBuf ? new Uint8Array(coverBuf) : null,
        });
        finalFile = new Blob([taggedBytes], { type: 'audio/mp4' });
      } catch (tagErr) {
        console.warn('Tagging error:', tagErr);
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
        { icon: ICON.server, label: t('menu.serverDownload'), hint: t('menu.serverDownloadHint'), href: v.hookFileUrl, download: fileName },
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

      const fileName = safeName(`${meta.artist ? meta.artist + ' - ' : ''}${meta.title || adamId} [${v.info.name.replace(/ · /g, ' ')}].m4a`);
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
      if (!res.ok || !data.masterUrl || !Array.isArray(data.variants)) throw new Error(data.msg || t('song.parseFailedHttp', { status: res.status }));
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
      artist: simplifyIfChinese(a.artistName || ''),
      album: simplifyIfChinese(a.albumName || ''),
      albumArtist: simplifyIfChinese(a.albumArtistName || albumAttr?.artistName || a.artistName || ''),
      albumId: rawSong.relationships?.albums?.data?.[0]?.id || '',
      trackNumber: a.trackNumber || 1,
      totalTracks: albumAttr?.trackCount || 0,
      discNumber: a.discNumber || 1,
      totalDiscs: 1,
      composer: simplifyIfChinese(a.composerName || ''),
      copyright: simplifyIfChinese(albumAttr?.copyright || ''),
      artists: (rawSong.relationships?.artists?.data || []).filter((r) => r.attributes?.name).map((r) => ({
        name: simplifyIfChinese(r.attributes.name),
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
