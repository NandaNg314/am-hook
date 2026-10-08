// 专辑页（/https://music.apple.com/{cc}/album/{slug}/{id}），由 app.mjs 挂载
import { createActions, playable, targetOf } from './actions.mjs';
import { createDetailHeader } from './detail-header.mjs';

const { formatTime, qualityIcon } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'album-page';

export function mount({ root, url, signal, player, navigate, onLangChange, toast, restoring }) {
  document.title = t('album.pageTitle');
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const pageUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = pageUrl.match(/music\.apple\.com\/([a-z]{2})\/album\/(?:([^/?#]+)\/)?(\d+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const albumId = linkMatch[3];

  // 带 ?i= 的专辑分享链接指向其中一首歌：与官网一样打开专辑页，选中该曲目并滚动到它
  const trackParam = url.searchParams.get('i');
  /** 选中（高亮）的曲目 ID：来自 ?i=，之后单击曲目行切换，单击曲目行以外的地方取消 */
  let selectedId = /^\d+$/.test(trackParam || '') ? trackParam : null;
  // 前进 / 后退恢复了原滚动位置时不再滚动到选中的曲目
  let revealPending = !!selectedId && !restoring;

  /** 当前专辑（amp-api albums 资源）与其中的曲目 */
  let album = null;
  let tracks = [];
  // 头部的资料库按钮（官网的「+」）：专辑连同全部曲目加入资料库，曲目已取到，不再重新请求
  const libraryTarget = () => (album ? targetOf(album, country, { collection: { resource: album, tracks } }) : null);
  const libraryToggle = actions.libraryButton(libraryTarget);
  root.querySelector('.detail-actions').append(Object.assign(document.createElement('span'), { className: 'detail-extra' }));
  // 喜爱（与 Apple Music 相同，喜爱即加入资料库）
  const favoriteToggle = actions.favoriteButton(libraryTarget);
  root.querySelector('.detail-extra').append(libraryToggle.button, favoriteToggle.button);
  let rows = new Map();
  let notesExpanded = false;
  let loadToken = 0;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

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

  /* ---------- amp-api：与 music.apple.com 专辑页相同的 albums 请求，经服务端 /amp 代理 ---------- */
  // l 按地区支持的语言选择，见 AmI18n.catalogLang
  const ALBUM_PARAMS = {
    platform: 'web',
    extend: 'offers,editorialArtwork,editorialVideo,extendedAssetUrls',
    'art[url]': 'f',
    include: 'record-labels,artists',
    'meta[albums:tracks]': 'popularity',
    'include[songs]': 'artists,composers,albums',
    'include[music-videos]': 'artists',
    'include[playlists]': 'curator',
    'fields[artists]': 'name,url',
    'fields[record-labels]': 'name,url',
    'fields[curators]': 'name',
    views: 'appears-on,more-by-artist,related-videos,other-versions,you-might-also-like,audio-extras,video-extras',
  };

  async function amp(path, params) {
    const url = new URL('/amp' + path, location.origin);
    // 值为 undefined 的参数不传（如地区不支持当前语言时的 l）
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
    let res = await fetch(url);
    if (res.status === 400 && url.searchParams.has('l')) {
      url.searchParams.delete('l');
      res = await fetch(url);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
    return data;
  }

  /** artwork.url 模板：{w}x{h}{c}.{f} */
  function artUrl(artwork, w, h = w) {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
  }

  /** 目录资源的 url → 本站页面路径；识别不了时按类型与 ID 拼出 */
  function pagePath(resource) {
    const url = (resource.attributes && resource.attributes.url) || '';
    const kind = { songs: 'song', 'music-videos': 'music-video', albums: 'album', artists: 'artist' }[resource.type];
    const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|artist)\/([^/?#]+)\/(\d+)/i);
    if (m && m[2] === kind) return `/https://music.apple.com/${m[1].toLowerCase()}/${kind}/${m[3]}/${m[4]}`;
    // 专辑内曲目的 url 是 album/...?i=<id>，统一转成歌曲页
    const slug = url.match(/\/album\/([^/?#]+)\//);
    return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
  }

  /** editorialNotes 是 HTML，只取纯文本 */
  function plainText(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });

  /* ---------- 渲染 ---------- */
  function renderHero() {
    const a = album.attributes;
    document.title = `${a.name} · am-hook`;
    $('title').classList.remove('skeleton');
    $('title').replaceChildren(a.name, a.contentRating === 'explicit' ? explicitBadge() : '');

    const artists = ((album.relationships && album.relationships.artists && album.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name);
    const artistEl = $('artist');
    artistEl.classList.remove('skeleton');
    // 艺人名链接到本站艺人页
    artistEl.replaceChildren(...(artists.length && artists.map((artist) => artist.attributes.name).join(' & ') === a.artistName
      ? artists.flatMap((artist, i) => [i ? ' & ' : '', el('a', { href: pagePath(artist), textContent: artist.attributes.name })])
      : [a.artistName || '']));

    const year = (a.releaseDate || '').slice(0, 4);
    $('sub').textContent = [(a.genreNames || [])[0], year].filter(Boolean).join(' · ');

    const traits = a.audioTraits || [];
    // 音质标志与播放条同一套图标
    const badges = [];
    if (traits.includes('hi-res-lossless')) badges.push('hires');
    else if (traits.includes('lossless')) badges.push('lossless');
    if (traits.includes('atmos')) badges.push('atmos');
    if (a.isMasteredForItunes) badges.push('adm');
    $('badges').replaceChildren(...badges.map((key) => qualityIcon(key)));

    const notes = plainText((a.editorialNotes && (a.editorialNotes.standard || a.editorialNotes.short)) || '');
    $('notes').hidden = !notes;
    $('hero').classList.toggle('no-notes', !notes);
    $('notes-text').textContent = notes;
    $('notes').classList.toggle('expanded', notesExpanded);
    requestAnimationFrame(() => {
      const text = $('notes-text');
      $('notes-more').hidden = !notesExpanded && text.scrollHeight <= text.clientHeight + 1;
      $('notes-more').textContent = t(notesExpanded ? 'album.less' : 'album.more');
    });

    renderHeader({ cover: a.artwork, attrs: a, alt: t('album.coverAlt', { title: a.name }) });
  }
  const renderHeader = createDetailHeader({ $, signal, artUrl, rerender: () => { if (album) renderHero(); } });

  /** 可播放的歌曲：播放队列只含这些 */
  const songs = () => tracks.filter((track) => track.type === 'songs' && playable(track));

  /** 曲目艺人：在 artistName 中依次找到各关联艺人的名字并链接到艺人页，分隔符（&、逗号、feat. 等）保留为文字 */
  function trackArtists(track) {
    const name = track.attributes.artistName || '';
    const artists = ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name);
    const parts = [];
    let pos = 0;
    for (const artist of artists) {
      const i = name.indexOf(artist.attributes.name, pos);
      if (i < 0) continue;
      if (i > pos) parts.push(name.slice(pos, i));
      parts.push(el('a', { href: pagePath(artist), textContent: artist.attributes.name }));
      pos = i + artist.attributes.name.length;
    }
    if (pos < name.length) parts.push(name.slice(pos));
    return parts;
  }

  function renderTracks() {
    const albumArtist = album.attributes.artistName;
    const discs = new Set(tracks.map((track) => track.attributes.discNumber || 1));
    rows = new Map();
    const nodes = [];
    let lastDisc = null;
    for (const track of tracks) {
      const a = track.attributes;
      const disc = a.discNumber || 1;
      if (discs.size > 1 && disc !== lastDisc) {
        lastDisc = disc;
        nodes.push(el('h2', { className: 'disc-title', textContent: t('album.disc', { n: disc }) }));
      }
      const video = track.type === 'music-videos';
      // 尚未发行的曲目：与官网一样置灰，不能播放，歌曲页在目录中查不到，不做链接
      const unavailable = !playable(track);
      const href = pagePath(track);
      const popular = !video && track.meta && track.meta.popularity >= 0.7;

      const index = video ? el('span', { className: 'track-index', innerHTML: ICON.video })
        : el('span', { className: 'track-index', textContent: String(a.trackNumber || '') });
      const num = el('span', { className: 'track-num' }, index,
        el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));
      let playBtn = null;
      if (!video && !unavailable) {
        playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play });
        playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
        playBtn.addEventListener('click', () => playTrack(track));
        num.append(playBtn);
      }
      if (popular) num.append(el('span', { className: 'track-pop', title: t('album.popular') }));

      const title = el(unavailable ? 'span' : 'a', { className: 'track-title', textContent: a.name, ...(unavailable ? {} : { href }) });
      const main = el('div', { className: 'track-main' },
        el('div', { className: 'track-line' }, title, a.contentRating === 'explicit' ? explicitBadge() : ''),
        a.artistName && a.artistName !== albumArtist ? el('div', { className: 'track-artist' }, ...trackArtists(track)) : null);
      // 「更多」菜单：播放按专辑顺序排队
      const more = actions.moreButton(targetOf(track, country, video || unavailable ? {} : { onPlay: () => playTrack(track) }));

      const row = el('div', { className: `track${video ? ' video' : ''}${unavailable ? ' unavailable' : ''}` }, num, main,
        el('span', { className: 'track-time', textContent: a.durationInMillis ? formatTime(a.durationInMillis / 1000) : '' }), more);
      if (!video && !unavailable) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track); });
      row.addEventListener('click', (e) => { if (!e.target.closest('a, button')) select(track.id); });
      rows.set(track.id, { row, playBtn });
      nodes.push(row);
    }
    $('tracks').replaceChildren(...nodes);
    $('tracks').hidden = false;
    $('play-all').disabled = $('shuffle').disabled = songs().length === 0;
    syncRows(player.current, !player.transport().paused);
    select(selectedId);
    const target = revealPending && rows.get(selectedId);
    if (target) {
      revealPending = false;
      target.row.scrollIntoView({ block: 'center' });
    }
  }

  function select(id) {
    selectedId = id;
    for (const [trackId, { row }] of rows) row.classList.toggle('selected', trackId === id);
  }
  document.addEventListener('pointerdown', (e) => {
    if (selectedId && !(e.target instanceof Element && e.target.closest('.track'))) select(null);
  }, { signal });

  function renderFooter() {
    const a = album.attributes;
    const lines = [];
    if (a.releaseDate) {
      const date = new Date(`${a.releaseDate}T00:00:00`);
      lines.push(Number.isNaN(date.getTime()) ? a.releaseDate
        : new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(date));
    }
    const songCount = tracks.filter((track) => track.type === 'songs').length;
    const videoCount = tracks.length - songCount;
    const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.attributes.durationInMillis || 0), 0) / 60000);
    const length = minutes >= 60 ? t('album.hours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('album.minutes', { n: minutes });
    lines.push([songCount && t('album.songs', { n: songCount }), videoCount && t('album.videos', { n: videoCount }), minutes && length].filter(Boolean).join(AmI18n.lang === 'zh' ? '，' : ', '));
    if (a.copyright) lines.push(a.copyright);
    if (a.recordLabel && !(a.copyright || '').includes(a.recordLabel)) lines.push(a.recordLabel);
    $('footer').replaceChildren(...lines.map((line) => el('p', { textContent: line })));
    $('footer').hidden = !lines.length;
  }

  /** 下方货架：与官网相同的 views，只保留本站能打开的专辑与 MV */
  const VIEWS = ['other-versions', 'related-videos', 'video-extras', 'more-by-artist', 'appears-on', 'you-might-also-like', 'audio-extras'];
  function renderShelves() {
    const sections = [];
    for (const key of VIEWS) {
      const view = album.views && album.views[key];
      const items = ((view && view.data) || []).filter((res) => res.attributes && (res.type === 'albums' || res.type === 'music-videos'));
      if (!items.length) continue;
      const shelf = el('div', { className: 'shelf' }, ...items.map((res) => {
        const mv = res.type === 'music-videos';
        const a = res.attributes;
        const src = mv ? artUrl(a.artwork, 480, 270) : artUrl(a.artwork, 360);
        const cover = el('span', { className: mv ? 'shelf-art mv' : 'shelf-art' },
          src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }));
        const title = el('span', { className: 'shelf-title', textContent: a.name });
        if (a.contentRating === 'explicit') title.append(explicitBadge());
        const sub = key === 'other-versions' || key === 'more-by-artist' ? (a.releaseDate || '').slice(0, 4) : a.artistName;
        return actions.wrapCard(el('a', { className: mv ? 'shelf-item mv' : 'shelf-item', href: pagePath(res) },
          cover, title, el('span', { className: 'shelf-sub', textContent: sub || '' })), targetOf(res, country));
      }));
      sections.push(el('section', { className: 'shelf-section' },
        el('h2', { className: 'shelf-heading', textContent: (view.attributes && view.attributes.title) || key }), shelf));
    }
    $('shelves').replaceChildren(...sections);
  }

  function render() {
    renderHero();
    renderTracks();
    renderFooter();
    renderShelves();
    libraryToggle.refresh();
    favoriteToggle.refresh();
  }

  async function loadAlbum() {
    const token = ++loadToken;
    if (!album) showAlert('info', () => t('album.loading'));
    try {
      const l = await AmI18n.catalogLang(country);
      const data = await amp(`/v1/catalog/${country}/albums/${albumId}`, { l, ...ALBUM_PARAMS });
      const next = data.data && data.data[0];
      if (!next) throw new Error('empty response');
      const rel = next.relationships && next.relationships.tracks;
      let list = (rel && rel.data) || [];
      // 超长专辑的曲目分页
      for (let more = rel && rel.next; more;) {
        const page = await amp(more, { l, 'include[songs]': 'artists', 'include[music-videos]': 'artists', 'fields[artists]': 'name,url' });
        list = list.concat(page.data || []);
        more = page.next;
      }
      if (token !== loadToken || signal.aborted) return;
      album = next;
      tracks = list.filter((track) => track.attributes);
      render();
      showAlert('', '');
      if ($('batch-gofile-btn')) $('batch-gofile-btn').disabled = !tracks.length;
      if ($('batch-dl-btn')) $('batch-dl-btn').disabled = !tracks.length;
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      showAlert('error', () => t('album.failed', { msg: err.message }));
    }
  }

  /* ---------- 播放：队列交给播放器（见 player.js），逐首选浏览器能播放的最高音质，播完自动下一首；离开页面后继续 ---------- */
  function entryFor(track) {
    const a = track.attributes;
    return {
      track: track.id,
      country,
      name: a.name,
      artist: a.artistName,
      // 各位艺人的名字与本站艺人页路径，歌词界面用来把艺人行中的名字做成链接
      artists: ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
        .filter((artist) => artist.attributes && artist.attributes.name)
        .map((artist) => ({ name: artist.attributes.name, href: pagePath(artist) })),
      album: album.attributes.name,
      href: pagePath(track),
      albumHref: pagePath(album),
      artwork: artUrl(a.artwork || album.attributes.artwork, 600),
      duration: a.durationInMillis || 0,
    };
  }

  /** order：songs() 中的下标，按原顺序；options.shuffle 同时开关随机播放（见 AmPlayer.playQueue） */
  function playOrder(order, pos = 0, options) {
    const list = songs();
    player.playQueue(order.map((i) => entryFor(list[i])), pos, options);
  }

  function playTrack(track) {
    if (player.current && player.current.track === track.id) { player.toggle(); return; }
    const list = songs();
    playOrder(list.map((_, i) => i), list.indexOf(track));
  }

  $('play-all').addEventListener('click', () => playOrder(songs().map((_, i) => i), 0, { shuffle: false }));
  $('shuffle').addEventListener('click', () => {
    const count = songs().length;
    playOrder([...Array(count).keys()], Math.floor(Math.random() * count), { shuffle: true });
  });

  function syncRows(current, playing) {
    for (const [id, { row, playBtn }] of rows) {
      const active = !!current && current.track === id;
      row.classList.toggle('playing', active);
      row.classList.toggle('paused', active && !playing);
      row.classList.toggle('loading', player.pendingTrack === id);
      if (playBtn) playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
    }
  }
  player.onChange(syncRows);

  $('notes-more').addEventListener('click', () => {
    notesExpanded = !notesExpanded;
    renderHero();
  });

  // 切换语言：名称、简介和货架标题由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    renderAlert();
    if (album) render();
    if (albumId) loadAlbum();
  });

  /* ---------- 批量转存至 Gofile 与批量本地下载 ---------- */
  const batchGofileBtn = $('batch-gofile-btn');
  const batchDlBtn = $('batch-dl-btn');
  const batchModal = $('batch-modal');
  const batchModalTitle = $('batch-modal-title');
  const batchModalClose = $('batch-modal-close');
  const batchModalCancel = $('batch-modal-cancel');
  const batchModalConfirm = $('batch-modal-confirm');
  const batchQualitySelect = $('batch-quality-select');
  const batchLyricsFormat = $('batch-lyrics-format');
  const batchEmbedLyrics = $('batch-embed-lyrics');
  const batchSaveLyrics = $('batch-save-lyrics');

  if (batchLyricsFormat && localStorage.getItem('am_lyrics_fmt')) {
    batchLyricsFormat.value = localStorage.getItem('am_lyrics_fmt');
  }
  if (batchEmbedLyrics && localStorage.getItem('am_embed_lyr') !== null) {
    batchEmbedLyrics.checked = localStorage.getItem('am_embed_lyr') === 'true';
  }
  if (batchSaveLyrics && localStorage.getItem('am_save_lyr') !== null) {
    batchSaveLyrics.checked = localStorage.getItem('am_save_lyr') === 'true';
  }

  const batchCard = $('batch-card');
  const batchStatusTitle = $('batch-status-title');
  const batchProgressFill = $('batch-progress-fill');
  const batchStatusDetail = $('batch-status-detail');
  const batchCancelBtn = $('batch-cancel-btn');

  const gofileDialog = $('gofile-dialog');
  const gofileCloseBtn = $('gofile-dialog-close');
  const gofileDoneBtn = $('gofile-done-btn');
  const gofileCopyBtn = $('gofile-copy-btn');
  const gofileLinkInput = $('gofile-link-input');
  const gofileOpenLink = $('gofile-open-link');
  const gofileSongInfo = $('gofile-song-info');

  let currentBatchMode = null;
  let batchAbortController = null;

  batchCloseDialogs();
  function batchCloseDialogs() {
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
        document.execCommand('copy');
        toast('已复制链接');
      }
    });

    batchModalClose?.addEventListener('click', () => batchModal.close());
    batchModalCancel?.addEventListener('click', () => batchModal.close());
    batchCancelBtn?.addEventListener('click', () => {
      if (batchAbortController) {
        batchAbortController.abort();
        toast('已请求取消批量任务');
      }
    });
  }

  const batchZipPack = $('batch-zip-pack');
  const batchZipPackContainer = $('batch-zip-pack-container');

  batchGofileBtn?.addEventListener('click', () => {
    currentBatchMode = 'gofile';
    if (batchModalTitle) batchModalTitle.textContent = '☁️ 转存全辑至 Gofile (VPS 2000M 极速)';
    if (batchZipPackContainer) batchZipPackContainer.hidden = false;
    batchModal?.showModal();
  });

  batchDlBtn?.addEventListener('click', () => {
    currentBatchMode = 'local';
    if (batchModalTitle) batchModalTitle.textContent = '📥 批量下载全辑到本机';
    if (batchZipPackContainer) batchZipPackContainer.hidden = true;
    batchModal?.showModal();
  });

  batchModalConfirm?.addEventListener('click', () => {
    batchModal?.close();
    const q = batchQualitySelect ? batchQualitySelect.value : 'Lossless';
    const lyricsFormat = batchLyricsFormat ? batchLyricsFormat.value : 'lrc';
    const embedLyrics = batchEmbedLyrics ? batchEmbedLyrics.checked : true;
    const saveLyricsFile = batchSaveLyrics ? batchSaveLyrics.checked : true;
    const isZip = batchZipPack ? batchZipPack.checked : true;

    localStorage.setItem('am_lyrics_fmt', lyricsFormat);
    localStorage.setItem('am_embed_lyr', String(embedLyrics));
    localStorage.setItem('am_save_lyr', String(saveLyricsFile));

    if (currentBatchMode === 'gofile') {
      runBatchGofile(q, embedLyrics, saveLyricsFile, lyricsFormat, isZip);
    } else {
      runBatchLocal(q, embedLyrics, saveLyricsFile, lyricsFormat);
    }
  });

  async function runBatchGofile(quality, embedLyrics, saveLyricsFile, lyricsFormat, isZip = true) {
    if (!tracks.length) return;
    batchAbortController = new AbortController();
    const batchSig = batchAbortController.signal;

    if (batchCard) batchCard.hidden = false;
    const albumTitle = album.attributes.name;
    const artistName = album.attributes.artistName;
    if (batchStatusTitle) batchStatusTitle.textContent = isZip
      ? `📦 正在极速打包压缩《${albumTitle}》全辑为 .zip...`
      : `☁️ 正在通过 VPS 极速转存《${albumTitle}》至 Gofile...`;
    if (batchProgressFill) batchProgressFill.style.width = '0%';
    if (batchStatusDetail) batchStatusDetail.textContent = `准备开始 (共 ${tracks.length} 首歌曲)...`;

    const batchSessionId = isZip ? `album_${albumId || Date.now()}_${Date.now()}` : null;
    const zipFilename = `${artistName} - ${albumTitle} [${quality}].zip`;
    const BATCH_CONCURRENCY = 3;
    let parentFolder = null;
    let guestToken = null;
    let finalDownloadPage = null;
    let successCount = 0;
    let finishedCount = 0;

    const albAttr = (album && album.attributes) || {};

    const processSingleTrack = async (t, index) => {
      if (batchSig.aborted) return;
      const attr = t.attributes || {};
      const songTitle = attr.name || '未知曲目';
      try {
        const coverUrl = artUrl(attr.artwork || albAttr.artwork, 1400);
        const resp = await fetch('/api/cloud-transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adamId: t.id,
            quality,
            folderId: parentFolder,
            token: guestToken,
            batchId: batchSessionId,
            isLastTrack: false,
            zipFilename,
            meta: {
              title: attr.name,
              artist: attr.artistName || artistName,
              album: albumTitle,
              albumArtist: artistName,
              date: attr.releaseDate || albAttr.releaseDate,
              genre: (attr.genreNames && attr.genreNames[0]) || (albAttr.genreNames && albAttr.genreNames[0]) || '',
              composer: attr.composerName || '',
              copyright: albAttr.copyright || '',
              trackNumber: attr.trackNumber || (index + 1),
              totalTracks: tracks.length,
              discNumber: attr.discNumber || 1,
              totalDiscs: 1,
              coverUrl
            },
            embedLyrics,
            saveLyricsFile,
            lyricsFormat,
            saveLrc: saveLyricsFile
          }),
          signal: batchSig
        });
        const resJson = await resp.json();
        if (resJson.status === 'ok' && resJson.data) {
          if (resJson.data.folderId && !parentFolder) parentFolder = resJson.data.folderId;
          if (resJson.data.guestToken && !guestToken) guestToken = resJson.data.guestToken;
          if (resJson.data.downloadPage) finalDownloadPage = resJson.data.downloadPage;
          successCount++;
        } else {
          console.warn(`[Batch] 曲目《${songTitle}》转存失败:`, resJson.error);
        }
      } catch (err) {
        if (!batchSig.aborted) console.warn(`[Batch] 曲目《${songTitle}》转存异常:`, err.message);
      } finally {
        finishedCount++;
        const pct = Math.floor((finishedCount / tracks.length) * (isZip ? 90 : 100));
        if (batchProgressFill) batchProgressFill.style.width = `${pct}%`;
        if (batchStatusDetail) {
          batchStatusDetail.textContent = `⚡ [3 线程并行加速] 已就绪 (${finishedCount}/${tracks.length}) 首曲目...`;
        }
      }
    };

    // 1. 若非单 ZIP 模式，首曲先单发以获取 folderId，以便后续并发曲目归集至同一网盘目录
    let startIndex = 0;
    if (!isZip && tracks.length > 0) {
      if (batchStatusDetail) batchStatusDetail.textContent = `(1/${tracks.length}) 正在初始化网盘文件夹...`;
      await processSingleTrack(tracks[0], 0);
      startIndex = 1;
    }

    // 2. 启动 3 线程并发工作池并行拉取转存
    let nextTrackIdx = startIndex;
    const worker = async () => {
      while (nextTrackIdx < tracks.length && !batchSig.aborted) {
        const cur = nextTrackIdx++;
        await processSingleTrack(tracks[cur], cur);
      }
    };

    const workerCount = Math.min(BATCH_CONCURRENCY, tracks.length - startIndex);
    const workerPromises = [];
    for (let w = 0; w < workerCount; w++) {
      workerPromises.push(worker());
    }
    await Promise.all(workerPromises);

    // 3. 若为 ZIP 模式且全部曲目已就绪，触发最终一键极速打包与直传
    if (isZip && !batchSig.aborted && successCount > 0) {
      if (batchProgressFill) batchProgressFill.style.width = '92%';
      if (batchStatusDetail) batchStatusDetail.textContent = `所有曲目已就绪，正在生成 ZIP 压缩包并极速直传 Gofile...`;
      try {
        const finResp = await fetch('/api/cloud-transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            finalizeBatch: true,
            batchId: batchSessionId,
            zipFilename,
            quality,
            folderId: parentFolder,
            token: guestToken,
            meta: { album: albumTitle }
          }),
          signal: batchSig
        });
        const finJson = await finResp.json();
        if (finJson.status === 'ok' && finJson.data) {
          if (finJson.data.downloadPage) finalDownloadPage = finJson.data.downloadPage;
          if (finJson.data.folderId) parentFolder = finJson.data.folderId;
          if (finJson.data.guestToken) guestToken = finJson.data.guestToken;
        }
      } catch (err) {
        if (!batchSig.aborted) console.warn('[Batch] 全辑 ZIP 打包直传异常:', err.message);
      }
    }

    if (batchProgressFill) batchProgressFill.style.width = '100%';
    setTimeout(() => { if (batchCard) batchCard.hidden = true; }, 1500);

    if (batchSig.aborted) {
      toast('已取消批量转存');
      return;
    }

    const shareUrl = finalDownloadPage || (parentFolder ? `https://gofile.io/d/${parentFolder}` : '');
    if (shareUrl) {
      toast(isZip ? '🎉 全辑已成功压缩并转存至 Gofile！' : `🎉 全辑转存完成！共 ${successCount}/${tracks.length} 首曲目`);
      if (gofileLinkInput) gofileLinkInput.value = shareUrl;
      if (gofileOpenLink) gofileOpenLink.href = shareUrl;
      if (gofileSongInfo) {
        gofileSongInfo.textContent = isZip
          ? `已成功将《${albumTitle}》打包压缩为单文件：${zipFilename} (${successCount} 首完整曲目${saveLyricsFile ? '与歌词' : ''})`
          : `已成功将《${albumTitle}》(${successCount} 首歌曲) 归集至同一 Gofile 文件夹`;
      }
      if (gofileCopyBtn) gofileCopyBtn.textContent = '复制链接';
      gofileDialog?.showModal();
    } else {
      toast('转存失败，未能创建网盘链接');
    }
  }

  async function runBatchLocal(quality, embedLyrics, saveLyricsFile, lyricsFormat) {
    if (!tracks.length) return;
    batchAbortController = new AbortController();
    const batchSig = batchAbortController.signal;

    if (batchCard) batchCard.hidden = false;
    if (batchStatusTitle) batchStatusTitle.textContent = `📥 正在批量下载《${album.attributes.name}》到本机...`;
    if (batchProgressFill) batchProgressFill.style.width = '0%';

    for (let i = 0; i < tracks.length; i++) {
      if (batchSig.aborted) break;
      const t = tracks[i];
      const attr = t.attributes || {};
      const songTitle = attr.name || '未知曲目';
      const pct = Math.floor((i / tracks.length) * 100);
      if (batchProgressFill) batchProgressFill.style.width = `${pct}%`;
      if (batchStatusDetail) batchStatusDetail.textContent = `(${i + 1}/${tracks.length}) 正在下载《${songTitle}》...`;

      try {
        const parseRes = await fetch(`/parse/song/${t.id}`, { signal: batchSig });
        const parseData = await parseRes.json();
        const variants = parseData.variants || [];
        if (!variants.length) continue;

        let selected = variants.find(v => v.codecs === 'alac') || variants[0];
        if (quality === 'Hi-Res') {
          selected = variants.find(v => v.codecs === 'alac' && (v.sample_rate > 48000 || v.bit_depth > 16)) || selected;
        } else if (quality === 'Atmos') {
          selected = variants.find(v => v.codecs && v.codecs.includes('ec-3')) || selected;
        } else if (quality === 'AAC') {
          selected = variants.find(v => v.codecs && v.codecs.includes('mp4a')) || variants[0];
        }

        const base = (parseData.masterUrl || '').replace(/[^\/]+$/, '');
        const audioUrl = `${location.origin}/${base}${selected.file_uri}`;
        const cleanArtist = (attr.artistName || album.attributes.artistName || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
        const cleanTitle = songTitle.replace(/[\\/:*?"<>|]+/g, '_').trim();
        const fileName = `${cleanArtist} - ${cleanTitle}.m4a`;

        const a = document.createElement('a');
        a.href = audioUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();

        // 可选下载独立外挂歌词文件（无歌词则跳过）
        if (saveLyricsFile) {
          try {
            const lRes = await fetch(`/lyrics/${t.id}`, { signal: batchSig });
            if (lRes.ok) {
              const rawTtml = await lRes.text();
              if (rawTtml && rawTtml.trim()) {
                let content = '';
                let ext = 'lrc';
                if (lyricsFormat === 'ttml') {
                  ext = 'ttml';
                  content = rawTtml;
                } else {
                  ext = 'lrc';
                  const pRegex = /<p[^>]*\bbegin=["']([^"']+)["'][^>]*>([\s\S]*?)<\/p>/gi;
                  const lines = [];
                  let m;
                  while ((m = pRegex.exec(rawTtml)) !== null) {
                    const sec = parseFloat(m[1].replace(/s$/i, '')) || 0;
                    const min = Math.floor(sec / 60);
                    const s = (sec % 60).toFixed(2);
                    const timeTag = `[${String(min).padStart(2, '0')}:${s.padStart(5, '0')}]`;
                    const text = m[2].replace(/<[^>]+>/g, '').trim();
                    if (text) lines.push(`${timeTag} ${text}`);
                  }
                  content = lines.length > 0 ? lines.join('\n') : rawTtml.replace(/<[^>]+>/g, '').trim();
                }
                if (content && content.trim()) {
                  const lBlob = new Blob([content], { type: 'text/plain;charset=utf-8' });
                  const lUrl = URL.createObjectURL(lBlob);
                  const la = document.createElement('a');
                  la.href = lUrl;
                  la.download = `${cleanArtist} - ${cleanTitle}.${ext}`;
                  document.body.appendChild(la);
                  la.click();
                  la.remove();
                  setTimeout(() => URL.revokeObjectURL(lUrl), 8000);
                }
              }
            }
          } catch {}
        }

        await new Promise(r => setTimeout(r, 1200));
      } catch (err) {
        if (batchSig.aborted) break;
        console.warn(`[Batch DL] 下载《${songTitle}》失败:`, err.message);
      }
    }

    if (batchProgressFill) batchProgressFill.style.width = '100%';
    setTimeout(() => { if (batchCard) batchCard.hidden = true; }, 1500);
    toast(batchSig.aborted ? '已取消批量下载' : '🎉 全辑批量下载完成！');
  }

  if (!albumId) {
    showAlert('error', () => t('album.badId'));
  } else {
    loadAlbum();
    AmDecrypt.collectGarbage();
  }
}
