// 歌单页（/https://music.apple.com/{cc}/playlist/{slug}/pl.{id}），由 app.mjs 挂载
import { createActions, playable, targetOf, localPath, normalizeArtistName, toSimplified } from './actions.mjs';
import { createDetailHeader } from './detail-header.mjs';
import { downloadDecryptedTrack, saveBlob, saveTextFile, fetchSongMeta } from './local-download.mjs';

const { formatTime, qualityIcon } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'album-page playlist-page';

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  document.title = t('playlist.pageTitle');
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const pageUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = pageUrl.match(/music\.apple\.com\/([a-z]{2})\/playlist\/(?:[^/?#]+\/)?(pl\.[\w-]+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const playlistId = linkMatch[2];

  /** 当前歌单（amp-api playlists 资源）与其中的曲目 */
  let playlist = null;
  let tracks = [];
  // 头部的资料库按钮（官网的「+」）：把这个 Apple Music 歌单加入资料库
  const libraryTarget = () => (playlist ? targetOf(playlist, country, { collection: { resource: playlist, tracks } }) : null);
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
    const msg = typeof alertState.message === 'function' ? alertState.message() : alertState.message;
    // 支持 \n 分段渲染（如批量下载的逐首失败清单），单行时行为与原来完全一致
    if (typeof msg === 'string' && msg.includes('\n')) {
      a.replaceChildren(...msg.split('\n').map((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        return row;
      }));
    } else {
      a.textContent = msg;
    }
  }

  /* ---------- amp-api：与 music.apple.com 歌单页相同的 playlists 请求，经服务端 /amp 代理 ---------- */
  // l 按地区支持的语言选择，见 AmI18n.catalogLang
  /** 曲目字段：首次请求与 tracks 分页请求共用 */
  const TRACK_PARAMS = {
    'include[songs]': 'artists',
    'include[music-videos]': 'artists',
    'fields[artists]': 'name,artwork,url',
    'fields[songs]': 'name,artistName,curatorName,composerName,artwork,playParams,contentRating,albumName,url,durationInMillis,audioTraits,extendedAssetUrls',
    'fields[albums]': 'name,artwork,playParams,url',
  };
  const PLAYLIST_PARAMS = {
    platform: 'web',
    extend: 'offers,editorialArtwork,editorialVideo,trackCount',
    'art[url]': 'f',
    include: 'tracks,curator',
    'omit[resource]': 'autos',
    'limit[tracks]': '300',
    'fields[curators]': 'name,url',
    'fields[apple-curators]': 'name,url',
    'limit[view.more-by-curator]': '15',
    'limit[view.featured-artists]': '15',
    views: 'more-by-curator,featured-artists',
    ...TRACK_PARAMS,
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
    if (resource.type === 'playlists') {
      const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/([^/?#]+)\/(pl\.[\w-]+)/i);
      return m ? `/https://music.apple.com/${m[1].toLowerCase()}/playlist/${m[2]}/${m[3]}` : `/https://music.apple.com/${country}/playlist/_/${resource.id}`;
    }
    const kind = { songs: 'song', 'music-videos': 'music-video', albums: 'album', artists: 'artist' }[resource.type];
    const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|artist)\/([^/?#]+)\/(\d+)/i);
    if (m && m[2] === kind) return `/https://music.apple.com/${m[1].toLowerCase()}/${kind}/${m[3]}/${m[4]}`;
    // 歌单内曲目的 url 是 album/...?i=<id>，统一转成歌曲页
    const slug = url.match(/\/album\/([^/?#]+)\//);
    return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
  }

  /** 曲目所属专辑的本站页面路径：取自曲目 url（album/<slug>/<id>?i=...） */
  function albumPath(track) {
    const m = ((track.attributes && track.attributes.url) || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/(\d+)/i);
    return m ? `/https://music.apple.com/${m[1].toLowerCase()}/album/${m[2]}/${m[3]}` : '';
  }

  /** description / editorialNotes 是 HTML，只取纯文本 */
  function plainText(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  }

  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? ''
      : new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(date);
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });

  /** 编辑歌单的封面在 editorialArtwork.staticDetailSquare，用户歌单只有 artwork */
  function coverArtwork() {
    const a = playlist.attributes;
    return (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork;
  }

  /* ---------- 渲染 ---------- */
  function renderHero() {
    const a = playlist.attributes;
    document.title = `${a.name} · am-hook`;
    $('title').classList.remove('skeleton');
    $('title').textContent = a.name;

    // 歌单作者：编辑歌单是 Apple Music 或某个策展人（curator / apple-curator / 艺人），链接到本站的策展人页或艺人页；
    // 本站打不开的地址才链接到 Apple Music
    const curator = ((playlist.relationships && playlist.relationships.curator && playlist.relationships.curator.data) || [])[0];
    const curatorName = (curator && curator.attributes && curator.attributes.name) || a.curatorName || '';
    const curatorUrl = curator && curator.attributes && curator.attributes.url;
    const curatorPath = localPath(curatorUrl)
      || (curator && ['curators', 'apple-curators'].includes(curator.type) && /^\d+$/.test(curator.id) ? `/https://music.apple.com/${country}/curator/_/${curator.id}` : '');
    $('artist').classList.remove('skeleton');
    $('artist').replaceChildren(curatorPath ? el('a', { href: curatorPath, textContent: curatorName })
      : curatorUrl ? el('a', { href: curatorUrl, target: '_blank', rel: 'noreferrer', textContent: curatorName })
      : curatorName);

    const updated = a.lastModifiedDate ? formatDate(a.lastModifiedDate) : '';
    $('sub').textContent = updated ? t('playlist.updated', { date: updated }) : '';

    const traits = a.audioTraits || [];
    const badges = [];
    if (traits.includes('hi-res-lossless')) badges.push('hires');
    else if (traits.includes('lossless')) badges.push('lossless');
    if (traits.includes('atmos')) badges.push('atmos');
    $('badges').replaceChildren(...badges.map((key) => qualityIcon(key)));

    const desc = a.description || a.editorialNotes || {};
    const notes = plainText(desc.standard || desc.short || '');
    $('notes').hidden = !notes;
    $('hero').classList.toggle('no-notes', !notes);
    $('notes-text').textContent = notes;
    $('notes').classList.toggle('expanded', notesExpanded);
    requestAnimationFrame(() => {
      const text = $('notes-text');
      $('notes-more').hidden = !notesExpanded && text.scrollHeight <= text.clientHeight + 1;
      $('notes-more').textContent = t(notesExpanded ? 'album.less' : 'album.more');
    });

    renderHeader({ cover: coverArtwork(), attrs: a, alt: t('album.coverAlt', { title: a.name }) });
  }
  const renderHeader = createDetailHeader({ $, signal, artUrl, rerender: () => { if (playlist) renderHero(); } });

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

  /** 曲目行（官网 songs-list-row--playlist）：封面、歌名与艺人两行、专辑列、时长 */
  function renderTracks() {
    const chart = !!playlist.attributes.isChart;
    rows = new Map();
    const nodes = tracks.map((track, i) => {
      const a = track.attributes;
      const video = track.type === 'music-videos';
      // 尚未发行的曲目：与官网一样置灰，不能播放；歌曲页与专辑页在目录中查不到，不做链接
      const unavailable = !playable(track);
      const href = pagePath(track);

      const src = artUrl(a.artwork, 80);
      const cover = el('span', { className: `track-art${video ? ' mv' : ''}` },
        src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }),
        el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));
      let playBtn = null;
      if (!video && !unavailable) {
        playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play });
        playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
        playBtn.addEventListener('click', () => playTrack(track));
        cover.append(playBtn);
      }

      const title = el(unavailable ? 'span' : 'a', { className: 'track-title', textContent: a.name, ...(unavailable ? {} : { href }) });
      const main = el('div', { className: 'track-main' },
        el('div', { className: 'track-line' }, title, a.contentRating === 'explicit' ? explicitBadge() : '',
          video ? el('span', { className: 'track-kind', innerHTML: ICON.video, title: t('album.video') }) : null),
        el('div', { className: 'track-artist' }, ...trackArtists(track)));
      const albumHref = unavailable ? '' : albumPath(track);
      const albumCol = albumHref && a.albumName ? el('a', { className: 'track-album', href: albumHref, textContent: a.albumName })
        : el('span', { className: 'track-album', textContent: a.albumName || '' });
      // 「更多」菜单：播放按歌单顺序排队
      const more = actions.moreButton(targetOf(track, country, { albumHref, ...(video || unavailable ? {} : { onPlay: () => playTrack(track) }) }));

      const row = el('div', { className: `track pl-track${video ? ' video' : ''}${unavailable ? ' unavailable' : ''}` }, cover,
        chart ? el('span', { className: 'track-rank', textContent: String(i + 1) }) : null, main, albumCol,
        el('span', { className: 'track-time', textContent: a.durationInMillis ? formatTime(a.durationInMillis / 1000) : '' }), more);
      if (!video && !unavailable) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track); });
      rows.set(track.id, { row, playBtn });
      return row;
    });
    $('tracks').classList.toggle('chart', chart);
    $('tracks').replaceChildren(...nodes);
    $('tracks').hidden = false;
    $('play-all').disabled = $('shuffle').disabled = songs().length === 0;
    syncRows(player.current, !player.transport().paused);
  }

  function renderFooter() {
    const songCount = tracks.filter((track) => track.type === 'songs').length;
    const videoCount = tracks.length - songCount;
    const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.attributes.durationInMillis || 0), 0) / 60000);
    const length = minutes >= 60 ? t('album.hours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('album.minutes', { n: minutes });
    const line = [songCount && t('album.songs', { n: songCount }), videoCount && t('album.videos', { n: videoCount }), minutes && length]
      .filter(Boolean).join(AmI18n.lang === 'zh' ? '，' : ', ');
    $('footer').replaceChildren(...(line ? [el('p', { textContent: line })] : []));
    $('footer').hidden = !line;
  }

  /** 下方货架：与官网相同的 views（策展人的更多歌单、精选艺人），艺人链接到本站艺人页 */
  const VIEWS = ['more-by-curator', 'featured-artists'];
  function renderShelves() {
    const sections = [];
    for (const key of VIEWS) {
      const view = playlist.views && playlist.views[key];
      const items = ((view && view.data) || []).filter((res) => res.attributes && ['playlists', 'albums', 'artists'].includes(res.type));
      if (!items.length) continue;
      const shelf = el('div', { className: 'shelf' }, ...items.map((res) => {
        const a = res.attributes;
        const artist = res.type === 'artists';
        const src = artUrl(a.artwork, 360);
        const cover = el('span', { className: artist ? 'shelf-art artist' : 'shelf-art' },
          src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }));
        const sub = res.type === 'playlists' ? a.curatorName : a.artistName;
        const item = el('a', { className: artist ? 'shelf-item artist' : 'shelf-item', href: pagePath(res) },
          cover, el('span', { className: 'shelf-title', textContent: a.name }), artist ? null : el('span', { className: 'shelf-sub', textContent: sub || '' }));
        return actions.wrapCard(item, targetOf(res, country));
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

  async function loadPlaylist() {
    const token = ++loadToken;
    if (!playlist) showAlert('info', () => t('playlist.loading'));
    try {
      const l = await AmI18n.catalogLang(country);
      const data = await amp(`/v1/catalog/${country}/playlists/${playlistId}`, { l, ...PLAYLIST_PARAMS });
      const next = data.data && data.data[0];
      if (!next) throw new Error('empty response');
      const rel = next.relationships && next.relationships.tracks;
      let list = (rel && rel.data) || [];
      // 首次请求最多 300 首，其余分页获取
      for (let more = rel && rel.next; more;) {
        const page = await amp(more, { l, ...TRACK_PARAMS });
        list = list.concat(page.data || []);
        more = page.next;
      }
      if (token !== loadToken || signal.aborted) return;
      playlist = next;
      tracks = list.filter((track) => track.attributes);
      render();
      showAlert('', '');
      if ($('batch-gofile-btn')) $('batch-gofile-btn').disabled = !tracks.length;
      if ($('batch-dl-btn')) $('batch-dl-btn').disabled = !tracks.length;
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      showAlert('error', () => t('playlist.failed', { msg: err.message }));
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
      album: a.albumName || playlist.attributes.name,
      href: pagePath(track),
      albumHref: a.albumName ? albumPath(track) : '',
      artwork: artUrl(a.artwork || coverArtwork(), 600),
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
    if (playlist) render();
    if (playlistId) loadPlaylist();
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
  const batchSaveLrc = $('batch-save-lrc');
  const batchSaveTtml = $('batch-save-ttml');
  const batchTranslateLyrics = $('batch-translate-lyrics');
  const batchRubyLyrics = $('batch-ruby-lyrics');
  const batchRubyMode = $('batch-ruby-mode');

  if (batchLyricsFormat && localStorage.getItem('am_lyrics_fmt')) {
    batchLyricsFormat.value = localStorage.getItem('am_lyrics_fmt');
  }
  if (batchSaveLrc && localStorage.getItem('am_save_lrc') !== null) {
    batchSaveLrc.checked = localStorage.getItem('am_save_lrc') === 'true';
  }
  if (batchSaveTtml && localStorage.getItem('am_save_ttml') !== null) {
    batchSaveTtml.checked = localStorage.getItem('am_save_ttml') === 'true';
  }
  if (batchTranslateLyrics && localStorage.getItem('am_translate_lyr') !== null) {
    batchTranslateLyrics.checked = localStorage.getItem('am_translate_lyr') === 'true';
  }
  if (batchRubyLyrics && localStorage.getItem('am_ruby_lyr') !== null) {
    batchRubyLyrics.checked = localStorage.getItem('am_ruby_lyr') === 'true';
  }
  if (batchRubyMode && localStorage.getItem('am_ruby_mode') !== null) {
    batchRubyMode.value = localStorage.getItem('am_ruby_mode');
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
  const batchModalHint = $('batch-modal-hint');

  batchGofileBtn?.addEventListener('click', () => {
    currentBatchMode = 'gofile';
    if (batchModalTitle) batchModalTitle.textContent = '☁️ 转存歌单至 Gofile (VPS 2000M 极速)';
    if (batchZipPackContainer) batchZipPackContainer.hidden = false;
    if (batchModalHint) batchModalHint.innerHTML = '💡 Gofile 云端转存计入每日转存配额（200 首/IP/天）。开始前会自动检查剩余配额，不足时直接拦截。';
    batchModal?.showModal();
  });

  batchDlBtn?.addEventListener('click', () => {
    currentBatchMode = 'local';
    if (batchModalTitle) batchModalTitle.textContent = '📥 批量下载歌单到本机';
    if (batchZipPackContainer) batchZipPackContainer.hidden = true;
    if (batchModalHint) batchModalHint.innerHTML = '💡 本机批量下载在浏览器内解密并保存，同样计入每日转存配额（消耗服务器出站带宽）。';
    batchModal?.showModal();
  });

  batchModalConfirm?.addEventListener('click', () => {
    batchModal?.close();
    const q = batchQualitySelect ? batchQualitySelect.value : 'Lossless';
    const lyricsFormat = batchLyricsFormat ? batchLyricsFormat.value : 'lrc';
    const embedLyrics = lyricsFormat !== 'off';
    const saveFormats = [];
    if (batchSaveLrc?.checked) saveFormats.push('lrc');
    if (batchSaveTtml?.checked) saveFormats.push('ttml');
    const translateLyrics = batchTranslateLyrics ? batchTranslateLyrics.checked : false;
    const ruby = batchRubyLyrics ? batchRubyLyrics.checked : false;
    const rubyMode = batchRubyMode ? batchRubyMode.value : 'roman';
    const isZip = batchZipPack ? batchZipPack.checked : true;

    localStorage.setItem('am_lyrics_fmt', lyricsFormat);
    localStorage.setItem('am_save_lrc', String(batchSaveLrc?.checked || false));
    localStorage.setItem('am_save_ttml', String(batchSaveTtml?.checked || false));
    localStorage.setItem('am_translate_lyr', String(translateLyrics));
    localStorage.setItem('am_ruby_lyr', String(ruby));
    localStorage.setItem('am_ruby_mode', rubyMode);

    if (currentBatchMode === 'gofile') {
      runBatchGofile(q, embedLyrics, saveFormats, lyricsFormat, isZip, translateLyrics, ruby, rubyMode);
    } else {
      runBatchLocal(q, embedLyrics, saveFormats, lyricsFormat, translateLyrics, ruby, rubyMode);
    }
  });

  async function runBatchGofile(quality, embedLyrics, saveFormats, lyricsFormat, isZip = true, translateLyrics = false, ruby = false, rubyMode = 'roman') {
    if (!tracks.length) return;

    // 前置配额预检查：剩余配额不足以覆盖整单曲目时直接拦截，避免逐首打到撞墙浪费服务器资源
    try {
      const quotaRes = await fetch('/api/quota', { signal: AbortSignal.timeout(8000) });
      const quotaJson = await quotaRes.json();
      if (quotaJson.status === 'ok' && quotaJson.data && !quotaJson.data.unlimited) {
        const remaining = quotaJson.data.remaining;
        if (remaining < tracks.length) {
          toast(`⚠️ 今日转存配额不足：本歌单共 ${tracks.length} 首，今日仅剩 ${remaining} 首。请明日北京时间 00:00 后重试或缩小范围`);
          console.warn(`[Batch] 前置配额拦截: 歌单 ${tracks.length} 首 > 剩余 ${remaining} 首`);
          return;
        }
      }
    } catch (err) {
      console.warn('[Batch] 配额预检查失败(继续):', err.message);
    }

    batchAbortController = new AbortController();
    const batchSig = batchAbortController.signal;

    const plName = (playlist && playlist.attributes && playlist.attributes.name) || 'Apple Music 歌单';
    if (batchCard) batchCard.hidden = false;
    if (batchStatusTitle) batchStatusTitle.textContent = isZip
      ? `📦 正在极速打包压缩歌单《${plName}》为 .zip...`
      : `☁️ 正在通过 VPS 极速转存《${plName}》至 Gofile...`;
    if (batchProgressFill) batchProgressFill.style.width = '0%';
    if (batchStatusDetail) batchStatusDetail.textContent = `准备开始 (共 ${tracks.length} 首歌曲)...`;

    const batchSessionId = isZip ? `playlist_${playlistId || Date.now()}_${Date.now()}` : null;
    const zipFilename = `${toSimplified(plName)} [${quality}].zip`;
    const BATCH_CONCURRENCY = 3;
    // 整单额度只在下单时由服务端一次性预留；这里标记首个请求带上整单曲目数，
    // 避免逐首扣费导致「跑了一半才被告知额度不足」。
    let quotaTracksPending = tracks.length;
    let parentFolder = null;
    let guestToken = null;
    let finalDownloadPage = null;
    let successCount = 0;
    let failedCount = 0;
    const failedTracks = [];
    let finishedCount = 0;
    let lastTrackError = null;
    let finalizeError = null;
    let zipPartCount = 1;
    let batchAbortReason = null;

    const processSingleTrack = async (t, index) => {
      if (batchSig.aborted) return;
      const attr = t.attributes || {};
      const songTitle = attr.name || '未知曲目';
      try {
        const coverUrl = artUrl(attr.artwork || (playlist && playlist.attributes && playlist.attributes.artwork), 1400);
        // 只有第一个发出的请求携带整单曲目数，服务端据此一次性预留额度；
        // 并发工作池下用同步自增保证只有一个请求拿到该值。
        const quotaTracks = quotaTracksPending;
        quotaTracksPending = 0;
        const resp = await fetch('/api/cloud-transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adamId: t.id,
            quality,
            folderId: parentFolder,
            token: guestToken,
            batchId: batchSessionId,
            quotaTracks: quotaTracks || undefined,
            isLastTrack: false,
            zipFilename,
            meta: {
              title: attr.name,
              artist: attr.artistName || '',
              album: attr.albumName || plName,
              albumArtist: attr.artistName || '',
              date: attr.releaseDate || '',
              genre: (attr.genreNames && attr.genreNames[0]) || '',
              composer: attr.composerName || '',
              copyright: '',
              trackNumber: index + 1,
              totalTracks: tracks.length,
              discNumber: 1,
              totalDiscs: 1,
              coverUrl
            },
            embedLyrics,
            lyricsFormat: (lyricsFormat === 'ttml' || lyricsFormat === 'lrc') ? lyricsFormat : 'lrc',
            saveLyricsFormats: saveFormats.length ? saveFormats : undefined,
            saveLrc: saveFormats.length > 0,
            translateLyrics,
            ruby,
            rubyMode
          }),
          signal: batchSig
        });
        const resJson = await resp.json();
        if (resJson.status === 'ok' && resJson.data) {
          if (resJson.data.folderId && !parentFolder) parentFolder = resJson.data.folderId;
          if (resJson.data.guestToken && !guestToken) guestToken = resJson.data.guestToken;
          if (resJson.data.downloadPage) finalDownloadPage = resJson.data.downloadPage;
          successCount++;
        } else if (resp.status === 429 || /配额|上限|Too Many/i.test(resJson.error || '')) {
          // 配额不足：立即中止整批，明确报错（不留着继续跑浪费资源）
          const msg = resJson.error || '今日转存配额不足';
          batchAbortReason = msg;
          batchAbortController.abort();
          toast(`⚠️ ${msg}`);
          console.warn(`[Batch] 配额不足中止批量: ${msg}`);
          return;
        } else if (resJson.error) {
          // 单个曲目失败（地区无版权等）：计入失败数，但不中断整单；收集后写入包内 error.log
          failedCount++;
          lastTrackError = resJson.error;
          failedTracks.push({
            title: songTitle,
            artist: attr.artistName || '',
            album: attr.albumName || plName,
            error: resJson.error,
            adamId: t.id
          });
          console.warn(`[Batch] 歌单曲目《${songTitle}》转存失败:`, resJson.error);
        }
      } catch (err) {
        if (!batchSig.aborted) console.warn(`[Batch] 歌单曲目《${songTitle}》转存异常:`, err.message);
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
      // finalize 要打包并上传数 GB，耗时可达数分钟。这里不跟随 batchSig：
      // 一旦用户点取消或配额中止，不该把已经在跑的打包上传半途掐断（服务端会自己收尾）。
      let finalizeOk = false;
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
            // 失败曲目清单：服务端据此在压缩包内生成 error.log（全部成功则不生成）
            failedTracks: failedTracks.length ? failedTracks : undefined,
            meta: { album: plName }
          })
        });
        const finJson = await finResp.json();
        if (finJson.status === 'ok' && finJson.data) {
          if (finJson.data.downloadPage) finalDownloadPage = finJson.data.downloadPage;
          if (finJson.data.folderId) parentFolder = finJson.data.folderId;
          if (finJson.data.guestToken) guestToken = finJson.data.guestToken;
          zipPartCount = finJson.data.partCount || 1;
          finalizeOk = true;
        } else if (finJson.error) {
          finalizeError = finJson.error;
        }
      } catch (err) {
        // 连接被浏览器掐断（标签页后台/休眠/网络切换）时这里拿不到任何响应，
        // 但服务端可能已经成功。标记为「结果未知」，稍后补查而不是直接报失败。
        finalizeError = err.message;
        console.warn('[Batch] 打包直传请求中断，稍后补查结果:', err.message);
      }

      // 结果未知：用 batchId 向服务端补查成品链接（服务端有 2 小时结果留档）
      if (!finalizeOk && !finalDownloadPage) {
        if (batchStatusDetail) batchStatusDetail.textContent = '正在确认云端结果...';
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 15000));
          try {
            const q = await fetch(`/api/cloud-transfer-result?batchId=${encodeURIComponent(batchSessionId)}`, {
              signal: AbortSignal.timeout(10000)
            });
            const qj = await q.json();
            if (qj.status === 'ok' && qj.data) {
              if (qj.data.downloadPage) finalDownloadPage = qj.data.downloadPage;
              if (qj.data.folderId) parentFolder = qj.data.folderId;
              if (qj.data.guestToken) guestToken = qj.data.guestToken;
              zipPartCount = qj.data.partCount || 1;
              finalizeError = null;
              console.log('[Batch] 补查成功，已取回云端链接');
              break;
            }
          } catch {}
        }
      }
    }

    if (batchProgressFill) batchProgressFill.style.width = '100%';
    // 不再无条件隐藏进度卡片：成功时保留（用户切回来仍能看到结果），失败时也保留错误信息。
    // 只有用户主动取消才在 1.5 秒后收起。
    if (batchSig.aborted) {
      setTimeout(() => { if (batchCard) batchCard.hidden = true; }, 1500);
    }

    if (batchSig.aborted) {
      toast(batchAbortReason ? `⚠️ ${batchAbortReason}` : '已取消批量转存');
      return;
    }

    const shareUrl = finalDownloadPage || (parentFolder ? `https://gofile.io/d/${parentFolder}` : '');
    if (shareUrl) {
      const splitNote = zipPartCount > 1 ? `（单包超过 Gofile 4GB 上限，已自动切分为 ${zipPartCount} 卷）` : '';
      toast(isZip
        ? `🎉 歌单已成功转存至 Gofile${zipPartCount > 1 ? `（${zipPartCount} 卷）` : ''}！`
        : `🎉 歌单转存完成！共 ${successCount}/${tracks.length} 首曲目`);
      if (gofileLinkInput) gofileLinkInput.value = shareUrl;
      if (gofileOpenLink) gofileOpenLink.href = shareUrl;
      if (gofileSongInfo) {
        const failNote = failedCount ? `，${failedCount} 首失败（详见压缩包内 _INTERNAL_error.log.txt）` : '';
        gofileSongInfo.textContent = isZip
          ? `已成功将歌单《${plName}》打包：${zipFilename} (${successCount} 首完整曲目${saveFormats.length ? '与歌词' : ''}${failNote})${splitNote}`
          : `已成功将歌单《${plName}》(${successCount} 首歌曲) 归集至同一 Gofile 文件夹${failNote}`;
      }
      if (gofileCopyBtn) gofileCopyBtn.textContent = '复制链接';
      gofileDialog?.showModal();
    } else if (finalizeError) {
      // 保留失败原因在卡片上，不只靠 2.6 秒的 toast
      if (batchStatusTitle) batchStatusTitle.textContent = '⚠️ 转存未完成';
      if (batchStatusDetail) batchStatusDetail.textContent = finalizeError;
      toast(`⚠️ 转存失败：${finalizeError}`);
    } else if (lastTrackError && successCount === 0) {
      if (batchStatusTitle) batchStatusTitle.textContent = '⚠️ 转存未完成';
      if (batchStatusDetail) batchStatusDetail.textContent = lastTrackError;
      toast(`⚠️ 转存失败：${lastTrackError}`);
    } else {
      if (batchStatusTitle) batchStatusTitle.textContent = '⚠️ 转存未完成';
      if (batchStatusDetail) batchStatusDetail.textContent = '未能创建网盘链接，请稍后重试';
      toast('转存失败，未能创建网盘链接');
    }
  }

  async function runBatchLocal(quality, embedLyrics, saveFormats, lyricsFormat, translateLyrics = false, ruby = false, rubyMode = 'roman') {
    if (!tracks.length) return;

    // 本机批量下载同样消耗 VPS 出站带宽，预先扣除整批配额；不足直接拦截
    try {
      const consumeRes = await fetch('/api/quota/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: tracks.length }),
        signal: AbortSignal.timeout(8000)
      });
      if (consumeRes.status === 429) {
        const errJson = await consumeRes.json().catch(() => null);
        toast(errJson?.error || '⚠️ 今日转存配额不足，无法进行本机批量下载');
        return;
      }
      if (!consumeRes.ok) throw new Error(`配额预扣失败: HTTP ${consumeRes.status}`);
    } catch (err) {
      toast(`⚠️ 配额预扣失败: ${err.message}`);
      return;
    }

    batchAbortController = new AbortController();
    const batchSig = batchAbortController.signal;

    const plName = (playlist && playlist.attributes && playlist.attributes.name) || 'Apple Music 歌单';
    if (batchCard) batchCard.hidden = false;
    if (batchStatusTitle) batchStatusTitle.textContent = `📥 正在批量下载《${plName}》到本机...`;
    if (batchProgressFill) batchProgressFill.style.width = '0%';
    let okCount = 0;
    let failCount = 0;
    const failReasons = [];
    for (let i = 0; i < tracks.length; i++) {
      if (batchSig.aborted) break;
      const t = tracks[i];
      const attr = t.attributes || {};
      const songTitle = attr.name || '未知曲目';
      const pct = Math.floor((i / tracks.length) * 100);
      if (batchProgressFill) batchProgressFill.style.width = `${pct}%`;
      if (batchStatusDetail) batchStatusDetail.textContent = `(${i + 1}/${tracks.length}) 正在解密下载《${songTitle}》...`;

      try {
        const parseRes = await fetch(`/parse/song/${t.id}`, { signal: batchSig });
        const parseData = await parseRes.json();
        const variants = parseData.variants || [];
        if (!variants.length) {
          // 无可用音频流：通常是该曲在当前账号地区无版权/未上架
          failReasons.push({ title: songTitle, artist: attr.artistName || '', reason: '此歌曲在解析账号所属地区无可用音频流（可能无版权或未上架）' });
          continue;
        }

        let selected = variants.find(v => v.codecs === 'alac') || variants[0];
        if (quality === 'Hi-Res') {
          selected = variants.find(v => v.codecs === 'alac' && (v.sample_rate > 48000 || v.bit_depth > 16)) || selected;
        } else if (quality === 'Atmos') {
          selected = variants.find(v => v.codecs && v.codecs.includes('ec-3')) || selected;
        } else if (quality === 'AAC') {
          selected = variants.find(v => v.codecs && v.codecs.includes('mp4a')) || variants[0];
        }

        // 曲目 M4A 名称：优先用逐曲元数据（含华语名补全），失败退回歌单/曲目字段
        const base = (parseData.masterUrl || '').replace(/[^\/]+$/, '');
        const m3u8Url = base + selected.uri;
        let songMeta = null;
        try {
          songMeta = await fetchSongMeta(t.id, { country, simplify: toSimplified });
        } catch {}
        if (!songMeta) {
          songMeta = {
            title: toSimplified(songTitle),
            artist: normalizeArtistName(attr.artistName || ''),
            album: toSimplified(attr.albumName || ''),
            albumArtist: normalizeArtistName(attr.artistName || ''),
            trackNumber: attr.trackNumber,
            totalTracks: tracks.length,
            discNumber: attr.discNumber || 1,
            totalDiscs: 1,
            artwork: attr.artwork?.url
              ? attr.artwork.url.replace('{w}', 600).replace('{h}', 600).replace('{c}', 'bb').replace('{f}', 'jpg')
              : '',
            isChinese: false,
          };
        }

        const normArtist = normalizeArtistName(songMeta.artist || attr.artistName || '');
        const cleanArtist = normArtist.replace(/[\\/:*?"<>|]+/g, '_').trim();
        const cleanTitle = toSimplified(songMeta.title || songTitle).replace(/[\\/:*?"<>|]+/g, '_').trim();

        const fileName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.m4a`;

        // 浏览器端解密 + 标签/封面/歌词注入（与单曲页同一实现）
        const dl = await downloadDecryptedTrack({
          variant: selected,
          meta: songMeta,
          m3u8Url,
          trackId: t.id,
          lyricsOpts: { embedMode: lyricsFormat, saveFormats, translateOn: translateLyrics, rubyOn: ruby, rubyMode },
          simplify: toSimplified,
          signal: batchSig,
        });

        saveBlob(dl.blob, fileName);

        // 可选保存独立外挂歌词文件（按 saveFormats 多格式；无歌词则跳过）
        const lyricsData = dl.lyricsData;
        if (saveFormats.length && lyricsData && lyricsData.hasLyrics) {
          const stem = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}`;
          if (saveFormats.includes('lrc') && lyricsData.lrc) {
            saveTextFile(lyricsData.lrc, `${stem}.lrc`);
          }
          if (saveFormats.includes('ttml') && lyricsData.ttml) {
            saveTextFile(lyricsData.ttml, `${stem}.ttml`, 'application/xml;charset=utf-8');
          }
        }

        okCount++;
        await new Promise(r => setTimeout(r, 1200));
      } catch (err) {
        if (batchSig.aborted) break;
        failReasons.push({ title: songTitle, artist: attr.artistName || '', reason: err.message || '未知错误' });
        console.warn(`[Batch DL] 下载《${songTitle}》失败:`, err.message);
      }
    }

    if (batchProgressFill) batchProgressFill.style.width = '100%';
    setTimeout(() => { if (batchCard) batchCard.hidden = true; }, 1500);

    if (batchSig.aborted) {
      toast('已取消批量下载');
      return;
    }
    failCount = failReasons.length;
    if (!failCount) {
      toast('🎉 歌单批量下载完成！');
      return;
    }
    // 逐首明确告知失败原因，而不是只报一个总数
    const brief = failReasons
      .slice(0, 3)
      .map((f) => `《${f.title}》(${f.reason})`)
      .join('；');
    toast(`⚠️ 成功 ${okCount} 首，失败 ${failReasons.length} 首：${brief}${failReasons.length > 3 ? '…' : ''}`);
    // 完整清单写到页内常驻提示条（不会被 Toast 2.6 秒自动吞掉）
    const lines = failReasons.map((f, idx) => `${idx + 1}. 《${f.title}》${f.artist ? ' - ' + f.artist : ''}：${f.reason}`);
    showAlert('error', () => `本机下载完成：成功 ${okCount} 首，失败 ${failReasons.length} 首\n${lines.join('\n')}`);
    console.warn('[Batch DL] 失败明细:', failReasons);
  }

  if (!playlistId) {
    showAlert('error', () => t('playlist.badId'));
  } else {
    loadPlaylist();
    AmDecrypt.collectGarbage();
  }
}
