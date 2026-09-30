// 各页面共用的条目操作（与 music.apple.com 相同）：封面悬停时的「播放」「更多」按钮、曲目行的「更多」菜单，
// 菜单项有播放、打开、复制本站链接与 Apple Music 链接。整张专辑 / 歌单的播放在这里取曲目后交给播放器队列。
//
// 条目 target：{ kind, href, apple, name, country, resource?, albumHref?, onPlay? }
//   kind：song / music-video / album / playlist / artist；href：本站页面路径（/https://music.apple.com/...）；
//   apple：Apple Music 原始地址；resource：amp-api 资源（歌曲单独播放时用来生成队列条目）；
//   albumHref：曲目所属专辑的本站路径（菜单里的「前往专辑」）；onPlay：页面自己的播放方式（如按专辑顺序播放）
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
function songEntry(track, country, context = {}) {
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

/** 专辑 / 歌单的全部歌曲（分页取完），MV 等跳过 */
async function collectionEntries(target) {
  const m = target.href.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/(album|playlist)\/(?:[^/?#]+\/)?([^/?#]+)/i);
  if (!m) return [];
  const country = m[1].toLowerCase();
  const playlist = m[2] === 'playlist';
  const l = await AmI18n.catalogLang(country);
  const trackParams = { l, 'include[songs]': 'artists', 'fields[artists]': 'name,url' };
  const data = await amp(`/v1/catalog/${country}/${playlist ? 'playlists' : 'albums'}/${m[3]}`, {
    platform: 'web', include: 'tracks', ...(playlist ? { 'limit[tracks]': '300' } : {}), ...trackParams,
  });
  const res = data.data && data.data[0];
  if (!res) return [];
  const rel = res.relationships && res.relationships.tracks;
  let list = (rel && rel.data) || [];
  for (let more = rel && rel.next, pages = 0; more && pages < 20; pages++) {
    const page = await amp(more, trackParams);
    list = list.concat(page.data || []);
    more = page.next;
  }
  const a = res.attributes || {};
  const context = playlist
    ? { album: a.name, artwork: (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork }
    : { album: a.name, albumHref: pagePath(res, country), artwork: a.artwork };
  return list.filter((track) => track.type === 'songs' && track.attributes).map((track) => songEntry(track, country, context));
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

/** items：'-' 分隔线，或 { icon, label, title?, onSelect }；title 为悬停提示（如完整链接） */
function openMenu(trigger, items) {
  const box = menuEl();
  const reopen = menu.trigger === trigger;
  closeMenu(false);
  if (reopen) return;
  box.replaceChildren(...items.map((it) => {
    if (it === '-') return el('div', { className: 'menu-sep', role: 'separator' });
    const node = el('button', { className: 'menu-item', type: 'button', innerHTML: it.icon, tabIndex: -1 });
    node.setAttribute('role', 'menuitem');
    node.append(el('span', { className: 'menu-text' }, el('span', { className: 'menu-label', textContent: it.label })));
    if (it.title) node.title = it.title;
    node.addEventListener('click', () => { closeMenu(false); it.onSelect(); });
    return node;
  }));
  box.hidden = false;
  menu.trigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  // 菜单打开期间封面上的按钮保持显示
  trigger.closest('.card-wrap, .row-wrap')?.classList.add('menu-open');
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

  const playable = (target) => ['song', 'album', 'playlist', 'music-video'].includes(target.kind) && (target.kind !== 'song' || target.onPlay || target.resource);

  async function play(target, button, shuffle = false) {
    if (target.kind === 'music-video') { navigate(target.href); return; }
    if (target.onPlay) { target.onPlay(); return; }
    if (target.kind === 'song') { player.playQueue([songEntry(target.resource, target.country)], 0); return; }
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

  function menuItems(target, button) {
    const items = [];
    if (target.kind === 'music-video') items.push({ icon: ICON.video, label: t('action.playMv'), onSelect: () => navigate(target.href) });
    else if (playable(target)) items.push({ icon: ICON.play, label: t('action.play'), onSelect: () => play(target, button) });
    if (target.kind === 'album' || target.kind === 'playlist') items.push({ icon: ICON.shuffle, label: t('action.shuffle'), onSelect: () => play(target, button, true) });
    if (target.kind === 'song') items.push({ icon: ICON.quality, label: t('album.quality'), onSelect: () => navigate(target.href) });
    if (target.albumHref) items.push({ icon: ICON.album, label: t('action.goAlbum'), onSelect: () => navigate(target.albumHref) });
    if (items.length) items.push('-');
    const site = location.origin + target.href;
    items.push(
      { icon: ICON.link, label: t('action.copySite'), title: site, onSelect: () => copy(site) },
      { icon: ICON.apple, label: t('action.copyApple'), title: target.apple, onSelect: () => copy(target.apple) });
    return items;
  }

  function moreButton(target, className = 'track-more') {
    const button = el('button', { className, type: 'button', innerHTML: ICON.more, title: t('action.more') });
    button.setAttribute('aria-label', t('action.moreFor', { name: target.name }));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(button, menuItems(target, button));
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

  return { moreButton, coverActions, wrapCard, wrapRow };
}
