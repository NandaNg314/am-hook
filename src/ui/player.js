/*
 * am-hook 简易在线播放器
 *
 * 播放方式按优先级：
 *   1. MSE：浏览器直接从 Apple CDN 获取 media m3u8 与分段，在 Worker 中用 wasm 解密（decrypt.js）
 *      后逐段喂给 SourceBuffer。只缓冲当前位置之后 ~45s，拖动时直接定位到对应 segment。
 *   2. EC-3 回退：原生 MSE 不可用时，按需加载 ec3.wasm，解码为 5.1/7.1 PCM。
 *   3. 原生 HLS：把服务端解密的 media m3u8 交给 <audio>（其他编码的可选路径）。
 *   4. 直连：<audio src=服务端解密的 media file>，依赖浏览器对 fMP4 的渐进式播放。
 *   3、4 需要服务端以 --hook 启动（item 带 hookM3u8Url / hookFileUrl）。
 */
(function (global) {
  'use strict';

  const AHEAD_SECONDS = 45;
  const BEHIND_SECONDS = 30;

  /** 服务端默认 media m3u8 是每段独立 URL 的通用写法；Safari 原生 HLS 用原始 EXT-X-MAP + BYTERANGE 写法 */
  function byterangeUrl(m3u8Url) {
    return m3u8Url + (m3u8Url.includes('?') ? '&' : '?') + 'hook=byterange';
  }

  /** time 所在 segment 下标 */
  function segmentAt(segments, time) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function mimeFor(codecs) {
    return `audio/mp4; codecs="${codecs || 'mp4a.40.2'}"`;
  }

  // 运行时确认播放失败的编码（检测结果不可靠时以实际结果为准）
  const failedCodecs = new Set();

  /**
   * 该编码在当前浏览器中可尝试的播放方式（按优先级），空数组表示不支持。
   * 注意：canPlayType('application/vnd.apple.mpegurl') 只说明浏览器能播 HLS，
   * 不代表能解码其中的编码（新版 Chrome/Edge 原生支持 HLS 但不支持 ALAC），
   * 所以 HLS / 直连都必须同时通过编码检测。EC-3 单独按 MSE -> PCM 检测，
   * 两种方式都由浏览器端解密，不依赖 --hook。
   */
  function detectModes(codecs, audio, hook) {
    if (failedCodecs.has(codecs)) return [];
    const mime = mimeFor(codecs);
    const modes = [];
    const decrypt = global.AmDecrypt && global.AmDecrypt.supported();
    const MS = global.ManagedMediaSource || global.MediaSource;
    if (MS && MS.isTypeSupported && MS.isTypeSupported(mime) && decrypt) modes.push('mse');
    if (/^(ec-3|ec3)$/i.test(String(codecs))) {
      if (decrypt && global.Worker && global.WebAssembly &&
          (global.AudioContext || global.webkitAudioContext)) modes.push('ec3');
      return modes;
    }
    if (hook && audio && audio.canPlayType(mime) !== '') {
      if (audio.canPlayType('application/vnd.apple.mpegurl') !== '') modes.push('hls');
      modes.push('direct');
    }
    if (String(codecs).toLowerCase() === 'alac' && MS && MS.isTypeSupported &&
        MS.isTypeSupported(mimeFor('flac')) && global.Worker && decrypt) modes.push('flac');
    return modes;
  }

  /** hook：服务端是否以 --hook 启动（决定能否使用原生 HLS / 直连） */
  function detectMode(codecs, audio, hook) {
    return detectModes(codecs, audio, hook)[0] || null;
  }

  /** 界面文案（i18n.js）；未加载时直接返回 key */
  function t(key, vars) {
    return global.AmI18n ? global.AmI18n.t(key, vars) : key;
  }

  /** 不能在浏览器内播放时给用户的建议 */
  function fallbackHint(item) {
    return t(item && item.hookM3u8Url ? 'player.hintExternal' : 'player.hintDownload');
  }

  function modeLabel(mode) {
    return mode === 'direct' ? t('player.direct') : mode === 'ec3' ? t('player.pcmMode') : mode.toUpperCase();
  }

  /* ---------- 播放队列的曲目：逐首解析 master，选浏览器能播放的最高音质 ---------- */
  function rankVariant(v) {
    const g = v.group_id.toLowerCase();
    return g.includes('alac') ? 0 : g.includes('atmos') ? 1 : g.includes('he-') ? 3 : 2;
  }

  function variantLabel(v) {
    const g = v.group_id.toLowerCase();
    if (g.includes('alac')) {
      const spec = [v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ');
      return `ALAC${spec ? ' · ' + spec : ''}`;
    }
    if (g.includes('atmos')) return 'Dolby Atmos';
    const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
    return `${g.includes('he-') ? 'HE-AAC' : 'AAC'}${kbps ? ' · ' + kbps + ' kbps' : ''}`;
  }

  let probe = null;

  /**
   * 艺人行（如「KAROL G, Judeline & rusowsky」）中每位艺人的名字链接到其艺人页，分隔符保持原样；
   * 名字对不上（如译名不同）而只有一位艺人时，整行链接到该艺人。artists: [{ name, href }]
   */
  function artistNodes(text, artists, doc = global.document) {
    const named = (artists || []).filter((a) => a && a.name && a.href).sort((a, b) => b.name.length - a.name.length);
    const link = (artist, label = artist.name) => Object.assign(doc.createElement('a'), { href: artist.href, textContent: label });
    const word = /[\p{L}\p{N}]/u;
    const nodes = [];
    let plain = '';
    let linked = false;
    for (let i = 0; i < text.length;) {
      // 名字前后不能紧挨字母或数字，避免把长名字里的一段当成另一位艺人
      const hit = (i === 0 || !word.test(text[i - 1])) && named.find((a) => text.startsWith(a.name, i)
        && !word.test(text[i + a.name.length] || ''));
      if (hit) {
        if (plain) nodes.push(plain);
        plain = '';
        nodes.push(link(hit));
        i += hit.name.length;
        linked = true;
      } else plain += text[i++];
    }
    if (plain) nodes.push(plain);
    if (text && !linked && named.length === 1) return [link(named[0], text)];
    return nodes;
  }

  /**
   * 音质标签：ALAC 高于 48 kHz 为 Hi-Res Lossless，其余 ALAC 为 Lossless；杜比全景声为 Dolby Atmos，
   * 其双耳渲染版本为 Spatial Audio；AAC、HE-AAC 与全景声的立体声缩混为 AAC
   */
  function qualityBadge(v) {
    const g = ((v && v.group_id) || '').toLowerCase();
    if (!g) return '';
    if (g.includes('alac')) return v.sample_rate > 48000 ? 'hires' : 'lossless';
    if (g.includes('atmos') && !g.includes('downmix')) return g.includes('binaural') ? 'spatial' : 'atmos';
    return 'lossy';
  }

  /** Apple Music 的音质标志（图标与文字一体），取自 gitlab.com/itouakirai/ame 的 src/applemusic/assets/badges */
  const QUALITY_BADGES = {
    hires: { label: 'Hi-Res Lossless', svg: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20"><path d="M9.21 3.13c.131.166.249.344.35.53a7.554 7.554 0 0 0-.49.94c-.1-.2-.2-.4-.31-.59.134-.301.284-.595.45-.88ZM7.64 7.82c.08.25.17.51.25.77-.15.76-.25 1.46-.32 2a.204.204 0 0 1-.065.129.202.202 0 0 1-.135.051.21.21 0 0 1-.18-.23c.1-.75.25-1.72.45-2.72Zm-2-4.69c.135.166.255.343.36.53a19.651 19.651 0 0 0-2 7 .204.204 0 0 1-.065.129.202.202 0 0 1-.135.051.21.21 0 0 1-.18-.23c.29-2.12.8-5.43 2.01-7.48Zm13.23 4.92a.192.192 0 0 1 .159.118.187.187 0 0 1 .011.102C19 9.07 18.8 10 18.6 11l-.25-.77c.14-.76.25-1.46.32-2a.204.204 0 0 1 .065-.129.202.202 0 0 1 .135-.051Zm3.58 0a.206.206 0 0 1 .164.117c.014.032.02.068.016.103-.32 2.09-.83 5.4-2 7.45a5.451 5.451 0 0 1-.35-.53 19.87 19.87 0 0 0 2-7 .21.21 0 0 1 .064-.096.204.204 0 0 1 .106-.044Zm-5.28 6.21.3.59a7.082 7.082 0 0 1-.44.88 4.454 4.454 0 0 1-.35-.53c.179-.305.343-.618.49-.94Zm-8.64-13a2.895 2.895 0 0 1 1.75.62 4.1 4.1 0 0 1 .54.48c2.71 2.79 3.86 10.16 5.68 13.14.085.153.185.297.3.43a1.81 1.81 0 0 0 1.38.88c.19-.002.377-.043.55-.12.175.189.366.363.57.52a3 3 0 0 1-1.59.44A2.861 2.861 0 0 1 16 17a5.34 5.34 0 0 1-.55-.48c-2.7-2.8-3.85-10.16-5.67-13.14-.55-.9-1.26-1.58-2.23-1.19a4.765 4.765 0 0 0-.57-.53 3.003 3.003 0 0 1 1.55-.43Zm-4.06 0c6-.81 6.42 15.51 10.13 15.51.19-.002.377-.043.55-.12.173.192.363.366.57.52-.48.289-1.03.442-1.59.44C10.88 17.62 9.26 11.88 8 8c-.08-.26-.17-.51-.25-.76a19.99 19.99 0 0 0-1.6-3.87 4.491 4.491 0 0 0-.37-.53 1.53 1.53 0 0 0-2.36-.38C1.55 3.82.68 8.33.41 10.62a.211.211 0 0 1-.21.18.211.211 0 0 1-.2-.22C.41 8 1.08 3.57 3 1.92a2.878 2.878 0 0 1 1.47-.65Zm7.64 0c3.25 0 4.86 5.75 6.12 9.61.08.26.17.51.25.76a19.99 19.99 0 0 0 1.6 3.87c.111.18.231.353.36.52a1.743 1.743 0 0 0 1.32.79 1.817 1.817 0 0 0 1-.4c1.87-1.35 2.74-5.85 3-8.14a.195.195 0 0 1 .068-.122.196.196 0 0 1 .132-.048.206.206 0 0 1 .164.117c.014.032.02.068.016.103-.41 2.59-1.08 7-3 8.66a3 3 0 0 1-1.93.69c-5.43 0-6.07-15.54-9.65-15.54-.19.002-.377.043-.55.12a4.765 4.765 0 0 0-.57-.53 3 3 0 0 1 1.67-.49ZM36.59 1a.6.6 0 1 1-.021 1.2.6.6 0 0 1 .021-1.2Zm7.81 1.31H43v2.28h1.44a1.07 1.07 0 0 0 1.21-1.14 1.097 1.097 0 0 0-.623-1.042 1.094 1.094 0 0 0-.627-.098Zm5 1.43A1.259 1.259 0 0 0 48.1 5h2.45a1.19 1.19 0 0 0-1.19-1.26Zm-8.42 1.1v.88H38v-.88Zm3.6-3.36a1.915 1.915 0 0 1 1.865.94c.186.321.275.69.255 1.06a1.826 1.826 0 0 1-1.24 1.82l1.44 2.6h-1.19L44.4 5.4H43v2.45h-1V1.48Zm-7.52 1.57v4.8h-1v-4.8Zm-6.29-1.57v2.69h3.29V1.48h1v6.37h-1V5h-3.29v2.85h-1V1.48ZM49.36 3a2.118 2.118 0 0 1 2.16 2.42v.33H48.1a1.305 1.305 0 0 0 .608 1.224c.204.127.441.195.682.196a1.153 1.153 0 0 0 1.15-.6h.92A1.998 1.998 0 0 1 49.36 8a2.193 2.193 0 0 1-2.041-1.254 2.193 2.193 0 0 1-.189-1.236 2.214 2.214 0 0 1 1.024-2.173c.362-.225.78-.343 1.206-.337ZM54 3c1.09 0 1.8.51 1.89 1.34H55a.902.902 0 0 0-1-.6c-.53 0-.94.27-.94.65s.25.49.77.61l.8.19c.92.21 1.36.6 1.36 1.3 0 .89-.85 1.5-2 1.5s-1.9-.52-2-1.35h1a1.004 1.004 0 0 0 1 .6c.6 0 1-.27 1-.66s-.23-.5-.71-.61l-.84-.2c-.92-.21-1.35-.62-1.35-1.33 0-.71.8-1.44 1.91-1.44Zm-2 10.79a1.247 1.247 0 0 0-1.096.64 1.245 1.245 0 0 0-.154.64h2.44A1.18 1.18 0 0 0 52 13.79Zm-15.75 0c-.83 0-1.29.62-1.29 1.69 0 1.07.46 1.68 1.29 1.68.83 0 1.3-.62 1.3-1.68s-.44-1.66-1.27-1.66Zm12.79-2.6v6.69h-1v-6.66Zm-18.3.31v5.52h3v.86h-4v-6.35ZM45.39 13c1.08 0 1.8.51 1.89 1.34h-.92c-.09-.36-.43-.59-1-.59-.57 0-.94.26-.94.65s.24.48.77.6l.8.19c.92.21 1.35.6 1.35 1.3 0 .89-.85 1.5-2 1.5s-1.91-.52-2-1.35h1a1.003 1.003 0 0 0 1 .61c.59 0 1-.28 1-.67s-.23-.49-.71-.61l-.85-.2c-.92-.21-1.35-.62-1.35-1.33 0-.71.86-1.44 1.96-1.44ZM41 13c1.09 0 1.8.51 1.9 1.34H42c-.09-.36-.43-.59-1-.59-.57 0-.93.26-.93.65s.24.48.76.6l.81.19c.92.21 1.35.6 1.35 1.3 0 .89-.85 1.5-2 1.5s-1.91-.52-2-1.35H40a.995.995 0 0 0 1.06.61c.59 0 1-.28 1-.67s-.23-.49-.72-.61l-.84-.2c-.92-.21-1.35-.62-1.35-1.33 0-.71.78-1.44 1.85-1.44Zm15.63 0c1.09 0 1.8.51 1.9 1.34h-.92c-.09-.36-.44-.59-1-.59s-.94.26-.94.65.25.48.77.6l.81.19c.92.21 1.35.6 1.35 1.3 0 .89-.85 1.5-2 1.5s-1.9-.52-2-1.35h1a.995.995 0 0 0 1.06.61c.59 0 1-.28 1-.67s-.21-.48-.66-.58l-.84-.2c-.92-.21-1.35-.62-1.35-1.33 0-.71.75-1.47 1.84-1.47ZM61 13c1.09 0 1.8.51 1.9 1.34H62c-.09-.36-.43-.59-1-.59-.57 0-.93.26-.93.65s.24.48.76.6l.81.19c.92.21 1.35.6 1.35 1.3 0 .89-.85 1.5-2 1.5s-1.91-.52-2-1.35h1a.995.995 0 0 0 1.06.61c.59 0 1-.28 1-.67s-.23-.49-.72-.61l-.84-.2c-.92-.21-1.35-.62-1.35-1.33 0-.71.78-1.44 1.86-1.44Zm-24.72 0a2.23 2.23 0 0 1 2.29 2.5 2.294 2.294 0 0 1-1.549 2.32A2.29 2.29 0 0 1 34 15.5a2.217 2.217 0 0 1 2.28-2.5ZM52 13a2.118 2.118 0 0 1 2.16 2.42v.33h-3.38a1.29 1.29 0 0 0 1.28 1.42 1.158 1.158 0 0 0 1.16-.6h.92A2.002 2.002 0 0 1 52 18a2.194 2.194 0 0 1-2.046-1.246 2.185 2.185 0 0 1-.194-1.234A2.232 2.232 0 0 1 52 13Z" fill-rule="evenodd" /></svg>' },
    lossless: { label: 'Lossless', svg: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20"><path d="M9.21 3.13c.131.166.249.344.35.53a7.554 7.554 0 0 0-.49.94c-.1-.2-.2-.4-.31-.59.134-.301.284-.595.45-.88ZM7.64 7.82c.08.25.17.51.25.77-.15.76-.25 1.46-.32 2a.204.204 0 0 1-.065.129.202.202 0 0 1-.135.051.21.21 0 0 1-.18-.23c.1-.75.25-1.72.45-2.72Zm-2-4.69c.135.166.255.343.36.53a19.651 19.651 0 0 0-2 7 .204.204 0 0 1-.065.129.202.202 0 0 1-.135.051.21.21 0 0 1-.18-.23c.29-2.12.8-5.43 2.01-7.48Zm13.23 4.92a.192.192 0 0 1 .159.118.187.187 0 0 1 .011.102C19 9.07 18.8 10 18.6 11l-.25-.77c.14-.76.25-1.46.32-2a.204.204 0 0 1 .065-.129.202.202 0 0 1 .135-.051Zm3.58 0a.206.206 0 0 1 .164.117c.014.032.02.068.016.103-.32 2.09-.83 5.4-2 7.45a5.451 5.451 0 0 1-.35-.53 19.87 19.87 0 0 0 2-7 .21.21 0 0 1 .064-.096.204.204 0 0 1 .106-.044Zm-5.28 6.21.3.59a7.082 7.082 0 0 1-.44.88 4.454 4.454 0 0 1-.35-.53c.179-.305.343-.618.49-.94Zm-8.64-13a2.895 2.895 0 0 1 1.75.62 4.1 4.1 0 0 1 .54.48c2.71 2.79 3.86 10.16 5.68 13.14.085.153.185.297.3.43a1.81 1.81 0 0 0 1.38.88c.19-.002.377-.043.55-.12.175.189.366.363.57.52a3 3 0 0 1-1.59.44A2.861 2.861 0 0 1 16 17a5.34 5.34 0 0 1-.55-.48c-2.7-2.8-3.85-10.16-5.67-13.14-.55-.9-1.26-1.58-2.23-1.19a4.765 4.765 0 0 0-.57-.53 3.003 3.003 0 0 1 1.55-.43Zm-4.06 0c6-.81 6.42 15.51 10.13 15.51.19-.002.377-.043.55-.12.173.192.363.366.57.52-.48.289-1.03.442-1.59.44C10.88 17.62 9.26 11.88 8 8c-.08-.26-.17-.51-.25-.76a19.99 19.99 0 0 0-1.6-3.87 4.491 4.491 0 0 0-.37-.53 1.53 1.53 0 0 0-2.36-.38C1.55 3.82.68 8.33.41 10.62a.211.211 0 0 1-.21.18.211.211 0 0 1-.2-.22C.41 8 1.08 3.57 3 1.92a2.878 2.878 0 0 1 1.47-.65Zm7.64 0c3.25 0 4.86 5.75 6.12 9.61.08.26.17.51.25.76a19.99 19.99 0 0 0 1.6 3.87c.111.18.231.353.36.52a1.743 1.743 0 0 0 1.32.79 1.817 1.817 0 0 0 1-.4c1.87-1.35 2.74-5.85 3-8.14a.195.195 0 0 1 .068-.122.196.196 0 0 1 .132-.048.206.206 0 0 1 .164.117c.014.032.02.068.016.103-.41 2.59-1.08 7-3 8.66a3 3 0 0 1-1.93.69c-5.43 0-6.07-15.54-9.65-15.54-.19.002-.377.043-.55.12a4.765 4.765 0 0 0-.57-.53 3 3 0 0 1 1.67-.49ZM52.68 8.17a1.313 1.313 0 0 0-1.3 1.34h2.53a1.233 1.233 0 0 0-1.23-1.34Zm-16.25 0c-.86 0-1.34.64-1.34 1.75 0 1.11.48 1.74 1.34 1.74.86 0 1.34-.64 1.34-1.74s-.49-1.71-1.34-1.71Zm13.19-2.65v6.93h-1V5.52Zm-18.88.31v5.72h3.1v.9h-4.13V5.83ZM62 7.37c1.12 0 1.86.52 1.95 1.39H63a.93.93 0 0 0-1-.62c-.55 0-1 .27-1 .68 0 .41.25.5.79.62l.83.2c.95.22 1.4.63 1.4 1.35 0 .93-.88 1.55-2.07 1.55s-2-.53-2-1.4h1c.082.212.233.39.429.505.197.114.426.158.651.125.62 0 1-.28 1-.69 0-.41-.23-.51-.73-.63l-.87-.21C60.45 10 60 9.6 60 8.86c0-.74.82-1.49 2-1.49Zm-4.5 0c1.12 0 1.86.52 1.95 1.39h-.94a.938.938 0 0 0-1-.62c-.55 0-1 .27-1 .68 0 .41.25.5.79.62l.83.2c.95.22 1.4.63 1.4 1.35 0 .93-.88 1.55-2.07 1.55s-2-.53-2-1.4h1c.082.212.233.39.429.505.197.114.426.158.651.125.62 0 1-.28 1-.69 0-.41-.23-.51-.73-.63l-.87-.21C56 10 55.51 9.6 55.51 8.86c0-.74.81-1.49 1.94-1.49Zm-4.77 0c1.39 0 2.23 1 2.23 2.51v.34h-3.58a1.34 1.34 0 0 0 1.33 1.47 1.178 1.178 0 0 0 1.19-.63h1a2.003 2.003 0 0 1-2.16 1.43A2.26 2.26 0 0 1 50.38 10a2.3 2.3 0 0 1 2.3-2.63Zm-6.86 0c1.12 0 1.86.52 2 1.39h-.94a.93.93 0 0 0-1-.62c-.55 0-1 .27-1 .68 0 .41.26.5.8.62l.83.2c1 .22 1.39.63 1.39 1.35 0 .93-.88 1.55-2.07 1.55s-2-.53-2-1.4h1c.12.39.49.63 1.09.63.6 0 1.05-.28 1.05-.69 0-.41-.24-.51-.74-.63l-.87-.21c-1-.22-1.39-.64-1.39-1.38 0-.74.67-1.49 1.8-1.49Zm-9.39 0a2.292 2.292 0 0 1 2.3 2.63 2.357 2.357 0 0 1-1.597 2.388 2.356 2.356 0 0 1-2.72-.923A2.357 2.357 0 0 1 34.07 10a2.295 2.295 0 0 1 1.076-2.299c.386-.235.833-.35 1.284-.331Zm4.89 0c1.12 0 1.86.52 2 1.39h-.94a.93.93 0 0 0-1-.62c-.55 0-1 .27-1 .68 0 .41.25.5.8.62l.83.2c1 .22 1.39.63 1.39 1.35 0 .93-.88 1.55-2.07 1.55s-2-.53-2-1.4h1c.082.212.233.39.429.505.197.114.426.158.651.125.62 0 1-.28 1-.69 0-.41-.23-.51-.73-.63l-.87-.21c-1-.22-1.39-.64-1.39-1.38 0-.74.72-1.49 1.85-1.49Z" fill-rule="evenodd" /></svg>' },
    atmos: { label: 'Dolby Atmos', svg: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 43 20"><path d="m11.418 12.526 2.344 5.44h-1.107l-.507-1.245H9.79l-.492 1.245H8.215l2.366-5.44h.837Zm6.521 0v.845h-1.668v4.595h-.968v-4.595h-1.667v-.845h4.303Zm2.721 0 1.413 3.865h.023l1.398-3.865h1.522v5.44h-.961v-4.372h-.015l-1.652 4.372h-.676l-1.628-4.372h-.016v4.372h-.922v-5.44h1.514Zm8.281.001c.405 0 .778.063 1.119.189.341.127.636.308.885.542.248.233.442.517.581.851.139.334.208.708.208 1.122 0 .405-.069.774-.208 1.108a2.57 2.57 0 0 1-.581.863 2.652 2.652 0 0 1-.885.563 3.034 3.034 0 0 1-1.119.201c-.399 0-.769-.067-1.107-.201a2.61 2.61 0 0 1-.878-.563 2.59 2.59 0 0 1-.577-.863 2.855 2.855 0 0 1-.208-1.108c0-.414.069-.788.208-1.122a2.453 2.453 0 0 1 1.455-1.393 3.15 3.15 0 0 1 1.107-.189Zm5.722.008c.262 0 .528.046.798.138.27.093.504.231.703.416l-.597.656a1.118 1.118 0 0 0-.412-.317 1.232 1.232 0 0 0-.857-.088.972.972 0 0 0-.291.124.682.682 0 0 0-.215.219.601.601 0 0 0-.084.324.576.576 0 0 0 .273.51c.085.059.189.11.31.153.122.044.255.088.401.132.165.053.337.114.514.182.177.068.34.158.488.269.148.112.27.253.365.423.094.17.142.382.142.634 0 .277-.051.519-.153.725a1.483 1.483 0 0 1-.409.514 1.74 1.74 0 0 1-.597.306 2.52 2.52 0 0 1-.722.102 2.71 2.71 0 0 1-.984-.186 1.895 1.895 0 0 1-.787-.55l.656-.612c.126.175.295.313.507.415.211.102.419.153.623.153.107 0 .216-.013.328-.04a.86.86 0 0 0 .302-.134.774.774 0 0 0 .219-.237.687.687 0 0 0 .084-.354.577.577 0 0 0-.095-.339.847.847 0 0 0-.255-.233 1.778 1.778 0 0 0-.379-.171l-.459-.153a4.663 4.663 0 0 1-.467-.175 1.55 1.55 0 0 1-.419-.27 1.29 1.29 0 0 1-.302-.412 1.4 1.4 0 0 1-.117-.608c0-.263.055-.489.164-.678.109-.189.253-.346.43-.47.178-.124.379-.216.605-.277.226-.061.456-.091.689-.091Zm-5.714.876a1.62 1.62 0 0 0-1.238.527c-.15.164-.266.356-.348.576-.082.221-.123.46-.123.718 0 .267.041.512.123.734.082.223.199.417.352.581.152.164.332.291.541.383.209.091.44.137.693.137.253 0 .485-.046.696-.137a1.61 1.61 0 0 0 .545-.383c.152-.164.269-.358.351-.581.082-.222.124-.467.124-.734 0-.258-.042-.497-.124-.718a1.763 1.763 0 0 0-.347-.576 1.627 1.627 0 0 0-.542-.387 1.707 1.707 0 0 0-.703-.14Zm-17.976.268-.853 2.212h1.69l-.837-2.212ZM38.017 3.527l1.55 3.484 1.549-3.484h1.3l-3.081 6.884a1.542 1.542 0 0 1-2.031.782l-.412-.184-.002-.001.148-.331.332-.747.171.076a.634.634 0 0 0 .837-.322l.003-.008.476-1.075.016-.035.044-.096-2.199-4.943h1.299ZM30.294 1.11v7.855h-1.189V1.11h1.189Zm2.192.001v2.905c.44-.308.976-.49 1.554-.49a2.722 2.722 0 0 1 2.719 2.719 2.722 2.722 0 0 1-2.719 2.718 2.702 2.702 0 0 1-1.554-.49v.492h-1.192V1.111h1.192Zm-6.869 2.415a2.72 2.72 0 0 1 2.718 2.718 2.72 2.72 0 0 1-2.718 2.719 2.721 2.721 0 0 1-2.719-2.719 2.72 2.72 0 0 1 2.719-2.718ZM3.157 1.109A3.93 3.93 0 0 1 7.08 5.032a3.93 3.93 0 0 1-3.923 3.923H2V1.109h1.157Zm10.005 0v7.846h-1.157a3.93 3.93 0 0 1-3.924-3.923 3.93 3.93 0 0 1 3.924-3.923h1.157Zm5.21 0a3.928 3.928 0 0 1 3.923 3.923 3.928 3.928 0 0 1-3.923 3.923h-2.834V1.109Zm7.245 3.486a1.64 1.64 0 0 0 0 3.278 1.64 1.64 0 0 0 1.639-1.639c0-.899-.74-1.639-1.639-1.639Zm8.423 0a1.64 1.64 0 0 0 0 3.279c.9 0 1.639-.73 1.639-1.639 0-.9-.739-1.64-1.639-1.64ZM18.372 2.299h-1.645v5.467h1.645a2.738 2.738 0 0 0 2.733-2.734 2.737 2.737 0 0 0-2.733-2.733Z" stroke="#00000000" fill-rule="evenodd" /></svg>' },
    spatial: { label: 'Spatial Audio', svg: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1869 900"><path d="M508.4 55.6c13.5 13.9 1 29.8-29.9 38.1-9.3 2.5-11.4 2.7-31.5 2.7-22.9.1-31.2-1.1-45.2-6.4-20.6-7.7-28.6-22.4-18.4-33.9l2.1-2.4-3.4 1.9c-7.8 4.3-14.1 12.8-14.1 18.9 0 13.3 21 26.1 50.7 30.9 38.1 6.1 80.1-.7 99-16 4.7-3.8 8.3-10.5 8.3-15.3 0-7-6.7-14.9-16.9-20.1l-4.4-2.2 3.7 3.8z" /><path d="M353.3 79.9c-20.1 9.6-31.3 22.3-31.3 35.8 0 23.7 33.9 43.1 89.5 51.5 11.9 1.7 61.9 1.7 73 0 26.8-4.3 47-10.1 61.2-17.7 19.7-10.4 28.6-21.1 28.5-34.1-.1-9.5-4.4-16.7-15.4-25.7-4.8-3.9-13.3-8.8-19.3-11.2l-4-1.6 3 2.3c11.8 9 17 16.9 16.9 26.3 0 7.9-2.3 12.5-9.9 20-13 13-39.9 22.9-71.4 26.5-12.1 1.4-40.1 1.4-52.2 0-31.5-3.6-58.3-13.5-71.4-26.5-7.6-7.5-9.9-12.1-9.9-20-.1-9.4 5.3-17.7 16.9-26.2 4-3 3.2-2.9-4.2.6zM1053.5 181c-29.2 3.1-51.5 19.4-57.5 41.9-1.8 6.9-1.4 21.6.8 28.8 6.7 21.5 23.1 31.9 64.3 40.8 26.1 5.7 33.8 8.6 41.7 15.8 6.2 5.8 8.2 10.4 8.2 19.7 0 21-16.9 33.3-46 33.3-27.5-.1-44.9-10.2-49.9-29.1l-1.2-4.2H990v3.2c0 1.8.7 5.8 1.5 8.8 5.3 20.1 21.3 34.6 45.6 41.2 7.3 2 10.8 2.3 26.4 2.3 21.3 0 28-1.3 42.5-8.2 20.5-9.8 30.3-25.9 30.2-49.3-.1-15.7-4.5-26.5-14.8-35.9-10.2-9.4-23.1-14.2-60.3-22.6-23.2-5.2-33.6-10.8-38.5-20.7-2.9-5.8-3.5-14.8-1.5-20.9 1.8-5.1 6.3-10.8 11.6-14.6 13.3-9.4 39.5-10.8 55.8-2.9 9.5 4.7 17.6 15.1 19.1 24.5l.7 4.1h12.3c14.3 0 13.6.7 10.9-10.9-4.7-19.8-21.6-36.3-43.5-42.5-5.4-1.5-21.5-3.7-25.5-3.5-1.1.1-5.1.5-9 .9zM1740 282.5V381h23V184h-23v98.5zM1547.1 186.7c-10.7 5.6-10.6 21 .2 26.2 2.4 1.2 5.3 2.1 6.5 2.1 6.4 0 13.6-6.2 14.8-12.6.9-4.8-1.9-11.8-5.8-14.5-4.2-3-11.3-3.5-15.7-1.2zM1463 219.5V239h-21v18.9l10.3.3 10.2.3.5 50c.5 48 .6 50.2 2.6 55.1 3.3 8 6.9 12.1 13.8 15.4 7.6 3.7 17.8 5.4 27.4 4.5l7.2-.7v-18.5l-8.5-.5c-9.5-.5-12.5-2-16-7.9-1.9-3.3-2-5.2-2-50.4v-47l13.3-.3 13.2-.3V239h-27v-39h-24v19.5zM766.7 226.5c-23.5 6.1-34.1 50.8-25.2 106.5 5.9 36.8 20 75.1 37.6 102 7 10.7 22.8 27.1 30.1 31.3 9.9 5.7 19.9 6.7 27.8 2.7 10.6-5.4 19.8-23 22.4-43l.6-4.5-2 5.3c-5.7 15.6-14.7 23.5-26.6 23.6-23.2 0-51.2-35.7-65.8-83.7-7-23.3-9.8-41.6-9.9-64.2 0-25.6 5.1-44 15-53.9 5.7-5.7 8.8-7 16.8-7.1 8.1 0 14.6 2.8 23 9.8 5.8 4.9 5.2 3.5-2.4-5.2-13.7-15.7-28.9-22.9-41.4-19.6zM109.2 229.5c-7.2 3.6-18.5 13.3-24.4 20.8-1.8 2.3-2.6 3.7-1.8 3.1.8-.6 3.6-2.7 6.2-4.7 8.9-6.7 18.5-9 27.3-6.6 5.3 1.4 13.5 9.9 17 17.5 8.5 18.6 9.9 51.9 3.5 83.4-9.4 46.1-31.2 86.5-54.8 101.8-17.8 11.5-33.7 5.7-42.8-15.6l-2.5-5.7.7 4.5c2.4 17.8 10.5 34.1 19.7 39.5 13.4 7.8 27.3 3.7 44.3-13.1C133.2 423 158 353.3 158 295.8c0-29.5-5.7-51-16.4-61.8-6.1-6.2-10.3-8-18.4-8-5.9 0-8 .5-14 3.5zM1222 236.7c-13.5 2.3-27.5 11.4-33.8 22.3l-2.7 4.5-.3-12.3-.3-12.2H1161v190h24v-72.2l4.4 5.9c10.3 14 23.9 20.7 42.1 20.7 27.7 0 48.4-17.1 56.7-47 1.9-6.8 2.2-10.5 2.2-26.4.1-16.4-.2-19.4-2.2-26.5-7.3-25.4-22.9-41.4-44.7-46-6.6-1.4-16-1.7-21.5-.8zm14.5 21.8c17.9 4.6 29 21.7 30.2 47 1.5 31.2-11.4 52.7-34 56.5-20.8 3.6-38.9-9.8-45.3-33.3-.8-2.9-1.7-9.5-2-14.7-2.2-37.6 21.3-63.1 51.1-55.5zM1360.5 236.6c-23.5 3.8-39.1 16.2-44 34.9-2.3 9-2.9 8.5 10 8.5h11.4l1.3-4.3c.8-2.7 3-6 6.3-9.3 6.6-6.6 12.7-8.8 25-8.9 11.5 0 17.9 2.1 23.9 8 5.5 5.3 7.6 11.6 7.6 23.2 0 7.9-.1 8.3-2.2 8.3-11 .1-48.9 3.2-54.1 4.4-15.4 3.6-26.8 11.4-32.3 22.3-2.7 5.4-2.9 6.6-2.9 17.3 0 10.8.2 11.9 3.1 18 3.9 8.2 7.5 12.4 14 16.6 8.5 5.5 16.5 7.7 27.9 7.8 17.7.2 32-6.4 41.8-19.3l4.7-6.2V381h24v-50.8c0-32.5-.4-53-1.1-56.8-4.1-22.5-22.7-36.1-50.4-36.9-6-.2-12.3-.1-14 .1zm41.3 88.7c-.3 9.2-.7 11-3.6 17-6.8 13.8-21.5 21.6-38.7 20.5-14.2-.9-23.8-8.4-25.1-19.4-.8-6.3.8-11.4 4.9-16 6.3-7.3 13-9 41.2-10.8 11-.7 20.4-1.4 20.9-1.5.4 0 .7 4.5.4 10.2zM1642.5 236.6c-23.5 3.8-39.1 16.2-44 34.9-2.3 9-2.9 8.5 10 8.5h11.4l1.3-4.3c.8-2.7 3-6 6.3-9.3 6.6-6.6 12.7-8.8 25-8.9 11.5 0 17.9 2.1 23.9 8 5.5 5.3 7.6 11.6 7.6 23.2 0 7.9-.1 8.3-2.2 8.3-11 .1-48.9 3.2-54.1 4.4-15.4 3.6-26.8 11.4-32.3 22.3-2.7 5.4-2.9 6.6-2.9 17.3 0 10.8.2 11.9 3.1 18 3.9 8.2 7.5 12.4 14 16.6 8.5 5.5 16.5 7.7 27.9 7.8 17.7.2 32-6.4 41.8-19.3l4.7-6.2V381h24v-50.8c0-32.5-.4-53-1.1-56.8-4.1-22.5-22.7-36.1-50.4-36.9-6-.2-12.3-.1-14 .1zm41.3 88.7c-.3 9.2-.7 11-3.6 17-6.8 13.8-21.5 21.6-38.7 20.5-14.2-.9-23.8-8.4-25.1-19.4-.8-6.3.8-11.4 4.9-16 6.3-7.3 13-9 41.2-10.8 11-.7 20.4-1.4 20.9-1.5.4 0 .7 4.5.4 10.2zM1542 310v71h24V239h-24v71z" /><path d="M65.5 263.9c-3.8 1.7-15 10.9-14.2 11.7.2.2 2.1-.5 4.2-1.6 12.6-6.4 23.5 2.7 27 22.6 1.8 10.2 1.8 15.8 0 29.7-3.6 27.5-14.5 52.8-28.9 67.3-11.8 11.8-21.3 13.2-29 4.2l-3.5-4.1.9 3.2c8.7 30.5 35.2 22.1 54.8-17.5 15-30.1 21.6-68.7 16.1-94.4-4-18.9-14.4-26.9-27.4-21.1zM816.2 263.7c-4.4 2.1-8.8 8.5-11.4 16.3-1.7 5.2-2.2 9.7-2.6 22.6-.3 14.2-.1 17.8 2.2 30 5.1 27.8 15.3 51.9 28.9 68.5 15.5 18.7 31.4 19.1 39.4 1.1 3.1-7.1 2.9-8-1-3.9-17.2 18.3-45.7-13.8-56.3-63.3-2.8-13-2.6-36.2.3-45.5 3.5-11 10.2-17.5 18.1-17.5 1.6 0 4.9 1.1 7.5 2.3 4.1 2.1 4.4 2.2 3.3.5-2.3-3.3-9.3-8.8-13.8-10.8-5.2-2.4-10.2-2.5-14.6-.3zM430 290.1c-80.7 10-144.1 73-153.6 152.9-1.8 15.1-1.7 26.3.1 40.7 10.3 79.2 72.3 141.5 151.2 151.8 85.1 11.2 168.7-45.9 189.9-129.5 20.2-80-17.5-161.3-92.1-198.5-16.1-8-31.2-13.1-47.5-16-11.3-1.9-37.5-2.8-48-1.4zm29.6 76c13.9 2.5 29 13.2 37.4 26.4 14.4 22.9 13.1 55.4-3.2 77-6.5 8.5-17.1 16.4-26.5 19.7-9.7 3.3-25.9 3.3-35.5 0-23.3-8-39-30.1-40.5-57.3-1.7-29.7 16-56.6 42.7-64.7 7.6-2.3 16.7-2.7 25.6-1.1zm9.4 156.4c17.5 2.3 34.3 7.1 46.5 13.2 13.5 6.8 29 19 34 26.7l1.9 2.9-5.9 5.4c-19.1 17-42.5 28.8-68.8 34.5-14.7 3.2-43.7 3.2-58.3 0-27-5.8-51-17.8-68.5-33.9-3.2-3-5.9-6.3-5.9-7.3 0-2.2 12.8-14.4 21-20 26.7-18.1 67.1-26.5 104-21.5zM1115.6 520.8c-.6 1-71.7 192-72.4 194.5-.4 1.6.5 1.7 12.4 1.5l12.8-.3 8.3-23.5c4.6-12.9 9-25.4 9.9-27.8l1.6-4.2h79.6l4.2 11.7c2.3 6.5 6.7 19.1 9.8 28l5.7 16.3h12.8c7 0 12.7-.3 12.7-.8 0-.4-16.4-44.6-36.3-98.2l-36.2-97.5-12.2-.3c-6.7-.1-12.4.1-12.7.6zm28.4 72.8c8.5 24 15.6 44.3 15.8 45 .3 1.2-5.2 1.4-31.8 1.4-26.2 0-32.1-.2-31.8-1.3 1-4.1 31.3-88.7 31.8-88.7.3 0 7.5 19.6 16 43.6zM1475 559c0 21.4-.3 39-.7 39-.5 0-1.9-1.9-3.3-4.1-3.4-5.6-11.2-12.5-18.2-16-27.8-14-61.4-2.2-75.3 26.4-5.3 11.1-7.4 18.8-8.4 31.6-2.5 29.2 5.1 53.7 21.6 69.2 23.3 22.1 62.4 18.8 79.9-6.7l3.9-5.7.3 12.2.3 12.1h22.9V520h-23v39zm-25.4 38c16 7.9 24.8 25.2 24.8 49 0 18.8-4.4 31.2-14.8 41.6-8.1 8-14.7 10.7-26.7 10.7-7.5 0-9.4-.4-15.2-3.1-17.3-8-25.6-26.4-24.4-53.6.6-14.6 2.9-22.8 9-31.8 10.4-15.6 30.6-21 47.3-12.8zM1537.1 522.7c-10.7 5.6-10.6 21 .2 26.2 2.4 1.2 5.3 2.1 6.5 2.1 6.4 0 13.6-6.2 14.8-12.6.9-4.8-1.9-11.8-5.8-14.5-4.2-3-11.3-3.5-15.7-1.2zM1632.5 573.5c-3.8.8-10.7 3.3-15.4 5.5-25 12-38.1 40.8-35 76.9 2.8 32 20.3 54.5 47.9 61.8 8.6 2.3 26.2 2.3 34.9 0 11.7-3.1 18.9-7.3 27.6-16.1 9.2-9.2 13.1-15.9 17.1-29.1 2.5-8.3 2.8-10.4 2.8-26 .1-19.9-1.1-25.8-8-40.2-7.6-15.9-21.2-27.2-38.4-31.9-8.1-2.2-25.1-2.6-33.5-.9zm24.6 20.9c14.4 3.3 24.8 14.5 29.5 31.7 2.4 8.9 2.5 30 .1 38.9-4.1 15.2-13 26.7-24.2 31-8.4 3.3-21.5 3.3-30 0-7.5-2.9-17-12-20.7-20-5.5-11.7-7.4-32.3-4.3-47.1 5.5-26.3 25.6-40.2 49.6-34.5zM1227 625.8c0 47.1.1 51.4 1.9 58.5 2.6 10 5.3 15 11.7 21.8 20.1 21 61.5 17.3 77.8-7.1 1.5-2.4 1.6-2.1 1.6 7.8V717h24V575h-23.9l-.3 47.7c-.3 47.3-.3 47.9-2.6 53.5-6.5 16-23.2 24.8-41.1 21.8-8.3-1.4-14.7-5.1-19.1-11.1-5.9-8.2-6-9.4-6-63.1V575h-24v50.8zM1532 646v71h24V575h-24v71zM725 667.1c-46.8 7.1-115.5 65.6-143.5 122.4-8.4 17-11.6 28-11.7 40.5-.1 14.9 3.8 22.7 14 27.7 5.2 2.6 6.6 2.8 16.7 2.7 9.5-.1 12.3-.5 20.8-3.3 5.3-1.8 9.7-3.3 9.7-3.5 0-.1-4.1 0-9 .2-15.2.7-24-3.3-28.5-13.1-5.8-12.4-3.5-28.7 7.2-50.5 21.1-43.3 70.8-88 110.8-99.7 13.1-3.8 24.5-3.8 32.3.1 10.4 5.3 14.2 14.3 12.9 30.8-.7 8.5.2 7.4 3.9-5 3.6-12 4-27.6.8-34.4-5.8-12.3-18.6-17.6-36.4-14.9zM153 667.9c-18.5 6.1-23.5 24.3-14.4 52.3 1.4 4.3 2.7 7.8 2.9 7.8.1 0 0-4-.3-9-.8-15 3-23.4 12.9-28.4 4.6-2.2 6.6-2.6 14.5-2.6 22.6 0 51.7 14.7 79.9 40.3 28.2 25.7 48.7 54.9 55.9 79.9 3.6 12.5 4.1 19.1 2.2 26.9-2.1 8-5.6 12.6-12.7 16.2-5.2 2.7-5.9 2.8-16.7 2.5l-11.3-.4 6.1 2.3c15.2 5.7 31.8 6.7 41.3 2.5 5.9-2.6 10.9-8 13.1-14.2 2.9-7.9 1.9-23.6-2.2-36.1-8.2-24.8-26.6-52.8-52.1-79.2-26.3-27.2-59.4-49.6-86.1-58.2-6.6-2.2-10.9-2.8-19.5-3.1-6-.2-12.1 0-13.5.5z" /><path d="M732.8 732.2c-10.8 1.4-26.2 8.9-41.4 20.1-9.6 7.1-29.8 27.6-36.6 37.3-20.2 28.4-24.5 52.8-10.8 60.8 4.3 2.5 16.3 2.7 22.5.3l4-1.6h-3.9c-6.3-.1-12.1-3.5-14.5-8.5-12.5-25.6 35.7-85 77.2-95.2 5.7-1.4 7.6-1.5 12.2-.5 6.8 1.5 11.2 5.6 12.1 11.2.4 2.1 1 3.9 1.5 3.9 1.2 0 2.2-8.7 1.5-13.7-1.5-11.3-9.5-16-23.8-14.1zM148.9 734.1c-2 1.2-4.4 3.5-5.4 5.1-2.1 3.6-3 12.9-1.7 18.3l.9 4 .7-3c3.4-14.8 15.6-18 36-9.5 27 11.2 57.3 43.1 66 69.2 6.1 18.3.4 30.6-14.5 30.9l-4.4.1 4.5 1.5c7.1 2.3 18.8 2.2 23-.2 14.1-8.2 8.7-34.5-12.9-63.5-7.6-10.2-24.7-27.2-35.4-35.2-22.5-16.7-45.9-24-56.8-17.7z" /></svg>' },
    lossy: { label: 'AAC', svg: '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><path d="M25.5 14.9c-6.9 1.7-13.4 6.9-15.4 12.4-.6 1.6-1.1 5.2-1.1 8.1 0 7.3 5.3 17.9 13 25.7 5.6 5.7 6 5.9 10.9 5.9H38l-6.3-6.4c-8-8.2-11.7-15-12.4-22.5-.7-7.6 2-13.2 7.9-16.2 3.8-2 5.3-2.1 16.3-1.6 7.8.3 14.6 1.3 19.4 2.7 4 1.1 7.6 1.8 7.9 1.5 2.3-2.2-12.4-7.5-26.4-9.5-8.4-1.1-14.4-1.2-18.9-.1z" /><path d="M38 27.2c-12.8 6.5-11.9 21.3 2.1 34.3 4.6 4.2 6.7 5.5 9.1 5.5h3.1l-5.5-5.8c-7.2-7.5-10.2-13.3-9.5-18.3.6-4.7 3.2-8.4 7.4-10.4 3.5-1.7 17.3-2 23.6-.6 2.9.7 3.7.6 3.7-.5 0-1.8-3.5-3.2-12.8-5-10.5-2-16-1.8-21.2.8zM95.2 41.3c-3.4 8.9-6.2 16.6-6.2 17 0 .4.9.7 1.9.7 1.4 0 2.4-1.3 3.7-4.5l1.7-4.5h14.5l1.4 4.2c1.1 3.1 2.1 4.4 3.6 4.6 1.2.2 2.2 0 2.2-.5 0-.4-2.8-8.1-6.2-17-8.3-21.6-8.3-21.6-16.6 0zm13.8 4.4c0 .2-2.5.3-5.6.3-4.1 0-5.5-.3-5.2-1.3.3-.6 1.5-4.3 2.8-8.1l2.3-6.9 2.8 7.8c1.6 4.4 2.9 8 2.9 8.2zM126.2 41.3c-3.4 8.9-6.2 16.5-6.2 16.9 0 .5.9.8 1.9.8 1.4 0 2.4-1.3 3.7-4.5l1.7-4.5h14.5l1.4 4.2c1.1 3.2 2.1 4.4 3.7 4.6 2.8.4 3 1.2-4.4-18.1-8-20.9-8-20.9-16.3.6zm13.8 4.4c0 .2-2.5.3-5.6.3-4.1 0-5.5-.3-5.2-1.3.3-.6 1.5-4.3 2.8-8.1l2.3-7 2.8 8c1.6 4.3 2.9 8 2.9 8.1zM160.3 27.1c-8.3 4.1-11.6 15.2-7.1 23.9 2.8 5.5 7.3 8.2 13.6 8.3 6.2.1 9.2-1 9.2-3.3 0-1.7-.4-1.8-3.1-.8-4.3 1.5-10.6.4-13.5-2.3-3-2.8-4.7-8.8-3.8-13.5 1.4-7.6 9.1-12.5 16.4-10.4 1.9.6 3.6 1 3.7 1 1.1 0 0-3.9-1.3-4.4-3.2-1.2-10-.5-14.1 1.5z" /><path d="M54.3 35.7c-2.8.5-7.2 4.9-7.9 8-1.1 4.1.6 9.1 4.6 14.1 5.5 7 9.5 9.2 16.5 9.2h5.7l-.4-14.1c-.3-13.4-.5-14.2-2.7-16-2.3-1.8-9.6-2.4-15.8-1.2z" /></svg>' },
  };

  /** 换歌后开始滚动前的停留时间（与 music.apple.com 相同） */
  const MARQUEE_DELAY = 3000;

  /**
   * 播放条的滚动字幕，照 music.apple.com 播放条（LCD）的 marquee 组件实现：
   *   放得下时静止；放不下时右侧渐隐，换歌 3 秒后滚动一遍（约 20px/s，副本首尾相接），滚完回到开头；
   *   鼠标移入时暂停（方便点击移动中的链接），移出后继续，已停下时再滚一遍。
   *   滚动时两侧渐隐，原文完全移出后去掉左侧渐隐（is-near-end）。
   * 结构：.marquee-line > .marquee-line__mask > .marquee-line__scroller > 原文 + aria-hidden 副本
   */
  class Marquee {
    constructor(host) {
      const doc = host.ownerDocument;
      const view = doc.defaultView;
      const div = (className) => Object.assign(doc.createElement('div'), { className });
      this.line = div('marquee-line inactive');
      this.mask = div('marquee-line__mask');
      this.scroller = div('marquee-line__scroller');
      this.text = Object.assign(doc.createElement('span'), { className: 'marquee-line__text' });
      this.copy = Object.assign(doc.createElement('span'), { className: 'marquee-line__text' });
      const chunk = div('marquee-line__chunk');
      const copyChunk = div('marquee-line__chunk marquee-line__chunk--copy');
      copyChunk.setAttribute('aria-hidden', 'true');
      chunk.append(this.text);
      copyChunk.append(this.copy);
      this.scroller.append(chunk, copyChunk);
      this.mask.append(this.scroller);
      this.line.append(this.mask);
      host.replaceChildren(this.line);
      this.active = false;
      this.timer = 0;
      this.reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
      this.line.addEventListener('mouseenter', () => { if (this.active) this.line.classList.add('is-paused'); });
      this.line.addEventListener('mouseleave', () => this.play());
      this.scroller.addEventListener('animationend', () => this.reset());
      new view.IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting && this.line.classList.contains('is-animating')) this.line.classList.add('is-near-end');
      }, { root: this.mask, threshold: 0 }).observe(this.text);
      // 播放条宽度变化（窗口缩放、歌词界面开关）时重新判断是否放得下
      new view.ResizeObserver(() => this.measure()).observe(this.line);
    }

    /** 换上新内容，放不下时 3 秒后滚动一遍 */
    set(nodes) {
      clearTimeout(this.timer);
      this.reset();
      this.line.classList.remove('is-paused');
      this.text.replaceChildren(...nodes);
      this.copy.replaceChildren(...[...this.text.childNodes].map((node) => node.cloneNode(true)));
      for (const link of this.copy.querySelectorAll('a')) link.tabIndex = -1;
      if (this.measure()) this.timer = setTimeout(() => this.play(), MARQUEE_DELAY);
    }

    measure() {
      const width = this.text.getBoundingClientRect().width;
      // 播放条隐藏时宽度都是 0，按放得下处理
      this.active = width > this.line.clientWidth + 0.5;
      this.line.classList.toggle('active', this.active);
      this.line.classList.toggle('inactive', !this.active);
      if (this.active) {
        const gap = parseFloat(getComputedStyle(this.scroller).getPropertyValue('--marquee-line-padding')) || 0;
        this.scroller.style.setProperty('--marquee-scroll-width', String(width + gap));
      } else this.reset();
      return this.active;
    }

    play() {
      const classes = this.line.classList;
      if (!this.active || this.reducedMotion.matches) return;
      if (classes.contains('is-animating')) classes.remove('is-paused');
      else {
        classes.remove('is-paused', 'is-near-end');
        classes.add('is-animating');
      }
    }

    reset() {
      this.line.classList.remove('is-animating', 'is-near-end');
    }
  }

  /** entry: { track, name, artist, artists, album, href, albumHref, artwork } → play() 使用的 item */
  /** 就地打乱 list[start..]（Fisher-Yates） */
  function shuffleFrom(list, start) {
    for (let i = list.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  async function resolveEntry(entry) {
    const res = await fetch(`/parse/song/${entry.track}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.masterUrl || !Array.isArray(data.variants)) throw new Error(data.msg || `HTTP ${res.status}`);
    const hook = !!data.hook;
    const base = data.masterUrl.slice(0, data.masterUrl.lastIndexOf('/') + 1);
    probe = probe || document.createElement('audio');
    const best = data.variants
      .map((v) => ({ ...v, mode: detectMode(v.codecs, probe, hook) }))
      .filter((v) => v.mode)
      .sort((a, b) => rankVariant(a) - rankVariant(b) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (!best) throw Object.assign(new Error(t('album.noPlayable', { name: entry.name })), { noPlayable: true });
    return {
      id: `${entry.track}:${best.group_id}`,
      track: entry.track,
      codecs: best.codecs,
      m3u8Url: base + best.uri,
      hookM3u8Url: hook ? `${location.origin}/${base + best.uri}` : null,
      hookFileUrl: hook ? `${location.origin}/${base + best.file_uri}` : null,
      label: variantLabel(best),
      badge: qualityBadge(best),
      title: entry.name,
      artist: entry.artist,
      artists: entry.artists,
      album: entry.album,
      href: entry.href,
      albumHref: entry.albumHref,
      artwork: entry.artwork,
    };
  }

  class FlacTranscoder {
    constructor() {
      this.worker = new Worker('/assets/flac-transcode-worker.js');
      this.pending = new Map();
      this.seq = 0;
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'FLAC Worker failed'));
        this.pending.clear();
      };
    }

    run(op, buf) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op, buf }, [buf]);
      });
    }

    destroy() {
      this.worker.terminate();
      for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
      this.pending.clear();
    }
  }

  class Ec3Decoder {
    constructor() {
      this.worker = new Worker('/assets/ec3-decode-worker.js');
      this.pending = new Map();
      this.seq = 0;
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'EC-3 Worker failed'));
        this.pending.clear();
      };
    }

    decode(buf) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op: 'decode', buf }, [buf]);
      });
    }

    flush() {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op: 'flush' });
      });
    }

    destroy() {
      this.worker.terminate();
      for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
      this.pending.clear();
    }
  }

  /** Bounded, on-demand multichannel PCM playback for EC-3. */
  class PcmEngine {
    constructor(onUpdate, onError, onEnded) {
      this.onUpdate = onUpdate;
      this.onError = onError;
      this.onEnded = onEnded;
      this.context = new (global.AudioContext || global.webkitAudioContext)();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.nodes = new Set();
      this.paused = true;
      this.anchorTime = 0;
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = 0;
      this.generation = 0;
      this.timer = setInterval(() => {
        if (!this.paused && this.duration && this.currentTime >= this.duration) {
          this.pause();
          if (this.onEnded) this.onEnded();
        }
        if (!this.paused) this.pump();
        this.onUpdate();
      }, 200);
      // Resume during the click gesture, before the asynchronous playlist request.
      this.started = this.context.resume().then(() => this.context.suspend());
    }

    get currentTime() {
      const time = this.paused ? this.anchorTime
        : this.anchorTime + Math.max(0, this.context.currentTime - this.anchorContextTime);
      return Math.min(this.duration || Infinity, time);
    }

    set currentTime(value) { const pending = this.seek(value); if (pending) pending.catch(() => {}); }

    async load(url) {
      const gen = this.generation;
      await this.started;
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.controller = new AbortController();
      this.playlist = await global.AmDecrypt.openTrack(url, this.controller.signal);
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.duration = this.playlist.duration;
      this.decoder = new Ec3Decoder();
      this.nextIndex = 0;
      await this.pump(true);
    }

    async pump(first = false) {
      if (this.busy || this.failed || !this.playlist || !this.decoder) return;
      this.busy = true;
      const gen = this.generation;
      const required = first;
      try {
        const { segments } = this.playlist;
        while (this.nextIndex < segments.length && (first || segments[this.nextIndex].time < this.currentTime + 12)) {
          const seg = segments[this.nextIndex];
          const encrypted = await this.playlist.load(seg, this.controller.signal);
          if (gen !== this.generation) return;
          const decoded = await this.decoder.decode(encrypted);
          if (gen !== this.generation) return;
          const { channels, rate, samples, chunks } = decoded;
          if (this.channels && (this.channels !== channels || this.rate !== rate)) {
            throw new Error('EC-3 channel layout changed during playback');
          }
          this.channels = channels;
          this.rate = rate;
          let sampleOffset = 0;
          for (const chunk of chunks) {
            const chunkTime = seg.time + sampleOffset / rate;
            const offset = Math.max(0, this.currentTime - chunkTime);
            sampleOffset += chunk.samples;
            if (offset >= chunk.samples / rate) {
              chunk.pcm = null;
              continue;
            }
            const data = new Float32Array(chunk.pcm);
            const buffer = this.context.createBuffer(channels, chunk.samples, rate);
            for (let ch = 0; ch < channels; ch++) {
              // FFmpeg's 7.1 order puts back channels before side channels;
              // Web Audio uses side channels before back channels.
              const sourceCh = channels === 8 ? [0, 1, 2, 3, 6, 7, 4, 5][ch] : ch;
              buffer.copyToChannel(data.subarray(sourceCh * chunk.capacity, sourceCh * chunk.capacity + chunk.samples), ch);
            }
            chunk.pcm = null;
            const node = this.context.createBufferSource();
            node.buffer = buffer;
            node.connect(this.gain);
            node.onended = () => { this.nodes.delete(node); node.disconnect(); };
            this.nodes.add(node);
            const when = Math.max(this.context.currentTime + 0.01,
              this.anchorContextTime + chunkTime - this.anchorTime);
            node.start(when, offset);
          }
          this.loadedUntil = Math.max(this.loadedUntil, seg.time + samples / rate);
          this.nextIndex++;
          first = false;
          this.onUpdate();
          if (required) break;
        }
      } catch (error) {
        if (required && gen === this.generation) throw error;
        if (error.name !== 'AbortError' && gen === this.generation) {
          this.failed = true;
          this.pause();
          this.onError(error);
        }
      } finally {
        this.busy = false;
      }
    }

    async play() {
      if (this.seeking) { this.resumeAfterSeek = true; return this.seekTask; }
      this.failed = false;
      await this.context.resume();
      this.paused = false;
      this.onUpdate();
      this.pump();
    }

    pause() {
      if (this.seeking) { this.resumeAfterSeek = false; return; }
      if (this.paused) return;
      this.anchorTime = this.currentTime;
      this.anchorContextTime = this.context.currentTime;
      this.paused = true;
      this.context.suspend();
      this.onUpdate();
    }

    seek(time) {
      if (!this.playlist) return;
      this.generation++;
      const gen = this.generation;
      this.failed = false;
      this.resumeAfterSeek = !this.paused || (this.seeking && this.resumeAfterSeek);
      this.seeking = true;
      this.paused = true;
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.anchorTime = Math.max(0, Math.min(time, this.duration));
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = this.anchorTime;
      this.nextIndex = segmentAt(this.playlist.segments, this.anchorTime);
      this.onUpdate();
      const task = (async () => {
        await this.context.suspend();
        while (this.busy && gen === this.generation) await new Promise((resolve) => setTimeout(resolve, 10));
        if (gen !== this.generation) return;
        await this.decoder.flush();
        if (gen !== this.generation) return;
        this.anchorContextTime = this.context.currentTime + 0.03;
        await this.pump(true);
        if (gen === this.generation && this.resumeAfterSeek) {
          await this.context.resume();
          this.paused = false;
          this.onUpdate();
          this.pump();
        }
      })().catch((error) => {
        if (gen === this.generation && error.name !== 'AbortError') {
          this.failed = true;
          this.onError(error);
        }
        throw error;
      })
        .finally(() => { if (gen === this.generation) { this.seeking = false; this.seekTask = null; } });
      this.seekTask = task;
      return task;
    }

    destroy() {
      this.generation++;
      clearInterval(this.timer);
      if (this.controller) this.controller.abort();
      if (this.decoder) this.decoder.destroy();
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.context.close();
    }
  }

  class MseEngine {
    constructor(audio) {
      this.audio = audio;
      this.generation = 0;
    }

    /** m3u8Url：Apple CDN 上的原始 media m3u8 */
    async load(m3u8Url, codecs, onError, transcode = false) {
      const gen = ++this.generation;
      this.destroy(false);
      this.onError = onError;
      this.controller = new AbortController();
      const playlist = await global.AmDecrypt.openTrack(m3u8Url, this.controller.signal);
      if (gen !== this.generation) return;
      this.playlist = playlist;
      if (transcode) this.transcoder = new FlacTranscoder();

      const MS = global.ManagedMediaSource || global.MediaSource;
      const ms = new MS();
      this.ms = ms;
      this.objectUrl = URL.createObjectURL(ms);
      if (global.ManagedMediaSource && MS === global.ManagedMediaSource) this.audio.disableRemotePlayback = true;
      this.audio.src = this.objectUrl;
      await new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));
      if (gen !== this.generation) return;

      ms.duration = playlist.duration;
      this.sb = ms.addSourceBuffer(mimeFor(transcode ? 'flac' : codecs));
      await this.append(await this.fetchRange(playlist.init, gen), gen);

      // 只记录成功追加的分段；时间戳与 EXTINF 有偏差时避免反复拉取。
      this.appendedSegments = new Set();
      this.pendingSegments = new Map();
      this.segmentController = new AbortController();
      this.seekSerial = 0;
      this.pumpSerial = 0;
      this.onTick = () => this.pump(gen);
      this.onSeeking = () => {
        this.seekSerial++;
        const seekSerial = this.seekSerial;
        this.pumpSerial++;
        this.segmentController.abort();
        this.segmentController = new AbortController();
        this.appendedSegments.clear();
        this.pendingSegments.clear();
        if (this.sb.updating) {
          this.sb.addEventListener('updateend', () => {
            if (gen !== this.generation || seekSerial !== this.seekSerial) return;
            this.busy = false;
            this.pump(gen);
          }, { once: true });
        } else {
          this.busy = false;
          this.pump(gen);
        }
      };
      this.audio.addEventListener('timeupdate', this.onTick);
      this.audio.addEventListener('seeking', this.onSeeking);
      this.pump(gen);
    }

    /** 获取并解密一个分段 */
    async fetchRange(range, gen, signal = this.controller.signal) {
      let buf = await this.playlist.load(range, signal);
      signal.throwIfAborted();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      if (this.transcoder) buf = await this.transcoder.run(range.init ? 'open' : 'transcode', buf);
      signal.throwIfAborted();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      return buf;
    }

    append(buf, gen) {
      return new Promise((resolve, reject) => {
        if (gen !== this.generation || !this.sb) return reject(new DOMException('stale', 'AbortError'));
        const done = () => { this.sb.removeEventListener('error', fail); resolve(); };
        const fail = () => { this.sb.removeEventListener('updateend', done); reject(new Error(t('player.errorAppend'))); };
        this.sb.addEventListener('updateend', done, { once: true });
        this.sb.addEventListener('error', fail, { once: true });
        try {
          this.sb.appendBuffer(buf); // readyState 为 ended 时追加会自动重新打开
        } catch (err) {
          this.sb.removeEventListener('updateend', done);
          this.sb.removeEventListener('error', fail);
          reject(err);
        }
      });
    }

    isBuffered(seg) {
      const b = this.sb.buffered;
      const from = seg.time + 0.25;
      const to = seg.time + Math.max(seg.duration - 0.25, 0.3);
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= from && b.end(i) >= to) return true;
      }
      return false;
    }

    async evict(gen) {
      const cut = this.audio.currentTime - (this.transcoder ? 2 : BEHIND_SECONDS);
      if (cut <= 1 || this.sb.updating) return;
      await new Promise((resolve) => {
        this.sb.addEventListener('updateend', resolve, { once: true });
        this.sb.remove(0, cut);
      });
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
    }

    ready(i) {
      // A nearly complete buffered range can still have queued FLAC fragments.
      // Finish those before starting the next segment: backfilling them later
      // changes MSE's append position and lets quota eviction remove future audio.
      if (this.pendingSegments.has(i)) return false;
      return this.isBuffered(this.playlist.segments[i]) || this.appendedSegments.has(i);
    }

    async pump(gen) {
      if (this.busy || gen !== this.generation || !this.sb) return;
      const { segments } = this.playlist;
      const now = this.audio.currentTime;
      const startIndex = segmentAt(segments, now);
      let target = -1;
      const ahead = this.transcoder ? 14 : AHEAD_SECONDS;
      for (let i = startIndex; i < segments.length; i++) {
        if (segments[i].time > now + ahead) break;
        if (!this.ready(i)) { target = i; break; }
      }
      if (target < 0) {
        // After seeking, earlier segments may never have been loaded. Signal
        // EOF once the remaining audio is appended so the decoder can flush
        // its final samples. A later seek/append reopens the MediaSource.
        const tailDone = segments.every((_, i) => i < startIndex || this.ready(i));
        if (tailDone && this.ms.readyState === 'open' && !this.sb.updating) {
          try { this.ms.endOfStream(); } catch {}
        }
        return;
      }

      this.busy = true;
      const pumpSerial = ++this.pumpSerial;
      const seekSerial = this.seekSerial;
      const signal = this.segmentController.signal;
      let waitForPlayback = false;
      try {
        if (this.transcoder) {
          let queue = this.pendingSegments.get(target);
          if (!queue) {
            queue = await this.fetchRange(segments[target], gen, signal);
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            this.pendingSegments.set(target, queue);
          }
          while (queue.length) {
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            try {
              await this.append(queue[0], gen);
            } catch (err) {
              if (!err || err.name !== 'QuotaExceededError') throw err;
              await this.evict(gen);
              try {
                await this.append(queue[0], gen);
              } catch (retryError) {
                if (!retryError || retryError.name !== 'QuotaExceededError') throw retryError;
                waitForPlayback = true;
                break;
              }
            }
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            queue.shift();
          }
          if (!queue.length) {
            this.pendingSegments.delete(target);
            this.appendedSegments.add(target);
          }
        } else {
          const buf = await this.fetchRange(segments[target], gen, signal);
          if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
          try {
            await this.append(buf, gen);
          } catch (err) {
            if (err && err.name === 'QuotaExceededError') {
              await this.evict(gen);
              await this.append(buf, gen);
            } else {
              throw err;
            }
          }
          if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
          this.appendedSegments.add(target);
        }
      } catch (err) {
        if (pumpSerial === this.pumpSerial && (!err || err.name !== 'AbortError')) {
          this.busy = false;
          if (this.onError) this.onError(err);
          return;
        }
      }
      if (pumpSerial === this.pumpSerial) {
        this.busy = false;
        if (!waitForPlayback && gen === this.generation) this.pump(gen);
      }
    }

    destroy(bump = true) {
      if (bump) this.generation++;
      if (this.controller) this.controller.abort();
      if (this.segmentController) this.segmentController.abort();
      if (this.transcoder) this.transcoder.destroy();
      if (this.onTick) {
        this.audio.removeEventListener('timeupdate', this.onTick);
        this.audio.removeEventListener('seeking', this.onSeeking);
      }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.onTick = this.onSeeking = this.controller = this.segmentController = this.objectUrl = this.sb = this.ms = this.playlist = this.transcoder = this.pendingSegments = this.appendedSegments = null;
      this.busy = false;
    }
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const ICON_LOADING = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
  const ICON_QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 14.5v5.5"/><circle cx="14" cy="20" r="2"/><path d="M16 14.5 20 13"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
  const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 12h10"/></svg>';
  const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3c2.2 0 3.4 1 4.5 2.8l3 4.4C14.6 16 15.8 17 18 17h2.5"/><path d="M3 17h3c1.6 0 2.7-.6 3.6-1.6M14.4 8.6C15.3 7.6 16.4 7 18 7h2.5"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/></svg>';
  const ICON_REPEAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/></svg>';
  const ICON_REPEAT_ONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/><path d="M11 10.5 12.5 9.5v5" stroke-width="1.8"/></svg>';

  /**
   * 页面底部播放条。
   * 外壳页（shell.html）中只有一个实例，站内页面在 iframe 中经 connect() 共用它，跳转页面时播放不中断；
   * 直接打开页面（浏览器不发送 Sec-Fetch-Dest）时每个页面各自创建。
   */
  class AmPlayer {
    /** options.navigate(href)：外壳传入，播放条上的链接交给它在 iframe 中打开（外壳不刷新，播放不中断） */
    constructor(root, options = {}) {
      this.root = root;
      this.navigate = options.navigate || null;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.mse = new MseEngine(this.audio);
      this.pcm = null;
      this.$ = (sel) => root.querySelector(sel);
      this.$('.player-text').addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link || !this.navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        this.navigate(link.getAttribute('href'));
      });
      // 歌名、「艺人 — 专辑」两行滚动字幕；音质标签在歌名右侧，不参与滚动
      const title = this.$('.player-title');
      const titleHost = Object.assign(root.ownerDocument.createElement('span'), { className: 'marquee marquee--primary' });
      this.quality = Object.assign(root.ownerDocument.createElement('span'), { className: 'player-quality', hidden: true });
      title.replaceChildren(titleHost, this.quality);
      this.titleMarquee = new Marquee(titleHost);
      this.$('.player-sub').classList.add('marquee', 'marquee--secondary');
      this.subMarquee = new Marquee(this.$('.player-sub'));
      this.listeners = new Set();
      this.unsupportedListeners = new Set();
      this.playToken = 0;
      /** 播放队列：{ entries, pos }，entries 见 resolveEntry；pendingTrack 为正在解析的曲目 */
      this.queue = null;
      this.queueSerial = 0;
      this.pendingTrack = null;
      /** 需要为播放条留出底部空间的文档（自身与 iframe 中的页面） */
      this.docs = new Set([root.ownerDocument]);
      /** 随机播放（true / false）与重复播放（off / all / one），与 Apple Music 相同，下次打开时保留 */
      this.shuffle = false;
      this.repeat = 'off';
      try {
        this.shuffle = localStorage.getItem('am-hook:shuffle') === '1';
        const repeat = localStorage.getItem('am-hook:repeat');
        if (repeat === 'all' || repeat === 'one') this.repeat = repeat;
      } catch {}
      new ResizeObserver(() => this.layout()).observe(root);
      this.bindUi();
      this.bindQueueUi();
      this.bindKeys(root.ownerDocument);
      try {
        const v = parseFloat(localStorage.getItem('am-hook:volume'));
        if (v >= 0 && v <= 1) this.audio.volume = v;
      } catch {}
      this.$('.volume').value = this.audio.volume;
      if (global.AmI18n) global.AmI18n.onChange(() => this.renderLang());
    }

    /** 切换界面语言后重绘播放条上的文字 */
    renderLang() {
      this.renderToggle();
      if (this.current) {
        this.renderMode();
        this.renderTrackText();
      }
      this.renderError();
      this.renderQueueLang();
    }

    /**
     * 与 music.apple.com 的播放条相同：第一行歌名（链接到歌曲页），第二行「艺人 — 专辑」，
     * 各位艺人与专辑名分别链接到艺人页、专辑页；过长时滚动（见 Marquee）；音质显示为歌名旁的小标签
     */
    renderTrackText() {
      const c = this.current;
      const doc = this.root.ownerDocument;
      const link = (href, text) => (href ? Object.assign(doc.createElement('a'), { href, textContent: text }) : text);
      this.titleMarquee.set([link(c.href, c.title || t('player.unknownTitle'))]);
      // 音质标志（Lossless / Hi-Res Lossless / Dolby Atmos / Spatial Audio / AAC），具体规格放在悬停提示里
      const badge = QUALITY_BADGES[c.badge];
      this.quality.innerHTML = badge ? badge.svg : '';
      if (badge) this.quality.setAttribute('aria-label', badge.label); else this.quality.removeAttribute('aria-label');
      this.quality.title = c.label || '';
      this.quality.className = `player-quality${badge ? ` player-quality--${c.badge}` : ''}`;
      this.quality.hidden = !badge;
      const artists = c.artist ? artistNodes(c.artist, c.artists, doc) : [];
      const album = c.album ? [link(c.albumHref, c.album)] : [];
      this.subMarquee.set([...artists, ...(artists.length && album.length ? [' — '] : []), ...album]);
    }

    renderMode() {
      if (!this.current) return;
      const ec3 = this.current.mode === 'ec3';
      const channels = this.pcm && this.pcm.channels;
      this.$('.player-mode').textContent = ec3 && channels
        ? t('player.pcmChannels', { n: channels - 1 }) : modeLabel(this.current.mode);
      const notice = this.$('.player-notice');
      const noticeKey = ec3 ? 'player.pcmNotice'
        : this.current.mode === 'flac' ? 'player.flacNotice' : null;
      notice.textContent = noticeKey ? t(noticeKey) : '';
      notice.hidden = !noticeKey;
    }

    transport() { return this.current && this.current.mode === 'ec3' && this.pcm ? this.pcm : this.audio; }

    updatePcm() {
      this.renderToggle();
      this.renderProgress();
      this.renderMode();
      this.emit();
    }

    onChange(fn) { this.listeners.add(fn); }
    emit() {
      this.listeners.forEach((fn) => fn(this.current, !this.transport().paused));
      this.renderModes();
      this.renderQueue();
    }

    bindUi() {
      const a = this.audio;
      this.$('.player-toggle').addEventListener('click', () => this.toggle());
      this.$('.skip-prev').addEventListener('click', () => this.previous());
      this.$('.skip-next').addEventListener('click', () => this.next());
      this.$('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      this.$('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      this.$('.volume').addEventListener('input', (e) => {
        a.volume = Number(e.target.value);
        if (this.pcm) this.pcm.gain.gain.value = a.volume;
        try { localStorage.setItem('am-hook:volume', String(a.volume)); } catch {}
      });

      const seek = this.$('.seek');
      const ratioAt = (e) => {
        const r = seek.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      };
      seek.addEventListener('pointerdown', (e) => {
        if (!this.duration()) return;
        seek.setPointerCapture(e.pointerId);
        seek.classList.add('dragging');
        this.dragRatio = ratioAt(e);
        this.renderProgress();
      });
      seek.addEventListener('pointermove', (e) => {
        if (this.dragRatio === undefined) return;
        this.dragRatio = ratioAt(e);
        this.renderProgress();
      });
      const release = () => {
        if (this.dragRatio === undefined) return;
        this.transport().currentTime = this.dragRatio * this.duration();
        this.dragRatio = undefined;
        seek.classList.remove('dragging');
      };
      seek.addEventListener('pointerup', release);
      seek.addEventListener('pointercancel', release);
      seek.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { this.seekBy(-5); e.preventDefault(); }
        if (e.key === 'ArrowRight') { this.seekBy(5); e.preventDefault(); }
      });

      ['timeupdate', 'progress', 'durationchange', 'loadedmetadata'].forEach((ev) => a.addEventListener(ev, () => this.renderProgress()));
      ['play', 'pause', 'playing', 'waiting', 'ended'].forEach((ev) => a.addEventListener(ev, () => { this.renderToggle(); this.emit(); }));
      a.addEventListener('ended', () => this.ended());
      a.addEventListener('error', () => {
        // 尝试阶段的错误由 play() 统一处理（会自动换下一种播放方式）
        if (!this.attempting && this.current && this.current.mode !== 'mse' && this.audio.getAttribute('src')) {
          const item = this.current;
          this.showError(() => t('player.errorGeneric', { hint: fallbackHint(item) }));
        }
      });

      if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', () => this.transport().play());
        ms.setActionHandler('pause', () => this.transport().pause());
        ms.setActionHandler('seekbackward', () => this.seekBy(-10));
        ms.setActionHandler('seekforward', () => this.seekBy(10));
        try { ms.setActionHandler('seekto', (d) => { this.transport().currentTime = d.seekTime; }); } catch {}
        try {
          ms.setActionHandler('nexttrack', () => this.next());
          ms.setActionHandler('previoustrack', () => this.previous());
        } catch {}
      }
    }

    /** 空格播放 / 暂停，左右方向键快退 / 快进；iframe 中的页面也要绑定，按键不会传到外壳 */
    bindKeys(doc) {
      // 待播清单面板：按 Esc 或点击面板与播放条以外的地方（含 iframe 中的页面）时收起
      doc.addEventListener('pointerdown', (e) => {
        if (this.queuePanel.hidden || this.queuePanel.contains(e.target) || this.root.contains(e.target)) return;
        this.closeQueue();
      });
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.queuePanel.hidden) { this.closeQueue(true); return; }
        if (!this.current || e.defaultPrevented || e.target.closest('input, textarea, button, a, [role="slider"]')) return;
        if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
        if (e.key === 'ArrowLeft') this.seekBy(-5);
        if (e.key === 'ArrowRight') this.seekBy(5);
      });
    }

    /**
     * 待播清单，布局与交互参照 music.apple.com 的「待播清单」侧栏：
     * 标题与「清除」、55px 的行（封面 / 歌名与艺人 / 时长），悬停时封面左上角出现移除按钮；
     * 鼠标单击选中、双击播放，拖动整行调整顺序；触屏点按播放，拖动右侧把手调整顺序（与 iOS 相同）。
     * 键盘：↑/↓ 选择，Enter 播放，Delete 移除，Alt+↑/↓ 移动。
     * 窄屏时随机 / 重复按钮从播放条移到清单标题旁（与手机版相同）。
     * 面板放在播放条所在的文档中（外壳时为外壳），浮在播放条上方。
     */
    bindQueueUi() {
      const doc = this.root.ownerDocument;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'player-queue';
      button.innerHTML = ICON_QUEUE;
      button.setAttribute('aria-expanded', 'false');
      this.$('.player-right').insertBefore(button, this.$('.player-mode'));

      const panel = doc.createElement('section');
      panel.className = 'queue-panel';
      panel.id = 'queue-panel';
      panel.hidden = true;
      panel.innerHTML = '<header class="queue-head"><h2 class="queue-title"></h2>'
        + `<div class="queue-switches"><button class="player-switch player-shuffle" type="button" aria-pressed="false">${ICON_SHUFFLE}</button>`
        + '<button class="player-switch player-repeat" type="button" aria-pressed="false"></button></div>'
        + '<button class="queue-clear" type="button"></button></header>'
        + '<p class="queue-empty" hidden></p><ol class="queue-list"></ol>';
      doc.body.appendChild(panel);
      button.setAttribute('aria-controls', panel.id);
      this.queueButton = button;
      this.queuePanel = panel;
      this.queueKey = '';
      this.queueSelected = null;

      button.addEventListener('click', () => (panel.hidden ? this.openQueue() : this.closeQueue()));
      panel.querySelector('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      panel.querySelector('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      panel.querySelector('.queue-clear').addEventListener('click', () => {
        if (this.queue) {
          this.queue.entries.splice(this.queue.pos + 1);
          if (this.queue.ordered) this.queue.ordered = this.queue.entries.slice();
        }
        this.renderQueue(true);
        this.renderModes();
      });

      const list = panel.querySelector('.queue-list');
      const rowOf = (target) => target.closest('.queue-item');
      const indexOf = (row) => Number(row.dataset.index);
      let pointerType = 'mouse';
      list.addEventListener('click', (e) => {
        const row = rowOf(e.target);
        if (!row || !this.queue || this.queueDrag) return;
        if (e.target.closest('.queue-remove')) this.removeQueueEntry(indexOf(row));
        else if (pointerType === 'mouse') this.selectQueueRow(row);
        else this.playAt(indexOf(row));
      });
      list.addEventListener('dblclick', (e) => {
        const row = rowOf(e.target);
        if (row && this.queue && !e.target.closest('.queue-remove')) this.playAt(indexOf(row));
      });
      list.addEventListener('keydown', (e) => {
        const row = rowOf(e.target);
        if (!row || !this.queue || e.target !== row) return;
        const index = indexOf(row);
        const rows = [...list.querySelectorAll('.queue-item')];
        const at = rows.indexOf(row);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.playAt(index); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.removeQueueEntry(index); return; }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const step = e.key === 'ArrowUp' ? -1 : 1;
        if (!e.altKey) {
          const next = rows[at + step];
          if (next) { this.selectQueueRow(next); next.focus(); }
          return;
        }
        const to = index + step;
        if (to <= this.queue.pos || to >= this.queue.entries.length) return;
        this.moveQueueEntry(index, to);
        list.querySelector(`.queue-item[data-index="${to}"]`).focus();
      });

      // 拖动排序：经过其他行的中线时交换位置，松开后按新顺序写回队列。
      // 鼠标按住整行移动超过 4px 开始拖动；把手（触屏时显示）按下即开始。
      // 指针捕获放在列表上：拖动的行会在 DOM 中移动，移动会让行内元素失去捕获
      list.addEventListener('pointerdown', (e) => {
        pointerType = e.pointerType || 'mouse';
        const row = rowOf(e.target);
        if (!row || !this.queue || e.button !== 0 || e.target.closest('.queue-remove')) return;
        const entry = this.queue.entries[indexOf(row)];
        const grip = e.target.closest('.queue-grip');
        if (!entry || (!grip && pointerType !== 'mouse')) return;
        if (grip) e.preventDefault();
        const startY = e.clientY;
        let active = false;
        const begin = () => {
          active = true;
          list.setPointerCapture(e.pointerId);
          row.classList.add('dragging');
          list.classList.add('sorting');
          this.queueDrag = { row };
          this.selectQueueRow(row);
        };
        const move = (ev) => {
          if (!active) {
            if (Math.abs(ev.clientY - startY) < 4) return;
            begin();
          }
          ev.preventDefault();
          // 靠近列表上下边缘时自动滚动
          const box = list.getBoundingClientRect();
          if (ev.clientY < box.top + 28) list.scrollTop -= 8;
          else if (ev.clientY > box.bottom - 28) list.scrollTop += 8;
          for (const other of list.querySelectorAll('.queue-item:not(.dragging)')) {
            const r = other.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            // other 在拖动行之前：指针越过它的中线往上时移到它前面；在之后：越过中线往下时移到它后面
            const above = other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
            if (above && ev.clientY < mid) other.before(row);
            else if (!above && ev.clientY > mid) other.after(row);
          }
        };
        const end = () => {
          list.removeEventListener('pointermove', move);
          list.removeEventListener('pointerup', end);
          list.removeEventListener('pointercancel', end);
          if (!active) return;
          row.classList.remove('dragging');
          list.classList.remove('sorting');
          // 点击事件在 pointerup 之后触发，等它过去再允许点击
          setTimeout(() => { this.queueDrag = null; }, 0);
          // 拖动期间可能已播完一首（pos 变化）或队列被替换，按曲目重新定位
          const q = this.queue;
          const from = q ? q.entries.indexOf(entry) : -1;
          const to = q ? q.pos + 1 + [...list.querySelectorAll('.queue-item')].indexOf(row) : -1;
          if (q && from > q.pos && to > q.pos && to < q.entries.length && to !== from) this.moveQueueEntry(from, to);
          else this.renderQueue(true);
        };
        list.addEventListener('pointermove', move);
        list.addEventListener('pointerup', end);
        list.addEventListener('pointercancel', end);
        if (grip) begin();
      });

      this.renderQueueLang();
    }

    /** 选中一行（鼠标单击、方向键），重绘后按曲目保留 */
    selectQueueRow(row) {
      this.queueSelected = this.queue ? this.queue.entries[Number(row.dataset.index)] : null;
      for (const other of this.queuePanel.querySelectorAll('.queue-item')) other.classList.toggle('selected', other === row);
    }

    /** 把队列中 from 处的曲目移到 to（均在当前曲目之后） */
    moveQueueEntry(from, to) {
      const entries = this.queue.entries;
      const [entry] = entries.splice(from, 1);
      entries.splice(to, 0, entry);
      this.renderQueue(true);
    }

    removeQueueEntry(index) {
      const q = this.queue;
      const [entry] = q.entries.splice(index, 1);
      if (q.ordered) q.ordered.splice(q.ordered.indexOf(entry), 1);
      this.renderQueue(true);
      this.renderModes();
      // 焦点移到原位置的下一行，没有时回到上一行或清单按钮
      const rows = this.queuePanel.querySelectorAll('.queue-item');
      const next = rows[Math.min(index - q.pos - 1, rows.length - 1)];
      if (next) { this.selectQueueRow(next); next.focus(); } else this.queueButton.focus();
    }

    openQueue() {
      this.queuePanel.hidden = false;
      this.queueButton.setAttribute('aria-expanded', 'true');
      this.renderQueue(true);
      this.placeQueue();
      this.queuePanel.querySelector('.queue-list').scrollTop = 0;
    }

    closeQueue(refocus = false) {
      if (this.queuePanel.hidden) return;
      this.queuePanel.hidden = true;
      this.queueButton.setAttribute('aria-expanded', 'false');
      this.queueSelected = null;
      if (refocus) this.queueButton.focus();
    }

    /** 面板右边缘与播放条对齐，底部在播放条上方；播放条并入歌词界面或隐藏时收起 */
    placeQueue() {
      if (this.queuePanel.hidden) return;
      if (this.root.hidden || this.root.closest('.lyrics-controls')) { this.closeQueue(); return; }
      const win = this.root.ownerDocument.defaultView;
      const bar = this.root.getBoundingClientRect();
      this.queuePanel.style.right = `${Math.max(12, win.innerWidth - bar.right)}px`;
      this.queuePanel.style.bottom = `${win.innerHeight - bar.top + 10}px`;
    }

    renderQueueLang() {
      const label = t('player.queue');
      this.queueButton.setAttribute('aria-label', label);
      this.queueButton.title = label;
      this.queuePanel.setAttribute('aria-label', label);
      this.queuePanel.querySelector('.queue-title').textContent = label;
      this.queuePanel.querySelector('.queue-clear').textContent = t('player.queueClear');
      this.queuePanel.querySelector('.queue-empty').textContent = t('player.queueEmpty');
      this.renderModes();
      this.renderQueue(true);
    }

    /** 面板打开时重绘列表；队列与播放状态未变时跳过，拖动中不重绘 */
    renderQueue(force = false) {
      if (!this.queuePanel || this.queuePanel.hidden || (this.queueDrag && !force)) return;
      const q = this.queue;
      const upcoming = q ? q.entries.slice(q.pos + 1) : [];
      const key = q ? `${q.pos}|${q.entries.map((e) => e.track).join(',')}` : '';
      if (!force && key === this.queueKey) return;
      this.queueKey = key;
      this.queuePanel.querySelector('.queue-empty').hidden = upcoming.length > 0;
      this.queuePanel.querySelector('.queue-clear').hidden = !upcoming.length;
      const doc = this.root.ownerDocument;
      const list = this.queuePanel.querySelector('.queue-list');
      const focused = doc.activeElement && list.contains(doc.activeElement);
      list.replaceChildren(...upcoming.map((entry, i) => {
        const li = doc.createElement('li');
        li.className = 'queue-item';
        li.classList.toggle('selected', entry === this.queueSelected);
        li.dataset.index = String(q.pos + 1 + i);
        li.tabIndex = 0;
        li.title = t('player.queueHint');
        li.innerHTML = '<span class="queue-art-wrap"><img class="queue-art" alt="" loading="lazy" draggable="false">'
          + `<button class="queue-remove" type="button">${ICON_REMOVE}</button></span>`
          + '<span class="queue-text"><span class="queue-name"></span><span class="queue-artist"></span></span>'
          + `<span class="queue-time"></span><span class="queue-grip" aria-hidden="true">${ICON_GRIP}</span>`;
        const art = li.querySelector('.queue-art');
        if (entry.artwork) art.src = entry.artwork; else art.removeAttribute('src');
        li.querySelector('.queue-name').textContent = entry.name || t('player.unknownTitle');
        li.querySelector('.queue-artist').textContent = entry.artist || '';
        li.querySelector('.queue-time').textContent = entry.duration ? formatTime(entry.duration / 1000) : '';
        const remove = li.querySelector('.queue-remove');
        remove.tabIndex = -1;
        remove.setAttribute('aria-label', t('player.queueRemove', { name: entry.name || '' }));
        remove.title = t('player.queueRemove', { name: entry.name || '' });
        return li;
      }));
      if (focused && !list.contains(doc.activeElement)) this.queueButton.focus();
    }

    /* ---------- 随机播放与重复播放：状态保存在本地，与 Apple Music 相同，开启时按钮反色 ---------- */

    /** 开启随机时打乱当前曲目之后的歌曲并记住原顺序；关闭时从当前曲目在原顺序中的位置继续 */
    setShuffle(on) {
      this.shuffle = on;
      try { localStorage.setItem('am-hook:shuffle', on ? '1' : '0'); } catch {}
      const q = this.queue;
      if (q && on && !q.ordered) {
        q.ordered = q.entries.slice();
        shuffleFrom(q.entries, q.pos + 1);
      } else if (q && !on && q.ordered) {
        const rest = new Set(q.entries.slice(q.pos + 1));
        const at = q.ordered.indexOf(q.entries[q.pos]);
        q.entries.splice(q.pos + 1, Infinity, ...q.ordered.slice(at + 1).filter((entry) => rest.has(entry)));
        q.ordered = null;
      }
      this.renderModes();
      this.renderQueue(true);
    }

    /** 关 → 全部重复 → 单曲重复 → 关 */
    cycleRepeat() {
      this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
      try { localStorage.setItem('am-hook:repeat', this.repeat); } catch {}
      this.renderModes();
    }

    /** 播放条与清单标题旁的随机 / 重复按钮，以及上一首 / 下一首是否可用 */
    renderModes() {
      if (!this.queuePanel) return;
      const shuffleLabel = t('player.shuffle');
      const repeatLabel = t(`player.repeat.${this.repeat}`);
      for (const scope of [this.root, this.queuePanel]) {
        for (const btn of scope.querySelectorAll('.player-shuffle')) {
          btn.setAttribute('aria-pressed', String(this.shuffle));
          btn.setAttribute('aria-label', shuffleLabel);
          btn.title = shuffleLabel;
        }
        for (const btn of scope.querySelectorAll('.player-repeat')) {
          btn.setAttribute('aria-pressed', String(this.repeat !== 'off'));
          btn.setAttribute('aria-label', repeatLabel);
          btn.title = repeatLabel;
          if (btn.dataset.mode !== this.repeat) {
            btn.dataset.mode = this.repeat;
            btn.innerHTML = this.repeat === 'one' ? ICON_REPEAT_ONE : ICON_REPEAT;
          }
        }
      }
      const prev = this.$('.skip-prev');
      const next = this.$('.skip-next');
      if (prev) prev.disabled = !this.current;
      if (next) next.disabled = !this.hasNext();
    }

    hasNext() {
      const q = this.queue;
      return !!this.current && (!!(q && q.entries[q.pos + 1]) || this.repeat === 'all');
    }

    /** 下一首；auto 为播放到结尾时自动切换（单曲重复只在这时生效，手动下一首照常切歌） */
    next(auto = false) {
      if (!this.current) return;
      const q = this.queue;
      if (auto && this.repeat === 'one') { this.restart(); return; }
      if (q && q.entries[q.pos + 1]) { this.playAt(q.pos + 1); return; }
      if (this.repeat !== 'all') return;
      if (q && q.entries.length > 1) this.playAt(0); else this.restart();
    }

    /** 与 Apple Music 相同：已播放超过 3 秒时回到开头，否则上一首（全部重复时从第一首回到最后一首） */
    previous() {
      if (!this.current) return;
      const q = this.queue;
      const first = !q || q.pos === 0;
      if (this.transport().currentTime > 3 || (first && (this.repeat !== 'all' || !q || q.entries.length < 2))) { this.restart(); return; }
      this.playAt(first ? q.entries.length - 1 : q.pos - 1);
    }

    restart() {
      const transport = this.transport();
      transport.currentTime = 0;
      if (transport.paused) transport.play().catch((err) => this.showError(err.message));
    }

    /** 显示播放条，页面按其高度留出底部空间（通知、错误信息换行时高度会变） */
    show() {
      this.root.hidden = false;
      this.layout();
    }

    /** 播放条上边缘的位置（外壳的 iframe 铺满窗口，与页面中的坐标相同），隐藏时为 Infinity */
    barTop() {
      return this.root.hidden ? Infinity : this.root.getBoundingClientRect().top;
    }

    layout() {
      const height = `${this.root.getBoundingClientRect().height}px`;
      for (const doc of this.docs) {
        if (!doc.defaultView) { this.docs.delete(doc); continue; } // iframe 已跳转到其他页面
        if (!doc.body) continue;
        doc.body.style.setProperty('--player-height', height);
        doc.body.classList.toggle('has-player', !this.root.hidden);
      }
      this.placeQueue();
    }

    /**
     * iframe 中的页面使用外壳的播放条：返回与 AmPlayer 相同用法的接口。
     * 页面跳转后其文档失效，注册的回调随之移除。
     */
    connect(win) {
      const doc = win.document;
      if (!this.docs.has(doc)) {
        this.docs.add(doc);
        this.bindKeys(doc);
        this.layout();
      }
      const player = this;
      const scoped = (set) => (fn) => {
        const wrapped = (...args) => {
          if (!doc.defaultView) { set.delete(wrapped); return; }
          fn(...args);
        };
        set.add(wrapped);
      };
      // 条目在外壳中保存，复制为外壳的对象，页面卸载后仍可使用
      const copy = (item) => ({ ...item, artists: (item.artists || []).map(({ name, href }) => ({ name, href })) });
      return {
        shared: true,
        get current() { return player.current; },
        get pendingTrack() { return player.pendingTrack; },
        get audio() { return player.audio; },
        transport: () => player.transport(),
        barTop: () => player.barTop(),
        play: (item) => player.play(copy(item)),
        playQueue: (entries, pos, options) => player.playQueue(entries.map(copy), pos, { ...options }),
        toggle: () => player.toggle(),
        pause: () => player.pause(),
        onChange: scoped(this.listeners),
        onUnsupported: scoped(this.unsupportedListeners),
      };
    }

    duration() {
      if (this.current && this.current.duration) return this.current.duration;
      return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }

    /**
     * item: { id, codecs, m3u8Url, hookM3u8Url, hookFileUrl, label, badge, title, artist, artists, album, href, albumHref, artwork }
     * artists: [{ name, href }]，各位艺人的名字与本站艺人页路径；href / albumHref 为本站歌曲页、专辑页路径；
     * badge 为音质标签（见 qualityBadge）；以上均可省略
     * m3u8Url 为 CDN 原始地址（浏览器解密）；hook* 为服务端解密地址，仅 --hook 时存在。
     */
    async play(item) {
      // 单独播放另一首歌时结束队列；同一首歌切换音质时保留
      if (this.queue && item.track !== this.queue.entries[this.queue.pos].track) this.clearQueue();
      return this.start(item);
    }

    /**
     * entries：按原顺序排列的曲目（见 resolveEntry）；从 pos 开始，播完一首自动播放下一首。
     * options.shuffle 同时开启 / 关闭随机播放（页面上的「随机播放」「播放」按钮），省略时沿用当前状态。
     * 随机播放时 pos 处的歌曲排在最前，其余打乱；原顺序记在 ordered 中，关闭随机时恢复。
     */
    playQueue(entries, pos = 0, options = {}) {
      if (typeof options.shuffle === 'boolean' && options.shuffle !== this.shuffle) {
        this.shuffle = options.shuffle;
        try { localStorage.setItem('am-hook:shuffle', this.shuffle ? '1' : '0'); } catch {}
      }
      this.queue = { entries, pos, ordered: null };
      if (this.shuffle) {
        this.queue.ordered = entries.slice();
        entries.unshift(...entries.splice(pos, 1));
        shuffleFrom(entries, 1);
        this.queue.pos = 0;
      }
      return this.playAt(this.queue.pos);
    }

    clearQueue() {
      this.queue = null;
      this.queueSerial++;
      this.pendingTrack = null;
    }

    async playAt(pos) {
      const entry = this.queue.entries[pos];
      this.queue.pos = pos;
      const serial = ++this.queueSerial;
      this.pendingTrack = entry.track;
      this.emit();
      try {
        const item = await resolveEntry(entry);
        if (serial !== this.queueSerial) return;
        this.pendingTrack = null;
        await this.start(item);
      } catch (err) {
        if (serial !== this.queueSerial) return;
        this.pendingTrack = null;
        this.showError(() => (err.noPlayable ? err.message : t('album.trackFailed', { name: entry.name, msg: err.message })));
      }
      this.emit();
    }

    async start(item) {
      if (this.current && this.current.id === item.id) { this.toggle(); return; }
      const modes = detectModes(item.codecs, this.audio, !!item.hookM3u8Url);
      if (!modes.length) {
        this.showError(() => t('player.errorCodec', { codecs: item.codecs, hint: fallbackHint(item) }));
        return;
      }
      const token = ++this.playToken;
      // 同一首歌切换音质时从当前位置继续；专辑页换曲（track 不同）从头播放
      const resumeAt = this.current && this.current.track === item.track ? this.transport().currentTime : 0;
      this.current = { ...item, mode: modes[0], duration: 0 };
      this.show();
      this.showError('');
      this.renderTrackText();
      const art = this.$('.player-art');
      if (item.artwork) {
        if (art.getAttribute('src') !== item.artwork) art.src = item.artwork;
      } else if (art.hasAttribute('src')) {
        art.removeAttribute('src');
      }
      this.setLoading(true);
      this.emit();
      this.updateMediaSession();

      // 依次尝试各播放方式，前一种因编码/格式不支持失败时自动换下一种
      let lastError = null;
      for (const mode of modes) {
        if (token !== this.playToken) return;
        this.current.mode = mode;
        this.current.duration = 0;
        this.renderMode();
        this.attempting = true;
        try {
          await this.tryMode(mode, item, resumeAt, token);
          this.attempting = false;
          this.renderProgress();
          return;
        } catch (err) {
          this.attempting = false;
          if (token !== this.playToken) return;
          if (err && err.name === 'NotAllowedError') {
            this.setLoading(false);
            this.showError(() => t('player.errorAutoplay'));
            return;
          }
          lastError = err;
          console.warn(`[am-hook] ${mode} 播放失败，尝试下一种方式`, err);
        }
      }

      this.teardown();
      failedCodecs.add(item.codecs);
      this.unsupportedListeners.forEach((fn) => fn(item.codecs));
      const detail = lastError && lastError.message ? ` (${lastError.message})` : '';
      this.showError(() => t('player.errorFailed', { label: item.label || item.codecs, codecs: item.codecs, hint: fallbackHint(item) }) + detail);
      this.emit();
    }

    teardown() {
      this.mse.destroy();
      if (this.pcm) { this.pcm.destroy(); this.pcm = null; }
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }

    async tryMode(mode, item, resumeAt, token) {
      this.teardown();
      if (mode === 'ec3') {
        this.pcm = new PcmEngine(() => this.updatePcm(), (err) => this.showError(err.message || String(err)), () => this.ended());
        this.pcm.gain.gain.value = this.audio.volume;
        await this.pcm.load(item.m3u8Url);
        if (token !== this.playToken) return;
        this.current.duration = this.pcm.duration;
        if (resumeAt > 0) await this.pcm.seek(resumeAt);
        await this.pcm.play();
        return;
      }
      if (mode === 'mse' || mode === 'flac') {
        await this.mse.load(item.m3u8Url, item.codecs, (err) => this.showError(err.message || String(err)), mode === 'flac');
        if (token !== this.playToken) return;
        this.current.duration = this.mse.playlist ? this.mse.playlist.duration : 0;
      } else {
        this.audio.src = mode === 'hls' ? byterangeUrl(item.hookM3u8Url) : item.hookFileUrl;
      }
      if (resumeAt > 0) this.audio.currentTime = resumeAt;
      await this.audio.play();
    }

    /** 某编码经实际尝试确认无法播放时回调 */
    onUnsupported(fn) { this.unsupportedListeners.add(fn); }

    /** 当前曲目播放到结尾（audio 与 EC-3 PCM 两种方式）：按重复模式播放下一首或重新播放 */
    ended() { if (this.current) this.next(true); }

    toggle() {
      if (!this.current) return;
      const transport = this.transport();
      if (transport.paused) transport.play().catch((err) => this.showError(err.message)); else transport.pause();
    }

    /** 其他媒体（如 MV）开始播放时暂停 */
    pause() {
      if (this.current && !this.transport().paused) this.transport().pause();
    }

    seekBy(delta) {
      const d = this.duration();
      if (!d) return;
      const transport = this.transport();
      transport.currentTime = Math.min(Math.max(0, transport.currentTime + delta), d - 0.1);
    }

    setLoading(on) {
      this.loading = on;
      this.renderToggle();
    }

    renderToggle() {
      const a = this.transport();
      const waiting = this.loading && a.paused || (!a.paused && this.current.mode !== 'ec3' && a.readyState < 3);
      if (!a.paused) this.loading = false;
      const btn = this.$('.player-toggle');
      btn.innerHTML = waiting ? ICON_LOADING : (a.paused ? ICON_PLAY : ICON_PAUSE);
      btn.setAttribute('aria-label', t(a.paused ? 'player.play' : 'player.pause'));
    }

    renderProgress() {
      const d = this.duration();
      const transport = this.transport();
      const t = this.dragRatio !== undefined ? this.dragRatio * d : transport.currentTime;
      const ratio = d ? Math.min(1, t / d) : 0;
      this.$('.seek-fill').style.width = `${ratio * 100}%`;
      this.$('.seek-thumb').style.left = `${ratio * 100}%`;
      let bufEnd = 0;
      if (this.current && this.current.mode === 'ec3' && this.pcm) {
        bufEnd = this.pcm.loadedUntil;
      } else {
        const b = this.audio.buffered;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= transport.currentTime + 0.5) bufEnd = Math.max(bufEnd, b.end(i));
        }
      }
      this.$('.seek-buffer').style.width = `${d ? Math.min(1, bufEnd / d) * 100 : 0}%`;
      this.$('.time-cur').textContent = formatTime(t);
      this.$('.time-total').textContent = formatTime(d);
      const seek = this.$('.seek');
      seek.setAttribute('aria-valuemax', String(Math.round(d)));
      seek.setAttribute('aria-valuenow', String(Math.round(t)));
      seek.setAttribute('aria-valuetext', `${formatTime(t)} / ${formatTime(d)}`);
      if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(transport.currentTime, d), playbackRate: 1 }); } catch {}
      }
    }

    updateMediaSession() {
      if (!('mediaSession' in navigator) || !global.MediaMetadata) return;
      const source = this.current.artwork || '';
      if (source !== this.mediaArtSource) {
        if (this.mediaArtController) this.mediaArtController.abort();
        if (this.mediaArtUrl) URL.revokeObjectURL(this.mediaArtUrl);
        this.mediaArtSource = source;
        this.mediaArtController = this.mediaArtUrl = this.mediaArtType = null;
        if (source) {
          // Reuse one local image for every quality of the same song.
          const controller = new AbortController();
          this.mediaArtController = controller;
          fetch(source, { signal: controller.signal, cache: 'force-cache' })
            .then((response) => {
              if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
              return response.blob();
            })
            .then((blob) => {
              if (controller.signal.aborted || this.mediaArtSource !== source) return;
              this.mediaArtUrl = URL.createObjectURL(blob);
              this.mediaArtType = blob.type || 'image/jpeg';
              this.writeMediaMetadata();
            })
            .catch(() => {}); // The player bar still displays the original image.
        }
      }
      this.writeMediaMetadata();
    }

    writeMediaMetadata() {
      const c = this.current;
      const state = {
        title: c.title || '',
        artist: c.artist || '',
        album: c.album || '',
        artwork: this.mediaArtUrl || '',
      };
      const previous = this.mediaMetadataState;
      if (previous && Object.keys(state).every((key) => state[key] === previous[key])) return;
      this.mediaMetadataState = state;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.title,
        artist: state.artist,
        album: state.album,
        artwork: this.mediaArtUrl
          ? [{ src: this.mediaArtUrl, sizes: '600x600', type: this.mediaArtType }]
          : [],
      });
    }

    /** msg 可以是函数，切换语言时重新求值 */
    showError(msg) {
      this.errorMsg = msg || null;
      this.renderError();
      if (msg) {
        this.show();
        this.setLoading(false);
      }
    }

    renderError() {
      const el = this.$('.player-msg');
      const msg = this.errorMsg;
      el.textContent = typeof msg === 'function' ? msg() : (msg || '');
      el.hidden = !msg;
    }
  }

  /** 页面的播放条：在外壳的 iframe 中时使用外壳的播放器（移除页面自己的播放条），否则在页面内创建 */
  function pagePlayer(root) {
    let shell = null;
    try { shell = global.parent !== global && global.parent.AmShell; } catch {}
    if (!shell) return new AmPlayer(root);
    root.remove();
    return shell.attach(global);
  }

  const api = { AmPlayer, pagePlayer, artistNodes, qualityBadge, segmentAt, formatTime, detectMode, detectModes, mimeFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, MseEngine };
  else global.AmHook = api;
})(typeof window !== 'undefined' ? window : globalThis);
