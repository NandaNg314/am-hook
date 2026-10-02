/*
 * am-hook 界面语言（中文 / English）
 *
 *   t(key, vars)          取当前语言文案，{name} 占位符由 vars 替换
 *   apply(root)           刷新静态文字：data-i18n（textContent）、data-i18n-html（innerHTML，仅限本文件内的可信文案）、
 *                         data-i18n-attr="title=key,aria-label=key2"（属性）
 *   setLang / toggle      切换语言并记住选择；onChange(fn) 在切换后回调，页面据此重绘动态内容
 *   [data-lang-toggle]    页面上的切换按钮，自动绑定
 * 初始语言：上次的选择，否则按浏览器语言（zh* 为中文，其余为英文）。
 *
 * 主地区与曲库语言（amp-api 的 storefront 与 l，与界面语言相互独立），选择保存在 localStorage，不会过期：
 *   storefronts()         异步：全部地区 { cc: { name, tags, default } }，取自 /amp/v1/storefronts（取不到时为 null）
 *   setRegions(list)      wrapper-lite 账号所在地区（app.mjs 根据 /status 设置），regions 为当前值
 *   storefront            主地区：用户的选择，否则为 wrapper-lite 的第一个地区，否则为 us；setStorefront(cc) 修改
 *   favorites             收藏的地区（默认 us / cn / jp），在选择面板里直接列出；toggleFavorite(cc) 收藏 / 取消
 *   ampLang(cc)           该地区选定的曲库语言（未选择时为 null，即地区默认语言）；setAmpLang(cc, tag) 修改
 *   catalogLang(cc)       异步：请求该地区 amp-api 用的 l：选定的语言，否则为地区默认语言（取不到地区信息时为 undefined）
 *   onSettingsChange(fn)  主地区、收藏或曲库语言变化后回调 fn({ kind: 'storefront' | 'favorites' | 'ampLang', cc })
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

      'lang.caption': '界面语言',
      'lang.button': '中文',
      'lang.title': 'Switch to English',

      'settings.storefront': '主地区',
      'settings.storefrontHint': '用于搜索等功能。选择 wrapper-lite 账号所在地区可获得最佳体验。',
      'settings.best': 'wrapper-lite 地区 · 最佳体验',
      'settings.outside': '非 wrapper-lite 地区：可以搜索与浏览，部分内容可能无法播放。',
      'settings.selected': '当前选择',
      'settings.favorites': '收藏的地区',
      'settings.favorite': '收藏“{name}”',
      'settings.unfavorite': '取消收藏“{name}”',
      'settings.more': '更多地区',
      'settings.less': '收起',
      'settings.filter': '筛选地区',
      'settings.noMatch': '没有匹配的地区',
      'settings.ampLang': '曲库语言',
      'settings.ampLangHint': '{storefront}的歌曲、专辑、艺人等信息所用的语言（Apple Music 提供的可选语言）。',
      'settings.default': '默认',
      'settings.loading': '正在获取地区列表…',
      'settings.failed': '无法获取地区列表。',
      'settings.retry': '重试',
      'settings.close': '关闭',

      'status.checking': '检查中…',
      'status.online': '在线',
      'status.down': '不可用',
      'status.region': '{count} 个地区',
      'status.regions': '{count} 个地区',
      'status.more': '另外 {count} 个地区',
      'status.expand': '展开全部地区',
      'status.collapse': '收起地区',
      'status.current': '当前主地区',
      'footer.tagline': 'am-hook · 浏览器端解密',
      'footer.note': '仅供个人学习使用',
      'footer.github': '在 GitHub 上查看',
      'footer.thanks': '致谢以下开源项目：',
      'nav.home': '主页',
      'nav.back': '返回',
      'nav.menu': '菜单',
      'nav.label': '导航',

      'home.inputLabel': '搜索，或输入歌曲 / MV 链接',
      'home.placeholder': '在此搜索或粘贴Apple Music链接',
      'home.submit': '解析',
      'home.search': '搜索',
      'home.empty': '请输入关键词或链接。',
      'search.results': '“{term}” 的搜索结果',
      'search.top': '最佳结果',
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
      'search.all': '全部',
      'search.seeAll': '查看全部',
      'home.example': '已支持链接示例',
      'home.recent': '最近搜索',
      'home.removeRecent': '删除“{term}”',
      'home.clear': '清空',
      'home.invalid': '无法识别：请输入歌曲、MV 或专辑链接。',
      'home.detectSong': '歌曲',
      'home.detectMv': 'MV',
      'home.detectAlbum': '专辑',
      'home.detectPlaylist': '歌单',
      'home.detectArtist': '艺人',
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
      'album.trackFailed': '无法播放《{name}》：{msg}',
      'album.noPlayable': '《{name}》没有浏览器可直接播放的音质，请打开歌曲页下载。',
      'album.coverAlt': '《{title}》封面',
      'action.play': '播放',
      'action.shuffle': '随机播放',
      'action.more': '更多',
      'action.moreFor': '更多 · {name}',
      'action.playMv': '播放音乐视频',
      'action.goAlbum': '前往专辑',
      'action.copySite': '复制本站链接',
      'action.copyApple': '复制 AM 链接',
      'action.copied': '已复制链接',
      'action.noSongs': '《{name}》里没有可播放的歌曲',
      'action.failed': '无法播放：{msg}',
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
      'artist.openInApple': '在 Apple Music 中查看 {name}',
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

      'player.previous': '上一首',
      'player.next': '下一首',
      'player.shuffle': '随机播放',
      'player.repeat.off': '重复播放',
      'player.repeat.all': '重复播放：全部',
      'player.repeat.one': '重复播放：单曲',
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
      'player.queue': '待播清单',
      'player.queueClear': '清除',
      'player.queueEmpty': '没有待播的歌曲。在专辑、歌单或艺人页开始播放后，后续歌曲会列在这里。',
      'player.queueHint': '双击播放，拖动调整顺序（也可按 Alt+↑/↓），Delete 移除',
      'player.queueRemove': '从待播清单移除「{name}」',

      'lyrics.title': '歌词',
      'lyrics.open': '歌词',
      'lyrics.close': '收起歌词',
      'lyrics.translationMenu': '歌词翻译',
      'lyrics.showTranslation': '显示翻译',
      'lyrics.hideTranslation': '隐藏翻译',
      'lyrics.showPronunciation': '显示发音',
      'lyrics.hidePronunciation': '隐藏发音',
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

      'lang.caption': 'Interface',
      'lang.button': 'English',
      'lang.title': '切换到中文',

      'settings.storefront': 'Primary storefront',
      'settings.storefrontHint': 'Used for search and more. Storefronts of the wrapper-lite account give the best experience.',
      'settings.best': 'wrapper-lite storefronts · best experience',
      'settings.outside': 'Not a wrapper-lite storefront: search and browsing work, some content may not play.',
      'settings.selected': 'Selected',
      'settings.favorites': 'Favorites',
      'settings.favorite': 'Add “{name}” to favorites',
      'settings.unfavorite': 'Remove “{name}” from favorites',
      'settings.more': 'More storefronts',
      'settings.less': 'Show less',
      'settings.filter': 'Filter storefronts',
      'settings.noMatch': 'No matching storefronts',
      'settings.ampLang': 'Catalog language',
      'settings.ampLangHint': 'Language of song, album and artist info in {storefront} (as offered by Apple Music).',
      'settings.default': 'Default',
      'settings.loading': 'Loading storefronts…',
      'settings.failed': 'Could not load storefronts.',
      'settings.retry': 'Retry',
      'settings.close': 'Close',

      'status.checking': 'Checking…',
      'status.online': 'Online',
      'status.down': 'Unavailable',
      'status.region': '{count} region',
      'status.regions': '{count} regions',
      'status.more': '{count} more regions',
      'status.expand': 'Show all regions',
      'status.collapse': 'Collapse regions',
      'status.current': 'Current storefront',
      'footer.tagline': 'am-hook · in-browser decryption',
      'footer.note': 'For personal study only',
      'footer.github': 'View on GitHub',
      'footer.thanks': 'Thanks to these open-source projects:',
      'nav.home': 'Home',
      'nav.back': 'Back',
      'nav.menu': 'Menu',
      'nav.label': 'Navigation',

      'home.inputLabel': 'Search, or enter a song / MV link',
      'home.placeholder': 'Search or paste an Apple Music link here',
      'home.submit': 'Parse',
      'home.search': 'Search',
      'home.empty': 'Enter a keyword or a link.',
      'search.results': 'Results for “{term}”',
      'search.top': 'Top Results',
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
      'search.all': 'All',
      'search.seeAll': 'See All',
      'home.example': 'Supported link examples',
      'home.recent': 'Recent Searches',
      'home.removeRecent': 'Remove “{term}”',
      'home.clear': 'Clear',
      'home.invalid': 'Unrecognized input: enter a song, music-video or album link.',
      'home.detectSong': 'Song',
      'home.detectMv': 'MV',
      'home.detectAlbum': 'Album',
      'home.detectPlaylist': 'Playlist',
      'home.detectArtist': 'Artist',
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
      'album.trackFailed': 'Cannot play “{name}”: {msg}',
      'album.noPlayable': '“{name}” has no quality this browser can play directly; open the song page to download it.',
      'album.coverAlt': 'Cover of {title}',
      'action.play': 'Play',
      'action.shuffle': 'Shuffle',
      'action.more': 'More',
      'action.moreFor': 'More · {name}',
      'action.playMv': 'Play music video',
      'action.goAlbum': 'Go to album',
      'action.copySite': 'Copy am-hook link',
      'action.copyApple': 'Copy AM link',
      'action.copied': 'Link copied',
      'action.noSongs': '“{name}” has no playable songs',
      'action.failed': 'Cannot play: {msg}',
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
      'artist.openInApple': 'View {name} on Apple Music',
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

      'player.previous': 'Previous',
      'player.next': 'Next',
      'player.shuffle': 'Shuffle',
      'player.repeat.off': 'Repeat',
      'player.repeat.all': 'Repeat: All',
      'player.repeat.one': 'Repeat: One',
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
      'player.queue': 'Playing Next',
      'player.queueClear': 'Clear',
      'player.queueEmpty': 'Nothing up next. Start playing from an album, playlist or artist page and the following songs show up here.',
      'player.queueHint': 'Double-click to play, drag to reorder (or press Alt+↑/↓), Delete to remove',
      'player.queueRemove': 'Remove “{name}” from Playing Next',

      'lyrics.title': 'Lyrics',
      'lyrics.open': 'Lyrics',
      'lyrics.close': 'Close lyrics',
      'lyrics.translationMenu': 'Lyrics translation',
      'lyrics.showTranslation': 'Show translations',
      'lyrics.hideTranslation': 'Hide translations',
      'lyrics.showPronunciation': 'Show pronunciations',
      'lyrics.hidePronunciation': 'Hide pronunciations',
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

  /* ---------- 主地区与曲库语言 ---------- */

  /**
   * 地区表取自 /amp/v1/storefronts（一次返回全部地区，几乎不变），保存在 localStorage：
   * 有保存的地区表就直接使用，保存超过 STOREFRONTS_TTL 时在后台重新拉取替换（失败时继续用旧的）。
   * 每个地区记为 { name, tags: supportedLanguageTags, default: defaultLanguageTag }。
   */
  const STOREFRONTS_KEY = 'am-hook:storefronts:v3';
  const STOREFRONTS_TTL = 30 * 24 * 3600 * 1000;
  let storefrontsPromise = null;

  async function fetchStorefronts() {
    const map = {};
    // 跟随分页 next（如 /v1/storefronts?offset=25），经 /amp 代理
    for (let path = '/v1/storefronts', page = 0; path && page < 20; page++) {
      const res = await fetch('/amp' + path);
      if (!res.ok) throw new Error(`storefronts ${res.status}`);
      const data = await res.json();
      for (const item of (data && data.data) || []) {
        const a = item && item.attributes;
        if (item.id && a && Array.isArray(a.supportedLanguageTags) && a.supportedLanguageTags.length) {
          map[String(item.id).toLowerCase()] = {
            name: a.name || String(item.id).toUpperCase(),
            tags: a.supportedLanguageTags,
            default: a.defaultLanguageTag || a.supportedLanguageTags[0],
          };
        }
      }
      path = data && data.next;
    }
    if (!Object.keys(map).length) throw new Error('no storefronts');
    return map;
  }

  function refreshStorefronts() {
    return fetchStorefronts().then((map) => {
      try { localStorage.setItem(STOREFRONTS_KEY, JSON.stringify({ at: Date.now(), map })); } catch {}
      return map;
    });
  }

  function storefronts() {
    if (!storefrontsPromise) {
      const cached = readJson(STOREFRONTS_KEY);
      if (cached && cached.map && Object.keys(cached.map).length) {
        storefrontsPromise = Promise.resolve(cached.map);
        if (!(Date.now() - cached.at < STOREFRONTS_TTL)) {
          refreshStorefronts().then((map) => { storefrontsPromise = Promise.resolve(map); }, () => {});
        }
      } else {
        // 失败不缓存，下次调用重试
        storefrontsPromise = refreshStorefronts().catch(() => { storefrontsPromise = null; return null; });
      }
    }
    return storefrontsPromise;
  }

  async function storefrontInfo(cc) {
    if (!/^[a-z]{2}$/i.test(cc || '')) return null;
    const map = await storefronts();
    return (map && map[cc.toLowerCase()]) || null;
  }

  const STOREFRONT_KEY = 'am-hook:storefront';
  const AMP_LANG_KEY = 'am-hook:amp-lang';
  const FAVORITES_KEY = 'am-hook:storefront-favorites';
  /** 没有改过收藏时默认收藏的常用地区 */
  const DEFAULT_FAVORITES = ['us', 'cn', 'jp'];
  const settingsListeners = new Set();
  let regions = [];

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function savedStorefront() {
    let saved = null;
    try { saved = localStorage.getItem(STOREFRONT_KEY); } catch {}
    return /^[a-z]{2}$/.test(saved || '') ? saved : null;
  }
  /** 地区 → 选定的曲库语言（只记录与地区默认语言不同的选择） */
  function ampLangs() {
    const map = readJson(AMP_LANG_KEY);
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }
  const currentStorefront = () => savedStorefront() || regions[0] || 'us';
  const emitSettings = (kind, cc) => settingsListeners.forEach((fn) => fn({ kind, cc }));

  /** wrapper-lite 账号所在地区；没有选择过主地区时主地区随之变化 */
  function setRegions(list) {
    const before = currentStorefront();
    regions = [...new Set((list || []).map((cc) => String(cc).toLowerCase()).filter((cc) => /^[a-z]{2}$/.test(cc)))];
    if (currentStorefront() !== before) emitSettings('storefront', currentStorefront());
  }

  function setStorefront(cc) {
    cc = String(cc || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc) || cc === savedStorefront()) return;
    const before = currentStorefront();
    try { localStorage.setItem(STOREFRONT_KEY, cc); } catch {}
    if (currentStorefront() !== before) emitSettings('storefront', cc);
  }

  /** 收藏的地区（按收藏顺序）；收藏全部取消后为空数组，不再回到默认 */
  function favorites() {
    const list = readJson(FAVORITES_KEY);
    return Array.isArray(list) ? list.filter((cc) => typeof cc === 'string' && /^[a-z]{2}$/.test(cc)) : DEFAULT_FAVORITES.slice();
  }

  function toggleFavorite(cc) {
    cc = String(cc || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) return;
    const list = favorites();
    const next = list.includes(cc) ? list.filter((code) => code !== cc) : [...list, cc];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch {}
    emitSettings('favorites', cc);
  }

  function ampLang(cc) {
    const tag = ampLangs()[String(cc || '').toLowerCase()];
    return typeof tag === 'string' ? tag : null;
  }

  /** tag 为空或为地区默认语言时清除选择（跟随地区默认语言） */
  async function setAmpLang(cc, tag) {
    cc = String(cc || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) return;
    const sf = await storefrontInfo(cc);
    if (!sf) return;
    const next = tag && sf.tags.includes(tag) && tag !== sf.default ? tag : null;
    if (next === ampLang(cc)) return;
    const map = ampLangs();
    if (next) map[cc] = next; else delete map[cc];
    try { localStorage.setItem(AMP_LANG_KEY, JSON.stringify(map)); } catch {}
    emitSettings('ampLang', cc);
  }

  /**
   * amp-api 的 l 参数：选定的曲库语言，否则为地区默认语言（如 cn → zh-Hans-CN）。
   * 地区不支持的语言不会报错，而是静默回退到地区默认语言，所以只在地区的 supportedLanguageTags 里选；
   * 取不到地区信息时为 undefined（不传 l，amp-api 同样使用地区默认语言）。
   */
  async function catalogLang(cc) {
    const sf = await storefrontInfo(cc);
    if (!sf) return undefined;
    const chosen = ampLang(cc);
    return chosen && sf.tags.includes(chosen) ? chosen : sf.default;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-lang-toggle]')) setLang(lang === 'zh' ? 'en' : 'zh');
  });
  // 其他标签页修改设置后同步
  global.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) setLang(e.newValue);
    if (e.key === STOREFRONT_KEY) emitSettings('storefront', currentStorefront());
    if (e.key === AMP_LANG_KEY) emitSettings('ampLang', null);
    if (e.key === FAVORITES_KEY) emitSettings('favorites', null);
  });

  global.AmI18n = {
    t,
    apply,
    setLang,
    toggle: () => setLang(lang === 'zh' ? 'en' : 'zh'),
    /** 返回取消订阅的函数（页面视图卸载时调用） */
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    get lang() { return lang; },
    storefronts,
    setRegions,
    get regions() { return regions.slice(); },
    get storefront() { return currentStorefront(); },
    setStorefront,
    get favorites() { return favorites(); },
    toggleFavorite,
    ampLang,
    setAmpLang,
    catalogLang,
    onSettingsChange: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
