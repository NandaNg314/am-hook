/*
 * 在线播放的歌词界面：用 AMLL（Apple Music-like Lyrics，见 browser/amll）显示歌词，接到 AmPlayer 上。
 *
 *   歌词     GET /lyrics/<adamId>?language=<地区默认语言>（服务端向 wrapper-lite /lyrics 获取的 TTML 原文），
 *            language 取歌曲所在地区的 defaultLanguageTag（AmI18n.defaultLang），取不到时不传；首次打开歌词界面时才请求并缓存；没有歌词时隐藏按钮。
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

/* 歌词翻译按钮与菜单的图标，取自 music.apple.com：按钮图标（17×16，路径坐标经 translate(-.51 4.44) scale(.101)），
 * 菜单项图标（显示 / 隐藏翻译按页面语言显示「文」或「A」，见 app.css 的 .lang-zh / .lang-en） */
const TRANSLATE_PATHS = ["M12.46-.44c0-12.76 8.13-20.17 20.37-20.17h47.4c12.24 0 20.4 7.41 20.4 20.17v4.47H98.3c-1.98 0-3.83.18-5.55.52v-4.7c0-8.62-4.82-13.14-13-13.14H33.3c-8.13-.01-13 4.52-13 13.14v28.34c0 8.62 4.88 13.04 12.99 13.04h5.16c2.07 0 3.76 1.24 3.76 4v12.32l15.71-14.03c1.92-1.7 3.1-2.3 5.76-2.3h14.24v7.37H63.37l-16.3 13.92c-2.92 2.56-4.53 3.87-6.9 3.87-3.41 0-5.27-2.38-5.27-6.07V48.59h-2.07c-12.24 0-20.37-7.39-20.37-20.2z","M39.43 28.52c-1.04 2.73.48 5.21 3.3 5.21 1.85 0 3-.98 3.71-3.05l2.96-8.6h14.37l3.01 8.6c.66 2.07 1.8 3.05 3.68 3.05 2.87 0 4.3-2.5 3.34-5.2L61.7-3.8c-.88-2.4-2.66-3.71-5.16-3.71-2.47 0-4.25 1.3-5.13 3.7L39.43 28.53ZM51.4 16.07l5.14-14.95 5.2 14.95H51.41Zm80.04 71.09-16.31-13.93H98.3c-12.77 0-20.38-7.38-20.38-20.13V24.2c0-12.77 7.6-20.17 20.38-20.17h47.38c12.24 0 20.37 7.4 20.37 20.16v28.83c0 12.81-8.13 20.2-20.37 20.2h-2.02v11.72c0 3.69-1.92 6.07-5.26 6.07-2.39 0-3.98-1.3-6.97-3.85Zm-6.9-66.08-2.42-4.92c-.93-1.85-2.8-2.68-4.58-1.7a3.35 3.35 0 0 0-1.55 4.57l2.37 4.97a3.35 3.35 0 0 0 4.47 1.66c1.84-.9 2.53-2.87 1.7-4.58Zm-21.63 9.57c0 1.87 1.5 3.25 3.46 3.25h3.74a32.44 32.44 0 0 0 7.25 13.18 35.9 35.9 0 0 1-11.69 4.86c-1.87.45-3 2.25-2.62 4.22.55 1.93 2.5 2.8 4.6 2.23a38.7 38.7 0 0 0 14.74-6.69 38.3 38.3 0 0 0 14.14 6.69c2.42.52 4.41-.2 4.9-2.23.6-2.12-.37-3.77-2.5-4.22a34.4 34.4 0 0 1-11.64-4.86 30.5 30.5 0 0 0 7.2-13.18h3.74c2.02 0 3.5-1.38 3.5-3.25s-1.48-3.26-3.5-3.26h-31.86c-1.97 0-3.46 1.4-3.46 3.26m19.48 12.3a26.45 26.45 0 0 1-5.46-9.05h10.74a27.3 27.3 0 0 1-5.28 9.05"];
const MENU_ICONS = {
  showTranslation: '<svg width="16" height="16" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" viewBox="0 0 133 133"><g fill-rule="nonzero"><path d="M45.928,39.077L86.723,39.077C88.495,39.077 89.739,37.958 89.739,36.341C89.739,34.724 88.444,33.594 86.723,33.594L45.928,33.594C44.218,33.594 42.974,34.724 42.974,36.341C42.974,37.958 44.166,39.077 45.928,39.077ZM58.696,54.689L64.254,54.689C67.361,54.689 69.32,52.69 69.32,49.583L69.371,32.875L78.698,26.305C79.828,25.569 80.295,24.449 80.295,23.402C80.295,21.732 79.019,20.219 76.863,20.219L54.156,20.219C52.239,20.219 50.85,21.483 50.85,23.173C50.85,24.893 52.187,26.064 54.156,26.064L76.739,26.064L76.739,21.867L65.538,29.618C63.785,30.81 63.267,32.158 63.267,34.356L63.319,48.843L58.696,48.843C56.769,48.843 55.442,50.025 55.442,51.746C55.442,53.456 56.79,54.689 58.696,54.689ZM45.94,23.567C47.609,23.567 48.698,22.334 48.698,20.521L48.698,16.318L83.859,16.318L83.859,20.521C83.859,22.344 84.968,23.567 86.595,23.567C88.264,23.567 89.384,22.334 89.384,20.521L89.384,13.571C89.384,11.965 88.109,10.886 86.388,10.886L46.251,10.886C44.437,10.886 43.193,11.965 43.193,13.571L43.193,20.521C43.193,22.334 44.282,23.567 45.94,23.567ZM64.575,13.977L70.182,11.925L67.803,5.255C67.181,3.669 65.482,2.902 63.906,3.462C62.341,4.021 61.574,5.721 62.123,7.359L64.575,13.977Z" class="lang-zh" transform="translate(-14.82 19.351) scale(1.2236)"/><path d="M50.179,51.898C51.951,51.898 53.184,51.038 53.961,48.769L57.507,38.396L74.958,38.396L78.545,48.769C79.271,51.028 80.514,51.898 82.297,51.898C84.483,51.898 85.913,50.53 85.913,48.51C85.913,47.784 85.747,47.049 85.364,46.003L71.682,9.117C70.75,6.599 68.854,5.304 66.181,5.304C63.559,5.304 61.767,6.599 60.783,9.117L47.091,46.003C46.759,47.049 46.593,47.784 46.593,48.499C46.593,50.541 48.023,51.898 50.179,51.898ZM59.466,32.499L65.953,13.628L66.502,13.628L72.988,32.499L59.466,32.499Z" class="lang-en" transform="translate(-14.82 19.351) scale(1.2236)"/></g></svg>',
  hideTranslation: '<svg width="16" height="16" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" viewBox="0 0 133 133"><g fill-rule="nonzero"><path d="M63.055,74.43L63.097,86.115L57.441,86.115C55.083,86.115 53.459,87.562 53.459,89.668C53.459,91.76 55.108,93.269 57.441,93.269L64.241,93.269C68.043,93.269 70.44,90.823 70.44,87.021L70.456,81.813L63.055,74.43ZM56.065,67.457L41.818,67.457C39.725,67.457 38.203,68.84 38.203,70.818C38.203,72.797 39.662,74.166 41.818,74.166L62.79,74.166L56.065,67.457ZM87.718,67.457L93.881,73.613C94.841,73.035 95.425,72.044 95.425,70.818C95.425,68.84 93.84,67.457 91.734,67.457L87.718,67.457ZM71.332,51.091L80.081,59.83L81.915,58.538C83.298,57.638 83.869,56.267 83.869,54.986C83.869,52.943 82.308,51.091 79.67,51.091L71.332,51.091ZM63.233,39.671L59.899,39.671L66.553,46.318L88.23,46.318L88.23,51.461C88.23,53.691 89.587,55.188 91.578,55.188C93.62,55.188 94.99,53.679 94.99,51.461L94.99,42.957C94.99,40.992 93.43,39.671 91.324,39.671L63.233,39.671L71.041,39.671L68.584,32.781C67.823,30.841 65.744,29.902 63.815,30.587C61.901,31.271 60.962,33.352 61.634,35.356L63.233,39.671ZM41.832,55.188C42.422,55.188 42.952,55.062 43.408,54.83L38.471,49.905L38.471,51.461C38.471,53.679 39.804,55.188 41.832,55.188Z" class="lang-zh"/><path d="M50.819,62.224L43.241,82.64C42.834,83.92 42.631,84.82 42.631,85.695C42.631,88.193 44.381,89.854 47.019,89.854C49.187,89.854 50.696,88.801 51.647,86.025L55.986,73.333L61.955,73.333L50.819,62.224ZM59.382,39.155L59.994,37.507C61.198,34.426 63.391,32.841 66.599,32.841C69.87,32.841 72.19,34.426 73.33,37.507L82.51,62.256L68.944,48.706L66.992,43.027L66.32,43.027L65.538,45.303L59.382,39.155Z" class="lang-en"/></g></svg>',
  showPronunciation: '<svg width="17" height="16" viewBox="0 0 17 16"><path d="M3.95 15.45c.16.19.38.28.66.28.2 0 .4-.05.57-.16.17-.1.38-.26.62-.48l2.43-2.23h4.4a3.7 3.7 0 0 0 1.8-.4c.5-.28.88-.67 1.14-1.19.26-.5.4-1.13.4-1.86v-5.7c0-.72-.14-1.34-.4-1.85s-.64-.9-1.14-1.18a3.7 3.7 0 0 0-1.8-.41H3.37a3.7 3.7 0 0 0-1.82.4C1.06.96.7 1.36.43 1.87c-.26.5-.4 1.13-.4 1.86v5.7c0 .72.14 1.34.4 1.85.27.52.64.9 1.13 1.18.5.27 1.08.41 1.77.41h.38v1.8c0 .34.08.6.24.79Zm3.27-3.52L5 14.26v-2.11c0-.23-.05-.38-.14-.47-.1-.1-.24-.14-.44-.14h-.96c-.67 0-1.16-.17-1.48-.52-.32-.35-.48-.87-.48-1.56V3.81c0-.68.16-1.2.48-1.55.32-.34.81-.52 1.48-.52h9.1c.66 0 1.16.18 1.48.52.32.35.48.87.48 1.55v5.65c0 .7-.16 1.2-.48 1.56-.32.35-.82.52-1.48.52H8.16c-.22 0-.39.03-.52.08s-.27.15-.42.31Zm-4.29-6.5c0-.41.32-.74.7-.74h4.39c.39 0 .7.33.7.73 0 .4-.31.74-.7.74H3.64a.72.72 0 0 1-.7-.74Zm.7 1.46c-.38 0-.7.34-.7.74 0 .4.32.74.7.74h1.5c.38 0 .7-.33.7-.74 0-.4-.32-.74-.7-.74h-1.5Zm6.54-1.47c0-.4.32-.73.7-.73h1.5c.38 0 .7.33.7.73 0 .4-.32.74-.7.74h-1.5a.72.72 0 0 1-.7-.74ZM7.98 6.9c-.39 0-.7.34-.7.74 0 .4.31.74.7.74h2.21c.39 0 .7-.33.7-.74 0-.4-.31-.74-.7-.74H8Z"/></svg>',
  hidePronunciation: '<svg width="16" height="16" viewBox="0 0 16 16" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2"><path d="m.93 2.9 1.19 1.19-.02.03c-.31.38-.47.92-.47 1.6v6.34c0 .77.2 1.35.57 1.74.38.39.96.58 1.74.58h1.14c.23 0 .4.05.51.15.1.1.16.28.16.53v2.37l2.63-2.6c.18-.19.35-.3.5-.36.15-.06.35-.09.6-.09h2.94l1.64 1.64H9.57l-2.84 2.51c-.28.25-.52.43-.73.55-.2.12-.42.18-.65.18-.34 0-.6-.1-.78-.32a1.3 1.3 0 0 1-.28-.88v-2.04h-.45c-.8 0-1.49-.16-2.06-.47a3.17 3.17 0 0 1-1.32-1.33 4.43 4.43 0 0 1-.46-2.1V5.67c0-.82.15-1.52.46-2.1.13-.25.28-.47.47-.67ZM1.04 0c.19 0 .34.07.48.2l16.72 16.7c.13.14.2.3.2.48s-.07.33-.2.46a.6.6 0 0 1-.47.2.64.64 0 0 1-.47-.2L.57 1.14A.64.64 0 0 1 .38.65C.38.47.45.32.58.2.7.07.85 0 1.03 0ZM14.7 1.77c.83 0 1.54.16 2.12.47.58.3 1.02.75 1.33 1.33.3.58.45 1.28.45 2.1v6.45c0 .82-.15 1.52-.45 2.1-.14.26-.3.49-.5.7l-1.19-1.2.05-.05c.3-.38.46-.92.46-1.61V5.72c0-.76-.2-1.34-.57-1.73-.38-.39-.96-.58-1.75-.58h-8.5L4.5 1.77h10.2ZM6.36 9.08a.83.83 0 1 1 0 1.66H4.71a.83.83 0 1 1 0-1.66h1.65Zm5.53 0c.46 0 .83.37.83.83v.07l-.9-.9h.07ZM4.4 6.38 6 7.97H4.7a.83.83 0 0 1-.3-1.6Zm9.7-.06a.83.83 0 1 1 0 1.66h-1.66a.83.83 0 1 1 0-1.66h1.66Zm-4.42 0a.83.83 0 0 1 .68 1.3l-1.3-1.3h.62Z" style="fill-rule:nonzero" transform="translate(.4 .14) scale(.81615)"/></svg>',
};

const SVG = 'http://www.w3.org/2000/svg';
const svgNode = (name, attrs) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/**
 * 歌词翻译按钮的图标，同 music.apple.com 的 invertible-mask：28×28 的方块以 22×22 的图标为遮罩，
 * 未开启时只显示图标，开启翻译或发音后反转为实心方块、图标镂空。返回 setInverted(bool)。
 */
function invertibleMask(button) {
  const id = `lyrics-translation-mask-${Math.random().toString(36).slice(2)}`;
  const svg = svgNode('svg', { class: 'invertible-mask', viewBox: '0 0 28 28', width: '28', height: '28', role: 'presentation' });
  const mask = svgNode('mask', { id });
  const base = svgNode('rect', { width: '100%', height: '100%' });
  const icon = svgNode('svg', { x: '3', y: '3', width: '22', height: '22', viewBox: '0 0 17 16' });
  for (const d of TRANSLATE_PATHS) icon.append(svgNode('path', { d, transform: 'translate(-.51 4.44)scale(.101)' }));
  mask.append(base, icon);
  svg.append(mask, svgNode('rect', { width: '100%', height: '100%', mask: `url(#${id})` }));
  button.replaceChildren(svg);
  return (inverted) => {
    base.setAttribute('fill', inverted ? 'white' : 'black');
    icon.setAttribute('fill', inverted ? 'black' : 'white');
    svg.classList.toggle('invertible-mask--inverted', inverted);
    svg.classList.toggle('invertible-mask--not-inverted', !inverted);
  };
}

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
 * root：#lyrics-overlay；toggle：播放条上的歌词按钮；bar：播放条，
 * 点击其中非控件区域（封面、标题、空白处）与点击歌词按钮相同；歌词界面打开时并入 .lyrics-controls。
 * adamId / country：歌曲页固定的歌曲及其地区；外壳页不传，改用返回值的 setTrack(id, country) 跟随正在播放的歌曲。
 * getMeta() 返回当前的 { title, artist, artists, artwork, country? }（artists: [{ name, href }]，用于艺人链接；
 * 有 country 时优先作为请求歌词的地区），
 * 变化后调用返回值的 refreshMeta()；t 为界面文案函数；notify 显示提示。
 * navigate(href)：外壳传入，点击艺人链接时关闭歌词界面并由它在 iframe 中打开；省略时按普通链接跳转。
 */
export function mountLyrics({ root, toggle, bar, player, adamId: initialId, country: initialCountry, getMeta, t, notify, onLangChange, navigate }) {
  const $ = (selector) => root.querySelector(selector);
  const follow = $('.lyrics-follow');
  // 翻译 / 发音：同 music.apple.com，一个「歌词翻译」按钮弹出菜单切换；开关在切歌后保留
  const translationMenu = $('.lyrics-translation-menu');
  const translationButton = $('.lyrics-translation-button');
  const menu = $('.lyrics-menu');
  const scrim = $('.lyrics-menu-scrim');
  const setInverted = invertibleMask(translationButton);
  const shown = { translation: false, pronunciation: false };
  const has = { translation: false, pronunciation: false };
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
  let adamId = null;
  let country = null;
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
    // 艺人名链接到艺人页（见 player.js 的 artistNodes）
    $('.lyrics-artist').replaceChildren(...globalThis.AmHook.artistNodes(meta.artist || '', meta.artists));
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
    closeMenu();
    barHome.replaceWith(bar);
    root.hidden = true;
    document.body.classList.remove('lyrics-open');
    toggle.setAttribute('aria-pressed', 'false');
    cancelAnimationFrame(frame);
    frame = 0;
    backdrop?.pause();
    toggle.focus({ preventScroll: true });
  }

  /** 歌曲有翻译或发音时才显示按钮；开启任一项时图标反转 */
  function syncOptions() {
    translationMenu.hidden = !(has.translation || has.pronunciation);
    setInverted(shown.translation || shown.pronunciation);
    if (!menu.hidden) renderMenu();
  }

  /** 菜单项同 music.apple.com：已开启的显示「隐藏…」，否则「显示…」，歌曲没有的一项置灰 */
  function renderMenu() {
    const items = [
      ['translation', has.translation && shown.translation ? 'hideTranslation' : 'showTranslation'],
      ['pronunciation', has.pronunciation && shown.pronunciation ? 'hidePronunciation' : 'showPronunciation'],
    ].map(([name, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.dataset.option = name;
      button.disabled = !has[name];
      button.title = t(`lyrics.${action}`);
      const text = document.createElement('span');
      text.className = 'lyrics-menu-text';
      text.textContent = button.title;
      const icon = document.createElement('span');
      icon.className = 'lyrics-menu-icon';
      icon.innerHTML = MENU_ICONS[action];
      button.append(text, icon);
      const item = document.createElement('li');
      item.setAttribute('role', 'none');
      item.append(button);
      return item;
    });
    menu.replaceChildren(...items);
  }

  /**
   * 在点击处弹出菜单（键盘打开时在按钮中心），同 amp-contextual-menu-button：
   * 右侧放不下时改到左侧，下方放不下（留 40px）时改为向上展开。
   */
  function openMenu(event) {
    renderMenu();
    menu.hidden = false;
    scrim.hidden = false;
    translationButton.setAttribute('aria-expanded', 'true');
    const rect = translationButton.getBoundingClientRect();
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top + rect.height / 2;
    menu.style.cssText = '';
    if (!matchMedia('(max-width: 483px)').matches) {
      const rtl = document.dir === 'rtl';
      const fitsRight = innerWidth - x > menu.offsetWidth;
      const left = (rtl && (x > menu.offsetWidth || !fitsRight)) || (!rtl && !fitsRight) ? x - menu.offsetWidth - 1 : x + 1;
      menu.style.left = `${left}px`;
      if (innerHeight - y > menu.offsetHeight + 40) menu.style.top = `${y}px`;
      else menu.style.bottom = `${innerHeight - y}px`;
    }
    if (!event.detail) menu.querySelector('button:not(:disabled)')?.focus();
  }

  function closeMenu(focusButton) {
    if (menu.hidden) return;
    menu.hidden = true;
    scrim.hidden = true;
    translationButton.setAttribute('aria-expanded', 'false');
    if (focusButton) translationButton.focus({ preventScroll: true });
  }

  /** 首次打开时获取歌词；加载中的重复点击被忽略，失败后可重试 */
  function fetchLyrics() {
    if (!request) {
      const id = adamId;
      toggle.setAttribute('aria-busy', 'true');
      request = Promise.resolve(globalThis.AmI18n?.defaultLang(getMeta()?.country || country))
        .catch(() => undefined)
        .then((language) => fetch(`/lyrics/${id}${language ? `?language=${encodeURIComponent(language)}` : ''}`))
        .then(async (response) => {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parsed = parseTTML(await response.text());
          return parsed.lines.length ? parsed : null;
        })
        .then((parsed) => {
          if (id !== adamId) return; // 已切换到另一首歌
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
          has.translation = voices.some((voice) => voice.translation);
          has.pronunciation = voices.some((voice) => voice.pronunciation || voice.pronunciationTokens.length);
          syncOptions();
        })
        .catch((error) => {
          if (id !== adamId) return;
          request = null;
          console.warn('[am-hook] 歌词加载失败', error);
          notify(t('lyrics.failed'));
        })
        .finally(() => { if (id === adamId) toggle.removeAttribute('aria-busy'); });
    }
    return request;
  }

  /** 切换歌曲（id 为空表示没有歌曲）：歌词界面打开时取回新歌词原地刷新，没有歌词时关闭 */
  function setTrack(id, cc) {
    id = id || null;
    if (id === adamId) return;
    adamId = id;
    country = cc || null;
    song = null;
    request = null;
    unavailable = false;
    toggle.removeAttribute('aria-busy');
    credits.replaceChildren();
    view.setLyricLines([]);
    closeMenu();
    has.translation = has.pronunciation = false;
    syncOptions();
    toggle.hidden = !id;
    bar.classList.toggle('lyrics-available', !!id);
    if (!open) return;
    if (!id) { hide(); return; }
    renderHeader();
    loadArtwork();
    fetchLyrics().then(() => {
      if (id !== adamId || !open) return;
      if (!song) { hide(); return; }
      setLines();
      view.setCurrentTime(currentTime(), true);
      view.resetScroll();
    });
  }

  function toggleOpen() {
    if (open) { hide(); return; }
    if (song) { show(); return; }
    if (unavailable || toggle.hasAttribute('aria-busy')) return;
    fetchLyrics().then(() => { if (song) show(); });
  }

  setTrack(initialId, initialCountry);
  toggle.addEventListener('click', toggleOpen);
  bar.addEventListener('click', (event) => {
    if (open || unavailable || !adamId || event.target.closest('button, input, a, [role="slider"], .player-msg, .player-notice')) return;
    toggleOpen();
  });
  $('.lyrics-close').addEventListener('click', hide);
  $('.lyrics-artist').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link || !navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    hide();
    navigate(link.getAttribute('href'));
  });
  translationButton.addEventListener('click', (event) => {
    if (menu.hidden) openMenu(event); else closeMenu();
  });
  scrim.addEventListener('click', () => closeMenu());
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-option]');
    if (!button || button.disabled) return;
    const name = button.dataset.option;
    shown[name] = !shown[name];
    closeMenu(true);
    syncOptions();
    setLines();
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[(index + buttons.length) % buttons.length]?.focus();
  });
  follow.addEventListener('click', () => { view.resetScroll(); follow.hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    // 菜单打开时 Esc 只关闭菜单
    if (!menu.hidden) closeMenu(true); else hide();
  });
  onLangChange(() => {
    renderCredits();
    if (!menu.hidden) renderMenu();
    if (open) renderHeader();
  });

  /** 页面重新取回歌曲信息（如切换语言）后调用，更新打开中的标题与封面 */
  function refreshMeta() {
    if (!open) return;
    renderHeader();
    loadArtwork();
  }

  return { show, hide, refreshMeta, setTrack, view, get song() { return song; } };
}
