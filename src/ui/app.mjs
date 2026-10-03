// 单页应用的前端路由（与 music.apple.com 相同）：文档只加载一次，播放条、音频与歌词界面常驻，
// 站内链接与搜索表单由这里接管，用 history.pushState 改地址并切换页面视图，跳转页面时播放不中断。
//
// 页面视图在 /assets/views/ 下：<name>.html 是页面内容，<name>.mjs 导出
//   bodyClass：页面对应的 body 类名（样式按它区分页面）；styles：页面额外需要的样式表（可省略）；
//   mount(ctx)：挂载页面，ctx 见 render()。页面注册到 window / document 上的监听都带 ctx.signal，
//   离开页面时 signal 中止，监听随之移除。

import { mountSettings } from '/assets/settings.mjs';

const { AmPlayer } = window.AmHook;
const { AmI18n } = window;
const { t } = AmI18n;
AmI18n.apply();

const $ = (id) => document.getElementById(id);
const viewRoot = $('view');

/* ---------- 路由：与服务端（src/m3u8.rs 的 parse_*_link 与 is_editorial_link）识别的页面地址相同 ---------- */
const PAGES = [
  ['song', /^https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[^/?#]+\/[0-9]+(?:[/?#]|$)/],
  ['mv', /^https:\/\/music\.apple\.com\/[a-z]{2}\/music-video\/[^/?#]+\/[0-9]+(?:[/?#]|$)/],
  // 艺人上传的视频（官网 post 页）与 MV 共用页面视图
  ['post', /^https:\/\/music\.apple\.com\/[a-z]{2}\/post\/(?:[^/?#]+\/)?[0-9]+(?:[/?#]|$)/],
  ['album', /^https:\/\/music\.apple\.com\/[a-z]{2}\/album\/(?:[^/?#]+\/)?[0-9]+(?:[/?#]|$)/],
  ['playlist', /^https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\/(?:[^/?#]+\/)?pl\.[0-9A-Za-z_-]+(?:[/?#]|$)/],
  ['artist', /^https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/(?:[^/?#]+\/)?[0-9]+(?:[/?#]|$)/],
  // 编辑页（与 src/m3u8.rs 的 is_editorial_link 相同）：新发现（官网 /{cc}/new）、room、multi-room、grouping 与 curator
  ['new', /^https:\/\/music\.apple\.com\/[a-z]{2}\/new\/?$/],
  // 排行榜（官网 /{cc}/new/top-charts）与各榜单的「查看全部」
  ['charts', /^https:\/\/music\.apple\.com\/[a-z]{2}\/new\/top-charts(?:\/(?:songs|playlists|albums|music-videos|city-charts|daily-global-top-charts))?\/?$/],
  ['editorial', /^https:\/\/music\.apple\.com\/[a-z]{2}\/(?:room|multi-room|grouping)\/[0-9]+(?:[/?#]|$)/],
  ['editorial', /^https:\/\/music\.apple\.com\/[a-z]{2}\/curator\/(?:[^/?#]+\/)?[0-9]+(?:[/?#]|$)/],
];

/** 页面名 → 视图文件（/assets/views/<file>.html / .mjs）：新发现与各编辑页共用 browse 视图，其余同名 */
const VIEW_FILES = { new: 'browse', charts: 'browse', editorial: 'browse', post: 'mv' };
/** 跟随主地区的排行榜路径（与 src/m3u8.rs 的 is_charts_path 相同） */
const CHARTS_PATH = /^\/new\/top-charts(?:\/(?:songs|playlists|albums|music-videos|city-charts|daily-global-top-charts))?\/?$/;

/** 地址对应的页面名；不是站内页面时为 null（交给浏览器正常跳转）。与服务端一样匹配未解码的路径 */
function route(url) {
  if (url.origin !== location.origin) return null;
  if (url.pathname === '/') return 'home';
  // 「新发现」（跟随主地区）
  if (url.pathname === '/new') return 'new';
  if (CHARTS_PATH.test(url.pathname)) return 'charts';
  const path = url.pathname.slice(1);
  const hit = PAGES.find(([, re]) => re.test(path));
  return hit ? hit[0] : null;
}

/* ---------- 常驻的播放条、提示与歌词界面 ---------- */
let toastTimer = 0;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

const player = new AmPlayer($('player'));
// 供调试与测试使用
window.AmApp = { player, navigate: (href, options) => navigate(href, options) };

// 歌词界面跟随正在播放的歌曲
import('/assets/lyrics/panel.mjs')
  .then(({ mountLyrics }) => {
    const lyrics = mountLyrics({
      root: $('lyrics-overlay'),
      toggle: $('player').querySelector('.player-lyrics'),
      bar: $('player'),
      player, t, notify: toast,
      getMeta: () => ({ title: player.current?.title, artist: player.current?.artist, artists: player.current?.artists, artwork: player.current?.artwork }),
      navigate: (href) => navigate(href),
      onLangChange: AmI18n.onChange,
    });
    const follow = (current) => lyrics.setTrack(current && current.track, current && current.country);
    follow(player.current);
    player.onChange(follow);
  })
  .catch((err) => console.warn('[am-hook] 歌词界面加载失败', err));

/* ---------- 导航（官网 .navigation）：≥484px 为侧边栏，<484px 为顶栏，菜单按钮展开整屏菜单 ---------- */
const nav = $('nav');
const navToggle = $('nav-toggle');
const navContent = $('nav-content');
const mobileNav = matchMedia('(max-width: 483px)');

/** 展开 / 收起手机菜单；收起时菜单内容不可聚焦，展开时页面不随之滚动 */
function setNavExpanded(open) {
  const expanded = open && mobileNav.matches;
  nav.classList.toggle('is-expanded', expanded);
  navToggle.setAttribute('aria-expanded', String(expanded));
  document.body.classList.toggle('nav-open', expanded);
  navContent.inert = mobileNav.matches && !expanded;
}
navToggle.addEventListener('click', () => setNavExpanded(!nav.classList.contains('is-expanded')));
mobileNav.addEventListener('change', () => setNavExpanded(false));
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !nav.classList.contains('is-expanded')) return;
  setNavExpanded(false);
  navToggle.focus();
});
// 在菜单里跳转或返回后收起（切换语言时保持展开）
nav.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('a[href], [data-back]')) setNavExpanded(false);
});
setNavExpanded(false);

/** 顶层页面（主页、新发现、排行榜首页）不显示「返回」，导航中对应的一项标为当前页；各榜单的「查看全部」仍标为排行榜 */
function syncNav(name, path) {
  nav.classList.toggle('is-home', name === 'home' || name === 'new' || path === '/new/top-charts');
  for (const link of nav.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/* ---------- 设置：主地区与曲库语言的选择面板 ---------- */
const settings = mountSettings({ picker: $('picker'), scrim: $('picker-scrim') });

/* ---------- wrapper-lite 状态：导航底部的状态块；账号所在地区为推荐的主地区（没有选择过时即为主地区） ----------
   上行为状态点、名称、地区数（或状态文字）与展开箭头；下行为地区代码，当前主地区排在最前并高亮。
   地区多时下行只保留一行放得下的部分，其余折叠为「+N」；展开后换行列出全部，超过几行时在块内滚动，不会把导航撑高。 */
/** null 表示检查中，否则为 { ok, regions } */
let wrapperStatus = null;
let statusPending = null;
let statusExpanded = false;

const statusBox = $('nav-status');
const statusHead = statusBox.querySelector('.wrapper-status-head');
const statusState = statusBox.querySelector('.wrapper-status-state');
const statusList = statusBox.querySelector('.wrapper-status-regions');

const statusRegionNames = new Map();
/** 按界面语言显示的地区名（Intl.DisplayNames），取不到时为地区代码 */
function statusRegionName(cc) {
  const locale = AmI18n.lang === 'zh' ? 'zh-CN' : 'en';
  try {
    if (!statusRegionNames.has(locale)) statusRegionNames.set(locale, new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }));
    return statusRegionNames.get(locale).of(cc.toUpperCase()) || cc.toUpperCase();
  } catch {
    return cc.toUpperCase();
  }
}

function renderStatus() {
  const ok = !!wrapperStatus && wrapperStatus.ok;
  const regions = ok ? [...new Set(wrapperStatus.regions.map((cc) => cc.toLowerCase()))] : [];
  statusBox.classList.toggle('ok', ok);
  statusBox.classList.toggle('bad', !!wrapperStatus && !ok);

  // 有地区时上行显示地区数（在线由绿点表示），否则显示状态文字
  const count = t(regions.length === 1 ? 'status.region' : 'status.regions', { count: regions.length });
  statusState.textContent = !wrapperStatus ? t('status.checking') : !ok ? t('status.down') : regions.length ? count : t('status.online');
  statusHead.title = regions.length ? `wrapper-lite · ${t('status.online')} · ${count}` : `wrapper-lite · ${statusState.textContent}`;

  const current = AmI18n.storefront;
  const ordered = regions.includes(current) ? [current, ...regions.filter((cc) => cc !== current)] : regions;
  statusList.replaceChildren(...ordered.map((cc) => {
    const chip = document.createElement('li');
    chip.className = 'region-chip';
    chip.textContent = cc.toUpperCase();
    chip.title = cc === current ? `${statusRegionName(cc)} · ${t('status.current')}` : statusRegionName(cc);
    chip.classList.toggle('is-current', cc === current);
    return chip;
  }));
  if (ordered.length) {
    const more = document.createElement('li');
    const button = document.createElement('button');
    more.className = 'region-more';
    button.type = 'button';
    button.addEventListener('click', () => setStatusExpanded(true));
    more.append(button);
    statusList.append(more);
  } else {
    statusExpanded = false;
  }
  statusList.hidden = !ordered.length;
  fitStatusRegions();
}

/** 折叠时只保留一行放得下的地区，其余收进「+N」（至少保留一个）；展开时全部列出 */
function fitStatusRegions() {
  const chips = [...statusList.querySelectorAll('.region-chip')];
  const more = statusList.querySelector('.region-more');
  statusBox.classList.toggle('is-expanded', statusExpanded);
  statusHead.setAttribute('aria-expanded', String(statusExpanded));
  for (const chip of chips) chip.hidden = false;
  let overflow = false;
  if (more) {
    more.hidden = true;
    // 宽度为 0（手机菜单未展开）时不折叠，等 ResizeObserver 再算
    if (!statusExpanded && statusList.clientWidth > 0 && statusList.scrollWidth > statusList.clientWidth) {
      overflow = true;
      more.hidden = false;
      for (let i = chips.length - 1; i > 0; i--) {
        chips[i].hidden = true;
        const hidden = chips.length - i;
        more.firstChild.textContent = `+${hidden}`;
        more.firstChild.title = t('status.more', { count: hidden });
        more.firstChild.setAttribute('aria-label', more.firstChild.title);
        if (statusList.scrollWidth <= statusList.clientWidth) break;
      }
    }
  }
  // 只有放不下或已展开时上行才可点击（展开 / 收起）
  const expandable = overflow || statusExpanded;
  statusHead.disabled = !expandable;
  statusBox.classList.toggle('is-expandable', expandable);
  statusHead.setAttribute('aria-label', expandable ? `${statusHead.title} · ${t(statusExpanded ? 'status.collapse' : 'status.expand')}` : statusHead.title);
}

function setStatusExpanded(expanded) {
  if (statusExpanded === expanded) return;
  statusExpanded = expanded;
  statusList.scrollTop = 0;
  fitStatusRegions();
  if (expanded) statusHead.focus();
}

statusHead.addEventListener('click', () => setStatusExpanded(!statusExpanded));
// 侧边栏宽度随窗口变化（33.88vw），手机菜单展开前宽度为 0：尺寸变化后重新折叠
new ResizeObserver(() => fitStatusRegions()).observe(statusList);
AmI18n.onSettingsChange(({ kind }) => { if (kind === 'storefront') renderStatus(); });

/** 重新检查状态（进行中的检查直接复用），返回 { ok, regions } */
function loadStatus() {
  statusPending ||= (async () => {
    try {
      const res = await fetch('/status');
      const data = await res.json();
      if (!res.ok || data.code !== 0) throw new Error();
      wrapperStatus = { ok: true, regions: (data.regions || []).map(String) };
      AmI18n.setRegions(wrapperStatus.regions);
    } catch {
      // 暂时连不上时保留上次的地区
      wrapperStatus = { ok: false, regions: [] };
    }
    statusPending = null;
    renderStatus();
    settings.refresh();
    return wrapperStatus;
  })();
  return statusPending;
}
AmI18n.onChange(renderStatus);
renderStatus();
loadStatus();

/* ---------- 页面视图 ---------- */
/** 当前页面：{ name, path, controller, bodyClass } */
let current = null;
let renderSeq = 0;
const fragments = new Map();
const styles = new Map();

function fragment(name) {
  if (!fragments.has(name)) {
    const pending = fetch(`/assets/views/${name}.html`).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    // 失败不缓存，下次跳转时重试
    pending.catch(() => fragments.delete(name));
    fragments.set(name, pending);
  }
  return fragments.get(name);
}

/** 页面额外的样式表：第一次进入页面时加载并保留（样式都限定在页面的 body 类名下） */
function stylesheet(href) {
  if (!styles.has(href)) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
    styles.set(href, new Promise((resolve) => {
      link.onload = resolve;
      link.onerror = resolve;
    }));
    document.head.append(link);
  }
  return styles.get(href);
}

/** 由播放条、歌词界面、导航菜单维护的 body 类名，切换页面时保留 */
const APP_CLASSES = new Set(['has-player', 'lyrics-open', 'nav-open']);

function unmount() {
  if (!current) return;
  current.controller.abort();
  current = null;
  const { body } = document;
  for (const name of [...body.classList]) if (!APP_CLASSES.has(name)) body.classList.remove(name);
  // 页面在 body 上设置的样式变量（封面主色等）；播放条高度保留
  for (const prop of [...body.style]) if (prop !== '--player-height') body.style.removeProperty(prop);
}

/**
 * 切换到 url 对应的页面视图。scroll 为进入后的滚动位置（前进 / 后退时恢复原位置）。
 * mount(ctx) 的 ctx：
 *   root：页面内容所在的元素（每次进入页面都是新的）；url：页面地址；signal：离开页面时中止；
 *   player：播放器（见 AmPlayer.scope）；navigate(href, { replace })：站内跳转；
 *   onLangChange(fn)：切换界面语言或曲库语言后回调（页面据此重绘文字、重新请求目录数据）；toast(message)：底部提示；restoring：是否在恢复前进 / 后退前的滚动位置；
 *   loadStatus()：重新检查 wrapper-lite 状态，返回 { ok, regions }。
 */
async function render(url, { scroll = 0, initial = false } = {}) {
  const name = route(url);
  const seq = ++renderSeq;
  if (!name) return;
  let view, html;
  try {
    const file = VIEW_FILES[name] || name;
    [view, html] = await Promise.all([import(`/assets/views/${file}.mjs`), fragment(file)]);
    await Promise.all((view.styles || []).map(stylesheet));
  } catch (err) {
    // 站内跳转时页面资源加载失败（如服务已升级、网络中断）：整页加载该地址；首次加载失败时不再重试，避免反复刷新
    console.warn('[am-hook] 页面加载失败', err);
    if (seq === renderSeq && !initial) location.reload();
    return;
  }
  if (seq !== renderSeq) return; // 加载期间又跳转到了其他页面

  unmount();
  const controller = new AbortController();
  const { signal } = controller;
  current = { name, path: url.pathname, controller };
  syncNav(name, url.pathname);
  setNavExpanded(false);
  document.title = 'am-hook';
  if (view.bodyClass) document.body.classList.add(...view.bodyClass.split(/\s+/));
  // 每次进入页面都换一个新元素：离开后仍在进行的异步操作（如歌曲下载）只会改动已移除的旧元素
  const root = Object.assign(document.createElement('div'), { className: 'app-page', innerHTML: html });
  viewRoot.replaceChildren(root);
  AmI18n.apply(root);
  settings.close(false);
  settings.renderValues();
  player.layout();
  window.scrollTo(0, 0);
  try {
    view.mount({
      root,
      url,
      signal,
      player: player.scope(signal),
      navigate,
      onLangChange: (fn) => {
        if (signal.aborted) return;
        signal.addEventListener('abort', AmI18n.onChange(fn), { once: true });
        signal.addEventListener('abort', AmI18n.onSettingsChange(({ kind }) => { if (kind === 'ampLang') fn(); }), { once: true });
      },
      toast,
      restoring: scroll > 0,
      loadStatus,
    });
  } catch (err) {
    console.error('[am-hook] 页面脚本出错', err);
  }
  restoreScroll(scroll, signal);
}

/* ---------- 滚动位置：每条历史记录各自保存，前进 / 后退时恢复 ---------- */
history.scrollRestoration = 'manual';
const scrollPositions = new Map();
let entrySeq = 0;
const newKey = () => `${Date.now().toString(36)}-${++entrySeq}`;

/** 当前历史记录的标识；页面自己 pushState 的记录（如首页搜索 ?q=）没有时补上 */
function entryKey() {
  const state = history.state;
  if (state && state.amKey) return state.amKey;
  const amKey = newKey();
  history.replaceState({ ...(state && typeof state === 'object' ? state : {}), amKey }, '');
  return amKey;
}

let scrollTimer = 0;
addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => scrollPositions.set(entryKey(), scrollY), 100);
}, { passive: true });

/** 页面内容大多异步加载：高度不够时等内容撑开再滚动，用户先动了滚动或超时就放弃 */
function restoreScroll(y, signal) {
  if (!y) return;
  const reached = () => {
    window.scrollTo(0, y);
    return Math.abs(scrollY - y) < 2;
  };
  if (reached()) return;
  const observer = new ResizeObserver(() => { if (reached()) stop(); });
  const timer = setTimeout(stop, 5000);
  const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of inputs) removeEventListener(type, stop, true);
  }
  observer.observe(viewRoot);
  for (const type of inputs) addEventListener(type, stop, { capture: true, passive: true });
  signal.addEventListener('abort', stop, { once: true });
}

/* ---------- 跳转 ---------- */
/** 站内跳转：href 不是站内页面时交给浏览器正常加载 */
function navigate(href, { replace = false } = {}) {
  const url = new URL(href, location.href);
  if (!route(url)) {
    if (replace) location.replace(url.href); else location.assign(url.href);
    return;
  }
  clearTimeout(scrollTimer);
  scrollPositions.set(entryKey(), scrollY);
  // amBack：上一条历史记录是站内页面，「返回」按钮可以直接 history.back()
  const amBack = replace ? !!(history.state && history.state.amBack) : true;
  const state = { amKey: newKey(), amBack };
  if (replace) history.replaceState(state, '', url.href);
  else history.pushState(state, '', url.href);
  render(url);
}

addEventListener('popstate', () => {
  const url = new URL(location.href);
  // 同一页面内的记录（如首页搜索的 ?q=）由页面自己处理
  if (current && url.pathname === current.path) return;
  if (!route(url)) { location.reload(); return; }
  render(url, { scroll: scrollPositions.get(history.state && history.state.amKey) || 0 });
});

/** 与浏览器处理链接的规则一致：修饰键、新窗口、下载链接与页内锚点不接管 */
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element && event.target.closest('a[href]');
  if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
  const url = new URL(link.href, location.href);
  if (!route(url)) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  navigate(url.href);
});

/** 页面顶部的「返回」按钮：从站内页面进入时回到上一页（恢复其滚动位置），直接打开链接进入时回到首页 */
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element && event.target.closest('[data-back]');
  if (!button) return;
  if (history.state && history.state.amBack) history.back();
  else navigate('/');
});

entryKey();
render(new URL(location.href), { initial: true });
