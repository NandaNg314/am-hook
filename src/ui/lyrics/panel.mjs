/*
 * 在线播放的歌词界面：用 AMLL（Apple Music-like Lyrics，见 browser/amll）显示歌词，接到 AmPlayer 上。
 *
 *   歌词     GET /lyrics/<adamId>（服务端向 wrapper-lite /lyrics 获取的 TTML 原文），
 *            首次打开歌词界面时才请求并缓存；没有歌词时隐藏按钮。
 *            ttml.mjs 解析 Apple TTML，toAmllLines() 转成 AMLL 的 LyricLine
 *   时间     每帧把 player.transport().currentTime 交给 DomLyricPlayer，点击歌词行跳转并继续播放
 *   背景     歌曲页已有的专辑封面，交给 AMLL 的 MeshGradientRenderer 生成流动背景
 *
 * 歌词界面只在打开时运行动画循环；关闭后停止，背景保留最后一帧。
 */
import { parseTTML } from './ttml.mjs';
import { DomLyricPlayer, BackgroundRender, MeshGradientRenderer } from './amll-core.mjs';

const validTokens = (voice) => voice.tokens.filter((token) => token.begin !== 0 || token.end !== 0);
const plainText = (voice) => validTokens(voice).map((t) => t.text + (t.spaceAfter ? ' ' : '')).join('').trim() || voice.text;
const same = (a, b) => a.replace(/[()]/g, '').trim().toLowerCase() === b.replace(/[()]/g, '').trim().toLowerCase();

/** 一个声部（主唱或和声）转成一行 AMLL 歌词；和声去掉 Apple 写在词里的括号 */
function amllLine(voice, line, { isBG, translation, pronunciation }) {
  const tokens = validTokens(voice);
  const clean = (text) => (isBG ? text.replace(/[()]/g, '') : text);
  const text = plainText(voice);
  // 逐词音译与原文相同（如英文歌）时不显示
  const romanTokens = pronunciation && !tokens.every((t) => t.text === voice.pronunciationTokens[voice.tokens.indexOf(t)]?.text);
  const words = tokens.length
    ? tokens.map((token) => {
      const roman = romanTokens ? voice.pronunciationTokens[voice.tokens.indexOf(token)]?.text : '';
      return {
        startTime: token.begin, endTime: Math.max(token.begin, token.end),
        word: clean(token.text) + (token.spaceAfter ? ' ' : ''),
        ...(roman ? { romanWord: clean(roman) } : {}),
      };
    })
    : [{ startTime: line.begin, endTime: Math.max(line.begin, line.end), word: clean(voice.text) }];
  const begin = Math.min(...words.map((w) => w.startTime));
  const end = Math.max(...words.map((w) => w.endTime));
  return {
    words, startTime: begin, endTime: end, isBG, isDuet: line.agent !== 'v1',
    translatedLyric: translation && voice.translation && !same(voice.translation, text) ? voice.translation : '',
    romanLyric: pronunciation && voice.pronunciation && !same(voice.pronunciation, text) ? voice.pronunciation : '',
  };
}

/** parseTTML 的结果转成 AMLL LyricLine[]，和声紧跟在所属主歌词行后面 */
export function toAmllLines(song, options) {
  return song.lines.flatMap((line) => {
    const main = amllLine(line, line, { ...options, isBG: false });
    if (!line.background.tokens.length && !line.background.text) return [main];
    return [main, amllLine(line.background, line, { ...options, isBG: true })];
  });
}

/**
 * root：歌曲页中的 #lyrics-overlay；toggle：播放条上的歌词按钮；bar：播放条，
 * 点击其中非控件区域（封面、标题、空白处）与点击歌词按钮相同；歌词界面打开时并入 .lyrics-controls。
 * getMeta() 返回当前的 { title, artist, artwork }；t 为界面文案函数；notify 显示提示。
 */
export function mountLyrics({ root, toggle, bar, player, adamId, getMeta, t, notify, onLangChange }) {
  const $ = (selector) => root.querySelector(selector);
  const follow = $('.lyrics-follow');
  const options = { translation: $('[data-option="translation"]'), pronunciation: $('[data-option="pronunciation"]') };
  const shown = { translation: false, pronunciation: false };
  const view = new DomLyricPlayer();
  $('.lyric-panel').append(view.getElement());
  const credits = document.createElement('div');
  credits.className = 'lyrics-credits';
  view.getBottomLineElement().append(credits);
  view.addEventListener('line-click', (event) => {
    // AMLL 会把行的开始时间提前最多 600ms 用于入场动画；跳转到第一个词的原始时间
    const line = event.line.getLine();
    seek(line.words[0]?.startTime ?? line.startTime);
  });

  const canvas = $('.lyrics-backdrop');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let backdrop = null;
  try {
    if (MeshGradientRenderer.isSupported()) {
      backdrop = new BackgroundRender(new MeshGradientRenderer(canvas), canvas);
      backdrop.setHasLyric(true);
      backdrop.setStaticMode(motion.matches);
      backdrop.pause();
      motion.addEventListener('change', () => backdrop.setStaticMode(motion.matches));
    }
  } catch (error) {
    console.warn('[am-hook] 歌词背景不可用', error);
    backdrop = null;
  }

  const barHome = document.createComment('player');
  let song = null;
  let request = null;
  let unavailable = false;
  let open = false;
  let frame = 0;
  let lastFrame = 0;
  let playing = null;
  let artworkSource = '';
  let artworkController = null;

  function currentTime() {
    return player.current ? player.transport().currentTime * 1000 : 0;
  }

  function seek(ms) {
    if (!player.current) return;
    const transport = player.transport();
    transport.currentTime = ms / 1000;
    view.setCurrentTime(ms, true);
    view.resetScroll();
    if (transport.paused) player.toggle();
  }

  function tick(timestamp) {
    const transport = player.current ? player.transport() : null;
    const now = !!transport && !transport.paused;
    if (now !== playing) {
      playing = now;
      if (now) view.resume(); else view.pause();
    }
    view.setCurrentTime(transport ? transport.currentTime * 1000 : 0);
    view.update(lastFrame ? timestamp - lastFrame : 0);
    lastFrame = timestamp;
    // AMLL 在用户滚动后暂停自动对齐，下一行进入可视范围时才会自己回来；这里提供立即回到当前行的按钮
    const suspended = !!view.scrollState?.isAutoAlignSuspended;
    if (follow.hidden === suspended) follow.hidden = !suspended;
    frame = requestAnimationFrame(tick);
  }

  function renderHeader() {
    const meta = getMeta();
    const art = $('.lyrics-art');
    if (meta.artwork) { if (art.getAttribute('src') !== meta.artwork) art.src = meta.artwork; } else art.removeAttribute('src');
    art.hidden = !meta.artwork;
    $('.lyrics-title').textContent = meta.title || t('player.unknownTitle');
    $('.lyrics-artist').textContent = meta.artist || '';
  }

  function renderCredits() {
    if (!song) return;
    credits.replaceChildren();
    if (song.credits.length) {
      const label = document.createElement('span');
      label.className = 'credit-label';
      label.textContent = t('lyrics.credits');
      const names = document.createElement('span');
      names.className = 'credit-names';
      names.textContent = song.credits.join(t('lyrics.creditsSeparator'));
      credits.append(label, names);
    }
    if (song.translation.automatic && shown.translation) {
      const note = document.createElement('div');
      note.className = 'translation-note';
      note.textContent = t('lyrics.aiTranslation');
      credits.append(note);
    }
  }

  /** 背景使用页面已有的封面；取不到封面或浏览器不支持 WebGL 时保留纯色背景 */
  function loadArtwork() {
    if (!backdrop) return;
    const source = getMeta().artwork || '';
    if (source === artworkSource) { backdrop.resume(); return; }
    artworkSource = source;
    if (artworkController) artworkController.abort();
    artworkController = null;
    if (!source) { canvas.hidden = true; root.classList.remove('has-backdrop'); return; }
    const controller = new AbortController();
    artworkController = controller;
    fetch(source, { signal: controller.signal, cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
        return response.blob();
      })
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        try { await backdrop.setAlbum(url); } finally { URL.revokeObjectURL(url); }
        if (controller.signal.aborted) return;
        canvas.hidden = false;
        root.classList.add('has-backdrop');
        if (open) backdrop.resume(); else backdrop.pause();
      })
      .catch((error) => { if (!controller.signal.aborted) console.warn('[am-hook] 歌词背景加载失败', error); });
  }

  function setLines() {
    view.setLyricLines(toAmllLines(song, shown), currentTime());
    renderCredits();
  }

  function show() {
    if (!song || open) return;
    open = true;
    // 播放控件并入歌词界面（桌面在封面下方，手机在底部），关闭时放回原处
    bar.replaceWith(barHome);
    $('.lyrics-controls').append(bar);
    root.hidden = false;
    document.body.classList.add('lyrics-open');
    toggle.setAttribute('aria-pressed', 'true');
    renderHeader();
    loadArtwork();
    // 视图需要可见时的尺寸来排版，打开时按当前进度重新对齐
    if (!view.getLyricLines().length) setLines();
    else view.rebuildLyricView(currentTime());
    view.setCurrentTime(currentTime(), true);
    view.resetScroll();
    playing = null;
    lastFrame = 0;
    frame = requestAnimationFrame(tick);
    $('.lyrics-close').focus({ preventScroll: true });
  }

  function hide() {
    if (!open) return;
    open = false;
    barHome.replaceWith(bar);
    root.hidden = true;
    document.body.classList.remove('lyrics-open');
    toggle.setAttribute('aria-pressed', 'false');
    cancelAnimationFrame(frame);
    frame = 0;
    backdrop?.pause();
    toggle.focus({ preventScroll: true });
  }

  function syncOptions() {
    for (const [name, button] of Object.entries(options)) {
      button.setAttribute('aria-pressed', String(shown[name]));
    }
  }

  /** 首次打开时获取歌词；加载中的重复点击被忽略，失败后可重试 */
  function fetchLyrics() {
    if (!request) {
      toggle.setAttribute('aria-busy', 'true');
      request = fetch(`/lyrics/${adamId}`)
        .then(async (response) => {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parsed = parseTTML(await response.text());
          return parsed.lines.length ? parsed : null;
        })
        .then((parsed) => {
          if (!parsed) {
            unavailable = true;
            toggle.hidden = true;
            bar.classList.remove('lyrics-available');
            notify(t('lyrics.none'));
            return;
          }
          song = parsed;
          view.getElement().lang = song.language;
          const voices = song.lines.flatMap((line) => [line, line.background]);
          options.translation.disabled = !voices.some((voice) => voice.translation);
          options.pronunciation.disabled = !voices.some((voice) => voice.pronunciation || voice.pronunciationTokens.length);
          syncOptions();
        })
        .catch((error) => {
          request = null;
          console.warn('[am-hook] 歌词加载失败', error);
          notify(t('lyrics.failed'));
        })
        .finally(() => toggle.removeAttribute('aria-busy'));
    }
    return request;
  }

  function toggleOpen() {
    if (open) { hide(); return; }
    if (song) { show(); return; }
    if (unavailable || toggle.hasAttribute('aria-busy')) return;
    fetchLyrics().then(() => { if (song) show(); });
  }

  toggle.hidden = false;
  bar.classList.add('lyrics-available');
  toggle.addEventListener('click', toggleOpen);
  bar.addEventListener('click', (event) => {
    if (open || unavailable || event.target.closest('button, input, a, [role="slider"], .player-msg, .player-notice')) return;
    toggleOpen();
  });
  $('.lyrics-close').addEventListener('click', hide);
  for (const [name, button] of Object.entries(options)) {
    button.addEventListener('click', () => {
      shown[name] = !shown[name];
      syncOptions();
      setLines();
    });
  }
  follow.addEventListener('click', () => { view.resetScroll(); follow.hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') { event.preventDefault(); hide(); }
  });
  onLangChange(() => {
    renderCredits();
    if (open) renderHeader();
  });

  return { show, hide, view, get song() { return song; } };
}
