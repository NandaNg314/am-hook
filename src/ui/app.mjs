// 单页应用的前端路由（与 music.apple.com 相同）：文档只加载一次，播放条、音频与歌词界面常驻，
// 站内链接与搜索表单由这里接管，用 history.pushState 改地址并切换页面视图，跳转页面时播放不中断。
//
// 页面视图在 /assets/views/ 下：<name>.html 是页面内容，<name>.mjs 导出
//   bodyClass：页面对应的 body 类名（样式按它区分页面）；styles：页面额外需要的样式表（可省略）；
//   mount(ctx)：挂载页面，ctx 见 render()。页面注册到 window / document 上的监听都带 ctx.signal，
//   离开页面时 signal 中止，监听随之移除。

const { AmPlayer } = window.AmHook;
const { AmI18n } = window;
const { t } = AmI18n;
AmI18n.apply();

const $ = (id) => document.getElementById(id);
const viewRoot = $('view');

/* ---------- 路由：与服务端（src/m3u8.rs 的 parse_*_link）识别的页面地址相同 ---------- */
const PAGES = [
  ['song', /^https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[^/?#]+\/[0-9]+(?:[/?#]|$)/],
  ['mv', /^https:\/\/music\.apple\.com\/[a-z]{2}\/music-video\/[^/?#]+\/[0-9]+(?:[/?#]|$)/],
  ['album', /^https:\/\/music\.apple\.com\/[a-z]{2}\/album\/(?:[^/?#]+\/)?[0-9]+(?:[/?#]|$)/],
  ['playlist', /^https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\/(?:[^/?#]+\/)?pl\.[0-9A-Za-z_-]+(?:[/?#]|$)/],
  ['artist', /^https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/(?:[^/?#]+\/)?[0-9]+(?:[/?#]|$)/],
];

/** 地址对应的页面视图名；不是站内页面时为 null（交给浏览器正常跳转）。与服务端一样匹配未解码的路径 */
function route(url) {
  if (url.origin !== location.origin) return null;
  if (url.pathname === '/') return 'home';
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

/** 由播放条、歌词界面维护的 body 类名，切换页面时保留 */
const APP_CLASSES = new Set(['has-player', 'lyrics-open']);

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
 *   onLangChange(fn)：切换语言后回调；toast(message)：底部提示。
 */
async function render(url, { scroll = 0, initial = false } = {}) {
  const name = route(url);
  const seq = ++renderSeq;
  if (!name) return;
  let view, html;
  try {
    [view, html] = await Promise.all([import(`/assets/views/${name}.mjs`), fragment(name)]);
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
  document.title = 'am-hook';
  if (view.bodyClass) document.body.classList.add(...view.bodyClass.split(/\s+/));
  // 每次进入页面都换一个新元素：离开后仍在进行的异步操作（如歌曲下载）只会改动已移除的旧元素
  const root = Object.assign(document.createElement('div'), { className: 'app-page', innerHTML: html });
  viewRoot.replaceChildren(root);
  AmI18n.apply(root);
  player.layout();
  window.scrollTo(0, 0);
  try {
    view.mount({
      root,
      url,
      signal,
      player: player.scope(signal),
      navigate,
      onLangChange: (fn) => { if (!signal.aborted) signal.addEventListener('abort', AmI18n.onChange(fn), { once: true }); },
      toast,
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
  const state = { amKey: newKey() };
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

/** 页面顶部的搜索框（GET 表单，提交到首页 ?q=） */
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method !== 'get') return;
  const url = new URL(form.action, location.href);
  if (!route(url)) return;
  url.search = new URLSearchParams(new FormData(form)).toString();
  event.preventDefault();
  navigate(url.href);
});

entryKey();
render(new URL(location.href), { initial: true });
