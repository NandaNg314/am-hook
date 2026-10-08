/**
 * utils/metadataAndLyrics.js
 * 
 * 1. Apple Music 目录与原版元数据抓取 (防罗马音变体，精准锁定原版日文/中文名)
 * 2. 纯净 LRC 转换器 (剥离 TTML 翻译与注音，标准 [mm:ss.xx] 输出)
 */

const API_BASE = 'https://amp-api.music.apple.com/v1/catalog';
const WEB_BROWSE_URL = 'https://music.apple.com/us/browse';

// 内存缓存 developer token
let cachedDeveloperToken = null;
let tokenExpiresAt = 0;

/**
 * 语言与文字检测
 * - 包含日文假名 (平假名 \u3040-\u309F, 片假名 \u30A0-\u30FF) -> 判定为日语 (ja-JP)
 * - 包含汉字且无假名 -> 判定为简体中文 (zh-Hans-CN)
 * - 其余西文 -> 默认 en-US
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en-US';
  const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
  if (hasKana) return 'ja-JP';
  const hasHan = /[\u4E00-\u9FA5]/.test(text);
  if (hasHan) return 'zh-Hans-CN';
  return 'en-US';
}

/**
 * 从 Apple Music 网页动态提取 developer JWT token
 */
async function getDeveloperToken() {
  const now = Date.now();
  if (cachedDeveloperToken && now < tokenExpiresAt) {
    return cachedDeveloperToken;
  }

  // 支持环境变量直接传入
  if (process.env.APPLE_DEVELOPER_TOKEN) {
    cachedDeveloperToken = process.env.APPLE_DEVELOPER_TOKEN;
    tokenExpiresAt = now + 12 * 3600 * 1000;
    return cachedDeveloperToken;
  }

  try {
    const res = await fetch(WEB_BROWSE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) throw new Error(`Fetch browse page failed with status ${res.status}`);
    const html = await res.text();

    const scriptMatch = html.match(/src="(\/assets\/index[~-][0-9A-Za-z_-]+\.js)"/);
    if (!scriptMatch) throw new Error('Main index script not found');

    const scriptUrl = `https://music.apple.com${scriptMatch[1]}`;
    const jsRes = await fetch(scriptUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!jsRes.ok) throw new Error(`Fetch script failed with status ${jsRes.status}`);
    const js = await jsRes.text();

    const tokenMatch = js.match(/eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/);
    if (!tokenMatch) throw new Error('JWT token not found in script');

    cachedDeveloperToken = tokenMatch[0];
    tokenExpiresAt = now + 6 * 3600 * 1000; // 缓存 6 小时
    return cachedDeveloperToken;
  } catch (err) {
    if (cachedDeveloperToken) return cachedDeveloperToken;
    throw err;
  }
}

/**
 * 手动设置 developer token (供测试或离线使用)
 */
function setDeveloperToken(token, ttlMs = 3600000) {
  cachedDeveloperToken = token;
  tokenExpiresAt = Date.now() + ttlMs;
}

/**
 * 将 TTML 时间字符串（如 00:01:23.456, 01:23.456, 83.456s, 83.45）转为秒数
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const str = timeStr.trim().replace(/s$/i, '');
  
  if (str.includes(':')) {
    const parts = str.split(':');
    if (parts.length === 3) {
      const [h, m, s] = parts;
      return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
    } else if (parts.length === 2) {
      const [m, s] = parts;
      return parseFloat(m) * 60 + parseFloat(s);
    }
  }
  return parseFloat(str) || 0;
}

/**
 * 将秒数格式化为标准 LRC 时间标签 [mm:ss.xx]
 */
function formatLrcTimestamp(seconds) {
  const safeSec = Math.max(0, seconds);
  const minutes = Math.floor(safeSec / 60);
  const remainingSec = safeSec % 60;
  
  const mStr = String(minutes).padStart(2, '0');
  const sStr = remainingSec.toFixed(2).padStart(5, '0');
  return `[${mStr}:${sStr}]`;
}

/**
 * 解码基础 HTML 实体
 */
function unescapeXml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * 纯净 LRC 转换器
 * 1. 剥离所有 <div type="translation"> 翻译
 * 2. 剥离所有带 pronunciation 属性的注音 <span ...>...</span> 标签
 * 3. 提取原始 <p begin="..."> 文本转为标准 [mm:ss.xx] LRC
 */
function ttmlToLrc(ttmlContent) {
  if (!ttmlContent || typeof ttmlContent !== 'string') return '';

  let cleaned = ttmlContent;

  // 1. 剥离所有翻译块 <div ... type="translation" ...>...</div> 以及 inline translation span
  cleaned = cleaned.replace(/<div[^>]*type=["']translation["'][^>]*>[\s\S]*?<\/div>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-translation["'][^>]*>[\s\S]*?<\/span>/gi, '');

  // 2. 剥离所有显式罗马音/注音 span 标签 (x-roman, pronunciation 标签)
  cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-roman["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*type=["']pronunciation["'][^>]*>[\s\S]*?<\/span>/gi, '');

  // 3. 处理带 pronunciation 属性的注音 span 标签：
  // 若 span 内文本与 pronunciation 注音相同或为纯注音文本，则连同内容一并剥离；
  // 若 span 内包裹的是汉字/假名歌词本身，则仅剥离注音标签与属性，保留纯歌词内容。
  cleaned = cleaned.replace(/<span[^>]*\bpronunciation=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi, (match, pron, innerText) => {
    const rawText = innerText.replace(/<[^>]+>/g, '').trim();
    if (!rawText) return '';
    // 若 innerText 与 pron 相近或 innerText 为纯拉丁音节而 pron 存在，视为注音标签并剔除
    if (rawText.toLowerCase() === pron.trim().toLowerCase() || (/^[a-zA-Z\s'-]+$/.test(rawText) && pron)) {
      return '';
    }
    // 否则保留歌词原文 (去除了 pronunciation 属性)
    return innerText;
  });

  // 4. 提取所有 <p begin="...">...</p>
  const pRegex = /<p[^>]*\bbegin=["']([^"']+)["'][^>]*>([\s\S]*?)<\/p>/gi;
  const lrcLines = [];
  let match;

  while ((match = pRegex.exec(cleaned)) !== null) {
    const beginAttr = match[1];
    let body = match[2];

    // 去掉内部的所有剩余 XML/HTML 标签 (保留纯文字)
    body = body.replace(/<[^>]+>/g, '');
    body = unescapeXml(body).trim();

    if (!body) continue;

    // 格式化时间戳
    const seconds = parseTimeToSeconds(beginAttr);
    const timeTag = formatLrcTimestamp(seconds);

    lrcLines.push(`${timeTag} ${body}`);
  }

  return lrcLines.join('\n');
}

/**
 * 获取歌曲元数据 (彻底防御罗马音变体)
 * 语种精准匹配：
 * - 优先检查曲名是否包含日文假名，若是强制附加 l=ja-JP 并优先请求 storefront=jp
 * - 若 storefront=jp 404 则回退至当前 storefront，但保留 l=ja-JP
 * - 若包含汉字且无假名，附加 l=zh-Hans-CN 锁定简体中文；其余默认 en-US
 */
async function fetchSongMetadata(trackId, options = {}) {
  const defaultStorefront = options.storefront || 'us';
  const devToken = options.developerToken || (await getDeveloperToken());
  const mediaUserToken = options.mediaUserToken;

  const buildHeaders = () => {
    const headers = {
      'Authorization': `Bearer ${devToken}`,
      'Origin': 'https://music.apple.com',
      'Referer': 'https://music.apple.com/'
    };
    if (mediaUserToken) {
      headers['Music-User-Token'] = mediaUserToken;
    }
    return headers;
  };

  // 辅助请求函数
  const requestSong = async (sf, lang) => {
    const url = `${API_BASE}/${sf}/songs/${trackId}?l=${lang}`;
    const res = await fetch(url, { headers: buildHeaders() });
    if (!res.ok) {
      return { status: res.status, data: null };
    }
    const json = await res.json();
    return { status: 200, data: json?.data?.[0] };
  };

  // 1. 初次尝试探测（如果指定了 titleHint 可以直接做语言判定）
  let targetLang = detectLanguage(options.titleHint || '');
  let primarySf = defaultStorefront;

  if (targetLang === 'ja-JP') {
    primarySf = 'jp';
  }

  let result = await requestSong(primarySf, targetLang);

  // 2. 若使用 jp 遇到 404，回退至 defaultStorefront，但依然保留 l=ja-JP
  if (result.status === 404 && primarySf !== defaultStorefront) {
    result = await requestSong(defaultStorefront, targetLang);
  }

  // 3. 若之前没有 hint，根据获取到的 attributes.name 重新判定语言
  if (result.status === 200 && result.data && !options.titleHint) {
    const songName = result.data.attributes?.name || '';
    const realLang = detectLanguage(songName);

    // 如果抓到的名字里包含假名，但之前不是用的 ja-JP，或者包含汉字之前不是 zh-Hans-CN
    if (realLang !== targetLang) {
      targetLang = realLang;
      const retrySf = realLang === 'ja-JP' ? 'jp' : defaultStorefront;
      const retryResult = await requestSong(retrySf, targetLang);
      if (retryResult.status === 200 && retryResult.data) {
        result = retryResult;
      } else if (retrySf !== defaultStorefront) {
        // 回退至原 storefront
        const fallback = await requestSong(defaultStorefront, targetLang);
        if (fallback.status === 200 && fallback.data) {
          result = fallback;
        }
      }
    }
  }

  if (result.status !== 200 || !result.data) {
    return null;
  }

  const attrs = result.data.attributes || {};
  return {
    id: result.data.id,
    title: attrs.name || '',
    artist: attrs.artistName || '',
    albumName: attrs.albumName || '',
    artwork: attrs.artwork,
    durationInMillis: attrs.durationInMillis || 0,
    storefront: primarySf,
    lang: targetLang,
    rawAttributes: attrs
  };
}

/**
 * 获取纯净 LRC 歌词
 * 若曲目无歌词或接口返回 404，安全捕获并返回 null，禁止报错中断下载主流程
 */
async function fetchSongLyrics(trackId, options = {}) {
  const storefront = options.storefront || 'us';
  const lang = options.lang || 'en-US';
  const devToken = options.developerToken || (await getDeveloperToken());
  const mediaUserToken = options.mediaUserToken;

  try {
    const headers = {
      'Authorization': `Bearer ${devToken}`,
      'Origin': 'https://music.apple.com',
      'Referer': 'https://music.apple.com/'
    };
    if (mediaUserToken) {
      headers['Music-User-Token'] = mediaUserToken;
    }

    const url = `${API_BASE}/${storefront}/songs/${trackId}/lyrics?l=${lang}`;
    const res = await fetch(url, { headers });

    if (res.status === 404 || !res.ok) {
      // 安全捕获 404，不中断主流程
      return null;
    }

    const json = await res.json();
    const ttml = json?.data?.[0]?.attributes?.ttml;
    if (!ttml) return null;

    // 转换为纯净 LRC
    return ttmlToLrc(ttml);
  } catch (err) {
    // 捕获网络或其他异常，略过歌词并不中断下载
    return null;
  }
}

module.exports = {
  detectLanguage,
  getDeveloperToken,
  setDeveloperToken,
  parseTimeToSeconds,
  formatLrcTimestamp,
  unescapeXml,
  ttmlToLrc,
  fetchSongMetadata,
  fetchSongLyrics
};
