// 各页面共用的条目操作（与 music.apple.com 相同）：封面悬停时的「播放」「更多」按钮、曲目行的「更多」菜单，
// 菜单项有播放、打开、复制本站链接与 Apple Music 链接。整张专辑 / 歌单的播放在这里取曲目后交给播放器队列。
//
// 菜单里还有资料库操作（与 music.apple.com 相同）：添加到资料库 / 从资料库中删除、添加到歌单（子菜单），见 library.mjs。
//
// 条目 target：{ kind, href, apple, name, country, resource?, albumHref?, onPlay?, track?, collection?, getTracks?, extraItems? }
//   kind：song / music-video / album / playlist / artist / library-playlist（本地歌单）；href：本站页面路径（/https://music.apple.com/...）；
//   apple：Apple Music 原始地址；resource：amp-api 资源（歌曲单独播放时用来生成队列条目）；
//   albumHref：曲目所属专辑的本站路径（菜单里的「前往专辑」）；onPlay：页面自己的播放方式（如按专辑顺序播放）；
//   track：资料库中的曲目快照（没有 resource 时用它加入资料库、歌单）；collection：页面已取到的专辑 / 歌单 { resource, tracks }，
//   加入资料库或歌单时不再重新请求；getTracks()：要加入歌单的曲目快照（本地歌单用）；playlistId：「添加到歌单」里不列出的歌单；
//   extraItems：页面自己的菜单项（如「从歌单中删除」）；noPlay：菜单里不列出「播放」（正在播放的歌曲）
import * as library from '/assets/library.mjs';
import { LIB_ICON, playlistMenuItems, moveMenuItems } from './library-ui.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3c2.2 0 3.4 1 4.5 2.8l3 4.4C14.6 16 15.8 17 18 17h2.5"/><path d="M3 17h3c1.6 0 2.7-.6 3.6-1.6M14.4 8.6C15.3 7.6 16.4 7 18 7h2.5"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/></svg>',
  quality: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
  album: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/* ---------- amp-api 与资源 ---------- */
async function amp(path, params) {
  const url = new URL('/amp' + path, location.origin);
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

function artUrl(artwork, w) {
  return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', w).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
}

const KINDS = { songs: 'song', 'music-videos': 'music-video', albums: 'album', playlists: 'playlist', artists: 'artist' };

/** 目录资源 → 本站页面路径；歌曲的 url 是 album/...?i=<id>，统一转成歌曲页 */
export function pagePath(resource, country) {
  const url = (resource.attributes && resource.attributes.url) || '';
  if (resource.type === 'playlists') {
    const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/([^/?#]+)\/(pl\.[\w-]+)/i);
    return m ? `/https://music.apple.com/${m[1].toLowerCase()}/playlist/${m[2]}/${m[3]}` : `/https://music.apple.com/${country}/playlist/_/${resource.id}`;
  }
  const kind = KINDS[resource.type];
  const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|artist)\/([^/?#]+)\/(\d+)/i);
  if (m && m[2] === kind) return `/https://music.apple.com/${m[1].toLowerCase()}/${kind}/${m[3]}/${m[4]}`;
  const slug = url.match(/\/album\/([^/?#]+)\//);
  return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
}

/** 本站能打开的 Apple Music 页面（与 app.mjs 的路由相同），艺人与策展人链接用 */
const LOCAL_LINK = /^https:\/\/music\.apple\.com\/[a-z]{2}\/(?:(?:song|music-video)\/[^/?#]+\/\d+|post\/(?:[^/?#]+\/)?\d+|(?:album|artist|curator)\/(?:[^/?#]+\/)?\d+|playlist\/(?:[^/?#]+\/)?pl\.[\w-]+|(?:room|multi-room|grouping)\/\d+)$/i;

/** Apple Music 地址 → 本站页面路径；本站打不开时为 '' */
export function localPath(url) {
  const m = String(url || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})(\/[^?#]*)/i);
  if (!m) return '';
  const clean = `https://music.apple.com/${m[1].toLowerCase()}${m[2].replace(/\/$/, '')}`;
  return LOCAL_LINK.test(clean) ? '/' + clean : '';
}

/**
 * 艺人行：在 artistName 中依次找到各关联艺人的名字并链接到艺人页，分隔符（&、逗号、feat. 等）保留为文字；
 * 没有关联艺人时整行链接到 artistUrl（专辑等）
 */
export function artistLinks(resource, country) {
  const a = resource.attributes || {};
  const name = a.artistName || '';
  const artists = ((resource.relationships && resource.relationships.artists && resource.relationships.artists.data) || [])
    .filter((artist) => artist.attributes && artist.attributes.name);
  const parts = [];
  let pos = 0;
  for (const artist of artists) {
    const i = name.indexOf(artist.attributes.name, pos);
    if (i < 0) continue;
    if (i > pos) parts.push(name.slice(pos, i));
    parts.push(el('a', { href: pagePath(artist, country), textContent: artist.attributes.name }));
    pos = i + artist.attributes.name.length;
  }
  if (!parts.length && name && localPath(a.artistUrl)) return [el('a', { href: localPath(a.artistUrl), textContent: name })];
  if (pos < name.length) parts.push(name.slice(pos));
  return parts;
}

/** 能否播放：尚未发行的曲目（如歌单里的预告曲目）只有名称、封面等少数字段，没有 playParams，目录中也查不到 */
export function playable(resource) {
  return !!(resource.attributes && resource.attributes.playParams);
}

/** 曲目所属专辑的本站路径：关联专辑，没有时取曲目 url 里的 album/<slug>/<id> */
export function albumPathOf(track) {
  const album = track.relationships && track.relationships.albums && track.relationships.albums.data && track.relationships.albums.data[0];
  if (album && album.attributes) return pagePath(album, 'us');
  const m = ((track.attributes && track.attributes.url) || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/(\d+)/i);
  return m ? `/https://music.apple.com/${m[1].toLowerCase()}/album/${m[2]}/${m[3]}` : '';
}

/** 资源 → 条目；extra 覆盖默认值（如 albumHref、onPlay） */
export function targetOf(resource, country, extra = {}) {
  const href = pagePath(resource, country);
  const a = resource.attributes || {};
  return { kind: KINDS[resource.type], href, apple: a.url || href.slice(1), name: a.name || '', country, resource, ...extra };
}

/** 歌曲资源 → 播放队列条目（见 AmPlayer.playQueue）；context 为专辑 / 歌单时补上专辑名与封面 */
export function songEntry(track, country, context = {}) {
  const a = track.attributes;
  return {
    track: track.id,
    country,
    name: a.name,
    artist: a.artistName,
    artists: ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name)
      .map((artist) => ({ name: artist.attributes.name, href: pagePath(artist, country) })),
    album: a.albumName || context.album || '',
    href: pagePath(track, country),
    albumHref: context.albumHref || (a.albumName ? albumPathOf(track) : ''),
    artwork: artUrl(a.artwork || context.artwork, 600),
    duration: a.durationInMillis || 0,
  };
}

/**
 * 正在播放的歌曲（AmPlayer 的 current）→ 条目，歌词界面标题旁的喜爱与「更多」用；没有歌曲时为 null。
 * 先用播放队列里的信息拼出曲目快照（封面地址还原为 {w}x{h} 模板），之后可用 songTarget() 换成完整资源
 */
export function nowPlayingTarget(current) {
  if (!current || !current.track) return null;
  const href = current.href || '';
  const albumHref = current.albumHref || '';
  return {
    kind: 'song', href, apple: href.slice(1), name: current.title || '', country: current.country, albumHref, noPlay: true,
    track: {
      kind: 'song', id: current.track, country: current.country, name: current.title || '', artist: current.artist || '',
      artists: current.artists || [], album: current.album || '', albumId: (albumHref.match(/\/(\d+)$/) || [])[1] || '', albumHref, href,
      artwork: (current.artwork || '').replace(/\/\d+x\d+(\w*)\.(jpg|png|webp)$/, '/{w}x{h}$1.$2'), bgColor: '', duration: 0, explicit: false,
    },
  };
}

/** 歌曲 id → 条目（含 amp-api 资源，曲目快照因此有时长、分级等完整信息）；名称按曲库语言返回 */
export async function songTarget(id, country) {
  const l = await Promise.resolve(AmI18n.catalogLang(country)).catch(() => undefined);
  const data = await amp(`/v1/catalog/${country}/songs/${id}`, { include: 'albums,artists', l });
  const song = data.data && data.data[0];
  if (!song || !song.attributes) throw new Error('not found');
  return targetOf(song, country, { albumHref: albumPathOf(song), noPlay: true });
}

/** 歌曲 / MV 资源 → 资料库曲目快照（见 library.mjs）；album 为所属专辑资源（专辑页的曲目没有专辑字段时补上） */
export function snapshotOf(track, country, album) {
  const a = track.attributes || {};
  const albumHref = album ? pagePath(album, country) : albumPathOf(track);
  const artwork = a.artwork || (album && album.attributes && album.attributes.artwork) || {};
  return {
    kind: KINDS[track.type],
    id: track.id,
    country,
    name: a.name || '',
    artist: a.artistName || '',
    artists: ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name)
      .map((artist) => ({ name: artist.attributes.name, href: pagePath(artist, country) })),
    album: a.albumName || (album && album.attributes && album.attributes.name) || '',
    albumId: (albumHref.match(/\/(\d+)$/) || [])[1] || '',
    albumHref,
    href: pagePath(track, country),
    artwork: artwork.url || '',
    bgColor: artwork.bgColor || '',
    duration: a.durationInMillis || 0,
    explicit: a.contentRating === 'explicit',
  };
}

/** 专辑 / 歌单资源 → 资料库条目 */
function collectionRecord(res, country) {
  const a = res.attributes || {};
  const href = pagePath(res, country);
  if (res.type === 'playlists') {
    const artwork = (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork || {};
    return { kind: 'playlist', id: res.id, country, name: a.name, curator: a.curatorName || '', href, artwork: artwork.url || '', bgColor: artwork.bgColor || '' };
  }
  const artist = ((res.relationships && res.relationships.artists && res.relationships.artists.data) || [])[0];
  return {
    kind: 'album', id: res.id, country, name: a.name, artist: a.artistName || '',
    artistHref: artist && artist.attributes ? pagePath(artist, country) : '', href,
    artwork: (a.artwork && a.artwork.url) || '', bgColor: (a.artwork && a.artwork.bgColor) || '',
    releaseDate: a.releaseDate || '', trackCount: a.trackCount || 0,
  };
}

/** 专辑 / 歌单的资源与全部曲目（分页取完）：{ country, resource, tracks }；页面已取到时（target.collection）直接使用 */
async function fetchCollection(target) {
  const m = target.href.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/(album|playlist)\/(?:[^/?#]+\/)?([^/?#]+)/i);
  if (!m) return null;
  const country = m[1].toLowerCase();
  if (target.collection && target.collection.resource) return { country, ...target.collection };
  const playlist = m[2] === 'playlist';
  const l = await AmI18n.catalogLang(country);
  const trackParams = { l, 'include[songs]': 'artists', 'include[music-videos]': 'artists', 'fields[artists]': 'name,url' };
  const data = await amp(`/v1/catalog/${country}/${playlist ? 'playlists' : 'albums'}/${m[3]}`, {
    platform: 'web', include: playlist ? 'tracks' : 'tracks,artists', ...(playlist ? { 'limit[tracks]': '300' } : {}), ...trackParams,
  });
  const res = data.data && data.data[0];
  if (!res) return null;
  const rel = res.relationships && res.relationships.tracks;
  let list = (rel && rel.data) || [];
  for (let more = rel && rel.next, pages = 0; more && pages < 20; pages++) {
    const page = await amp(more, trackParams);
    list = list.concat(page.data || []);
    more = page.next;
  }
  return { country, resource: res, tracks: list };
}

/** 专辑 / 歌单的全部歌曲，MV 与无法播放的曲目跳过 */
async function collectionEntries(target) {
  const c = await fetchCollection(target);
  if (!c) return [];
  const res = c.resource;
  const a = res.attributes || {};
  const context = res.type === 'playlists'
    ? { album: a.name, artwork: (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork }
    : { album: a.name, albumHref: pagePath(res, c.country), artwork: a.artwork };
  return c.tracks.filter((track) => track.type === 'songs' && playable(track)).map((track) => songEntry(track, c.country, context));
}

/** 专辑 / 歌单中可以加入资料库、歌单的曲目快照（歌曲与 MV，尚未发行的跳过） */
function collectionSnapshots(c) {
  const album = c.resource.type === 'albums' ? c.resource : null;
  return c.tracks.filter((track) => (track.type === 'songs' || track.type === 'music-videos') && playable(track))
    .map((track) => snapshotOf(track, c.country, album));
}

/** 条目在资料库中的 kind 与 id；不能加入资料库的条目为 null */
function libraryKey(target) {
  if (!['song', 'music-video', 'album', 'playlist'].includes(target.kind)) return null;
  if (target.track) return { kind: target.track.kind, id: target.track.id };
  if (target.resource) return { kind: target.kind, id: target.resource.id };
  const m = (target.href || '').match(target.kind === 'playlist' ? /\/(pl\.[\w-]+)$/ : /\/(\d+)$/);
  return m ? { kind: target.kind, id: m[1] } : null;
}

/**
 * 喜爱用的键：本地歌单为 { local: true, id }，艺人为 { kind: 'artist', id }，其余与 libraryKey 相同；不能喜爱时为 null
 */
function favoriteKey(target) {
  if (target.kind === 'library-playlist') return target.playlistId ? { local: true, id: target.playlistId } : null;
  if (target.kind === 'artist') {
    const id = target.resource ? target.resource.id : ((target.href || '').match(/\/(\d+)$/) || [])[1];
    return id ? { kind: 'artist', id } : null;
  }
  return libraryKey(target);
}

/** 加入资料库的条目：歌曲 / MV 为自身；专辑连同全部曲目（与 Apple Music 相同）；Apple Music 歌单只有歌单本身；艺人为艺人条目 */
async function libraryRecords(target) {
  if (target.kind === 'song' || target.kind === 'music-video') {
    const track = target.track || (target.resource && snapshotOf(target.resource, target.country));
    if (!track) throw new Error('no metadata');
    return [track];
  }
  if (target.kind === 'artist') {
    const key = favoriteKey(target);
    const a = (target.resource && target.resource.attributes) || {};
    return [{ kind: 'artist', id: key.id, country: target.country, name: a.name || target.name, href: target.href, artwork: (a.artwork && a.artwork.url) || target.artwork || '' }];
  }
  const c = await fetchCollection(target);
  if (!c) throw new Error('not found');
  const records = [collectionRecord(c.resource, c.country)];
  if (target.kind === 'album') records.push(...collectionSnapshots(c));
  return records;
}

/** 加入资料库，返回新增数量 */
async function addTargetToLibrary(target) {
  return library.addToLibrary(await libraryRecords(target));
}

/** 要加入歌单的曲目快照 */
async function targetTracks(target) {
  if (target.getTracks) return target.getTracks();
  if (target.kind === 'song' || target.kind === 'music-video') {
    const track = target.track || (target.resource && snapshotOf(target.resource, target.country));
    return track ? [track] : [];
  }
  const c = await fetchCollection(target);
  return c ? collectionSnapshots(c) : [];
}

/* ---------- 复制 ---------- */
function copyText(text, done) {
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

/* ---------- 弹出菜单：整站一个，fixed 定位，避免被列表 overflow 裁剪 ---------- */
const menu = { el: null, trigger: null, player: null };

function menuEl() {
  if (menu.el) return menu.el;
  menu.el = el('div', { className: 'menu', role: 'menu', hidden: true });
  document.body.append(menu.el);
  menu.el.addEventListener('keydown', (e) => {
    const items = [...menu.el.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.trigger && !menu.el.contains(e.target) && !menu.trigger.contains(e.target)) closeMenu(false);
  });
  addEventListener('resize', () => closeMenu(false));
  addEventListener('scroll', (e) => {
    if (!menu.trigger || menu.el.contains(e.target)) return;
    if (matchMedia('(max-width: 760px)').matches) positionMenu();
    else closeMenu(false);
  }, { capture: true });
  return menu.el;
}

function closeMenu(focusTrigger) {
  if (!menu.trigger) return;
  menu.el.hidden = true;
  menu.trigger.setAttribute('aria-expanded', 'false');
  menu.trigger.closest('.card-wrap, .row-wrap')?.classList.remove('menu-open');
  if (focusTrigger) menu.trigger.focus();
  menu.trigger = null;
}

/**
 * items：'-' 分隔线，或 { icon, label, hint?, title?, onSelect }；hint 为第二行小字，title 为悬停提示（如完整链接）；
 * 带 submenu()（返回子菜单项）的项点击后在原位置换成子菜单，第一项「‹ 名称」返回上一级（如「添加到歌单」）
 */
export function openMenu(trigger, items) {
  const box = menuEl();
  const reopen = menu.trigger === trigger;
  closeMenu(false);
  if (reopen) return;
  box.hidden = false;
  menu.trigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  // 菜单打开期间封面上的按钮保持显示
  trigger.closest('.card-wrap, .row-wrap')?.classList.add('menu-open');
  fillMenu(items);
}

function fillMenu(items) {
  const box = menu.el;
  box.replaceChildren(...items.map((it) => {
    if (it === '-') return el('div', { className: 'menu-sep', role: 'separator' });
    const node = el('button', { className: `menu-item${it.back ? ' menu-back' : ''}${it.danger ? ' danger' : ''}`, type: 'button', innerHTML: it.icon, tabIndex: -1 });
    node.setAttribute('role', 'menuitem');
    if (it.submenu) node.setAttribute('aria-haspopup', 'menu');
    node.append(el('span', { className: 'menu-text' }, el('span', { className: 'menu-label', textContent: it.label }),
      it.hint ? el('span', { className: 'menu-hint', textContent: it.hint }) : null));
    if (it.title) node.title = it.title;
    node.addEventListener('click', () => {
      if (it.submenu) {
        fillMenu([{ icon: LIB_ICON.back, label: it.label, back: true, onSelect: () => fillMenu(items) }, '-', ...it.submenu()]);
        return;
      }
      if (it.back) { it.onSelect(); return; }
      closeMenu(false);
      it.onSelect();
    });
    return node;
  }));
  // 换成子菜单后高度变了，重新定位
  box.style.maxHeight = '';
  positionMenu();
  box.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
}

/** 与歌曲页的菜单相同：手机上贴底显示；否则右对齐触发按钮，朝空间大的一侧展开 */
function positionMenu() {
  const box = menu.el;
  if (matchMedia('(max-width: 760px)').matches) {
    const viewport = window.visualViewport;
    const top = viewport ? viewport.offsetTop : 0;
    const height = viewport ? viewport.height : innerHeight;
    box.style.maxHeight = `${Math.max(80, height - 32)}px`;
    box.style.left = '12px';
    box.style.top = `${top + height - box.getBoundingClientRect().height - 16}px`;
    return;
  }
  const r = menu.trigger.getBoundingClientRect();
  box.style.maxHeight = '';
  const m = box.getBoundingClientRect();
  const bottom = Math.min(innerHeight, menu.player ? menu.player.barTop() : innerHeight) - 8;
  const below = bottom - r.bottom - 6;
  const above = r.top - 6 - 8;
  const down = below >= m.height || below >= above;
  const height = Math.min(m.height, down ? below : above);
  if (height < m.height) box.style.maxHeight = `${height}px`;
  box.style.top = `${Math.max(8, down ? r.bottom + 6 : r.top - 6 - height)}px`;
  box.style.left = `${Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8)}px`;
}

/**
 * 页面挂载时调用：ctx 为 mount 的 { signal, player, navigate, toast }。
 * 返回 moreButton（曲目行末尾的「更多」）、coverActions / wrapCard（封面悬停按钮）、wrapRow（搜索结果行加播放与更多）。
 */
export function createActions({ signal, player, navigate, toast }) {
  menu.player = player;
  signal.addEventListener('abort', () => closeMenu(false), { once: true });

  const playable = (target) => ['song', 'album', 'playlist', 'music-video', 'library-playlist'].includes(target.kind)
    && (target.kind !== 'song' || target.onPlay || target.resource || target.track)
    && (target.kind !== 'library-playlist' || !!target.onPlay);

  async function play(target, button, shuffle = false) {
    if (target.kind === 'music-video') { navigate(target.href); return; }
    if (target.onPlay) { target.onPlay(); return; }
    if (target.kind === 'song') { player.playQueue([target.resource ? songEntry(target.resource, target.country) : library.entryOf(target.track)], 0); return; }
    if (button) button.classList.add('busy');
    try {
      // 离开页面后取回的曲目照样播放：播放条常驻
      const entries = await collectionEntries(target);
      if (!entries.length) { toast(t('action.noSongs', { name: target.name })); return; }
      player.playQueue(entries, shuffle ? Math.floor(Math.random() * entries.length) : 0, { shuffle });
    } catch (err) {
      toast(t('action.failed', { msg: err.message }));
    } finally {
      if (button) button.classList.remove('busy');
    }
  }

  function copy(url) {
    copyText(url, () => toast(t('action.copied')));
  }

  /** 加入 / 移出资料库；busy 为请求曲目期间显示忙碌的按钮 */
  async function toggleLibrary(target, busy) {
    const key = libraryKey(target);
    if (!key) return;
    if (library.inLibrary(key.kind, key.id)) {
      library.removeFromLibrary(key.kind, key.id);
      toast(t('library.removedFrom', { name: target.name }));
      return;
    }
    if (busy) busy.classList.add('busy');
    try {
      await addTargetToLibrary(target);
      toast(t('library.addedToLibrary', { name: target.name }));
    } catch (err) {
      toast(t('library.failed', { msg: err.message }));
    } finally {
      if (busy) busy.classList.remove('busy');
    }
  }

  const favoriteOf = (key) => !!key && (key.local ? !!(library.playlist(key.id) || {}).favorite : library.isFavorite(key.kind, key.id));

  /** 喜爱 / 取消喜爱（与 Apple Music 相同，喜爱时同时加入资料库）；busy 为请求曲目期间显示忙碌的按钮 */
  async function toggleFavorite(target, busy) {
    const key = favoriteKey(target);
    if (!key) return;
    const on = !favoriteOf(key);
    if (key.local) {
      library.setPlaylistFavorite(key.id, on);
    } else {
      if (busy) busy.classList.add('busy');
      try {
        // 已在资料库中时不必再取曲目
        const records = on && !library.libraryItem(key.kind, key.id) ? await libraryRecords(target) : [];
        library.setFavorite(key.kind, key.id, on, records);
      } catch (err) {
        toast(t('library.failed', { msg: err.message }));
        return;
      } finally {
        if (busy) busy.classList.remove('busy');
      }
    }
    toast(t(on ? 'library.favoritedName' : 'library.unfavoritedName', { name: target.name }));
  }

  /** 资料库菜单项：喜爱 / 取消喜爱、添加到资料库 / 从资料库中删除、添加到歌单（子菜单）、移到文件夹（子菜单） */
  function libraryItems(target, button) {
    const items = [];
    const fav = favoriteKey(target);
    if (fav) {
      const on = favoriteOf(fav);
      items.push({ icon: on ? LIB_ICON.star : LIB_ICON.starFilled, label: t(on ? 'library.unfavorite' : 'library.favorite'), onSelect: () => toggleFavorite(target, button) });
    }
    const key = libraryKey(target);
    if (key) {
      const has = library.inLibrary(key.kind, key.id);
      items.push({ icon: has ? LIB_ICON.remove : LIB_ICON.add, label: t(has ? 'library.remove' : 'library.add'), onSelect: () => toggleLibrary(target, button) });
    }
    if (key || target.getTracks) {
      items.push({
        icon: LIB_ICON.addToPlaylist, label: t('library.addToPlaylist'),
        submenu: () => playlistMenuItems(() => targetTracks(target), { toast, navigate, except: target.playlistId }),
      });
    }
    // 移到文件夹：本地歌单、文件夹（页面给出 moveEntry），以及已添加到资料库的 Apple Music 歌单
    const catalog = key && key.kind === 'playlist' && library.libraryItem('playlist', key.id);
    const entry = target.moveEntry || (catalog ? { type: 'catalog', id: key.id } : null);
    if (entry) {
      const current = entry.type === 'folder' ? (library.folder(entry.id) || {}).parentId
        : entry.type === 'playlist' ? (library.playlist(entry.id) || {}).folderId : catalog.folderId;
      items.push({ icon: LIB_ICON.move, label: t('library.moveToFolder'), submenu: () => moveMenuItems(entry, current || '', { toast }) });
    }
    return items;
  }

  function menuItems(target, button) {
    const items = [];
    if (target.kind === 'music-video') items.push({ icon: ICON.video, label: t('action.playMv'), onSelect: () => navigate(target.href) });
    else if (playable(target) && !target.noPlay) items.push({ icon: ICON.play, label: t('action.play'), onSelect: () => play(target, button) });
    if (target.kind === 'album' || target.kind === 'playlist' || target.onShuffle) {
      items.push({ icon: ICON.shuffle, label: t('action.shuffle'), onSelect: () => (target.onShuffle ? target.onShuffle() : play(target, button, true)) });
    }
    if (target.kind === 'song') items.push({ icon: ICON.quality, label: t('album.quality'), onSelect: () => navigate(target.href) });
    if (target.albumHref) items.push({ icon: ICON.album, label: t('action.goAlbum'), onSelect: () => navigate(target.albumHref) });
    const lib = libraryItems(target, button);
    if (lib.length) items.push(...(items.length ? ['-'] : []), ...lib);
    if (target.extraItems && target.extraItems.length) items.push(...(items.length ? ['-'] : []), ...target.extraItems);
    // 本地歌单没有 Apple Music 链接
    if (!target.href || !target.apple) return items;
    if (items.length) items.push('-');
    const site = location.origin + target.href;
    items.push(
      { icon: ICON.link, label: t('action.copySite'), title: site, onSelect: () => copy(site) },
      { icon: ICON.apple, label: t('action.copyApple'), title: target.apple, onSelect: () => copy(target.apple) });
    return items;
  }

  /** 「更多」按钮；target 也可以是返回当前条目的函数（如歌词界面里正在播放的歌曲），返回 null 时不弹出菜单 */
  function moreButton(target, className = 'track-more') {
    const button = el('button', { className, type: 'button', innerHTML: ICON.more, title: t('action.more') });
    button.setAttribute('aria-label', typeof target === 'function' ? t('action.more') : t('action.moreFor', { name: target.name }));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const current = typeof target === 'function' ? target() : target;
      if (current) openMenu(button, menuItems(current, button));
    });
    return button;
  }

  function playButton(target, className) {
    const button = el('button', { className, type: 'button', innerHTML: ICON.play });
    button.setAttribute('aria-label', t('album.playTrack', { name: target.name }));
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      play(target, button);
    });
    return button;
  }

  /** 叠在封面上的按钮：左下「播放」、右下「更多」；艺人只有「更多」。放在 .card-wrap 里，悬停时显示 */
  function coverActions(target) {
    const actions = el('div', { className: 'cover-actions' });
    if (playable(target)) actions.append(playButton(target, 'cover-btn cover-play'));
    actions.append(moreButton(target, 'cover-btn cover-more'));
    return actions;
  }

  /**
   * 详情页头部的资料库按钮（与 music.apple.com 专辑 / 歌单页的「+」相同）：不在资料库中显示 +，在时显示 ✓，点击切换。
   * getTarget() 返回当前条目（页面数据载入前为 null，按钮不可用）。返回 { button, refresh }，数据载入后调用 refresh()
   */
  function libraryButton(getTarget, className = 'detail-circle-btn lib-toggle') {
    const button = el('button', { className, type: 'button', disabled: true });
    const refresh = () => {
      const target = getTarget();
      const key = target && libraryKey(target);
      const has = !!key && library.inLibrary(key.kind, key.id);
      button.disabled = !key;
      button.innerHTML = has ? LIB_ICON.added : LIB_ICON.add;
      button.setAttribute('aria-pressed', String(has));
      button.title = t(has ? 'library.inLibrary' : 'library.add');
      button.setAttribute('aria-label', button.title);
    };
    button.addEventListener('click', () => {
      const target = getTarget();
      if (target) toggleLibrary(target, button);
    });
    signal.addEventListener('abort', library.onChange(refresh), { once: true });
    refresh();
    return { button, refresh };
  }

  /**
   * 喜爱按钮（☆ / ★），用法与 libraryButton 相同；className 默认为详情页头部的圆形按钮；icons（{ star, starFilled }）可换成别的图标。返回 { button, refresh }
   */
  function favoriteButton(getTarget, className = 'detail-circle-btn lib-fav-toggle', icons = LIB_ICON) {
    const button = el('button', { className, type: 'button', disabled: true });
    const refresh = () => {
      const target = getTarget();
      const key = target && favoriteKey(target);
      const on = favoriteOf(key);
      button.disabled = !key;
      button.innerHTML = on ? icons.starFilled : icons.star;
      button.setAttribute('aria-pressed', String(on));
      button.title = t(on ? 'library.unfavorite' : 'library.favorite');
      button.setAttribute('aria-label', button.title);
    };
    button.addEventListener('click', () => {
      const target = getTarget();
      if (target) toggleFavorite(target, button);
    });
    signal.addEventListener('abort', library.onChange(refresh), { once: true });
    refresh();
    return { button, refresh };
  }

  /** 「添加到歌单」按钮：直接打开歌单子菜单 */
  function playlistButton(getTarget, className) {
    const button = el('button', { className, type: 'button', innerHTML: LIB_ICON.addToPlaylist, title: t('library.addToPlaylist') });
    button.setAttribute('aria-label', t('library.addToPlaylist'));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = getTarget();
      if (target) openMenu(button, playlistMenuItems(() => targetTracks(target), { toast, navigate }));
    });
    return button;
  }

  /** 封面卡片（链接）外包一层 .card-wrap，加上 coverActions（按钮不能放进链接里） */
  function wrapCard(card, target) {
    return el('div', { className: `card-wrap${target.kind === 'music-video' ? ' mv' : ''}${target.kind === 'artist' ? ' artist' : ''}` }, card, coverActions(target));
  }

  /** 搜索结果行：封面上叠加播放按钮（方形封面），行末「更多」 */
  function wrapRow(row, target) {
    const wrap = el('div', { className: 'row-wrap' }, row);
    if (playable(target) && target.kind !== 'music-video') wrap.append(playButton(target, 'row-play'));
    wrap.append(moreButton(target, 'track-more row-more'));
    return wrap;
  }

  return { moreButton, coverActions, wrapCard, wrapRow, libraryButton, favoriteButton, playlistButton, toggleFavorite };
}

// 常见港台/海外华语艺人英文艺名、拼音与别名全量映射表 (涵盖主流歌手，杜绝英文艺名)
export const CHINESE_ARTIST_ALIASES = {
  // 张惠妹系列
  'amei': '张惠妹',
  'a-mei': '张惠妹',
  'amit': '张惠妹',
  'chang hui-mei': '张惠妹',
  // 陈绮贞 / 陈奕迅 / 方大同
  'cheer chen': '陈绮贞',
  'chen chi-chen': '陈绮贞',
  'eason chan': '陈奕迅',
  'chan yik-shun': '陈奕迅',
  'khalil fong': '方大同',
  // 周杰伦 / 陶喆 / 王力宏 / 林俊杰
  'jay chou': '周杰伦',
  'chou chieh-lun': '周杰伦',
  'david tao': '陶喆',
  'tao che-sheng': '陶喆',
  'wang leehom': '王力宏',
  'leehom wang': '王力宏',
  'jj lin': '林俊杰',
  'wayne lin': '林俊杰',
  // 王菲 / 邓紫棋 / 蔡依林 / 孙燕姿
  'faye wong': '王菲',
  'shirley wong': '王菲',
  'g.e.m.': '邓紫棋',
  'gem': '邓紫棋',
  'g.e.m': '邓紫棋',
  'gloria tang': '邓紫棋',
  'jolin tsai': '蔡依林',
  'tsai i-ling': '蔡依林',
  'stefanie sun': '孙燕姿',
  'sun yan-zi': '孙燕姿',
  // 梁静茹 / 五月天 / 苏打绿 / 卢广仲 / 林宥嘉
  'fish leong': '梁静茹',
  'jasmine leong': '梁静茹',
  'mayday': '五月天',
  'sodagreen': '苏打绿',
  'oaeen': '苏打绿',
  'crowd lu': '卢广仲',
  'lu kwang-chung': '卢广仲',
  'yoga lin': '林宥嘉',
  'lin yu-chia': '林宥嘉',
  // S.H.E / 田馥甄 / 任家萱 / 陈嘉桦
  's.h.e': 'S.H.E',
  'she': 'S.H.E',
  'hebe tien': '田馥甄',
  'hebe': '田馥甄',
  'selina ren': '任家萱',
  'selina': '任家萱',
  'ella chen': '陈嘉桦',
  'ella': '陈嘉桦',
  // 蔡健雅 / 戴佩妮 / 刘若英 / 莫文蔚
  'tanya chua': '蔡健雅',
  'penny tai': '戴佩妮',
  'rene liu': '刘若英',
  'karen mok': '莫文蔚',
  // 杨丞琳 / 王心凌 / 周兴哲 / 萧敬腾 / 杨宗纬
  'rainie yang': '杨丞琳',
  'cyndi wang': '王心凌',
  'eric chou': '周兴哲',
  'jam hsiao': '萧敬腾',
  'aska yang': '杨宗纬',
  // 安溥 / 张悬 / 魏如萱 / 徐佳莹 / 艾怡良 / 王若琳 / 黄丽玲
  'anpu': '安溥',
  'deserts chang': '张悬',
  'waa wei': '魏如萱',
  'lala hsu': '徐佳莹',
  'eve ai': '艾怡良',
  'joanna wang': '王若琳',
  'a-lin': '黄丽玲',
  'alin': '黄丽玲',
  'huang li-ling': '黄丽玲',
  // 四大天王 & 乐坛巨星
  'jacky cheung': '张学友',
  'andy lau': '刘德华',
  'aaron kwok': '郭富城',
  'leon lai': '黎明',
  'leslie cheung': '张国荣',
  'anita mui': '梅艳芳',
  'teresa teng': '邓丽君',
  'beyond': 'Beyond',
  'wakin chau': '周华健',
  'emil chau': '周华健',
  'emil wakin chau': '周华健',
  'jonathan lee': '李宗盛',
  'chyi chin': '齐秦',
  'chyi yu': '齐豫',
  'dave wang': '王杰',
  'jeff chang': '张信哲',
  'phil chang': '张宇',
  'angus tung': '童安格',
  'samuel tai': '邰正宵',
  'steve chou': '周传雄',
  'harlem yu': '庾澄庆',
  'george lam': '林子祥',
  'sally yeh': '叶倩文',
  'sandy lam': '林忆莲',
  'priscilla chan': '陈慧娴',
  'vivian chow': '周慧敏',
  'kelly chen': '陈慧琳',
  'sammi cheng': '郑秀文',
  'gigi leung': '梁咏琪',
  'coco lee': '李玟',
  // 香港中生代与新生代
  'hins cheung': '张敬轩',
  'joey yung': '容祖儿',
  'leo ku': '古巨基',
  'miriam yeung': '杨千嬅',
  'hacken lee': '李克勤',
  'edison chen': '陈冠希',
  'shawn yue': '余文乐',
  'pakho chau': '周柏豪',
  'terence lam': '林家谦',
  'keung to': '姜涛',
  'anson lo': '卢瀚霆',
  'mc cheung': '张天赋',
  'gareth.t': '汤令山',
  'jay fung': '冯允谦',
  'aga': 'AGA 江海迦',
  'gin lee': '李幸倪',
  'jace chan': '陈凯咏',
  'cloud wan': '云浩影',
  'panther chan': '陈蕾',
  'kaho hung': '洪嘉豪',
  'jeffrey ngai': '魏浚笙',
  'mike tsang': '曾比特',
  'gigi yim': '炎明熹',
  // 独立乐团与新潮乐队
  'accusefive': '告五人',
  'deca joins': 'deca joins',
  'sunset rollercoaster': '落日飞车',
  'omnipotent youth society': '万能青年旅店',
  'new pants': '新裤子',
  'second hand rose': '二手玫瑰',
  'no party for cao dong': '草东没有派对',
  'my little airport': 'my little airport',
  // 内地主流唱作人与流行艺人
  'yicheng shen': '沈以诚',
  'joker xue': '薛之谦',
  'vae xu': '许嵩',
  'silence wang': '汪苏泷',
  'ronghao li': '李荣浩',
  'hua chenyu': '华晨宇',
  'mao buyi': '毛不易',
  'charlie zhou': '周深',
  'tia ray': '袁娅维',
  'lexie liu': '刘柏辛',
  'jackson wang': '王嘉尔',
  'lay zhang': '张艺兴',
  'mc hotdog': '热狗',
  'soft lipa': '蛋堡',
  'higher brothers': '更高兄弟'
};

const T_CHARS = "\u346f\u3473\u3476\u34e8\u361a\u3704\u370f\u380f\u396e\u3a5c\u3a73\u3a75\u407b\u40ee\u42b7\u42d9\u42da\u42f9\u42fb\u4366\u43b1\u4661\u4700\u477c\u4947\u4951\u4971\u499b\u499f\u4bc0\u4c3e\u4c77\u4c7d\u4c81\u4c98\u4d09\u4e1f\u4e26\u4e7e\u4e82\u4e99\u4e9e\u4f47\u4f48\u4f54\u4f75\u4f86\u4f96\u4fb6\u4fb7\u4fc1\u4fc2\u4fd4\u4fe0\u4fe5\u4fec\u5000\u5006\u5008\u5009\u500b\u5011\u5016\u502b\u5032\u5049\u5051\u5074\u5075\u507d\u508c\u5091\u5096\u5098\u5099\u50a2\u50ad\u50af\u50b3\u50b4\u50b5\u50b7\u50be\u50c2\u50c5\u50c9\u50d1\u50d5\u50de\u50e5\u50e8\u50f1\u50f9\u5100\u5101\u5102\u5104\u5108\u5109\u510e\u5110\u5114\u5115\u5118\u511f\u512a\u5132\u5137\u5138\u513a\u513b\u513c\u5147\u514c\u5152\u5157\u5167\u5169\u518a\u5191\u51aa\u51c8\u51cd\u51dc\u51f1\u5225\u522a\u5244\u5247\u524b\u524e\u5257\u525b\u525d\u526e\u5274\u5275\u5277\u5283\u5284\u5287\u5289\u528a\u528c\u528d\u528f\u5291\u529a\u52c1\u52d5\u52d9\u52db\u52dd\u52de\u52e2\u52e9\u52f1\u52f3\u52f5\u52f8\u52fb\u532d\u532f\u5331\u5340\u5354\u5379\u537b\u537d\u5399\u53a0\u53a4\u53ad\u53b2\u53b4\u53c3\u53c4\u53e2\u5412\u5433\u5436\u5442\u54bc\u54e1\u5504\u5538\u554f\u5553\u555e\u555f\u5562\u558e\u559a\u55aa\u55ab\u55ac\u55ae\u55b2\u55c6\u55c7\u55ca\u55ce\u55da\u55e9\u55f6\u5606\u560d\u5613\u5614\u5616\u5617\u561c\u5629\u562e\u562f\u5630\u5635\u5638\u563d\u5641\u5653\u565a\u565d\u5660\u5665\u5666\u566f\u5672\u5674\u5678\u5679\u5680\u5687\u568c\u5690\u5695\u5699\u56a5\u56a6\u56a8\u56ae\u56b2\u56b3\u56b4\u56b6\u56c0\u56c1\u56c2\u56c5\u56c8\u56c9\u56cc\u56d1\u56ea\u5707\u570b\u570d\u5712\u5713\u5716\u5718\u57bb\u57e1\u57f0\u57f7\u5805\u580a\u5816\u581d\u582f\u5831\u5834\u584a\u584b\u584f\u5852\u5857\u585a\u5862\u5864\u5875\u5879\u588a\u589c\u58ae\u58b0\u58b3\u58b6\u58bb\u58be\u58c7\u58cb\u58ce\u58d3\u58d8\u58d9\u58da\u58dc\u58de\u58df\u58e0\u58e2\u58e9\u58ea\u58ef\u58fa\u58fc\u58fd\u5920\u5922\u5925\u593e\u5950\u5967\u5969\u596a\u596c\u596e\u597c\u599d\u59cd\u59e6\u5a1b\u5a41\u5a66\u5a6d\u5aa7\u5aaf\u5ab0\u5abc\u5abd\u5acb\u5ad7\u5af5\u5afa\u5afb\u5aff\u5b00\u5b03\u5b08\u5b0b\u5b0c\u5b19\u5b21\u5b24\u5b2a\u5b30\u5b38\u5b43\u5b4b\u5b4c\u5b6b\u5b78\u5b7f\u5bae\u5bc0\u5be2\u5be6\u5be7\u5be9\u5beb\u5bec\u5bf5\u5bf6\u5c07\u5c08\u5c0b\u5c0d\u5c0e\u5c37\u5c46\u5c4d\u5c53\u5c5c\u5c62\u5c64\u5c68\u5c6c\u5ca1\u5cef\u5cf4\u5cf6\u5cfd\u5d0d\u5d11\u5d17\u5d19\u5d22\u5d2c\u5d50\u5d57\u5d7e\u5d81\u5d84\u5d87\u5d94\u5d97\u5da0\u5da2\u5da7\u5da8\u5dae\u5db8\u5dba\u5dbc\u5dbd\u5dcb\u5dd2\u5dd4\u5dd6\u5df0\u5df9\u5e25\u5e2b\u5e33\u5e36\u5e40\u5e43\u5e53\u5e57\u5e58\u5e5f\u5e63\u5e6b\u5e6c\u5e77\u5e79\u5e7e\u5eab\u5ec1\u5ec2\u5ec4\u5ec8\u5ece\u5ed5\u5eda\u5edd\u5edf\u5ee0\u5ee1\u5ee2\u5ee3\u5ee9\u5eec\u5ef3\u5f12\u5f14\u5f33\u5f35\u5f37\u5f46\u5f48\u5f4c\u5f4e\u5f54\u5f59\u5f60\u5f65\u5f6b\u5f72\u5f7f\u5f8c\u5f91\u5f9e\u5fa0\u5fa9\u5fb5\u5fb9\u6046\u6065\u6085\u609e\u60b5\u60b6\u60bd\u60e1\u60f1\u60f2\u60fb\u611b\u611c\u6128\u6134\u6137\u613e\u6144\u614b\u614d\u6158\u615a\u615f\u6163\u6164\u616a\u616b\u616e\u6173\u6176\u617a\u617c\u617e\u6182\u618a\u6190\u6191\u6192\u6196\u619a\u61a4\u61ab\u61ae\u61b2\u61b6\u61c7\u61c9\u61cc\u61cd\u61de\u61df\u61e3\u61e4\u61e8\u61f2\u61f6\u61f7\u61f8\u61fa\u61fc\u61fe\u6200\u6207\u6214\u6227\u6229\u6230\u6231\u6232\u6236\u625e\u62cb\u62da\u6329\u6331\u633e\u6368\u636b\u6371\u6372\u6383\u6384\u6386\u6397\u6399\u639b\u63a1\u63c0\u63da\u63db\u63ee\u63ef\u640d\u6416\u6417\u6427\u6435\u6436\u6451\u645c\u645f\u646f\u6473\u6476\u647a\u647b\u6488\u648f\u6490\u6493\u649d\u649f\u64a3\u64a5\u64ab\u64b2\u64b3\u64bb\u64be\u64bf\u64c1\u64c4\u64c7\u64ca\u64cb\u64d3\u64d4\u64da\u64e0\u64e1\u64e3\u64ec\u64ef\u64f0\u64f1\u64f2\u64f4\u64f7\u64fa\u64fb\u64fc\u64fd\u64fe\u6504\u6506\u650f\u6514\u6516\u6519\u651b\u651c\u651d\u6522\u6523\u6524\u652a\u652c\u654e\u6553\u6557\u6558\u6575\u6578\u6582\u6583\u6586\u6595\u65ac\u65b7\u65bc\u65c2\u65e3\u6607\u6642\u6649\u665d\u6688\u6689\u6698\u66a2\u66ab\u66c4\u66c6\u66c7\u66c9\u66cf\u66d6\u66e0\u66e8\u66ec\u66f8\u6703\u6727\u672e\u6771\u67b4\u67f5\u67fa\u67fb\u687f\u6894\u6898\u689d\u689f\u68b2\u68c4\u68ca\u68d6\u68d7\u68df\u68e1\u68e7\u68f2\u68f6\u690f\u6932\u694a\u6953\u6968\u696d\u6975\u6998\u69a6\u69aa\u69ae\u69b2\u69bf\u69cb\u69cd\u69d3\u69e4\u69e7\u69e8\u69ee\u69f3\u69f6\u69fc\u6a01\u6a02\u6a05\u6a11\u6a13\u6a19\u6a1e\u6a22\u6a23\u6a27\u6a2b\u6a33\u6a38\u6a39\u6a3a\u6a3f\u6a48\u6a4b\u6a5f\u6a62\u6a6b\u6a81\u6a89\u6a94\u6a9c\u6a9f\u6aa2\u6aa3\u6aae\u6aaf\u6ab3\u6ab8\u6abb\u6ac3\u6ad3\u6ada\u6adb\u6add\u6ade\u6adf\u6ae5\u6ae7\u6ae8\u6aea\u6aeb\u6aec\u6af1\u6af3\u6af8\u6afb\u6b04\u6b05\u6b0a\u6b0f\u6b12\u6b16\u6b1e\u6b3d\u6b4e\u6b50\u6b5f\u6b61\u6b72\u6b77\u6b78\u6b7f\u6b98\u6b9e\u6ba4\u6ba8\u6bab\u6bad\u6bae\u6baf\u6bb0\u6bb2\u6bba\u6bbb\u6bbc\u6bc0\u6bc6\u6bff\u6c02\u6c08\u6c0c\u6c23\u6c2b\u6c2c\u6c33\u6c3e\u6c4e\u6c59\u6c7a\u6c92\u6c96\u6cc1\u6cdd\u6d29\u6d36\u6d79\u6d87\u6d97\u6dbc\u6dd2\u6dda\u6de5\u6de8\u6de9\u6dea\u6df5\u6df6\u6dfa\u6e19\u6e1b\u6e22\u6e26\u6e2c\u6e3e\u6e4a\u6e5e\u6e67\u6e6f\u6e88\u6e96\u6e9d\u6eab\u6eae\u6eb3\u6ebc\u6ec4\u6ec5\u6ecc\u6ece\u6ed9\u6eec\u6eef\u6ef2\u6ef7\u6ef8\u6efb\u6efe\u6eff\u6f01\u6f0a\u6f1a\u6f22\u6f23\u6f2c\u6f32\u6f35\u6f38\u6f3f\u6f41\u6f51\u6f54\u6f59\u6f5a\u6f5b\u6f64\u6f6f\u6f70\u6f77\u6f7f\u6f80\u6f86\u6f87\u6f90\u6f97\u6fa0\u6fa4\u6fa6\u6fa9\u6fae\u6fb1\u6fbe\u6fc1\u6fc3\u6fc4\u6fd5\u6fd8\u6fda\u6fdb\u6fdc\u6fdf\u6fe4\u6fe7\u6feb\u6ff0\u6ff1\u6ffa\u6ffc\u6ffe\u7002\u7005\u7006\u7007\u7009\u700b\u700f\u7015\u7018\u701d\u701f\u7020\u7026\u7027\u7028\u7030\u7032\u703e\u7043\u7044\u7051\u7055\u7058\u705d\u7061\u7063\u7064\u7067\u7069\u707d\u70ba\u70cf\u70f4\u7121\u7149\u7152\u7159\u7162\u7165\u7169\u716c\u7171\u7185\u7192\u7197\u71b1\u71b2\u71be\u71c1\u71c8\u71c9\u71d2\u71d9\u71dc\u71df\u71e6\u71ec\u71ed\u71f4\u71f6\u71fb\u71fc\u71fe\u720d\u7210\u721b\u722d\u7232\u723a\u723e\u7240\u7246\u7258\u7274\u727d\u7296\u729b\u72a2\u72a7\u72c0\u72f9\u72fd\u7319\u7336\u733b\u7341\u7343\u7344\u7345\u734e\u7368\u736a\u736b\u736e\u7370\u7371\u7372\u7375\u7377\u7378\u737a\u737b\u737c\u7380\u73fe\u7431\u743a\u743f\u744b\u7452\u7463\u7464\u7469\u746a\u7472\u7489\u74a1\u74a3\u74a6\u74ab\u74af\u74b0\u74b5\u74b8\u74bd\u74bf\u74ca\u74cf\u74d4\u74da\u750c\u7515\u7522\u7523\u755d\u7562\u756b\u7570\u7575\u7576\u7587\u758a\u75d9\u75e0\u75fe\u7602\u760b\u760d\u7613\u761e\u7621\u7627\u762e\u7632\u763a\u763b\u7642\u7646\u7647\u7649\u7652\u7658\u765f\u7661\u7662\u7664\u7665\u7667\u7669\u766c\u766d\u766e\u7670\u7671\u7672\u767c\u7681\u769a\u76b0\u76b8\u76ba\u76c3\u76dc\u76de\u76e1\u76e3\u76e4\u76e7\u76ea\u771e\u7725\u773e\u774f\u775c\u775e\u7798\u779c\u779e\u77b6\u77bc\u77c7\u77d3\u77da\u77ef\u7843\u785c\u7864\u7868\u786f\u7895\u78a9\u78ad\u78b8\u78ba\u78bc\u78bd\u78d1\u78da\u78e0\u78e3\u78e7\u78ef\u78fd\u78fe\u7904\u790e\u7919\u7926\u792a\u792b\u792c\u7931\u7955\u797f\u798d\u798e\u7995\u79a1\u79a6\u79aa\u79ae\u79b0\u79b1\u79bf\u79c8\u7a05\u7a08\u7a0f\u7a1c\u7a1f\u7a2e\u7a31\u7a40\u7a47\u7a4c\u7a4d\u7a4e\u7a60\u7a61\u7a62\u7a69\u7a6b\u7a6d\u7aa9\u7aaa\u7aae\u7aaf\u7ab5\u7ab6\u7aba\u7ac4\u7ac5\u7ac7\u7ac8\u7aca\u7aea\u7af6\u7b46\u7b4d\u7b67\u7b74\u7b87\u7b8b\u7b8f\u7b9a\u7bc0\u7bc4\u7bc9\u7bcb\u7bd4\u7be0\u7be4\u7be9\u7bf3\u7c00\u7c0d\u7c11\u7c1e\u7c21\u7c23\u7c2b\u7c39\u7c3d\u7c3e\u7c43\u7c4c\u7c54\u7c59\u7c5b\u7c5c\u7c5f\u7c60\u7c64\u7c69\u7c6a\u7c6c\u7c6e\u7c72\u7cb5\u7cc9\u7cdd\u7cde\u7ce7\u7cf0\u7cf2\u7cf4\u7cf6\u7cf9\u7cfe\u7d00\u7d02\u7d04\u7d05\u7d06\u7d07\u7d08\u7d09\u7d0b\u7d0d\u7d10\u7d13\u7d14\u7d15\u7d16\u7d17\u7d18\u7d19\u7d1a\u7d1b\u7d1c\u7d1d\u7d21\u7d2c\u7d2e\u7d30\u7d31\u7d32\u7d33\u7d35\u7d39\u7d3a\u7d3c\u7d3f\u7d40\u7d42\u7d43\u7d44\u7d45\u7d46\u7d4e\u7d50\u7d55\u7d5b\u7d5d\u7d5e\u7d61\u7d62\u7d66\u7d68\u7d70\u7d71\u7d72\u7d73\u7d76\u7d79\u7d81\u7d83\u7d86\u7d88\u7d89\u7d8c\u7d8f\u7d90\u7d91\u7d93\u7d9c\u7d9e\u7da0\u7da2\u7da3\u7dab\u7dac\u7dad\u7daf\u7db0\u7db1\u7db2\u7db3\u7db4\u7db5\u7db8\u7db9\u7dba\u7dbb\u7dbd\u7dbe\u7dbf\u7dc4\u7dc7\u7dca\u7dcb\u7dd1\u7dd2\u7dd3\u7dd4\u7dd7\u7dd8\u7dd9\u7dda\u7ddd\u7dde\u7de0\u7de1\u7de3\u7de6\u7de8\u7de9\u7dec\u7def\u7df1\u7df2\u7df4\u7df6\u7df9\u7dfb\u7dfc\u7e08\u7e09\u7e0a\u7e0b\u7e10\u7e11\u7e15\u7e17\u7e1b\u7e1d\u7e1e\u7e1f\u7e23\u7e27\u7e2b\u7e2d\u7e2e\u7e31\u7e32\u7e33\u7e34\u7e35\u7e36\u7e37\u7e39\u7e3d\u7e3e\u7e43\u7e45\u7e46\u7e52\u7e54\u7e55\u7e5a\u7e5e\u7e61\u7e62\u7e69\u7e6a\u7e6b\u7e6d\u7e6e\u7e6f\u7e70\u7e73\u7e78\u7e79\u7e7c\u7e7d\u7e7e\u7e7f\u7e87\u7e88\u7e8a\u7e8c\u7e8d\u7e8f\u7e93\u7e94\u7e96\u7e98\u7e9c\u7f3d\u7f43\u7f48\u7f4c\u7f4e\u7f70\u7f75\u7f77\u7f85\u7f86\u7f88\u7f8b\u7fa3\u7fa5\u7fa8\u7fa9\u7fb6\u7fd2\u7feb\u7fec\u7ff9\u7ffd\u802c\u802e\u8056\u805e\u806f\u8070\u8072\u8073\u8075\u8076\u8077\u8079\u807d\u807e\u8085\u8105\u8108\u811b\u8123\u8129\u812b\u8139\u814e\u8156\u8161\u8166\u816b\u8173\u8178\u8183\u8195\u819a\u819e\u81a0\u81a9\u81bd\u81be\u81bf\u81c9\u81cd\u81cf\u81d8\u81da\u81df\u81e0\u81e2\u81e5\u81e8\u81fa\u8207\u8208\u8209\u820a\u8216\u8218\u8259\u8264\u8266\u826b\u8271\u8277\u82bb\u82e7\u8332\u834a\u838a\u8396\u83a2\u83a7\u83ef\u83f4\u83f8\u8407\u840a\u842c\u8434\u8435\u8449\u8452\u8464\u8466\u846f\u8477\u8490\u8493\u8494\u8495\u849e\u84bc\u84c0\u84c6\u84cb\u84ee\u84ef\u84f4\u84fd\u8514\u8518\u851e\u8523\u8525\u8526\u852d\u8541\u8546\u854e\u8552\u8553\u8555\u8558\u8562\u8569\u856a\u856d\u8577\u8580\u8588\u858a\u858c\u8591\u8594\u8598\u859f\u85a6\u85a9\u85b4\u85b5\u85b9\u85ba\u85cd\u85ce\u85dd\u85e5\u85ea\u85ed\u85f4\u85f6\u85f9\u85fa\u8600\u8604\u8606\u8607\u860a\u860b\u861a\u861e\u8622\u862d\u863a\u863f\u8646\u8655\u865b\u865c\u865f\u8667\u866f\u86fa\u86fb\u8706\u8755\u875f\u8766\u8768\u8778\u8784\u879e\u87a2\u87ae\u87bb\u87bf\u87c4\u87c8\u87ce\u87e3\u87ec\u87ef\u87f2\u87f6\u87fb\u8801\u8805\u8806\u880d\u8810\u8811\u8814\u881f\u8823\u8828\u8831\u8836\u883b\u8846\u884a\u8853\u8855\u885a\u885b\u885d\u889e\u88b7\u88ca\u88cf\u88dc\u88dd\u88e1\u88fd\u8907\u890c\u8918\u8932\u8933\u8938\u893b\u8947\u8949\u894f\u8956\u895d\u8960\u8964\u896a\u896c\u896f\u8972\u8974\u8988\u898b\u898e\u898f\u8993\u8996\u8998\u89a1\u89a5\u89a6\u89aa\u89ac\u89af\u89b2\u89b7\u89ba\u89bd\u89bf\u89c0\u89f4\u89f6\u89f8\u8a01\u8a02\u8a03\u8a08\u8a0a\u8a0c\u8a0e\u8a10\u8a12\u8a13\u8a15\u8a16\u8a17\u8a18\u8a1b\u8a1d\u8a1f\u8a22\u8a23\u8a25\u8a29\u8a2a\u8a2d\u8a31\u8a34\u8a36\u8a3a\u8a3b\u8a3c\u8a41\u8a46\u8a4e\u8a50\u8a52\u8a54\u8a55\u8a56\u8a57\u8a58\u8a5b\u8a5e\u8a60\u8a61\u8a62\u8a63\u8a66\u8a69\u8a6b\u8a6c\u8a6d\u8a6e\u8a70\u8a71\u8a72\u8a73\u8a75\u8a7c\u8a7f\u8a84\u8a85\u8a86\u8a87\u8a8c\u8a8d\u8a91\u8a92\u8a95\u8a98\u8a9a\u8a9e\u8aa0\u8aa1\u8aa3\u8aa4\u8aa5\u8aa6\u8aa8\u8aaa\u8aac\u8ab0\u8ab2\u8ab6\u8ab9\u8abc\u8abe\u8abf\u8ac2\u8ac4\u8ac7\u8ac9\u8acb\u8acd\u8acf\u8ad1\u8ad2\u8ad6\u8ad7\u8adb\u8adc\u8add\u8ade\u8ae1\u8ae2\u8ae4\u8ae6\u8ae7\u8aeb\u8aed\u8aee\u8af1\u8af3\u8af6\u8af7\u8af8\u8afa\u8afc\u8afe\u8b00\u8b01\u8b02\u8b04\u8b05\u8b0a\u8b0e\u8b10\u8b14\u8b16\u8b17\u8b19\u8b1a\u8b1b\u8b1d\u8b20\u8b21\u8b28\u8b2b\u8b2c\u8b2d\u8b33\u8b39\u8b3e\u8b41\u8b49\u8b4e\u8b4f\u8b56\u8b58\u8b59\u8b5a\u8b5c\u8b5f\u8b6b\u8b6d\u8b6f\u8b70\u8b74\u8b77\u8b78\u8b7d\u8b7e\u8b80\u8b85\u8b8a\u8b8b\u8b8c\u8b8e\u8b92\u8b93\u8b95\u8b96\u8b9a\u8b9c\u8b9e\u8c3f\u8c48\u8c4e\u8c50\u8c54\u8c6c\u8c76\u8c8d\u8c93\u8c99\u8c9d\u8c9e\u8c9f\u8ca0\u8ca1\u8ca2\u8ca7\u8ca8\u8ca9\u8caa\u8cab\u8cac\u8caf\u8cb0\u8cb2\u8cb3\u8cb4\u8cb6\u8cb7\u8cb8\u8cba\u8cbb\u8cbc\u8cbd\u8cbf\u8cc0\u8cc1\u8cc2\u8cc3\u8cc4\u8cc5\u8cc7\u8cc8\u8cca\u8cd1\u8cd2\u8cd3\u8cd5\u8cd9\u8cda\u8cdc\u8cde\u8ce0\u8ce1\u8ce2\u8ce3\u8ce4\u8ce6\u8ce7\u8cea\u8ceb\u8cec\u8ced\u8cf0\u8cf4\u8cf5\u8cfa\u8cfb\u8cfc\u8cfd\u8cfe\u8d04\u8d05\u8d07\u8d08\u8d0a\u8d0b\u8d0d\u8d0f\u8d10\u8d13\u8d14\u8d16\u8d17\u8d1b\u8d1c\u8d6c\u8d95\u8d99\u8da8\u8db2\u8de1\u8e10\u8e30\u8e34\u8e4c\u8e55\u8e5f\u8e60\u8e63\u8e64\u8e7a\u8e82\u8e89\u8e8a\u8e8b\u8e8d\u8e8e\u8e91\u8e92\u8e93\u8e95\u8e9a\u8ea1\u8ea5\u8ea6\u8eaa\u8ec0\u8eca\u8ecb\u8ecc\u8ecd\u8ed1\u8ed2\u8ed4\u8edb\u8edf\u8ee4\u8eeb\u8ef2\u8ef8\u8ef9\u8efa\u8efb\u8efc\u8efe\u8f03\u8f05\u8f07\u8f08\u8f09\u8f0a\u8f12\u8f13\u8f14\u8f15\u8f1b\u8f1c\u8f1d\u8f1e\u8f1f\u8f25\u8f26\u8f29\u8f2a\u8f2c\u8f2f\u8f33\u8f38\u8f3b\u8f3c\u8f3e\u8f3f\u8f40\u8f42\u8f44\u8f45\u8f46\u8f49\u8f4d\u8f4e\u8f54\u8f5f\u8f61\u8f62\u8f64\u8fa6\u8fad\u8fae\u8faf\u8fb2\u8ff4\u9015\u9019\u9023\u9031\u9032\u904a\u904b\u904e\u9054\u9055\u9059\u905c\u905e\u9060\u9061\u9069\u9072\u9076\u9077\u9078\u907a\u907c\u9081\u9084\u9087\u908a\u908f\u9090\u90df\u90f5\u9106\u9109\u9112\u9114\u9116\u9127\u912d\u9130\u9132\u9134\u9136\u913a\u9147\u9148\u9183\u9196\u919c\u919e\u919f\u91a3\u91ab\u91ac\u91b1\u91c0\u91c1\u91c3\u91c5\u91cb\u91d0\u91d2\u91d3\u91d4\u91d5\u91d7\u91d8\u91d9\u91dd\u91e3\u91e4\u91e6\u91e7\u91e9\u91f5\u91f7\u91f9\u91fa\u91fe\u9200\u9201\u9203\u9204\u9205\u9208\u9209\u920d\u920e\u9210\u9211\u9212\u9214\u9215\u921e\u9221\u9223\u9225\u9226\u9227\u922e\u9230\u9233\u9234\u9237\u9238\u9239\u923a\u923d\u923e\u923f\u9240\u9245\u9246\u9248\u9249\u924b\u924d\u9251\u9255\u9257\u925a\u925b\u925e\u9262\u9264\u9266\u926c\u926d\u9273\u9276\u9278\u927a\u927b\u927f\u9280\u9283\u9285\u928d\u9291\u9293\u9296\u9298\u929a\u929b\u929c\u92a0\u92a3\u92a5\u92a6\u92a8\u92a9\u92aa\u92ab\u92ac\u92b1\u92b3\u92b7\u92b9\u92bb\u92bc\u92c1\u92c3\u92c5\u92c7\u92cc\u92cf\u92d2\u92d9\u92dd\u92df\u92e3\u92e4\u92e5\u92e6\u92e8\u92e9\u92ea\u92ed\u92ee\u92ef\u92f0\u92f1\u92f6\u92f8\u92fc\u9301\u9304\u9306\u9307\u9308\u930f\u9310\u9312\u9315\u9318\u9319\u931a\u931b\u931f\u9320\u9321\u9322\u9326\u9328\u9329\u932b\u932e\u932f\u9332\u9333\u9336\u9338\u933c\u9340\u9341\u9343\u9345\u9346\u9347\u9348\u934a\u934b\u934d\u9354\u9358\u935a\u935b\u9360\u9364\u9365\u9369\u936c\u9370\u9375\u9376\u937a\u937c\u937e\u9382\u9384\u9387\u938a\u938c\u9394\u9396\u9398\u939a\u939b\u93a1\u93a2\u93a3\u93a6\u93a7\u93a9\u93aa\u93ac\u93ad\u93ae\u93b0\u93b2\u93b3\u93b5\u93b6\u93b8\u93bf\u93c3\u93c7\u93c8\u93cc\u93cd\u93d0\u93d1\u93d7\u93d8\u93dc\u93dd\u93de\u93df\u93e1\u93e2\u93e4\u93e8\u93f0\u93f5\u93f7\u93f9\u93fa\u93fd\u9403\u940b\u9410\u9412\u9413\u9414\u9418\u9419\u941d\u9420\u9425\u9426\u9427\u9428\u942b\u942e\u942f\u9432\u9433\u9435\u9436\u9438\u943a\u943f\u9444\u944a\u944c\u9451\u9452\u9454\u9455\u945e\u9460\u9463\u9465\u946d\u9470\u9471\u9472\u9477\u9479\u947c\u947d\u947e\u947f\u9481\u9482\u9577\u9580\u9582\u9583\u9586\u9588\u9589\u958b\u958c\u958e\u958f\u9591\u9592\u9593\u9594\u9598\u95a1\u95a3\u95a4\u95a5\u95a8\u95a9\u95ab\u95ac\u95ad\u95b1\u95b2\u95b6\u95b9\u95bb\u95bc\u95bd\u95be\u95bf\u95c3\u95c6\u95c7\u95c8\u95ca\u95cb\u95cc\u95cd\u95d0\u95d2\u95d3\u95d4\u95d5\u95d6\u95dc\u95de\u95e0\u95e1\u95e2\u95e4\u95e5\u9658\u965d\u965e\u9663\u9670\u9673\u9678\u967d\u9689\u968a\u968e\u9695\u969b\u96a8\u96aa\u96af\u96b1\u96b4\u96b8\u96bb\u96cb\u96d6\u96d9\u96db\u96dc\u96de\u96e2\u96e3\u96f2\u96fb\u9711\u9722\u9727\u973d\u9742\u9744\u9746\u9748\u9749\u975a\u975c\u975d\u9766\u9768\u978f\u979d\u97a6\u97bd\u97c1\u97c3\u97c6\u97c9\u97cb\u97cc\u97cd\u97d3\u97d9\u97dc\u97dd\u97de\u97fb\u97ff\u9801\u9802\u9803\u9805\u9806\u9807\u9808\u980a\u980c\u980e\u980f\u9810\u9811\u9812\u9813\u9817\u9818\u981c\u9821\u9824\u9826\u982d\u982e\u9830\u9832\u9834\u9837\u9838\u9839\u983b\u983d\u9846\u984c\u984d\u984e\u984f\u9852\u9853\u9854\u9858\u9859\u985b\u985e\u9862\u9865\u9867\u986b\u986c\u986f\u9870\u9871\u9873\u9874\u98a8\u98ad\u98ae\u98af\u98b1\u98b3\u98b6\u98b8\u98ba\u98bb\u98bc\u98c0\u98c4\u98c6\u98c8\u98db\u98e0\u98e2\u98e3\u98e5\u98e9\u98ea\u98eb\u98ed\u98ef\u98f1\u98f2\u98f4\u98fc\u98fd\u98fe\u98ff\u9903\u9904\u9905\u9908\u9909\u990a\u990c\u990e\u990f\u9911\u9912\u9913\u9915\u9916\u9918\u991a\u991b\u991c\u991e\u9921\u9928\u992c\u9931\u9933\u9935\u9936\u9937\u993a\u993c\u993e\u993f\u9941\u9943\u9945\u9948\u9949\u994a\u994b\u994c\u9951\u9952\u9957\u995c\u995e\u9962\u99ac\u99ad\u99ae\u99b1\u99b3\u99b4\u99b9\u99c1\u99d0\u99d1\u99d2\u99d4\u99d5\u99d8\u99d9\u99db\u99dd\u99df\u99e1\u99e2\u99ed\u99f0\u99f1\u99f8\u99ff\u9a01\u9a02\u9a05\u9a0c\u9a0d\u9a0e\u9a0f\u9a16\u9a19\u9a24\u9a27\u9a2b\u9a2d\u9a2e\u9a30\u9a36\u9a37\u9a38\u9a3e\u9a40\u9a41\u9a42\u9a43\u9a44\u9a45\u9a4a\u9a4c\u9a4d\u9a4f\u9a55\u9a57\u9a5a\u9a5b\u9a5f\u9a62\u9a64\u9a65\u9a66\u9a6a\u9a6b\u9aaf\u9acf\u9ad2\u9ad4\u9ad5\u9ad6\u9aee\u9b06\u9b0d\u9b1a\u9b22\u9b25\u9b27\u9b28\u9b29\u9b2e\u9b31\u9b39\u9b4e\u9b58\u9b5a\u9b5b\u9b62\u9b68\u9b6f\u9b74\u9b77\u9b7a\u9b81\u9b83\u9b8a\u9b8b\u9b8d\u9b8e\u9b90\u9b91\u9b92\u9b93\u9b9a\u9b9c\u9b9d\u9b9e\u9ba3\u9ba6\u9baa\u9bab\u9bad\u9bae\u9bb3\u9bb6\u9bba\u9bc0\u9bc1\u9bc7\u9bc9\u9bca\u9bd2\u9bd4\u9bd5\u9bd6\u9bd7\u9bdb\u9bdd\u9be1\u9be2\u9be4\u9be7\u9be8\u9bea\u9beb\u9bf0\u9bf4\u9bf7\u9bfd\u9bff\u9c01\u9c02\u9c03\u9c06\u9c08\u9c09\u9c0c\u9c0d\u9c0f\u9c10\u9c12\u9c13\u9c1b\u9c1c\u9c1f\u9c20\u9c23\u9c25\u9c27\u9c28\u9c29\u9c2d\u9c2e\u9c31\u9c32\u9c33\u9c35\u9c37\u9c39\u9c3a\u9c3b\u9c3c\u9c3e\u9c42\u9c45\u9c48\u9c49\u9c52\u9c54\u9c56\u9c57\u9c58\u9c5d\u9c5f\u9c60\u9c63\u9c64\u9c67\u9c68\u9c6d\u9c6f\u9c77\u9c78\u9c7a\u9ce5\u9ce7\u9ce9\u9cec\u9cf2\u9cf3\u9cf4\u9cf6\u9cfe\u9d06\u9d07\u9d09\u9d12\u9d15\u9d1b\u9d1d\u9d1e\u9d1f\u9d23\u9d26\u9d28\u9d2f\u9d30\u9d34\u9d37\u9d3b\u9d3f\u9d41\u9d42\u9d43\u9d50\u9d51\u9d52\u9d53\u9d5c\u9d5d\u9d60\u9d61\u9d6a\u9d6c\u9d6e\u9d6f\u9d70\u9d72\u9d77\u9d7e\u9d84\u9d87\u9d89\u9d8a\u9d93\u9d96\u9d98\u9d9a\u9da1\u9da5\u9da9\u9daa\u9dac\u9daf\u9db2\u9db4\u9db9\u9dba\u9dbb\u9dbc\u9dbf\u9dc0\u9dc1\u9dc2\u9dc4\u9dc9\u9dca\u9dd3\u9dd6\u9dd7\u9dd9\u9dda\u9de5\u9de6\u9deb\u9def\u9df2\u9df3\u9df4\u9df8\u9df9\u9dfa\u9dfd\u9e02\u9e07\u9e0a\u9e0c\u9e0f\u9e15\u9e18\u9e1a\u9e1b\u9e1d\u9e1e\u9e75\u9e79\u9e7a\u9e7c\u9e7d\u9e97\u9ea5\u9ea9\u9eaa\u9eab\u9eaf\u9eb4\u9eb5\u9ebc\u9ebd\u9ec3\u9ecc\u9ede\u9ee8\u9ef2\u9ef4\u9ef6\u9ef7\u9efd\u9eff\u9f02\u9f09\u9f15\u9f34\u9f4a\u9f4b\u9f4e\u9f4f\u9f52\u9f54\u9f55\u9f57\u9f59\u9f5c\u9f5f\u9f60\u9f61\u9f63\u9f66\u9f67\u9f6a\u9f6c\u9f72\u9f76\u9f77\u9f8d\u9f8e\u9f90\u9f91\u9f94\u9f95\u9f9c\u9fc1\u9fd3";
const S_CHARS = "\u3454\u3447\u3439\u523e\u360e\u36af\u36e3\u37c6\u3918\u3a2b\u39d0\u64dc\u4025\u9fce\u4336\u433a\u433b\u433f\u433e\u4360\u43ac\u464c\u4727\u478d\u4982\u9fcf\u497e\u49b6\u49b7\u4bc5\u9c83\u4ca3\u4c9d\u9cda\u9ce4\u9e6e\u4e22\u5e76\u5e72\u4e71\u4e98\u4e9a\u4f2b\u5e03\u5360\u5e76\u6765\u4ed1\u4fa3\u5c40\u4fe3\u7cfb\u4f23\u4fa0\u4f21\u79c1\u4f25\u4fe9\u4feb\u4ed3\u4e2a\u4eec\u5e78\u4f26\u3448\u4f1f\u343d\u4fa7\u4fa6\u4f2a\u3437\u6770\u4f27\u4f1e\u5907\u5bb6\u4f63\u506c\u4f20\u4f1b\u503a\u4f24\u503e\u507b\u4ec5\u4f65\u4fa8\u4ec6\u4f2a\u4fa5\u507e\u96c7\u4ef7\u4eea\u4fca\u4fac\u4ebf\u4fa9\u4fed\u50a4\u50a7\u4fe6\u4faa\u5c3d\u507f\u4f18\u50a8\u4fea\u3469\u50a9\u50a5\u4fe8\u51f6\u5151\u513f\u5156\u5185\u4e24\u518c\u80c4\u5e42\u51c0\u51bb\u51db\u51ef\u522b\u5220\u522d\u5219\u514b\u5239\u522c\u521a\u5265\u5250\u5240\u521b\u94f2\u5212\u672d\u5267\u5218\u523d\u523f\u5251\u34e5\u5242\u3509\u52b2\u52a8\u52a1\u52cb\u80dc\u52b3\u52bf\u52da\u52a2\u52cb\u52b1\u529d\u5300\u5326\u6c47\u532e\u533a\u534f\u6064\u5374\u5373\u538d\u5395\u5386\u538c\u5389\u53a3\u53c2\u53c1\u4e1b\u54a4\u5434\u5450\u5415\u5459\u5458\u5457\u5ff5\u95ee\u542f\u54d1\u542f\u5521\u359e\u5524\u4e27\u5403\u4e54\u5355\u54df\u545b\u556c\u551d\u5417\u545c\u5522\u54d4\u53f9\u55bd\u556f\u5455\u5567\u5c1d\u551b\u54d7\u5520\u5578\u53fd\u54d3\u5452\u5574\u6076\u5618\u358a\u549d\u54d2\u54dd\u54d5\u55f3\u54d9\u55b7\u5428\u5f53\u549b\u5413\u54dc\u5c1d\u565c\u556e\u54bd\u5456\u5499\u5411\u4eb8\u55be\u4e25\u5624\u556d\u55eb\u56a3\u5181\u5453\u5570\u82cf\u5631\u56f1\u56f5\u56fd\u56f4\u56ed\u5706\u56fe\u56e2\u575d\u57ad\u91c7\u6267\u575a\u57a9\u57b4\u57da\u5c27\u62a5\u573a\u5757\u8314\u57b2\u57d8\u6d82\u51a2\u575e\u57d9\u5c18\u5811\u57ab\u5760\u5815\u575b\u575f\u57af\u5899\u57a6\u575b\u57b1\u57d9\u538b\u5792\u5739\u5786\u575b\u574f\u5784\u5785\u575c\u575d\u5846\u58ee\u58f6\u58f8\u5bff\u591f\u68a6\u4f19\u5939\u5942\u5965\u5941\u593a\u5956\u594b\u59f9\u5986\u59d7\u5978\u5a31\u5a04\u5987\u5a05\u5a32\u59ab\u36c0\u5aaa\u5988\u8885\u59aa\u59a9\u5a34\u5a34\u5a73\u59ab\u5aad\u5a06\u5a75\u5a07\u5af1\u5ad2\u5b37\u5ad4\u5a74\u5a76\u5a18\u36e4\u5a08\u5b59\u5b66\u5b6a\u5bab\u91c7\u5bdd\u5b9e\u5b81\u5ba1\u5199\u5bbd\u5ba0\u5b9d\u5c06\u4e13\u5bfb\u5bf9\u5bfc\u5c34\u5c4a\u5c38\u5c43\u5c49\u5c61\u5c42\u5c66\u5c5e\u5188\u5cf0\u5c98\u5c9b\u5ce1\u5d03\u6606\u5c97\u4ed1\u5ce5\u5cbd\u5c9a\u5c81\u37e5\u5d5d\u5d2d\u5c96\u5d5a\u5d02\u5ce4\u5ce3\u5cc4\u5cc3\u5d04\u5d58\u5cad\u5c7f\u5cb3\u5cbf\u5ce6\u5dc5\u5ca9\u5def\u537a\u5e05\u5e08\u5e10\u5e26\u5e27\u5e0f\u384e\u5e3c\u5e3b\u5e1c\u5e01\u5e2e\u5e31\u5e76\u5e72\u51e0\u5e93\u5395\u53a2\u53a9\u53a6\u5ebc\u836b\u53a8\u53ae\u5e99\u5382\u5e91\u5e9f\u5e7f\u5eea\u5e90\u5385\u5f11\u540a\u5f2a\u5f20\u5f3a\u522b\u5f39\u5f25\u5f2f\u5f55\u6c47\u5f5f\u5f66\u96d5\u5f68\u4f5b\u540e\u5f84\u4ece\u5f95\u590d\u5f81\u5f7b\u6052\u803b\u60a6\u60ae\u6005\u95f7\u51c4\u6076\u607c\u607d\u607b\u7231\u60ec\u60ab\u6006\u607a\u5ffe\u6817\u6001\u6120\u60e8\u60ed\u6078\u60ef\u60ab\u6004\u6002\u8651\u60ad\u5e86\u396a\u621a\u6b32\u5fe7\u60eb\u601c\u51ed\u6126\u616d\u60ee\u6124\u60af\u6003\u5baa\u5fc6\u6073\u5e94\u603f\u61d4\u8499\u603c\u61d1\u393d\u6079\u60e9\u61d2\u6000\u60ac\u5fcf\u60e7\u6151\u604b\u6206\u620b\u6217\u622c\u6218\u622f\u620f\u6237\u634d\u629b\u62fc\u635d\u6332\u631f\u820d\u626a\u6328\u5377\u626b\u62a1\u39cf\u631c\u6323\u6302\u91c7\u62e3\u626c\u6362\u6325\u6404\u635f\u6447\u6363\u6247\u63fe\u62a2\u63b4\u63bc\u6402\u631a\u62a0\u629f\u6298\u63ba\u635e\u6326\u6491\u6320\u39d1\u6322\u63b8\u62e8\u629a\u6251\u63ff\u631e\u631d\u6361\u62e5\u63b3\u62e9\u51fb\u6321\u39df\u62c5\u636e\u6324\u62ac\u6363\u62df\u6448\u62e7\u6401\u63b7\u6269\u64b7\u6446\u64de\u64b8\u39f0\u6270\u6445\u64b5\u62e2\u62e6\u6484\u6400\u64ba\u643a\u6444\u6512\u631b\u644a\u6405\u63fd\u6559\u655a\u8d25\u53d9\u654c\u6570\u655b\u6bd9\u6569\u6593\u65a9\u65ad\u4e8e\u65d7\u65e2\u5347\u65f6\u664b\u663c\u6655\u6656\u65f8\u7545\u6682\u6654\u5386\u6619\u6653\u5411\u66a7\u65f7\u663d\u6652\u4e66\u4f1a\u80e7\u672f\u4e1c\u62d0\u6805\u62d0\u67e5\u6746\u6800\u67a7\u6761\u67ad\u68c1\u5f03\u68cb\u67a8\u67a3\u680b\u3b4e\u6808\u6816\u68be\u6860\u3b4f\u6768\u67ab\u6862\u4e1a\u6781\u77e9\u5e72\u6769\u8363\u6985\u6864\u6784\u67aa\u6760\u68bf\u6920\u6901\u692e\u6868\u6922\u691d\u6869\u4e50\u679e\u6881\u697c\u6807\u67a2\u3b64\u6837\u699d\u3b74\u686a\u6734\u6811\u6866\u692b\u6861\u6865\u673a\u692d\u6a2a\u6aa9\u67fd\u6863\u6867\u69da\u68c0\u6a2f\u68bc\u53f0\u69df\u67e0\u69db\u67dc\u6a79\u6988\u6809\u691f\u6a7c\u680e\u6a71\u69e0\u680c\u67a5\u6a65\u6987\u8616\u680a\u6989\u6a31\u680f\u6989\u6743\u6924\u683e\u6984\u68c2\u94a6\u53f9\u6b27\u6b24\u6b22\u5c81\u5386\u5f52\u6b81\u6b8b\u6b92\u6b87\u3c6e\u6b9a\u50f5\u6b93\u6ba1\u3c69\u6b7c\u6740\u58f3\u58f3\u6bc1\u6bb4\u6bf5\u7266\u6be1\u6c07\u6c14\u6c22\u6c29\u6c32\u6cdb\u6cdb\u6c61\u51b3\u6ca1\u51b2\u51b5\u6eaf\u6cc4\u6c79\u6d43\u6cfe\u6d9a\u51c9\u51c4\u6cea\u6e0c\u51c0\u51cc\u6ca6\u6e0a\u6d9e\u6d45\u6da3\u51cf\u6ca8\u6da1\u6d4b\u6d51\u51d1\u6d48\u6d8c\u6c64\u6ca9\u51c6\u6c9f\u6e29\u6d49\u6da2\u6e7f\u6ca7\u706d\u6da4\u8365\u6c47\u6caa\u6ede\u6e17\u5364\u6d52\u6d50\u6eda\u6ee1\u6e14\u6e87\u6ca4\u6c49\u6d9f\u6e0d\u6da8\u6e86\u6e10\u6d46\u988d\u6cfc\u6d01\u6ca9\u3d0b\u6f5c\u6da6\u6d54\u6e83\u6ed7\u6da0\u6da9\u6d47\u6d9d\u6c84\u6da7\u6e11\u6cfd\u6eea\u6cf6\u6d4d\u6dc0\u3ce0\u6d4a\u6d53\u3ce1\u6e7f\u6cde\u6e81\u8499\u6d55\u6d4e\u6d9b\u3cd4\u6ee5\u6f4d\u6ee8\u6e85\u6cfa\u6ee4\u6f9b\u6ee2\u6e0e\u3cbf\u6cfb\u6c88\u6d4f\u6fd2\u6cf8\u6ca5\u6f47\u6f46\u6f74\u6cf7\u6fd1\u5f25\u6f4b\u6f9c\u6ca3\u6ee0\u6d12\u6f13\u6ee9\u704f\u3cd5\u6e7e\u6ee6\u6edf\u6edf\u707e\u4e3a\u4e4c\u70c3\u65e0\u70bc\u709c\u70df\u8315\u7115\u70e6\u7080\u3dbd\u7174\u8367\u709d\u70ed\u988e\u70bd\u70e8\u706f\u7096\u70e7\u70eb\u7116\u8425\u707f\u6bc1\u70db\u70e9\u3db6\u718f\u70ec\u7118\u70c1\u7089\u70c2\u4e89\u4e3a\u7237\u5c14\u5e8a\u5899\u724d\u62b5\u7275\u8366\u7266\u728a\u727a\u72b6\u72ed\u72c8\u72f0\u72b9\u72f2\u72b8\u5446\u72f1\u72ee\u5956\u72ec\u72ef\u7303\u72dd\u72de\u3e8d\u83b7\u730e\u72b7\u517d\u736d\u732e\u7315\u7321\u73b0\u96d5\u73d0\u73f2\u73ae\u739a\u7410\u7476\u83b9\u739b\u73b1\u740f\u740e\u7391\u7477\u73f0\u3ec5\u73af\u7399\u7478\u73ba\u7487\u743c\u73d1\u748e\u74d2\u74ef\u74ee\u4ea7\u4ea7\u4ea9\u6bd5\u753b\u5f02\u753b\u5f53\u7574\u53e0\u75c9\u9178\u75b4\u75d6\u75af\u75a1\u75ea\u7617\u75ae\u759f\u7606\u75ad\u7618\u7618\u7597\u75e8\u75eb\u7605\u6108\u75a0\u762a\u75f4\u75d2\u7596\u75c7\u75ac\u765e\u7663\u763f\u763e\u75c8\u762b\u766b\u53d1\u7682\u7691\u75b1\u76b2\u76b1\u676f\u76d7\u76cf\u5c3d\u76d1\u76d8\u5362\u8361\u771f\u7726\u4f17\u56f0\u7741\u7750\u770d\u4056\u7792\u7786\u7751\u8499\u772c\u77a9\u77eb\u6731\u7841\u7856\u7817\u781a\u57fc\u7855\u7800\u781c\u786e\u7801\u40b5\u7859\u7816\u7875\u789c\u789b\u77f6\u7857\u40c5\u785a\u7840\u788d\u77ff\u783a\u783e\u77fe\u783b\u79d8\u7984\u7978\u796f\u794e\u7943\u5fa1\u7985\u793c\u7962\u7977\u79c3\u7c7c\u7a0e\u79c6\u4149\u68f1\u7980\u79cd\u79f0\u8c37\u415f\u7a23\u79ef\u9896\u79fe\u7a51\u79fd\u7a33\u83b7\u7a5e\u7a9d\u6d3c\u7a77\u7a91\u7a8e\u7aad\u7aa5\u7a9c\u7a8d\u7aa6\u7076\u7a83\u7ad6\u7ade\u7b14\u7b0b\u7b15\u41f2\u4e2a\u7b3a\u7b5d\u672d\u8282\u8303\u7b51\u7ba7\u7b7c\u7b7f\u7b03\u7b5b\u7b5a\u7ba6\u7bd3\u84d1\u7baa\u7b80\u7bd1\u7bab\u7b5c\u7b7e\u5e18\u7bee\u7b79\u4264\u7b93\u7bef\u7ba8\u7c41\u7b3c\u7b7e\u7b3e\u7c16\u7bf1\u7ba9\u5401\u7ca4\u7cbd\u7cc1\u7caa\u7cae\u56e2\u7c9d\u7c74\u7c9c\u7e9f\u7ea0\u7eaa\u7ea3\u7ea6\u7ea2\u7ea1\u7ea5\u7ea8\u7eab\u7eb9\u7eb3\u7ebd\u7ebe\u7eaf\u7eb0\u7ebc\u7eb1\u7eae\u7eb8\u7ea7\u7eb7\u7ead\u7eb4\u7eba\u4337\u624e\u7ec6\u7ec2\u7ec1\u7ec5\u7ebb\u7ecd\u7ec0\u7ecb\u7ed0\u7ecc\u7ec8\u5f26\u7ec4\u4339\u7eca\u7ed7\u7ed3\u7edd\u7ee6\u7ed4\u7ede\u7edc\u7eda\u7ed9\u7ed2\u7ed6\u7edf\u4e1d\u7edb\u7edd\u7ee2\u7ed1\u7ee1\u7ee0\u7ee8\u7ee3\u7ee4\u7ee5\u433c\u6346\u7ecf\u7efc\u7f0d\u7eff\u7ef8\u7efb\u7ebf\u7ef6\u7ef4\u7ef9\u7efe\u7eb2\u7f51\u7ef7\u7f00\u5f69\u7eb6\u7efa\u7eee\u7efd\u7ef0\u7eeb\u7ef5\u7ef2\u7f01\u7d27\u7eef\u7eff\u7eea\u7eec\u7ef1\u7f03\u7f04\u7f02\u7ebf\u7f09\u7f0e\u7f14\u7f17\u7f18\u7f0c\u7f16\u7f13\u7f05\u7eac\u7f11\u7f08\u7ec3\u7f0f\u7f07\u81f4\u7f0a\u8426\u7f19\u7f22\u7f12\u7ec9\u7f23\u7f0a\u7f1e\u7f1a\u7f1c\u7f1f\u7f1b\u53bf\u7ee6\u7f1d\u7f21\u7f29\u7eb5\u7f27\u4338\u7ea4\u7f26\u7d77\u7f15\u7f25\u603b\u7ee9\u7ef7\u7f2b\u7f2a\u7f2f\u7ec7\u7f2e\u7f2d\u7ed5\u7ee3\u7f0b\u7ef3\u7ed8\u7cfb\u8327\u7f30\u7f33\u7f32\u7f34\u4341\u7ece\u7ee7\u7f24\u7f31\u4340\u98a3\u7f2c\u7ea9\u7eed\u7d2f\u7f20\u7f28\u624d\u7ea4\u7f35\u7f06\u94b5\u44e8\u575b\u7f42\u575b\u7f5a\u9a82\u7f62\u7f57\u7f74\u7f81\u8288\u7fa4\u7f9f\u7fa1\u4e49\u81bb\u4e60\u73a9\u7fda\u7fd8\u7fd9\u8027\u8022\u5723\u95fb\u8054\u806a\u58f0\u8038\u8069\u8042\u804c\u804d\u542c\u804b\u8083\u80c1\u8109\u80eb\u5507\u4fee\u8131\u80c0\u80be\u80e8\u8136\u8111\u80bf\u811a\u80a0\u817d\u8158\u80a4\u43dd\u80f6\u817b\u80c6\u810d\u8113\u8138\u8110\u8191\u814a\u80ea\u810f\u8114\u81dc\u5367\u4e34\u53f0\u4e0e\u5174\u4e3e\u65e7\u94fa\u9986\u8231\u8223\u8230\u823b\u8270\u8273\u520d\u82ce\u5179\u8346\u5e84\u830e\u835a\u82cb\u534e\u5eb5\u70df\u82cc\u83b1\u4e07\u835d\u83b4\u53f6\u836d\u836e\u82c7\u836f\u8364\u641c\u83bc\u83b3\u8480\u8385\u82cd\u836a\u5e2d\u76d6\u83b2\u82c1\u83bc\u835c\u535c\u53c2\u848c\u848b\u8471\u8311\u836b\u8368\u8487\u835e\u836c\u82b8\u83b8\u835b\u8489\u8361\u829c\u8427\u84e3\u8570\u835f\u84df\u8297\u59dc\u8537\u8359\u83b6\u8350\u8428\u82e7\u44d3\u82d4\u8360\u84dd\u8369\u827a\u836f\u85ae\u44d6\u8574\u82c8\u853c\u853a\u841a\u8572\u82a6\u82cf\u8574\u82f9\u85d3\u8539\u830f\u5170\u84e0\u841d\u8502\u5904\u865a\u864f\u53f7\u4e8f\u866c\u86f1\u8715\u86ac\u8680\u732c\u867e\u8671\u8717\u86f3\u8682\u8424\u45d6\u877c\u8780\u86f0\u8748\u87a8\u866e\u8749\u86f2\u866b\u86cf\u8681\u8683\u8747\u867f\u874e\u86f4\u877e\u869d\u8721\u86ce\u87cf\u86ca\u8695\u86ee\u4f17\u8511\u672f\u540c\u80e1\u536b\u51b2\u886e\u5939\u8885\u91cc\u8865\u88c5\u91cc\u5236\u590d\u88c8\u8886\u88e4\u88e2\u891b\u4eb5\u88e5\u88e5\u88af\u8884\u88e3\u88c6\u8934\u889c\u6446\u886c\u88ad\u8955\u6838\u89c1\u89c3\u89c4\u89c5\u89c6\u89c7\u89cb\u89cd\u89ce\u4eb2\u89ca\u89cf\u89d0\u89d1\u89c9\u89c8\u89cc\u89c2\u89de\u89ef\u89e6\u8ba0\u8ba2\u8ba3\u8ba1\u8baf\u8ba7\u8ba8\u8ba6\u8bb1\u8bad\u8baa\u8bab\u6258\u8bb0\u8bb9\u8bb6\u8bbc\u4723\u8bc0\u8bb7\u8bbb\u8bbf\u8bbe\u8bb8\u8bc9\u8bc3\u8bca\u6ce8\u8bc1\u8bc2\u8bcb\u8bb5\u8bc8\u8bd2\u8bcf\u8bc4\u8bd0\u8bc7\u8bce\u8bc5\u8bcd\u548f\u8be9\u8be2\u8be3\u8bd5\u8bd7\u8be7\u8bdf\u8be1\u8be0\u8bd8\u8bdd\u8be5\u8be6\u8bdc\u8bd9\u8bd6\u8bd4\u8bdb\u8bd3\u5938\u5fd7\u8ba4\u8bf3\u8bf6\u8bde\u8bf1\u8bee\u8bed\u8bda\u8beb\u8bec\u8bef\u8bf0\u8bf5\u8bf2\u8bf4\u8bf4\u8c01\u8bfe\u8c07\u8bfd\u8c0a\u8a1a\u8c03\u8c04\u8c06\u8c08\u8bff\u8bf7\u8be4\u8bf9\u8bfc\u8c05\u8bba\u8c02\u8c00\u8c0d\u8c1e\u8c1d\u8c25\u8be8\u8c14\u8c1b\u8c10\u8c0f\u8c15\u54a8\u8bb3\u8c19\u8c0c\u8bbd\u8bf8\u8c1a\u8c16\u8bfa\u8c0b\u8c12\u8c13\u8a8a\u8bcc\u8c0e\u8c1c\u8c27\u8c11\u8c21\u8c24\u8c26\u8c25\u8bb2\u8c22\u8c23\u8c23\u8c1f\u8c2a\u8c2c\u8c2b\u8bb4\u8c28\u8c29\u54d7\u8bc1\u8c32\u8ba5\u8c2e\u8bc6\u8c2f\u8c2d\u8c31\u566a\u8c35\u6bc1\u8bd1\u8bae\u8c34\u62a4\u8bea\u8a89\u8c2b\u8bfb\u8c09\u53d8\u8a5f\u4729\u96e0\u8c17\u8ba9\u8c30\u8c36\u8d5e\u8c20\u8c33\u6eaa\u5c82\u7ad6\u4e30\u8273\u732a\u8c6e\u72f8\u732b\u4759\u8d1d\u8d1e\u8d20\u8d1f\u8d22\u8d21\u8d2b\u8d27\u8d29\u8d2a\u8d2f\u8d23\u8d2e\u8d33\u8d40\u8d30\u8d35\u8d2c\u4e70\u8d37\u8d36\u8d39\u8d34\u8d3b\u8d38\u8d3a\u8d32\u8d42\u8d41\u8d3f\u8d45\u8d44\u8d3e\u8d3c\u8d48\u8d4a\u5bbe\u8d47\u8d52\u8d49\u8d50\u8d4f\u8d54\u8d53\u8d24\u5356\u8d31\u8d4b\u8d55\u8d28\u8d4d\u8d26\u8d4c\u4790\u8d56\u8d57\u8d5a\u8d59\u8d2d\u8d5b\u8d5c\u8d3d\u8d58\u8d5f\u8d60\u8d5e\u8d5d\u8d61\u8d62\u8d46\u8d43\u8d51\u8d4e\u8d5d\u8d63\u8d43\u8d6a\u8d76\u8d75\u8d8b\u8db1\u8ff9\u8df5\u903e\u8e0a\u8dc4\u8df8\u8ff9\u8dd6\u8e52\u8e2a\u8df7\u8df6\u8db8\u8e0c\u8dfb\u8dc3\u47e2\u8e2f\u8dde\u8e2c\u8e70\u8df9\u8e51\u8e7f\u8e9c\u8e8f\u8eaf\u8f66\u8f67\u8f68\u519b\u8f6a\u8f69\u8f6b\u8f6d\u8f6f\u8f77\u8f78\u8f71\u8f74\u8f75\u8f7a\u8f72\u8f76\u8f7c\u8f83\u8f82\u8f81\u8f80\u8f7d\u8f7e\u8f84\u633d\u8f85\u8f7b\u8f86\u8f8e\u8f89\u8f8b\u8f8d\u8f8a\u8f87\u8f88\u8f6e\u8f8c\u8f91\u8f8f\u8f93\u8f90\u8f92\u8f97\u8206\u8f92\u6bc2\u8f96\u8f95\u8f98\u8f6c\u8f99\u8f7f\u8f9a\u8f70\u8f94\u8f79\u8f73\u529e\u8f9e\u8fab\u8fa9\u519c\u56de\u5f84\u8fd9\u8fde\u5468\u8fdb\u6e38\u8fd0\u8fc7\u8fbe\u8fdd\u9065\u900a\u9012\u8fdc\u6eaf\u9002\u8fdf\u7ed5\u8fc1\u9009\u9057\u8fbd\u8fc8\u8fd8\u8fe9\u8fb9\u903b\u9026\u90cf\u90ae\u90d3\u4e61\u90b9\u90ac\u90e7\u9093\u90d1\u90bb\u90f8\u90ba\u90d0\u909d\u9142\u90e6\u814c\u915d\u4e11\u915d\u848f\u7cd6\u533b\u9171\u9166\u917f\u8845\u917e\u917d\u91ca\u5398\u9485\u9486\u9487\u948c\u948a\u9489\u948b\u9488\u9493\u9490\u6263\u948f\u9492\u9497\u948d\u9495\u948e\u497a\u94af\u94ab\u9498\u94ad\u94a5\u949a\u94a0\u949d\u94a9\u94a4\u94a3\u9491\u949e\u94ae\u94a7\u949f\u9499\u94ac\u949b\u94aa\u94cc\u94c8\u94b6\u94c3\u94b4\u94b9\u94cd\u94b0\u94b8\u94c0\u94bf\u94be\u5de8\u94bb\u94ca\u94c9\u94c7\u94cb\u94c2\u94b7\u94b3\u94c6\u94c5\u94ba\u94b5\u94a9\u94b2\u94bc\u94bd\u952b\u94cf\u94f0\u94d2\u94ec\u94ea\u94f6\u94f3\u94dc\u94da\u94e3\u94e8\u94e2\u94ed\u94eb\u94e6\u8854\u94d1\u94f7\u94f1\u94df\u94f5\u94e5\u94d5\u94ef\u94d0\u94de\u9510\u9500\u9508\u9511\u9509\u94dd\u9512\u950c\u94a1\u94e4\u94d7\u950b\u94fb\u950a\u9513\u94d8\u9504\u9503\u9514\u9507\u94d3\u94fa\u9510\u94d6\u9506\u9502\u94fd\u950d\u952f\u94a2\u951e\u5f55\u9516\u952b\u9529\u94d4\u9525\u9515\u951f\u9524\u9531\u94ee\u951b\u952c\u952d\u951c\u94b1\u9526\u951a\u9520\u9521\u9522\u9519\u5f55\u9530\u8868\u94fc\u954e\u951d\u9528\u952a\u94ab\u9494\u9534\u9533\u70bc\u9505\u9540\u9537\u94e1\u9496\u953b\u953d\u9538\u9532\u9518\u9539\u953e\u952e\u9536\u9517\u9488\u949f\u9541\u953f\u9545\u9551\u9570\u9555\u9501\u9549\u9524\u9548\u9543\u94a8\u84e5\u954f\u94e0\u94e9\u953c\u9550\u9547\u9547\u9552\u954b\u954d\u9553\u9fd4\u954c\u954e\u955e\u65cb\u94fe\u9546\u9559\u9560\u955d\u94ff\u9535\u9557\u9558\u955b\u94f2\u955c\u9556\u9542\u933e\u955a\u94e7\u9564\u956a\u497d\u9508\u94d9\u94f4\u9563\u94f9\u9566\u9561\u949f\u956b\u9562\u9568\u4985\u950e\u950f\u9544\u954c\u9570\u4983\u956f\u956d\u94c1\u956e\u94ce\u94db\u9571\u94f8\u956c\u9554\u9274\u9274\u9572\u9527\u9574\u94c4\u9573\u9565\u9567\u94a5\u9575\u9576\u954a\u9569\u9523\u94bb\u92ae\u51ff\u9562\u954b\u957f\u95e8\u95e9\u95ea\u95eb\u95ec\u95ed\u5f00\u95f6\u95f3\u95f0\u95f2\u95f2\u95f4\u95f5\u95f8\u9602\u9601\u5408\u9600\u95fa\u95fd\u9603\u9606\u95fe\u9605\u9605\u960a\u9609\u960e\u960f\u960d\u9608\u960c\u9612\u677f\u6697\u95f1\u9614\u9615\u9611\u9607\u9617\u9618\u95ff\u9616\u9619\u95ef\u5173\u961a\u9613\u9610\u8f9f\u961b\u95fc\u9649\u9655\u5347\u9635\u9634\u9648\u9646\u9633\u9667\u961f\u9636\u9668\u9645\u968f\u9669\u9666\u9690\u9647\u96b6\u53ea\u96bd\u867d\u53cc\u96cf\u6742\u9e21\u79bb\u96be\u4e91\u7535\u6cbe\u9721\u96fe\u9701\u96f3\u972d\u53c7\u7075\u53c6\u9753\u9759\u9754\u817c\u9765\u5de9\u7ef1\u79cb\u9792\u7f30\u9791\u5343\u97af\u97e6\u97e7\u97e8\u97e9\u97ea\u97ec\u97b2\u97eb\u97f5\u54cd\u9875\u9876\u9877\u9879\u987a\u9878\u987b\u987c\u9882\u9880\u9883\u9884\u987d\u9881\u987f\u9887\u9886\u988c\u9889\u9890\u988f\u5934\u9892\u988a\u988b\u9895\u9894\u9888\u9893\u9891\u9893\u9897\u9898\u989d\u989a\u989c\u9899\u989b\u989c\u613f\u98a1\u98a0\u7c7b\u989f\u98a2\u987e\u98a4\u98a5\u663e\u98a6\u9885\u989e\u98a7\u98ce\u98d0\u98d1\u98d2\u53f0\u522e\u98d3\u98d4\u98cf\u98d6\u98d5\u98d7\u98d8\u98d9\u98da\u98de\u9963\u9965\u9964\u9966\u9968\u996a\u996b\u996c\u996d\u98e7\u996e\u9974\u9972\u9971\u9970\u9973\u997a\u9978\u997c\u7ccd\u9977\u517b\u9975\u9979\u997b\u997d\u9981\u997f\u9982\u997e\u4f59\u80b4\u9984\u9983\u996f\u9985\u9986\u7cca\u7cc7\u9967\u5582\u9989\u9987\u998e\u9969\u998f\u998a\u998c\u998d\u9992\u9990\u9991\u9993\u9988\u9994\u9965\u9976\u98e8\u990d\u998b\u9995\u9a6c\u9a6d\u51af\u9a6e\u9a70\u9a6f\u9a72\u9a73\u9a7b\u9a7d\u9a79\u9a75\u9a7e\u9a80\u9a78\u9a76\u9a7c\u9a77\u9a82\u9a88\u9a87\u9a83\u9a86\u9a8e\u9a8f\u9a8b\u9a8d\u9a93\u9a94\u9a92\u9a91\u9a90\u9a9b\u9a97\u9a99\u4bc4\u9a9e\u9a98\u9a9d\u817e\u9a7a\u9a9a\u9a9f\u9aa1\u84e6\u9a9c\u9a96\u9aa0\u9aa2\u9a71\u9a85\u9a95\u9a81\u9aa3\u9a84\u9a8c\u60ca\u9a7f\u9aa4\u9a74\u9aa7\u9aa5\u9aa6\u9a8a\u9a89\u80ae\u9ac5\u810f\u4f53\u9acc\u9acb\u53d1\u677e\u80e1\u987b\u9b13\u6597\u95f9\u54c4\u960b\u9604\u90c1\u9b36\u9b49\u9b47\u9c7c\u9c7d\u9c7e\u9c80\u9c81\u9c82\u9c7f\u9c84\u9c85\u9c86\u9c8c\u9c89\u9c8f\u9c87\u9c90\u9c8d\u9c8b\u9c8a\u9c92\u9c98\u9c9e\u9c95\u4c9f\u9c96\u9c94\u9c9b\u9c91\u9c9c\u9c93\u9caa\u9c9d\u9ca7\u9ca0\u9ca9\u9ca4\u9ca8\u9cac\u9cbb\u9caf\u9cad\u9c9e\u9cb7\u9cb4\u9cb1\u9cb5\u9cb2\u9cb3\u9cb8\u9cae\u9cb0\u9cb6\u9cba\u9cc0\u9cab\u9cca\u9cc8\u9c97\u9cc2\u4ca0\u9cbd\u9cc7\u4ca1\u9cc5\u9cbe\u9cc4\u9cc6\u9cc3\u9cc1\u9cd2\u9cd1\u9ccb\u9ca5\u9ccf\u4ca2\u9cce\u9cd0\u9ccd\u9cc1\u9ca2\u9ccc\u9cd3\u9cd8\u9ca6\u9ca3\u9cb9\u9cd7\u9cdb\u9cd4\u9cc9\u9cd9\u9cd5\u9cd6\u9cdf\u9cdd\u9cdc\u9cde\u9c9f\u9cbc\u9c8e\u9c99\u9ce3\u9ce1\u9ce2\u9cbf\u9c9a\u9ce0\u9cc4\u9c88\u9ca1\u9e1f\u51eb\u9e20\u51eb\u9e24\u51e4\u9e23\u9e22\u4d13\u9e29\u9e28\u9e26\u9e30\u9e35\u9e33\u9e32\u9e2e\u9e31\u9e2a\u9e2f\u9e2d\u9e38\u9e39\u9e3b\u4d15\u9e3f\u9e3d\u4d14\u9e3a\u9e3c\u9e40\u9e43\u9e46\u9e41\u9e48\u9e45\u9e44\u9e49\u9e4c\u9e4f\u9e50\u9e4e\u96d5\u9e4a\u9e53\u9e4d\u4d16\u9e2b\u9e51\u9e52\u9e4b\u9e59\u9e55\u9e57\u9e56\u9e5b\u9e5c\u4d17\u9e27\u83ba\u9e5f\u9e64\u9e60\u9e61\u9e58\u9e63\u9e5a\u9e5a\u9e62\u9e5e\u9e21\u4d18\u9e5d\u9e67\u9e65\u9e25\u9e37\u9e68\u9e36\u9e6a\u9e54\u9e69\u9e6b\u9e47\u9e47\u9e6c\u9e70\u9e6d\u9e34\u3d89\u9e6f\u4d19\u9e71\u9e72\u9e2c\u9e74\u9e66\u9e73\u9e42\u9e3e\u5364\u54b8\u9e7e\u78b1\u76d0\u4e3d\u9ea6\u9eb8\u9762\u9762\u66f2\u66f2\u9762\u4e48\u4e48\u9ec4\u9ec9\u70b9\u515a\u9eea\u9709\u9ee1\u9ee9\u9efe\u9f0b\u9f0c\u9f0d\u51ac\u9f39\u9f50\u658b\u8d4d\u9f51\u9f7f\u9f80\u9f81\u9f82\u9f85\u9f87\u9f83\u9f86\u9f84\u51fa\u9f88\u556e\u9f8a\u9f89\u9f8b\u816d\u9f8c\u9f99\u5390\u5e9e\u4dae\u9f9a\u9f9b\u9f9f\u4724\u9fd2";

const T2S_MAP = new Map();
for (let i = 0; i < T_CHARS.length; i++) {
  T2S_MAP.set(T_CHARS[i], S_CHARS[i]);
}
T2S_MAP.set('妳', '你');
T2S_MAP.set('著', '着');
T2S_MAP.set('後', '后');

export function toSimplified(text) {
  if (!text || typeof text !== 'string') return text || '';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
    return text;
  }
  return text.split('').map((c) => T2S_MAP.get(c) || c).join('');
}

export function normalizeArtistName(rawArtist) {
  if (!rawArtist || typeof rawArtist !== 'string') return rawArtist || '';
  const trimmed = rawArtist.trim();
  const lower = trimmed.toLowerCase();

  // 1. 直接命中别名映射
  if (CHINESE_ARTIST_ALIASES[lower]) {
    return CHINESE_ARTIST_ALIASES[lower];
  }

  // 2. 多艺人合唱形式拆分判定 (&, feat., ft., 逗号, 斜杠)
  const splitRegex = /(\s*(?:,|&|\/|feat\.|ft\.)\s*)/i;
  if (splitRegex.test(trimmed)) {
    const parts = trimmed.split(splitRegex);
    let matched = false;
    const mapped = parts.map((part, idx) => {
      if (idx % 2 === 0) {
        const pLower = part.trim().toLowerCase();
        if (CHINESE_ARTIST_ALIASES[pLower]) {
          matched = true;
          return CHINESE_ARTIST_ALIASES[pLower];
        }
        return toSimplified(part);
      }
      return part;
    });
    if (matched) {
      return mapped.join('');
    }
  }

  // 3. 通用繁体转简体
  return toSimplified(trimmed);
}

