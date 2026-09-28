/*
 * am-hook 界面语言（中文 / English）
 *
 *   t(key, vars)          取当前语言文案，{name} 占位符由 vars 替换
 *   apply(root)           刷新静态文字：data-i18n（textContent）、data-i18n-html（innerHTML，仅限本文件内的可信文案）、
 *                         data-i18n-attr="title=key,aria-label=key2"（属性）
 *   setLang / toggle      切换语言并记住选择；onChange(fn) 在切换后回调，页面据此重绘动态内容
 *   catalogLang(cc)       异步：当前语言在该地区 amp-api 可用的 l 值（地区不支持时为 undefined）
 *   [data-lang-toggle]    页面上的切换按钮，自动绑定
 * 初始语言：上次的选择，否则按浏览器语言（zh* 为中文，其余为英文）。
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'am-hook:lang';

  const dict = {
    zh: {
      "mv.preview": "视频预览",
      "mv.quality": "画质与音轨",
      "mv.custom": "自由组合",
      "mv.unavailable": "暂无可用轨道",
      "mv.failed": "MV 加载失败",
      "mv.play": "播放所选轨道",
      "mv.download": "下载 MP4",
      "mv.cancel": "取消",
      "mv.save": "保存 MP4",
      "mv.hint": "选择视频和音频轨道。下载会在浏览器内逐段处理并合并为 MP4。",
      "mv.video": "视频轨道",
      "mv.audio": "音频轨道",
      "mv.loading": "正在解析 MV…",
      "mv.ready": "已就绪，请选择轨道后播放或下载。",
      "mv.license": "正在准备音视频轨道…",
      "mv.buffering": "正在缓冲…",
      "mv.playing": "播放已就绪",
      "mv.pressPlay": "请点击视频中的播放按钮",
      "mv.downloading": "下载中 {percent}% · {size} MB",
      "mv.defrag": "正在整理为标准 MP4…",
      "mv.complete": "MP4 已生成，可点击“保存 MP4”再次保存。",
      "mv.cancelled": "已取消",
      "mv.downloadOnly": "当前浏览器仅支持下载",
      "mv.channels": "声道",
      "mv.recommended": "视频推荐",

      'lang.button': 'EN',
      'lang.title': 'Switch to English',

      'status.checking': '检查 wrapper-lite…',
      'status.online': 'wrapper-lite 在线',
      'status.down': 'wrapper-lite 不可用',
      'footer.tagline': 'am-hook · 浏览器端解密',
      'footer.note': '仅供个人学习使用',
      'footer.github': '在 GitHub 上查看',
      'footer.thanks': '致谢以下开源项目：',
      'nav.home': '主页',

      'home.intro': '搜索或粘贴 Apple Music 歌曲、音乐视频链接，在浏览器里播放与下载。',
      'home.formHint': '输入关键词搜索，或粘贴歌曲、MV 链接、带 ?i= 的专辑分享链接及歌曲 ID',
      'home.inputLabel': '搜索，或输入歌曲 / MV 链接、歌曲 ID',
      'home.placeholder': '搜索歌曲、MV，或粘贴链接',
      'home.submit': '解析',
      'home.search': '搜索',
      'home.empty': '请输入关键词或链接。',
      'search.results': '“{term}” 的搜索结果',
      'search.songs': '歌曲',
      'search.mvs': '音乐视频',
      'search.more': '加载更多',
      'search.loading': '正在搜索…',
      'search.none': '没有找到相关的歌曲或音乐视频。',
      'search.failed': '搜索失败：{msg}',
      'search.storefront': '地区',
      'search.close': '关闭',
      'search.explicit': '含不当内容',
      'search.albums': '专辑',
      'search.playlists': '歌单',
      'search.artists': '艺人',
      'search.placeholder': '搜索',
      'home.example': '示例',
      'home.recent': '最近解析',
      'home.clear': '清空',
      'home.invalid': '无法识别：请输入歌曲、MV 或专辑链接，或纯数字歌曲 ID。',
      'home.detectSong': '歌曲',
      'home.detectMv': 'MV',
      'home.detectAlbum': '专辑',
      'home.detectPlaylist': '歌单',
      'home.detectArtist': '艺人',
      'home.detectId': '歌曲 ID',
      'album.pageTitle': 'am-hook · 专辑',
      'album.loading': '正在载入专辑…',
      'album.failed': '专辑加载失败：{msg}',
      'album.badId': '无效的专辑链接。',
      'album.play': '播放',
      'album.shuffle': '随机播放',
      'album.more': '更多',
      'album.less': '收起',
      'album.disc': '碟 {n}',
      'album.songs': '{n} 首歌曲',
      'album.videos': '{n} 个视频',
      'album.minutes': '{n} 分钟',
      'album.hours': '{h} 小时 {m} 分钟',
      'album.popular': '热门',
      'album.playTrack': '播放 {name}',
      'album.quality': '音质与下载',
      'album.video': '音乐视频',
      'album.preparing': '正在解析《{name}》…',
      'album.trackFailed': '无法播放《{name}》：{msg}',
      'album.noPlayable': '《{name}》没有浏览器可直接播放的音质，请打开歌曲页下载。',
      'album.coverAlt': '《{title}》封面',
      'album.digitalMaster': 'Apple 数码母带',
      'playlist.pageTitle': 'am-hook · 歌单',
      'playlist.loading': '正在载入歌单…',
      'playlist.failed': '歌单加载失败：{msg}',
      'playlist.badId': '无效的歌单链接。',
      'playlist.updated': '更新于 {date}',
      'artist.pageTitle': 'am-hook · 艺人',
      'artist.loading': '正在载入艺人…',
      'artist.failed': '艺人加载失败：{msg}',
      'artist.badId': '无效的艺人链接。',
      'artist.seeAll': '显示全部',
      'artist.about': '关于 {name}',
      'artist.hometown': '家乡',
      'artist.origin': '发源地',
      'artist.born': '出生日期',
      'artist.formed': '成立时间',
      'artist.genre': '流派',
      'artist.portraitAlt': '{name} 的照片',
      'home.tagAtmos': '空间音频',
      'home.tagAac': '通用',
      'home.tagMv': '视频',
      'home.fmtAlac': '最高 24-bit / 192 kHz，逐比特还原录音室母带。',
      'home.fmtAtmos': 'EC-3 多声道，浏览器内解码播放。',
      'home.fmtAac': '256 kbps 立体声，兼容性最好。',
      'home.fmtMv': '自选画质与音轨，合并下载为 MP4。',

      'song.pageTitle': 'am-hook · 音质解析',
      'song.play': '播放',
      'song.external': '外部播放',
      'song.externalTitle': '用外部播放器播放最高音质',
      'song.reparse': '重新解析',
      'song.variants': '可用音质',
      'song.count': '{total} 个音质 · {playable} 个可在浏览器播放',
      'song.fallbackTitle': '歌曲 {id}',
      'song.noMeta': '未能获取歌曲信息',
      'song.coverAlt': '{title} 封面',
      'song.badId': '无法从链接中识别歌曲 ID。',
      'song.loading': '正在获取 master m3u8…',
      'song.parseFailed': '解析失败',
      'song.parseFailedHttp': '解析失败（HTTP {status}）',

      'q.lossless': '无损',
      'q.atmos': '杜比全景声',
      'q.binaural': '双耳',
      'q.downmix': '缩混',

      'row.play': '播放 {name}',
      'row.playTitle': '在线播放',
      'row.unsupported': '当前浏览器不支持该编码',
      'row.unsupportedTitle': '当前浏览器不支持 {codecs}，{hint}',
      'row.playable': '浏览器可播',
      'row.external': '需外部播放器',
      'row.downloadOnly': '仅可下载',
      'row.channels': '声道 {n}',
      'row.more': '更多',
      'row.moreAria': '{name} 更多操作',
      'row.cancel': '取消下载',
      'row.cancelAria': '取消下载 {name}',

      'menu.download': '下载解密文件',
      'menu.downloadHint': '浏览器内解密 · {file}',
      'menu.serverDownload': '通过服务器下载',
      'menu.serverDownloadHint': '由服务端解密，消耗服务器流量',
      'menu.players': '外部播放器',
      'menu.playersHint': '服务端解密 · 所有音质',
      'menu.morePlayers': '显示其他平台（{n}）',
      'menu.lessPlayers': '收起其他平台',
      'menu.copy': '复制地址',
      'menu.copyHint': 'M3U8 用于播放器，文件用于 IDM 等下载工具',
      'menu.copyFile': '文件',

      'toast.copiedM3u8': '已复制 media m3u8 地址',
      'toast.copiedFile': '已复制 media file 地址',
      'toast.player': '正在唤起 {name}…若没有反应，请确认已安装 {name} 并已注册对应的链接协议',

      'dl.busy': '该音质正在下载',
      'dl.preparing': '正在准备下载…',
      'dl.progress': '浏览器解密下载中 {pct}% · {done} / {total}',
      'dl.defrag': '正在整理为标准 MP4…',
      'dl.done': '解密完成，已交给浏览器保存（{size}）',
      'dl.cancelled': '已取消下载',
      'dl.failed': '下载失败：{msg}',

      'player.back': '后退 10 秒',
      'player.forward': '前进 10 秒',
      'player.play': '播放',
      'player.pause': '暂停',
      'player.seek': '播放进度',
      'player.mode': '播放方式',
      'player.volume': '音量',
      'player.unknownTitle': '未知歌曲',
      'player.direct': '直连',
      'player.pcmMode': '多声道 PCM',
      'player.pcmChannels': '{n}.1 PCM',
      'player.pcmNotice': '正在播放解码后的多声道 PCM；保留 5.1/7.1 声道，但不包含完整的 Atmos 空间音频效果。实际输出取决于设备。',
      'player.flacNotice': '当前浏览器不支持直接播放 ALAC，已在浏览器内无损转码为 FLAC 播放；下载仍保留原始 ALAC。',
      'player.hintExternal': '可在该音质的「更多」菜单中选择外部播放器播放',
      'player.hintDownload': '可下载解密文件后用本地播放器播放',
      'player.errorGeneric': '播放出错，请换一个音质，或{hint}。',
      'player.errorCodec': '当前浏览器不支持 {codecs} 编码，{hint}。',
      'player.errorFailed': '当前浏览器无法播放 {label}（{codecs}），{hint}。',
      'player.errorAutoplay': '浏览器阻止了自动播放，请点击播放按钮。',
      'player.errorAppend': 'SourceBuffer 追加失败，浏览器可能不支持该编码',

      'lyrics.title': '歌词',
      'lyrics.open': '歌词',
      'lyrics.close': '收起歌词',
      'lyrics.translation': '翻译',
      'lyrics.pronunciation': '发音',
      'lyrics.follow': '回到当前歌词',
      'lyrics.credits': '创作者：',
      'lyrics.creditsSeparator': '、',
      'lyrics.aiTranslation': '翻译由 AI 生成',
      'lyrics.none': '这首歌没有歌词',
      'lyrics.failed': '歌词加载失败，请稍后重试',

      'err.worker': '解密 Worker 出错',
      'err.defrag': '解碎片失败：{msg}',
      'err.template': '获取解密模板失败：{msg}',
      'err.m3u8Http': '获取 media m3u8 失败（HTTP {status}）',
      'err.m3u8Map': 'media m3u8 缺少 EXT-X-MAP BYTERANGE',
      'err.m3u8Empty': 'media m3u8 中没有可播放的分段',
      'err.m3u8Key': 'media m3u8 缺少轨道密钥信息',
      'err.segmentHttp': '分段请求失败（HTTP {status}）',
      'err.segmentLength': '分段长度不符（{got}/{want}）',
    },
    en: {
      "mv.preview": "Video preview",
      "mv.quality": "Video & audio quality",
      "mv.custom": "Mix & match",
      "mv.unavailable": "No tracks available",
      "mv.failed": "Unable to load music video",
      "mv.play": "Play selected tracks",
      "mv.download": "Download MP4",
      "mv.cancel": "Cancel",
      "mv.save": "Save MP4",
      "mv.hint": "Choose video and audio tracks. Downloads are processed segment by segment and merged into MP4 in your browser.",
      "mv.video": "Video tracks",
      "mv.audio": "Audio tracks",
      "mv.loading": "Loading music video…",
      "mv.ready": "Ready. Choose tracks to play or download.",
      "mv.license": "Preparing video and audio…",
      "mv.buffering": "Buffering…",
      "mv.playing": "Ready to play",
      "mv.pressPlay": "Press play in the video controls",
      "mv.downloading": "Downloading {percent}% · {size} MB",
      "mv.defrag": "Converting to progressive MP4…",
      "mv.complete": "MP4 is ready. Use Save MP4 to save it again.",
      "mv.cancelled": "Cancelled",
      "mv.downloadOnly": "Download only in this browser",
      "mv.channels": "channels",
      "mv.recommended": "Recommended for video",

      'lang.button': '中文',
      'lang.title': '切换到中文',

      'status.checking': 'Checking wrapper-lite…',
      'status.online': 'wrapper-lite online',
      'status.down': 'wrapper-lite unavailable',
      'footer.tagline': 'am-hook · in-browser decryption',
      'footer.note': 'For personal study only',
      'footer.github': 'View on GitHub',
      'footer.thanks': 'Thanks to these open-source projects:',
      'nav.home': 'Home',

      'home.intro': 'Search or paste an Apple Music song or music video link, then play or download right in your browser.',
      'home.formHint': 'Search by keyword, or paste a song / music-video link, an album link with ?i=, or a song ID',
      'home.inputLabel': 'Search, or enter a song / MV link or song ID',
      'home.placeholder': 'Search songs and music videos, or paste a link',
      'home.submit': 'Parse',
      'home.search': 'Search',
      'home.empty': 'Enter a keyword or a link.',
      'search.results': 'Results for “{term}”',
      'search.songs': 'Songs',
      'search.mvs': 'Music Videos',
      'search.more': 'Load more',
      'search.loading': 'Searching…',
      'search.none': 'No songs or music videos found.',
      'search.failed': 'Search failed: {msg}',
      'search.storefront': 'Storefront',
      'search.close': 'Close',
      'search.explicit': 'Explicit',
      'search.albums': 'Albums',
      'search.playlists': 'Playlists',
      'search.artists': 'Artists',
      'search.placeholder': 'Search',
      'home.example': 'Examples',
      'home.recent': 'Recent',
      'home.clear': 'Clear',
      'home.invalid': 'Unrecognized input: enter a song, music-video or album link, or a numeric song ID.',
      'home.detectSong': 'Song',
      'home.detectMv': 'MV',
      'home.detectAlbum': 'Album',
      'home.detectPlaylist': 'Playlist',
      'home.detectArtist': 'Artist',
      'home.detectId': 'Song ID',
      'album.pageTitle': 'am-hook · Album',
      'album.loading': 'Loading album…',
      'album.failed': 'Failed to load album: {msg}',
      'album.badId': 'Invalid album link.',
      'album.play': 'Play',
      'album.shuffle': 'Shuffle',
      'album.more': 'MORE',
      'album.less': 'LESS',
      'album.disc': 'Disc {n}',
      'album.songs': '{n} songs',
      'album.videos': '{n} videos',
      'album.minutes': '{n} minutes',
      'album.hours': '{h} hr {m} min',
      'album.popular': 'Popular',
      'album.playTrack': 'Play {name}',
      'album.quality': 'Qualities & download',
      'album.video': 'Music video',
      'album.preparing': 'Preparing “{name}”…',
      'album.trackFailed': 'Cannot play “{name}”: {msg}',
      'album.noPlayable': '“{name}” has no quality this browser can play directly; open the song page to download it.',
      'album.coverAlt': 'Cover of {title}',
      'album.digitalMaster': 'Apple Digital Master',
      'playlist.pageTitle': 'am-hook · Playlist',
      'playlist.loading': 'Loading playlist…',
      'playlist.failed': 'Failed to load playlist: {msg}',
      'playlist.badId': 'Invalid playlist link.',
      'playlist.updated': 'Updated {date}',
      'artist.pageTitle': 'am-hook · Artist',
      'artist.loading': 'Loading artist…',
      'artist.failed': 'Failed to load artist: {msg}',
      'artist.badId': 'Invalid artist link.',
      'artist.seeAll': 'See All',
      'artist.about': 'About {name}',
      'artist.hometown': 'Hometown',
      'artist.origin': 'Origin',
      'artist.born': 'Born',
      'artist.formed': 'Formed',
      'artist.genre': 'Genre',
      'artist.portraitAlt': 'Photo of {name}',
      'home.tagAtmos': 'Spatial',
      'home.tagAac': 'Universal',
      'home.tagMv': 'Video',
      'home.fmtAlac': 'Up to 24-bit / 192 kHz, bit-for-bit studio masters.',
      'home.fmtAtmos': 'Multichannel EC-3, decoded right in the browser.',
      'home.fmtAac': '256 kbps stereo that plays everywhere.',
      'home.fmtMv': 'Pick video and audio tracks, save as MP4.',

      'song.pageTitle': 'am-hook · Audio qualities',
      'song.play': 'Play',
      'song.external': 'External player',
      'song.externalTitle': 'Play the highest quality in an external player',
      'song.reparse': 'Reparse',
      'song.variants': 'Available qualities',
      'song.count': '{total} qualities · {playable} playable in browser',
      'song.fallbackTitle': 'Song {id}',
      'song.noMeta': 'Song info unavailable',
      'song.coverAlt': '{title} cover',
      'song.badId': 'Could not find a song ID in the link.',
      'song.loading': 'Fetching master m3u8…',
      'song.parseFailed': 'Parse failed',
      'song.parseFailedHttp': 'Parse failed (HTTP {status})',

      'q.lossless': 'Lossless',
      'q.atmos': 'Dolby Atmos',
      'q.binaural': 'Binaural',
      'q.downmix': 'Downmix',

      'row.play': 'Play {name}',
      'row.playTitle': 'Play in browser',
      'row.unsupported': 'Codec not supported by this browser',
      'row.unsupportedTitle': 'This browser can\'t decode {codecs}; {hint}',
      'row.playable': 'Plays in browser',
      'row.external': 'External player',
      'row.downloadOnly': 'Download only',
      'row.channels': '{n} ch',
      'row.more': 'More',
      'row.moreAria': 'More actions for {name}',
      'row.cancel': 'Cancel download',
      'row.cancelAria': 'Cancel download of {name}',

      'menu.download': 'Download decrypted file',
      'menu.downloadHint': 'Decrypted in the browser · {file}',
      'menu.serverDownload': 'Download via server',
      'menu.serverDownloadHint': 'Decrypted by the server; uses server bandwidth',
      'menu.players': 'External players',
      'menu.playersHint': 'Server-decrypted · every quality',
      'menu.morePlayers': 'Show other platforms ({n})',
      'menu.lessPlayers': 'Hide other platforms',
      'menu.copy': 'Copy URL',
      'menu.copyHint': 'M3U8 for players, file for download managers such as IDM',
      'menu.copyFile': 'File',

      'toast.copiedM3u8': 'Copied media m3u8 URL',
      'toast.copiedFile': 'Copied media file URL',
      'toast.player': 'Opening {name}… If nothing happens, make sure {name} is installed and handles its link protocol',

      'dl.busy': 'This quality is already downloading',
      'dl.preparing': 'Preparing download…',
      'dl.progress': 'Decrypting in browser {pct}% · {done} / {total}',
      'dl.defrag': 'Converting to progressive MP4…',
      'dl.done': 'Decrypted and handed to the browser to save ({size})',
      'dl.cancelled': 'Download cancelled',
      'dl.failed': 'Download failed: {msg}',

      'player.back': 'Back 10 seconds',
      'player.forward': 'Forward 10 seconds',
      'player.play': 'Play',
      'player.pause': 'Pause',
      'player.seek': 'Playback position',
      'player.mode': 'Playback method',
      'player.volume': 'Volume',
      'player.unknownTitle': 'Unknown song',
      'player.direct': 'Direct',
      'player.pcmMode': 'Multichannel PCM',
      'player.pcmChannels': '{n}.1 PCM',
      'player.pcmNotice': 'Playing decoded multichannel PCM. 5.1/7.1 channels are retained, but the full Atmos spatial experience is unavailable. Output depends on your device.',
      'player.flacNotice': 'This browser cannot play ALAC directly, so it is being converted losslessly to FLAC for playback. Downloads retain the original ALAC.',
      'player.hintExternal': 'pick an external player from that quality\'s More menu',
      'player.hintDownload': 'download the decrypted file and play it locally',
      'player.errorGeneric': 'Playback failed. Try another quality, or {hint}.',
      'player.errorCodec': 'This browser can\'t decode {codecs}; {hint}.',
      'player.errorFailed': 'This browser can\'t play {label} ({codecs}); {hint}.',
      'player.errorAutoplay': 'The browser blocked autoplay. Press play to start.',
      'player.errorAppend': 'SourceBuffer append failed; the browser may not support this codec',

      'lyrics.title': 'Lyrics',
      'lyrics.open': 'Lyrics',
      'lyrics.close': 'Close lyrics',
      'lyrics.translation': 'Translation',
      'lyrics.pronunciation': 'Pronunciation',
      'lyrics.follow': 'Back to current line',
      'lyrics.credits': 'Written by:',
      'lyrics.creditsSeparator': ', ',
      'lyrics.aiTranslation': 'Translation generated by AI',
      'lyrics.none': 'This song has no lyrics',
      'lyrics.failed': 'Failed to load lyrics. Try again later.',

      'err.worker': 'Decryption worker error',
      'err.defrag': 'Defragmentation failed: {msg}',
      'err.template': 'Failed to get the decryption template: {msg}',
      'err.m3u8Http': 'Failed to fetch media m3u8 (HTTP {status})',
      'err.m3u8Map': 'media m3u8 has no EXT-X-MAP BYTERANGE',
      'err.m3u8Empty': 'media m3u8 has no playable segments',
      'err.m3u8Key': 'media m3u8 is missing the track key',
      'err.segmentHttp': 'Segment request failed (HTTP {status})',
      'err.segmentLength': 'Segment length mismatch ({got}/{want})',
    },
  };

  function detect() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && dict[saved]) return saved;
    } catch {}
    const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    return /^zh\b/i.test(prefs[0] || '') ? 'zh' : 'en';
  }

  let lang = detect();
  const listeners = new Set();

  function t(key, vars) {
    const s = dict[lang][key] ?? dict.zh[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s;
  }

  function apply(root = document) {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split('=').map((s) => s.trim());
        el.setAttribute(attr, t(key));
      }
    });
    root.querySelectorAll('[data-lang-toggle]').forEach((btn) => {
      btn.querySelector('.lang-label').textContent = t('lang.button');
      btn.title = t('lang.title');
      btn.setAttribute('aria-label', t('lang.title'));
    });
  }

  function setLang(next) {
    if (!dict[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  /**
   * amp-api 的 l 参数。地区不支持的语言不会报错，而是静默回退到地区默认语言（如 cn 只支持 zh-Hans-CN / en-GB，
   * 传 en-US 仍返回中文），所以按 /amp/v1/storefronts/<cc> 的 supportedLanguageTags 选择；
   * 地区不支持当前界面语言时返回 undefined（不传 l），取不到地区信息时退回常见写法。
   */
  const storefrontTags = new Map();
  function supportedTags(cc) {
    if (!storefrontTags.has(cc)) {
      storefrontTags.set(cc, fetch(`/amp/v1/storefronts/${cc}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const tags = data && data.data && data.data[0] && data.data[0].attributes && data.data[0].attributes.supportedLanguageTags;
          if (!Array.isArray(tags)) throw new Error('no supportedLanguageTags');
          return tags;
        })
        .catch(() => { storefrontTags.delete(cc); return null; }));
    }
    return storefrontTags.get(cc);
  }
  async function catalogLang(cc) {
    const zh = lang === 'zh';
    const tags = /^[a-z]{2}$/i.test(cc || '') ? await supportedTags(cc.toLowerCase()) : null;
    if (!tags) return zh ? 'zh-Hans-CN' : 'en-US';
    for (const re of zh ? [/^zh-Hans/i, /^zh/i] : [/^en-US$/i, /^en/i]) {
      const hit = tags.find((tag) => re.test(tag));
      if (hit) return hit;
    }
    return undefined;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-lang-toggle]')) setLang(lang === 'zh' ? 'en' : 'zh');
  });

  global.AmI18n = {
    t,
    apply,
    setLang,
    toggle: () => setLang(lang === 'zh' ? 'en' : 'zh'),
    onChange: (fn) => listeners.add(fn),
    catalogLang,
    get lang() { return lang; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
