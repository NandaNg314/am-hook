// 首页（/，搜索结果为 /?q=），由 app.mjs 挂载
const { AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'home-page';

export function mount({ root, signal, navigate, onLangChange }) {
  const $ = (id) => root.querySelector(`#${id}`);
  const input = $('input');
  const errorEl = $('error');
  const detectEl = $('detect');
  /** wrapper-lite 状态：null 表示检查中，否则为 { ok, regions } */
  let wrapperStatus = null;

  /** 把各种输入规整为页面路径：/https://music.apple.com/{cc}/(song|music-video|album|playlist|artist)/{slug}/{id} */
  function toSongLink(raw) {
    const value = raw.trim();
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const cc = /^[a-z]{2}$/i.test(parts[0] || '') ? parts[0].toLowerCase() : 'us';
    const mv = url.pathname.match(/^\/[a-z]{2}\/music-video\/(?:([^/]+)\/)?(\d+)\/?$/i);
    if (mv) return `https://music.apple.com/${cc}/music-video/${mv[1] || '_'}/${mv[2]}`;
    const song = url.pathname.match(/\/song\/([^/]+)\/(\d+)/i);
    if (song) return `https://music.apple.com/${cc}/song/${song[1]}/${song[2]}`;
    const trackId = url.searchParams.get('i');
    const album = url.pathname.match(/\/album\/([^/]+)\//i);
    if (trackId && /^\d+$/.test(trackId)) return `https://music.apple.com/${cc}/song/${album ? album[1] : '_'}/${trackId}`;
    // 不带 ?i= 的专辑链接打开专辑页（slug 可省略）
    const albumPage = url.pathname.match(/^\/[a-z]{2}\/album\/(?:([^/]+)\/)?(\d+)\/?$/i);
    if (albumPage) return `https://music.apple.com/${cc}/album/${albumPage[1] || '_'}/${albumPage[2]}`;
    // 歌单链接打开歌单页（ID 形如 pl.xxx / pl.u-xxx，slug 可省略）
    const playlistPage = url.pathname.match(/^\/[a-z]{2}\/playlist\/(?:([^/]+)\/)?(pl\.[\w-]+)\/?$/i);
    if (playlistPage) return `https://music.apple.com/${cc}/playlist/${playlistPage[1] || '_'}/${playlistPage[2]}`;
    // 艺人链接打开艺人页（slug 可省略）
    const artistPage = url.pathname.match(/^\/[a-z]{2}\/artist\/(?:([^/]+)\/)?(\d+)\/?$/i);
    if (artistPage) return `https://music.apple.com/${cc}/artist/${artistPage[1] || '_'}/${artistPage[2]}`;
    return null;
  }

  const submitLabel = $('submit-label');
  const suggestEl = $('suggest');
  const resultsEl = $('results');
  const resultsBody = $('results-body');
  const storefrontSel = $('storefront');
  const STOREFRONT_KEY = 'am-hook:storefront';
  let errorKey = null;

  const isUrlLike = (value) => /^https?:\/\//i.test(value);

  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const link = toSongLink(value);
    if (link) { navigate('/' + link); return; }
    // 其余输入按关键词搜索；无法识别的链接与空输入给出提示
    errorKey = !value ? 'home.empty' : isUrlLike(value) ? 'home.invalid' : null;
    input.setAttribute('aria-invalid', String(!!errorKey));
    errorEl.hidden = !errorKey;
    if (errorKey) {
      errorEl.textContent = t(errorKey);
      input.focus();
      return;
    }
    closeSuggest();
    runSearch(value, 'push');
  });
  input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); errorEl.hidden = true; renderDetect(); scheduleSuggest(); });

  /** 输入时即时提示识别结果：歌曲 / MV 等类型与地区；按钮在“解析”与“搜索”之间切换 */
  function renderDetect() {
    const value = input.value.trim();
    const link = value && toSongLink(value);
    submitLabel.dataset.i18n = link ? 'home.submit' : 'home.search';
    submitLabel.textContent = t(submitLabel.dataset.i18n);
    detectEl.hidden = !link;
    if (!link) return;
    const [, cc, kind] = link.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|playlist|artist)\//);
    const label = { song: 'home.detectSong', 'music-video': 'home.detectMv', album: 'home.detectAlbum', playlist: 'home.detectPlaylist', artist: 'home.detectArtist' }[kind];
    detectEl.textContent = `${t(label)} · ${cc.toUpperCase()}`;
  }

  // 示例链接：填入输入框，按“解析”即可打开
  root.querySelectorAll('[data-example]').forEach((btn) => btn.addEventListener('click', () => {
    input.value = btn.dataset.example;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }));

  // 按 / 聚焦输入框
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    input.focus();
  }, { signal });

  function renderStatus() {
    const pill = $('status');
    pill.classList.toggle('ok', !!wrapperStatus && wrapperStatus.ok);
    pill.classList.toggle('bad', !!wrapperStatus && !wrapperStatus.ok);
    pill.lastElementChild.textContent = !wrapperStatus ? t('status.checking')
      : !wrapperStatus.ok ? t('status.down')
      : wrapperStatus.regions.length ? `wrapper-lite · ${wrapperStatus.regions.join(' / ').toUpperCase()}` : t('status.online');
  }

  async function loadStatus() {
    renderStatus();
    try {
      const res = await fetch('/status');
      const data = await res.json();
      if (!res.ok || data.code !== 0) throw new Error();
      wrapperStatus = { ok: true, regions: (data.regions || []).map(String) };
    } catch {
      wrapperStatus = { ok: false, regions: [] };
    }
    renderStatus();
    renderStorefronts(wrapperStatus.regions);
  }

  /* ---------- 搜索（与 music.apple.com/search 相同的 amp-api 调用，经服务端 /amp 代理） ---------- */

  /** 搜索地区：默认使用 wrapper-lite 账号所在地区（解析与解密都以它为准），有多个时可切换 */
  function renderStorefronts(regions) {
    const list = [...new Set(regions.map((cc) => cc.toLowerCase()).filter((cc) => /^[a-z]{2}$/.test(cc)))];
    if (!list.length) list.push('us');
    let saved = null;
    try { saved = localStorage.getItem(STOREFRONT_KEY); } catch {}
    storefrontSel.replaceChildren(...list.map((cc) => new Option(cc.toUpperCase(), cc)));
    storefrontSel.value = list.includes(saved) ? saved : list[0];
    $('storefront-wrap').hidden = list.length < 2;
  }
  const storefront = () => storefrontSel.value || 'us';
  // l 按地区支持的语言选择，见 AmI18n.catalogLang
  const catalogLang = () => AmI18n.catalogLang(storefront());

  storefrontSel.addEventListener('change', () => {
    try { localStorage.setItem(STOREFRONT_KEY, storefrontSel.value); } catch {}
    if (search.term) runSearch(search.term);
  });

  /** amp-api 需要 developer token 且只允许 music.apple.com 跨域，统一走服务端 /amp 代理 */
  async function amp(path, params, signal) {
    const url = new URL('/amp' + path, location.origin);
    // 值为 undefined 的参数不传（如地区不支持当前语言时的 l）
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
    let res = await fetch(url, { signal });
    // 地区不支持所选语言时去掉 l，改用地区默认语言
    if (res.status === 400 && url.searchParams.has('l')) {
      url.searchParams.delete('l');
      res = await fetch(url, { signal });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
    return data;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** amp-api 的 artwork.url 是 {w}x{h}{c}.{f} 模板 */
  function artUrl(artwork, w, h) {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
  }

  function artNode(className, src) {
    const box = el('span', className);
    box.append(src ? Object.assign(document.createElement('img'), { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', 'ph'));
    return box;
  }

  function fmtDuration(ms) {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function explicitBadge() {
    const badge = el('span', 'explicit', 'E');
    badge.title = t('search.explicit');
    badge.setAttribute('aria-label', t('search.explicit'));
    return badge;
  }

  /** 目录资源 → 可打开的歌曲 / MV / 专辑 / 歌单条目；其余类型（艺人等）本站无法打开，忽略 */
  const KINDS = { songs: 'song', 'music-videos': 'music-video', albums: 'album', playlists: 'playlist', artists: 'artist' };
  const KIND_LABELS = { song: 'home.detectSong', 'music-video': 'home.detectMv', album: 'home.detectAlbum', playlist: 'home.detectPlaylist', artist: 'home.detectArtist' };
  function toItem(resource) {
    const attrs = resource && resource.attributes;
    const kind = resource && KINDS[resource.type];
    if (!attrs || !kind) return null;
    const mv = kind === 'music-video';
    let link = toSongLink(attrs.url || '');
    if (!link || !link.includes(`/${kind}/`)) link = `https://music.apple.com/${storefront()}/${kind}/_/${resource.id}`;
    return {
      // 歌单没有 artistName，副标题用歌单作者（curatorName）
      kind, mv, href: '/' + link, title: attrs.name || resource.id, artist: attrs.artistName || attrs.curatorName || '', album: attrs.albumName || '',
      year: (attrs.releaseDate || '').slice(0, 4), genre: (attrs.genreNames || [])[0] || '',
      artwork: attrs.artwork, duration: attrs.durationInMillis, explicit: attrs.contentRating === 'explicit',
      traits: attrs.audioTraits || [], has4K: !!attrs.has4K, subtitle: attrs.subtitle || '',
    };
  }

  /** 音质标志：歌曲用 app.css 的 .q-icon 图标（与播放条同一套），MV 用 4K 文字标签 */
  const QUALITY_LABELS = { hires: 'Hi-Res Lossless', lossless: 'Lossless', atmos: 'Dolby Atmos' };
  function qualityBadges(item, mvClass = '') {
    if (item.mv) return item.has4K ? [el('span', `q-badge ${mvClass}`.trim(), '4K')] : [];
    const keys = [];
    if (item.traits.includes('hi-res-lossless')) keys.push('hires');
    else if (item.traits.includes('lossless')) keys.push('lossless');
    if (item.traits.includes('atmos')) keys.push('atmos');
    return keys.map((key) => {
      const icon = el('span', `q-icon q-icon--${key}`);
      icon.title = QUALITY_LABELS[key];
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', QUALITY_LABELS[key]);
      return icon;
    });
  }

  // 建议下拉框：search/suggestions 的 terms（补全词）与 topResults（直达歌曲 / MV）
  let suggestTimer = 0;
  let suggestController = null;
  let suggestItems = [];
  let activeIndex = -1;

  function scheduleSuggest() {
    clearTimeout(suggestTimer);
    if (suggestController) suggestController.abort();
    const term = input.value.trim();
    if (!term || toSongLink(term) || isUrlLike(term)) { closeSuggest(); return; }
    suggestTimer = setTimeout(() => loadSuggest(term), 180);
  }

  async function loadSuggest(term) {
    const controller = suggestController = new AbortController();
    try {
      await statusReady;
      // 参数与官网一致（types 相同，才能拿到与官网相同的直达结果与顺序）；本站打不开的类型在 renderSuggest 里跳过
      const data = await amp(`/v1/catalog/${storefront()}/search/suggestions`, {
        term, l: await catalogLang(), platform: 'web', kinds: 'terms,topResults',
        types: 'activities,artists,albums,editorial-items,music-movies,music-videos,playlists,record-labels,songs,stations,tv-episodes',
        'fields[albums]': 'artistName,artwork,contentRating,name,playParams,url', 'fields[artists]': 'url,name,artwork',
        'limit[results:terms]': '5', 'limit[results:topResults]': '10', 'omit[resource]': 'autos', 'art[url]': 'c,f', with: 'naturalLanguage',
      }, controller.signal);
      if (controller !== suggestController || document.activeElement !== input) return;
      renderSuggest(term, (data.results && data.results.suggestions) || []);
    } catch {
      if (controller === suggestController) closeSuggest();
    }
  }

  function renderSuggest(term, suggestions) {
    suggestItems = [];
    for (const suggestion of suggestions) {
      let option;
      if (suggestion.kind === 'terms' && suggestion.displayTerm) {
        const display = suggestion.displayTerm;
        const searchTerm = suggestion.searchTerm || display;
        option = el('button', 'suggest-item suggest-term');
        option.type = 'button';
        // 与官网一致：拆出与输入匹配的部分，补全部分加粗
        const at = display.toLowerCase().indexOf(term.toLowerCase());
        const text = el('span', 'suggest-text');
        if (at >= 0) text.append(el('b', null, display.slice(0, at)), el('span', null, display.slice(at, at + term.length)), el('b', null, display.slice(at + term.length)));
        else text.append(el('b', null, display));
        option.append(el('span', 'suggest-icon'), text);
        option.addEventListener('click', () => {
          input.value = searchTerm;
          renderDetect();
          closeSuggest();
          runSearch(searchTerm, 'push');
        });
      } else if (suggestion.kind === 'topResults') {
        const item = toItem(suggestion.content);
        if (!item) continue;
        option = el('a', 'suggest-item suggest-result');
        option.href = item.href;
        const title = el('span', 'suggest-title', item.title);
        if (item.explicit) title.append(explicitBadge());
        const text = el('span', 'suggest-text');
        // 与官网一致：接口给了 subtitle 就用它，否则为“类型 · 艺人 / 歌单作者”
        text.append(title, el('span', 'suggest-sub', item.subtitle || [t(KIND_LABELS[item.kind]), item.artist].filter(Boolean).join(' · ')));
        option.append(artNode(item.mv ? 'suggest-art mv' : item.kind === 'artist' ? 'suggest-art round' : 'suggest-art', artUrl(item.artwork, 80, 80)), text);
      } else continue;
      option.id = `suggest-${suggestItems.length}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.tabIndex = -1;
      // 保持输入框焦点，避免 blur 先于 click 关闭下拉框
      option.addEventListener('mousedown', (event) => event.preventDefault());
      suggestItems.push(option);
    }
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    suggestEl.replaceChildren(...suggestItems);
    suggestEl.hidden = suggestItems.length === 0;
    input.setAttribute('aria-expanded', String(!suggestEl.hidden));
  }

  function setActive(index) {
    activeIndex = index;
    suggestItems.forEach((option, i) => {
      option.classList.toggle('active', i === index);
      option.setAttribute('aria-selected', String(i === index));
    });
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', suggestItems[index].id);
      suggestItems[index].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function closeSuggest() {
    clearTimeout(suggestTimer);
    if (suggestController) suggestController.abort();
    suggestController = null;
    suggestEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeSuggest(); return; }
    if (suggestEl.hidden || !suggestItems.length) return;
    const n = suggestItems.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1 >= n ? -1 : activeIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1 < -1 ? n - 1 : activeIndex - 1); }
    else if (event.key === 'Enter' && activeIndex >= 0 && !event.isComposing) { event.preventDefault(); suggestItems[activeIndex].click(); }
  });
  input.addEventListener('blur', closeSuggest);
  input.addEventListener('focus', () => { if (input.value.trim()) scheduleSuggest(); });

  // 搜索结果：/v1/catalog/{storefront}/search，取最佳结果与歌曲、艺人、专辑、歌单、MV 五组，next 分页地址同样经 /amp 代理
  // 分组顺序按接口返回的 meta.results.order（与官网一致），缺失时用这里的顺序
  const GROUPS = [['top', 'search.top'], ['artist', 'search.artists'], ['album', 'search.albums'], ['song', 'search.songs'], ['playlist', 'search.playlists'], ['music_video', 'search.mvs']];
  const GROUP_LABELS = Object.fromEntries(GROUPS);
  // 首屏每组显示的条数（能被 3 / 2 / 1 列与 6 / 4 / 2 列整除），其余点“加载更多”展开；最佳结果只取前 6 条
  const PREVIEW = 12;
  const TOP_LIMIT = 6;
  const search = { term: '', controller: null };
  // next 分页地址只带 groups / offset / term / types / l，其余参数需补上，否则返回空结果
  const PAGE_PARAMS = { limit: '21', platform: 'web', with: 'serverBubbles', 'omit[resource]': 'autos' };

  function statusNode(text, className) {
    return el('p', `results-state${className ? ' ' + className : ''}`, text);
  }

  /** history: 'push' / 'replace' 同步地址栏 ?q=，省略时不改动（切换地区、语言后重新搜索） */
  async function runSearch(term, history) {
    search.term = term;
    if (search.controller) search.controller.abort();
    const controller = search.controller = new AbortController();
    if (history) {
      const url = new URL(location.href);
      url.searchParams.set('q', term);
      if (url.href !== location.href) {
        if (history === 'push') window.history.pushState(null, '', url);
        else window.history.replaceState(window.history.state, '', url);
      }
    }
    resultsEl.hidden = false;
    $('results-title').textContent = t('search.results', { term });
    resultsBody.replaceChildren(statusNode(t('search.loading'), 'loading'));
    try {
      await statusReady;
      const data = await amp(`/v1/catalog/${storefront()}/search`, {
        term, l: await catalogLang(), types: 'songs,albums,music-videos,playlists,artists', ...PAGE_PARAMS,
      }, controller.signal);
      if (controller !== search.controller) return;
      const results = data.results || {};
      const order = (data.meta && data.meta.results && data.meta.results.order) || GROUPS.map(([key]) => key);
      const groups = order.filter((key) => GROUP_LABELS[key] && results[key] && results[key].data && results[key].data.some(toItem));
      resultsBody.replaceChildren(...(groups.length
        ? groups.map((key) => key === 'top' ? topNode(results.top) : groupNode(key, GROUP_LABELS[key], results[key], controller))
        : [statusNode(t('search.none'))]));
    } catch (error) {
      if (controller !== search.controller || error.name === 'AbortError') return;
      resultsBody.replaceChildren(statusNode(t('search.failed', { msg: error.message }), 'error'));
    }
  }

  /** 最佳结果：混合类型，按相关度排序，不分页 */
  function topNode(block) {
    const section = el('div', 'result-group top-group');
    const list = el('div', 'song-grid');
    list.append(...block.data.map(toItem).filter(Boolean).slice(0, TOP_LIMIT).map(topRow));
    section.append(el('h3', 'group-title', t('search.top')), list);
    return section;
  }

  function groupNode(key, label, block, controller) {
    const [listClass, render] = { music_video: ['mv-grid', mvCard], album: ['album-grid', albumCard], playlist: ['album-grid', playlistCard], artist: ['album-grid', artistCard] }[key] || ['song-grid', songRow];
    const section = el('div', 'result-group');
    const list = el('div', listClass);
    const more = el('button', 'btn load-more', t('search.more'));
    more.type = 'button';
    let next = block.next;
    // 已取到的条目；首屏只渲染前 PREVIEW 条，“加载更多”先展开已取到的，再按 next 翻页
    const items = block.data.map(toItem).filter(Boolean);
    let shown = 0;
    const show = (count) => {
      list.append(...items.slice(shown, count).map(render));
      shown = Math.max(shown, Math.min(count, items.length));
      more.hidden = shown >= items.length && !next;
    };
    show(PREVIEW);
    more.addEventListener('click', async () => {
      if (shown < items.length) { show(items.length); return; }
      more.disabled = true;
      try {
        const data = await amp(next, PAGE_PARAMS, controller.signal);
        const page = (data.results && (data.results[key] || Object.values(data.results)[0])) || {};
        items.push(...(page.data || []).map(toItem).filter(Boolean));
        next = page.next;
        show(items.length);
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
      more.disabled = false;
    });
    section.append(el('h3', 'group-title', t(label)), list, more);
    return section;
  }

  /** 最佳结果的一行：与歌曲行同样的布局，副标题带类型；艺人圆形头像，MV 用 16:9 缩略图 */
  function topRow(item) {
    const row = el('a', 'song-row');
    row.href = item.href;
    const title = el('span', 'row-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    const main = el('span', 'row-main');
    main.append(title, el('span', 'row-sub', [t(KIND_LABELS[item.kind]), item.artist].filter(Boolean).join(' · ')));
    const cover = item.mv ? artNode('row-cover wide', artUrl(item.artwork, 160, 90))
      : artNode(item.kind === 'artist' ? 'row-cover round' : 'row-cover', artUrl(item.artwork, 96, 96));
    row.append(cover, main);
    if (item.kind === 'song' || item.mv) {
      const meta = el('span', 'row-meta');
      meta.append(...qualityBadges(item), el('span', 'row-time', fmtDuration(item.duration)));
      row.append(meta);
    }
    return row;
  }

  function songRow(item) {
    const row = el('a', 'song-row');
    row.href = item.href;
    const title = el('span', 'row-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    const main = el('span', 'row-main');
    main.append(title, el('span', 'row-sub', [item.artist, item.album].filter(Boolean).join(' · ')));
    const meta = el('span', 'row-meta');
    meta.append(...qualityBadges(item), el('span', 'row-time', fmtDuration(item.duration)));
    row.append(artNode('row-cover', artUrl(item.artwork, 96, 96)), main, meta);
    return row;
  }

  function albumCard(item) {
    const card = el('a', 'album-card');
    card.href = item.href;
    const title = el('span', 'recent-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    card.append(artNode('album-thumb', artUrl(item.artwork, 360, 360)), title, el('span', 'recent-sub', [item.artist, item.year].filter(Boolean).join(' · ')));
    return card;
  }

  /** 艺人：圆形头像，副标题为主要流派（与官网搜索结果一致） */
  function artistCard(item) {
    const card = el('a', 'album-card artist-card');
    card.href = item.href;
    card.append(artNode('album-thumb round', artUrl(item.artwork, 360, 360)), el('span', 'recent-title', item.title), el('span', 'recent-sub', item.genre));
    return card;
  }

  function playlistCard(item) {
    const card = el('a', 'album-card');
    card.href = item.href;
    card.append(artNode('album-thumb', artUrl(item.artwork, 360, 360)), el('span', 'recent-title', item.title), el('span', 'recent-sub', item.artist));
    return card;
  }

  function mvCard(item) {
    const card = el('a', 'mv-card');
    card.href = item.href;
    const thumb = artNode('mv-thumb', artUrl(item.artwork, 480, 270));
    if (item.duration) thumb.append(el('span', 'mv-time', fmtDuration(item.duration)));
    thumb.append(...qualityBadges(item, 'mv-q'));
    const title = el('span', 'recent-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    card.append(thumb, title, el('span', 'recent-sub', item.artist));
    return card;
  }

  function closeResults() {
    search.term = '';
    if (search.controller) search.controller.abort();
    resultsEl.hidden = true;
    resultsBody.replaceChildren();
    const url = new URL(location.href);
    if (url.searchParams.has('q')) {
      url.searchParams.delete('q');
      history.replaceState(history.state, '', url);
    }
  }
  $('close-results').addEventListener('click', closeResults);

  /** 地址栏 ?q= 决定是否显示搜索结果（刷新、前进后退） */
  function syncFromUrl() {
    if (location.pathname !== '/') return; // 正在离开首页
    const q = (new URL(location.href).searchParams.get('q') || '').trim();
    if (!q) {
      if (search.term) closeResults();
      return;
    }
    input.value = q;
    renderDetect();
    if (q !== search.term) runSearch(q);
  }
  addEventListener('popstate', syncFromUrl, { signal });

  onLangChange(() => {
    renderStatus();
    renderDetect();
    closeSuggest();
    if (!errorEl.hidden && errorKey) errorEl.textContent = t(errorKey);
    if (search.term) runSearch(search.term);
  });

  function readRecent() {
    try {
      const items = JSON.parse(localStorage.getItem('am-hook:recent') || '[]');
      return Array.isArray(items) ? items.filter((item) => item && typeof item.link === 'string' && toSongLink(item.link)).slice(0, 12) : [];
    } catch { return []; }
  }

  function renderRecent() {
    const items = readRecent();
    const section = $('recent');
    section.hidden = items.length === 0;
    $('recent-list').replaceChildren(...items.map((item) => {
      const a = document.createElement('a');
      a.className = 'recent-item';
      a.href = '/' + toSongLink(item.link);
      const cover = Object.assign(document.createElement('span'), { className: 'recent-cover' });
      cover.append(item.artwork ? Object.assign(document.createElement('img'), { src: item.artwork.replace('600x600bb', '300x300bb'), alt: '', loading: 'lazy' })
                                : Object.assign(document.createElement('span'), { className: 'ph' }));
      a.append(
        cover,
        Object.assign(document.createElement('span'), { className: 'recent-title', textContent: item.title || item.id }),
        Object.assign(document.createElement('span'), { className: 'recent-sub', textContent: item.artist || '' })
      );
      return a;
    }));
  }

  $('clear-recent').addEventListener('click', () => {
    try { localStorage.removeItem('am-hook:recent'); } catch {}
    renderRecent();
  });

  renderStorefronts([]);
  const statusReady = loadStatus();
  renderDetect();
  renderRecent();
  syncFromUrl();
}
