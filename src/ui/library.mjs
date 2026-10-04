// 资料库与歌单（与 music.apple.com 的「资料库」「歌单」相同），全部保存在本浏览器的 IndexedDB 中，服务端不保存任何数据。
// 启动时整库读入内存，读取都是同步的；修改先改内存、立即通知界面，再写入 IndexedDB；
// 同一浏览器的其他标签页经 BroadcastChannel 收到通知后重新读取。IndexedDB 不可用时（如部分隐私模式）只保存在内存中，
// persistent() 为 false，页面据此提示。
//
// 曲目快照 track（资料库中的歌曲 / MV 与歌单中的曲目共用）：
//   { kind: 'song' | 'music-video', id, country, name, artist, artists: [{ name, href }], album, albumId, albumHref,
//     href, artwork, bgColor, duration, explicit }
//   href / albumHref / artists[].href 为本站页面路径（/https://music.apple.com/...），artwork 为 amp-api 的 {w}x{h} 图片模板。
// 资料库条目 item：曲目快照，或
//   专辑 { kind: 'album', id, country, name, artist, artistHref, href, artwork, bgColor, releaseDate, trackCount }
//   Apple Music 歌单 { kind: 'playlist', id: 'pl.…', country, name, curator, href, artwork, bgColor }
//   均带 addedAt（毫秒）。键为 `${kind}:${id}`。
// 本地歌单 playlist：{ id: 'p.…', name, description, createdAt, updatedAt, tracks: [{ uid, addedAt, ...track }] }
//
// 导入 / 导出文件（JSON）：{ format: 'am-hook-library', version: 1, exportedAt, items: [...], playlists: [...] }，
// 导出单个歌单时 items 为空。导入时逐条校验，链接只接受本站的 Apple Music 页面路径，图片只接受 https 地址。

export const FORMAT = 'am-hook-library';
export const FORMAT_VERSION = 1;

const DB_NAME = 'am-hook-library';
const DB_VERSION = 1;
const CHANNEL = 'am-hook-library';
/** 单个歌单与整个资料库的上限，避免导入异常文件时占满存储 */
const MAX_TRACKS = 10000;
const MAX_ITEMS = 100000;

/** key → item */
const items = new Map();
/** id → playlist */
const lists = new Map();
const listeners = new Set();
let db = null;
let channel = null;

/* ---------- 校验与规范化：本地写入与导入共用，保证存下的数据可以直接放进页面 ---------- */
const SITE_PATH = /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/(?:song|album|music-video|playlist|artist)\/[^\s"'<>\\]*$/;
const ART = /^https:\/\/[^\s"'<>\\()]+$/;
const COLOR = /^[0-9a-f]{6}$/i;
const PLAYLIST_ID = /^p\.[0-9A-Za-z_-]{1,64}$/;
const CATALOG_PLAYLIST_ID = /^pl\.[0-9A-Za-z_-]{1,64}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;

const str = (value, max = 300) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const href = (value) => { const s = str(value, 600); return SITE_PATH.test(s) ? s : ''; };
const art = (value) => { const s = str(value, 600); return ART.test(s) ? s : ''; };
const color = (value) => (typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : '');
const country = (value) => (typeof value === 'string' && /^[a-z]{2}$/i.test(value) ? value.toLowerCase() : 'us');
const time = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);

function cleanTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'music-video' ? 'music-video' : raw.kind === 'song' ? 'song' : '';
  const id = str(raw.id, 20);
  if (!kind || !NUMERIC_ID.test(id)) return null;
  const albumId = str(raw.albumId, 20);
  return {
    kind,
    id,
    country: country(raw.country),
    name: str(raw.name) || id,
    artist: str(raw.artist),
    artists: (Array.isArray(raw.artists) ? raw.artists : []).slice(0, 20)
      .map((a) => a && { name: str(a.name), href: href(a.href) })
      .filter((a) => a && a.name),
    album: str(raw.album),
    albumId: NUMERIC_ID.test(albumId) ? albumId : '',
    albumHref: href(raw.albumHref),
    href: href(raw.href),
    artwork: art(raw.artwork),
    bgColor: color(raw.bgColor),
    duration: Number.isFinite(raw.duration) && raw.duration > 0 ? Math.round(raw.duration) : 0,
    explicit: raw.explicit === true,
  };
}

function cleanItem(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  let item = null;
  if (raw.kind === 'song' || raw.kind === 'music-video') {
    item = cleanTrack(raw);
  } else if (raw.kind === 'album') {
    const id = str(raw.id, 20);
    if (!NUMERIC_ID.test(id)) return null;
    item = {
      kind: 'album', id, country: country(raw.country), name: str(raw.name) || id, artist: str(raw.artist),
      artistHref: href(raw.artistHref), href: href(raw.href), artwork: art(raw.artwork), bgColor: color(raw.bgColor),
      releaseDate: str(raw.releaseDate, 10), trackCount: Number.isInteger(raw.trackCount) && raw.trackCount > 0 ? raw.trackCount : 0,
    };
  } else if (raw.kind === 'playlist') {
    const id = str(raw.id, 70);
    if (!CATALOG_PLAYLIST_ID.test(id)) return null;
    item = {
      kind: 'playlist', id, country: country(raw.country), name: str(raw.name) || id, curator: str(raw.curator),
      href: href(raw.href), artwork: art(raw.artwork), bgColor: color(raw.bgColor),
    };
  }
  if (!item) return null;
  item.addedAt = time(raw.addedAt, now);
  item.key = keyOf(item.kind, item.id);
  return item;
}

function cleanPlaylist(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const createdAt = time(raw.createdAt, now);
  const uids = new Set();
  const tracks = [];
  for (const entry of (Array.isArray(raw.tracks) ? raw.tracks : []).slice(0, MAX_TRACKS)) {
    const track = cleanTrack(entry);
    if (!track) continue;
    let uid = str(entry.uid, 40);
    if (!/^[0-9A-Za-z_-]{4,40}$/.test(uid) || uids.has(uid)) uid = randomId(12);
    uids.add(uid);
    tracks.push({ uid, addedAt: time(entry.addedAt, createdAt), ...track });
  }
  return {
    id: PLAYLIST_ID.test(raw.id) ? raw.id : `p.${randomId(14)}`,
    name: str(raw.name, 200),
    description: str(raw.description, 4000),
    createdAt,
    updatedAt: Math.max(createdAt, time(raw.updatedAt, createdAt)),
    tracks,
  };
}

/** crypto.randomUUID 只在安全上下文可用（http://<局域网 IP> 不行），getRandomValues 都可用 */
function randomId(length) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const keyOf = (kind, id) => `${kind}:${id}`;

/* ---------- IndexedDB ---------- */
const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function loadAll() {
  const tx = db.transaction(['items', 'playlists'], 'readonly');
  const [storedItems, storedLists] = await Promise.all([
    request(tx.objectStore('items').getAll()),
    request(tx.objectStore('playlists').getAll()),
  ]);
  items.clear();
  lists.clear();
  for (const item of storedItems) items.set(item.key, item);
  for (const list of storedLists) lists.set(list.id, list);
}

/** 依次提交的写入：同一对象存储上的事务按创建顺序执行，后写的不会被先写的覆盖 */
function persist({ putItems = [], deleteItems = [], putLists = [], deleteLists = [], clear = false }) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(['items', 'playlists'], 'readwrite');
    } catch (err) {
      console.warn('[am-hook] 资料库写入失败', err);
      resolve();
      return;
    }
    const itemStore = tx.objectStore('items');
    const listStore = tx.objectStore('playlists');
    if (clear) { itemStore.clear(); listStore.clear(); }
    for (const key of deleteItems) itemStore.delete(key);
    for (const id of deleteLists) listStore.delete(id);
    for (const item of putItems) itemStore.put(item);
    for (const list of putLists) listStore.put(list);
    tx.oncomplete = () => {
      if (channel) channel.postMessage('changed');
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      console.warn('[am-hook] 资料库写入失败', tx.error);
      resolve();
    };
  });
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error(err); }
  }
}

/** 读入资料库（只进行一次）；失败时保留空的内存资料库 */
export const ready = (async () => {
  try {
    if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
    db = await openDb();
    // 其他标签页升级数据库版本时先关闭，避免阻塞
    db.onversionchange = () => { db.close(); db = null; };
    await loadAll();
    if (globalThis.BroadcastChannel) {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = () => { if (db) loadAll().then(emit, (err) => console.warn('[am-hook] 资料库读取失败', err)); };
    }
  } catch (err) {
    db = null;
    console.warn('[am-hook] 资料库只保存在内存中', err);
  }
  emit();
})();

/** 是否保存在 IndexedDB 中（否则关闭标签页后丢失） */
export const persistent = () => !!db;

/** 资料库或歌单变化（含其他标签页的修改）后回调；返回取消函数 */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------- 资料库 ---------- */
/** kind 省略时为全部条目 */
export function libraryItems(kind) {
  const all = [...items.values()];
  return kind ? all.filter((item) => item.kind === kind) : all;
}

export const libraryItem = (kind, id) => items.get(keyOf(kind, id)) || null;

/** 是否在资料库中；专辑只要有其中的歌曲就算（与 Apple Music 相同，添加单曲后专辑也出现在资料库里） */
export function inLibrary(kind, id) {
  if (items.has(keyOf(kind, id))) return true;
  if (kind !== 'album') return false;
  for (const item of items.values()) if (item.albumId === id && (item.kind === 'song' || item.kind === 'music-video')) return true;
  return false;
}

/** 添加条目（见文件开头），已有的更新信息、保留添加时间；返回新增的数量 */
export function addToLibrary(records) {
  if (items.size + records.length > MAX_ITEMS) throw new Error('library is full');
  const now = Date.now();
  const puts = [];
  let added = 0;
  for (const raw of records) {
    const item = cleanItem({ ...raw, addedAt: undefined }, now);
    if (!item) continue;
    const old = items.get(item.key);
    if (old) item.addedAt = old.addedAt; else added++;
    items.set(item.key, item);
    puts.push(item);
  }
  if (puts.length) { emit(); persist({ putItems: puts }); }
  return added;
}

/** 从资料库删除；专辑连同其中的歌曲与 MV 一起删除（与 Apple Music 的「从资料库中删除」相同）。返回删除的数量 */
export function removeFromLibrary(kind, id) {
  const keys = [keyOf(kind, id)];
  if (kind === 'album') {
    for (const item of items.values()) if (item.albumId === id && (item.kind === 'song' || item.kind === 'music-video')) keys.push(item.key);
  }
  const removed = keys.filter((key) => items.delete(key));
  if (removed.length) { emit(); persist({ deleteItems: removed }); }
  return removed.length;
}

/* ---------- 本地歌单 ---------- */
/** 按最近修改排在前面（与「添加到歌单」菜单相同）；sort 为 'name' 时按名称 */
export function playlists(sort = 'updated') {
  const all = [...lists.values()];
  if (sort === 'name') return all.sort((a, b) => a.name.localeCompare(b.name) || b.createdAt - a.createdAt);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const playlist = (id) => lists.get(id) || null;

function savePlaylist(list) {
  list.updatedAt = Math.max(Date.now(), list.updatedAt + 1);
  lists.set(list.id, list);
  emit();
  return persist({ putLists: [list] });
}

/** 新建歌单，返回歌单；tracks 为曲目快照 */
export function createPlaylist({ name = '', description = '', tracks = [] } = {}) {
  const now = Date.now();
  const list = cleanPlaylist({ name, description, createdAt: now, updatedAt: now, tracks: tracks.map((track) => ({ ...track, addedAt: now })) }, now);
  list.id = `p.${randomId(14)}`;
  lists.set(list.id, list);
  emit();
  persist({ putLists: [list] });
  return list;
}

/** 修改名称、描述 */
export function updatePlaylist(id, { name, description }) {
  const list = lists.get(id);
  if (!list) return;
  const next = { ...list };
  if (name !== undefined) next.name = str(name, 200);
  if (description !== undefined) next.description = str(description, 4000);
  savePlaylist(next);
}

export function deletePlaylist(id) {
  if (!lists.delete(id)) return;
  emit();
  persist({ deleteLists: [id] });
}

/** 复制歌单（名称加后缀 suffix），返回新歌单 */
export function duplicatePlaylist(id, suffix) {
  const list = lists.get(id);
  if (!list) return null;
  return createPlaylist({ name: `${list.name} ${suffix}`.trim(), description: list.description, tracks: list.tracks });
}

/**
 * 添加曲目到歌单末尾。与 Apple Music 一样默认跳过歌单里已有的曲目（options.duplicates 为 true 时照样添加）。
 * 返回 { added, skipped }
 */
export function addToPlaylist(id, tracks, { duplicates = false } = {}) {
  const list = lists.get(id);
  if (!list) return { added: 0, skipped: 0 };
  const now = Date.now();
  const have = new Set(list.tracks.map((track) => keyOf(track.kind, track.id)));
  const next = { ...list, tracks: list.tracks.slice() };
  let added = 0;
  let skipped = 0;
  for (const raw of tracks) {
    const track = cleanTrack(raw);
    if (!track) continue;
    const key = keyOf(track.kind, track.id);
    if (!duplicates && have.has(key)) { skipped++; continue; }
    if (next.tracks.length >= MAX_TRACKS) break;
    have.add(key);
    next.tracks.push({ uid: randomId(12), addedAt: now, ...track });
    added++;
  }
  if (added) savePlaylist(next);
  return { added, skipped };
}

/** 按 uid 删除歌单中的曲目（同一首歌可以出现多次，uid 区分各次） */
export function removeFromPlaylist(id, uids) {
  const list = lists.get(id);
  if (!list) return;
  const drop = new Set(uids);
  const tracks = list.tracks.filter((track) => !drop.has(track.uid));
  if (tracks.length !== list.tracks.length) savePlaylist({ ...list, tracks });
}

/** 把下标 from 的曲目移到 to */
export function movePlaylistTrack(id, from, to) {
  const list = lists.get(id);
  if (!list || from === to || from < 0 || to < 0 || from >= list.tracks.length || to >= list.tracks.length) return;
  const tracks = list.tracks.slice();
  tracks.splice(to, 0, ...tracks.splice(from, 1));
  savePlaylist({ ...list, tracks });
}

/** 清空资料库与全部歌单 */
export function clearAll() {
  items.clear();
  lists.clear();
  emit();
  return persist({ clear: true });
}

/* ---------- 导入与导出 ---------- */
/** 导出数据：playlistIds 省略时为整个资料库与全部歌单，否则只含这些歌单 */
export function exportData(playlistIds) {
  const strip = ({ key, ...item }) => item;
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    items: playlistIds ? [] : [...items.values()].sort((a, b) => a.addedAt - b.addedAt).map(strip),
    playlists: playlistIds ? playlistIds.map((id) => lists.get(id)).filter(Boolean) : playlists().reverse(),
  };
}

/**
 * 解析导入文件的文本：校验格式并规范化每一条，无效的条目丢弃。
 * 返回 { items, playlists, dropped }；不是本格式或版本过新时抛出 Error（message 为 'format' / 'version'）。
 */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('format'); }
  if (!data || typeof data !== 'object' || data.format !== FORMAT) throw new Error('format');
  if (!Number.isInteger(data.version) || data.version > FORMAT_VERSION) throw new Error('version');
  const now = Date.now();
  const rawItems = Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
  const rawLists = Array.isArray(data.playlists) ? data.playlists.slice(0, 1000) : [];
  const parsedItems = rawItems.map((raw) => cleanItem(raw, now)).filter(Boolean);
  const parsedLists = rawLists.map((raw) => cleanPlaylist(raw, now)).filter(Boolean);
  const rawTracks = rawLists.reduce((sum, raw) => sum + (raw && Array.isArray(raw.tracks) ? raw.tracks.length : 0), 0);
  const keptTracks = parsedLists.reduce((sum, list) => sum + list.tracks.length, 0);
  return {
    items: parsedItems,
    playlists: parsedLists,
    dropped: (rawItems.length - parsedItems.length) + (rawLists.length - parsedLists.length) + Math.max(0, rawTracks - keptTracks),
  };
}

/**
 * 导入 parseImport 的结果。replace 为 true 时先清空现有资料库与歌单；
 * 否则合并：资料库条目按键合并（保留较早的添加时间），同一 id 的歌单保留修改时间较新的一份。
 * 返回 { items, playlists }：实际新增 / 更新的数量
 */
export async function importData(parsed, { replace = false } = {}) {
  if (replace) { items.clear(); lists.clear(); }
  const putItems = [];
  const putLists = [];
  for (const item of parsed.items) {
    const old = items.get(item.key);
    if (old) item.addedAt = Math.min(old.addedAt, item.addedAt);
    items.set(item.key, item);
    putItems.push(item);
  }
  for (const list of parsed.playlists) {
    const old = lists.get(list.id);
    if (old && old.updatedAt >= list.updatedAt) continue;
    lists.set(list.id, list);
    putLists.push(list);
  }
  emit();
  await persist({ clear: replace, putItems, putLists });
  return { items: putItems.length, playlists: putLists.length };
}

/* ---------- 页面用的小工具 ---------- */
/** 图片模板 → 指定尺寸的地址 */
export function artUrl(template, w, h = w) {
  return template ? template.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
}

/** 曲目快照 → 播放队列条目（见 AmPlayer.playQueue） */
export function entryOf(track) {
  return {
    track: track.id,
    country: track.country,
    name: track.name,
    artist: track.artist,
    artists: track.artists,
    album: track.album,
    href: track.href,
    albumHref: track.albumHref,
    artwork: artUrl(track.artwork, 600),
    duration: track.duration,
  };
}

/** Apple Music 原始地址（本站页面路径去掉开头的 /） */
export const appleUrl = (path) => (path ? path.slice(1) : '');
