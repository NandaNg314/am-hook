/**
 * cloud-service.mjs
 * 
 * am-hook VPS 2000M 极速云端转存服务
 * 监听: 127.0.0.1:31409
 * 
 * 核心功能:
 * 1. 接收客户端请求 (adamId 或 hookFileUrl + 元数据 + 歌词 + 目标音质)
 * 2. VPS 内网向 127.0.0.1:31408 请求解密音频流 (Apple CDN 2Gbps 直连，约 0.4s)
 * 3. 并行抓取高清封面并解析纯净歌词
 * 4. 原生免转码 MP4 结构注入元数据与内嵌歌词 (约 0.02s)
 * 5. VPS 极速直传 Gofile 网盘，支持专辑/歌单归集到同一文件夹 (约 1.8s)
 * 6. 可选同步生成并上传独立 .lrc 歌词文件
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

dns.setDefaultResultOrder('ipv4first');

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 自动加载 .env 配置文件 (如果存在)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch {}

const PORT = process.env.CLOUD_PORT || 31409;
const HOST = process.env.CLOUD_HOST || '127.0.0.1';
const HOOK_BASE = process.env.HOOK_BASE || 'http://127.0.0.1:31408';
const WRAPPER_BASE = process.env.WRAPPER_BASE || 'http://127.0.0.1:12340';

// CENC/M4P 老歌 webplayback 回退解密链：ffmpeg 拉加密 fMP4 -> Widevine 换 Key -> cenc-tool 解密
const WV_PY = process.env.WV_PY || '/home/ubuntu/am-hook/tools/wv_env/bin/python';
const WV_KEY_SCRIPT = process.env.WV_KEY_SCRIPT || '/home/ubuntu/am-hook/tools/wv/get_wv_key.py';
const CENC_TOOL_PATH = process.env.CENC_TOOL_PATH || '/home/ubuntu/am-hook/target/release/cenc-tool';

// 繁简字转换字典 (OpenCC 词表)
let t2sMap = {};
try {
  const t2sPath = path.join(__dirname, 't2s.json');
  if (fs.existsSync(t2sPath)) {
    const raw = JSON.parse(fs.readFileSync(t2sPath, 'utf8'));
    if (raw.t && raw.s) {
      const tArr = Array.from(raw.t);
      const sArr = Array.from(raw.s);
      for (let i = 0; i < tArr.length; i++) {
        t2sMap[tArr[i]] = sArr[i];
      }
    } else {
      Object.assign(t2sMap, raw);
    }
  }
} catch (e) {
  console.warn('加载 t2s.json 失败:', e.message);
}

// 补充常用繁简口语字
const EXTRA_T2S = {
  '著': '着',
  '妳': '你',
  '牠': '它',
  '週': '周',
  '裡': '里',
  '麽': '么',
  '係': '系',
  '佈': '布',
  '併': '并',
  '傢': '家',
  '儘': '尽',
  '軼': '轶'
};
Object.assign(t2sMap, EXTRA_T2S);

// 内存级高清封面缓存 (防止整辑下载时频繁向 Apple CDN 请求相同封面触发超时或单曲封面丢失)
const coverCache = new Map(); // url -> { buf: Uint8Array, expiresAt: number }
setInterval(() => {
  const now = Date.now();
  for (const [url, item] of coverCache.entries()) {
    if (now > item.expiresAt) coverCache.delete(url);
  }
}, 30 * 60 * 1000).unref();


/**
 * 繁体中文转简体中文
 * 智能保留：英文、数字、标点符号以及日文假名（若为日语歌则原样保留假名与日本汉字）
 */
function toSimplifiedChinese(text) {
  if (!text || typeof text !== 'string') return text;
  // 如果包含日文假名（平假名 \u3040-\u309F 或 片假名 \u30A0-\u30FF），判定为日语，原样保留
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
    return text;
  }
  let out = '';
  for (const ch of text) {
    out += t2sMap[ch] || ch;
  }
  return out;
}

// 常见港台/海外华语艺人英文艺名、拼音与别名全量映射表 (涵盖主流歌手，杜绝英文艺名)
const CHINESE_ARTIST_ALIASES = {
  // 张惠妹系列
  'amei': '张惠妹',
  'a-mei': '张惠妹',
  'amit': '张惠妹',
  'chang hui-mei': '张惠妹',
  // 陈绮贞 / 陈奕迅 / 方大同
  'cheer chen': '陈绮贞',
  'chen chi-chen': '陈绮贞',
  'eason chan': '陈奕迅',
  'chan yik-shun': '陈奕迅',
  'khalil fong': '方大同',
  // 周杰伦 / 陶喆 / 王力宏 / 林俊杰
  'jay chou': '周杰伦',
  'chou chieh-lun': '周杰伦',
  'david tao': '陶喆',
  'tao che-sheng': '陶喆',
  'wang leehom': '王力宏',
  'leehom wang': '王力宏',
  'jj lin': '林俊杰',
  'wayne lin': '林俊杰',
  // 中国摇滚 / 民谣系列
  'zhang chu': '张楚',
  'dou wei': '窦唯',
  'he yong': '何勇',
  'tang dynasty': '唐朝',
  'black panther': '黑豹',
  'cui jian': '崔健',
  'wang feng': '汪峰',
  'xu wei': '许巍',
  'pu shu': '朴树',
  // 王菲 / 邓紫棋 / 蔡依林 / 孙燕姿
  'faye wong': '王菲',
  'shirley wong': '王菲',
  'g.e.m.': '邓紫棋',
  'gem': '邓紫棋',
  'g.e.m': '邓紫棋',
  'gloria tang': '邓紫棋',
  'jolin tsai': '蔡依林',
  'tsai i-ling': '蔡依林',
  'stefanie sun': '孙燕姿',
  'sun yan-zi': '孙燕姿',
  // 梁静茹 / 五月天 / 苏打绿 / 卢广仲 / 林宥嘉
  'fish leong': '梁静茹',
  'jasmine leong': '梁静茹',
  'mayday': '五月天',
  'sodagreen': '苏打绿',
  'oaeen': '苏打绿',
  'crowd lu': '卢广仲',
  'lu kwang-chung': '卢广仲',
  'yoga lin': '林宥嘉',
  'lin yu-chia': '林宥嘉',
  // S.H.E / 田馥甄 / 任家萱 / 陈嘉桦
  's.h.e': 'S.H.E',
  'she': 'S.H.E',
  'hebe tien': '田馥甄',
  'hebe': '田馥甄',
  'selina ren': '任家萱',
  'selina': '任家萱',
  'ella chen': '陈嘉桦',
  'ella': '陈嘉桦',
  // 蔡健雅 / 戴佩妮 / 刘若英 / 莫文蔚
  'tanya chua': '蔡健雅',
  'penny tai': '戴佩妮',
  'rene liu': '刘若英',
  'karen mok': '莫文蔚',
  // 杨丞琳 / 王心凌 / 周兴哲 / 萧敬腾 / 杨宗纬
  'rainie yang': '杨丞琳',
  'cyndi wang': '王心凌',
  'eric chou': '周兴哲',
  'jam hsiao': '萧敬腾',
  'aska yang': '杨宗纬',
  // 安溥 / 张悬 / 魏如萱 / 徐佳莹 / 艾怡良 / 王若琳 / 黄丽玲
  'anpu': '安溥',
  'deserts chang': '张悬',
  'waa wei': '魏如萱',
  'lala hsu': '徐佳莹',
  'eve ai': '艾怡良',
  'joanna wang': '王若琳',
  'a-lin': '黄丽玲',
  'alin': '黄丽玲',
  'huang li-ling': '黄丽玲',
  // 四大天王 & 乐坛巨星
  'jacky cheung': '张学友',
  'andy lau': '刘德华',
  'aaron kwok': '郭富城',
  'leon lai': '黎明',
  'leslie cheung': '张国荣',
  'anita mui': '梅艳芳',
  'teresa teng': '邓丽君',
  'beyond': 'Beyond',
  'wakin chau': '周华健',
  'emil chau': '周华健',
  'emil wakin chau': '周华健',
  'jonathan lee': '李宗盛',
  'chyi chin': '齐秦',
  'chyi yu': '齐豫',
  'dave wang': '王杰',
  'jeff chang': '张信哲',
  'phil chang': '张宇',
  'angus tung': '童安格',
  'samuel tai': '邰正宵',
  'steve chou': '周传雄',
  'harlem yu': '庾澄庆',
  'george lam': '林子祥',
  'sally yeh': '叶倩文',
  'sandy lam': '林忆莲',
  'priscilla chan': '陈慧娴',
  'vivian chow': '周慧敏',
  'kelly chen': '陈慧琳',
  'sammi cheng': '郑秀文',
  'gigi leung': '梁咏琪',
  'coco lee': '李玟',
  // 香港中生代与新生代
  'hins cheung': '张敬轩',
  'joey yung': '容祖儿',
  'leo ku': '古巨基',
  'miriam yeung': '杨千嬅',
  'hacken lee': '李克勤',
  'edison chen': '陈冠希',
  'shawn yue': '余文乐',
  'pakho chau': '周柏豪',
  'terence lam': '林家谦',
  'keung to': '姜涛',
  'anson lo': '卢瀚霆',
  'mc cheung': '张天赋',
  'gareth.t': '汤令山',
  'jay fung': '冯允谦',
  'aga': 'AGA 江海迦',
  'gin lee': '李幸倪',
  'jace chan': '陈凯咏',
  'cloud wan': '云浩影',
  'panther chan': '陈蕾',
  'kaho hung': '洪嘉豪',
  'jeffrey ngai': '魏浚笙',
  'mike tsang': '曾比特',
  'gigi yim': '炎明熹',
  // 独立乐团与新潮乐队
  'accusefive': '告五人',
  'deca joins': 'deca joins',
  'sunset rollercoaster': '落日飞车',
  'omnipotent youth society': '万能青年旅店',
  'new pants': '新裤子',
  'second hand rose': '二手玫瑰',
  'no party for cao dong': '草东没有派对',
  'my little airport': 'my little airport',
  // 内地主流唱作人与流行艺人
  'yicheng shen': '沈以诚',
  'joker xue': '薛之谦',
  'vae xu': '许嵩',
  'silence wang': '汪苏泷',
  'ronghao li': '李荣浩',
  'hua chenyu': '华晨宇',
  'mao buyi': '毛不易',
  'charlie zhou': '周深',
  'tia ray': '袁娅维',
  'lexie liu': '刘柏辛',
  'jackson wang': '王嘉尔',
  'lay zhang': '张艺兴',
  'mc hotdog': '热狗',
  'soft lipa': '蛋堡',
  'higher brothers': '更高兄弟',
  'yico tseng': '曾轶可',
  'tseng yico': '曾轶可',
  'yico': '曾轶可',
  'leah dou': '窦靖童',
  'elva hsiao': '萧亚轩',
  'angela chang': '张韶涵',
  'angela zhang': '张韶涵',
  'yisa yu': '郁可唯',
  'sara liu': '刘惜君',
  'jane zhang': '张靓颖',
  'chris lee': '李宇春',
  'bibi zhou': '周笔畅',
  'shang wenjie': '尚雯婕',
  'tan weiwei': '谭维维',
  'della ding': '丁当',
  'ding dang': '丁当',
  'momo wu': '吴莫愁',
  'curley g': '希林娜依·高',
  'vava': '毛衍七',
  'sunnee': '杨芸晴',
  'amber kuo': '郭采洁',
  'valen hsu': '许茹芸',
  'tarcy su': '苏慧伦',
  'winnie hsin': '辛晓琪',
  'mavis fan': '范晓萱',
  'shunza': '顺子',
  'wanfang': '万芳',
  'peggy hsu': '许哲珮'
};

/**
 * 规范化艺人名称：
 * 1. 优先查阅港台英文艺名/官方别名映射表 (如 aMEI -> 张惠妹, Eason Chan -> 陈奕迅)
 * 2. 支持合唱形式拆分处理 (如 "aMEI & Jay Chou" -> "张惠妹 & 周杰伦")
 * 3. 繁体中文自动规范为简体 (日语平假名/片假名保持原貌)
 */
function normalizeArtistName(rawArtist) {
  if (!rawArtist || typeof rawArtist !== 'string') return rawArtist;
  const trimmed = rawArtist.trim();
  const lower = trimmed.toLowerCase();

  // 1. 直接命中别名映射
  if (CHINESE_ARTIST_ALIASES[lower]) {
    return CHINESE_ARTIST_ALIASES[lower];
  }

  // 2. 多艺人合唱形式拆分判定 (&, feat., ft., 逗号, 斜杠)
  const splitRegex = /(\s*(?:,|&|\/|feat\.|ft\.)\s*)/i;
  if (splitRegex.test(trimmed)) {
    const parts = trimmed.split(splitRegex);
    let matched = false;
    const mapped = parts.map((part, idx) => {
      if (idx % 2 === 0) {
        const pLower = part.trim().toLowerCase();
        if (CHINESE_ARTIST_ALIASES[pLower]) {
          matched = true;
          return CHINESE_ARTIST_ALIASES[pLower];
        }
        return toSimplifiedChinese(part);
      }
      return part;
    }).join('');
    if (matched) return mapped;
  }

  return toSimplifiedChinese(trimmed);
}

/**
 * 封装 ZIP 归档文件
 * 使用 python3 zipfile 进行封装：
 * 1. 强制写入 PKZIP Bit 11 (0x800) UTF-8 标识位，彻底解决 Windows 资源管理器打开含中日韩字符 ZIP 乱码、报损坏或空白的问题
 * 2. 采用 ZIP_STORED (Store 0，无额外压缩计算)，直接流式打包，速度极快
 */
async function packZipFolder(sourceDir, outputZipPath, fileList = null) {
  const zipScript = path.join(__dirname, 'zip_pack.py');
  const args = [zipScript, outputZipPath, sourceDir];
  if (Array.isArray(fileList) && fileList.length) args.push(...fileList);
  // 大专辑（100+ 曲/多卷）单卷打包可能数分钟，放宽至 600s 防止中途超时残留空 zip
  await execFileAsync('python3', args, { timeout: 600000 });
}

// Gofile 服务器缓存 (缓存 5 分钟)
let cachedServer = null;
let serverExpiresAt = 0;

async function getGofileServer() {
  const now = Date.now();
  if (cachedServer && now < serverExpiresAt) {
    return cachedServer;
  }
  try {
    const res = await fetch('https://api.gofile.io/servers', { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    if (json.status === 'ok' && json.data && json.data.servers && json.data.servers.length) {
      cachedServer = json.data.servers[0].name;
      serverExpiresAt = now + 5 * 60 * 1000;
      return cachedServer;
    }
  } catch (err) {
    console.warn('[Gofile] 获取服务器列表失败:', err.message);
  }
  return cachedServer || 'store1';
}

/* ==================== TTML 纯净 LRC 转换 ==================== */

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

function formatLrcTimestamp(seconds) {
  const safeSec = Math.max(0, seconds);
  const minutes = Math.floor(safeSec / 60);
  const remainingSec = safeSec % 60;
  const mStr = String(minutes).padStart(2, '0');
  const sStr = remainingSec.toFixed(2).padStart(5, '0');
  return `[${mStr}:${sStr}]`;
}

function unescapeXml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseLyrics(ttmlContent) {
  if (!ttmlContent || typeof ttmlContent !== 'string' || !ttmlContent.trim()) {
    return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
  }

  let cleaned = ttmlContent;
  // 1. 剥离所有翻译块与注音标签
  cleaned = cleaned.replace(/<div[^>]*type=["']translation["'][^>]*>[\s\S]*?<\/div>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-translation["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-roman["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*type=["']pronunciation["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*\bpronunciation=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi, (match, pron, innerText) => {
    const rawText = innerText.replace(/<[^>]+>/g, '').trim();
    if (!rawText) return '';
    if (rawText.toLowerCase() === pron.trim().toLowerCase() || (/^[a-zA-Z\s'-]+$/.test(rawText) && pron)) return '';
    return innerText;
  });

  // 2. 匹配所有 <p> 标签（无论是否有 begin 属性）
  const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  const timedLines = [];
  const plainLines = [];
  let match;

  while ((match = pRegex.exec(cleaned)) !== null) {
    const pAttrs = match[1] || '';
    let body = match[2].replace(/<[^>]+>/g, '');
    body = unescapeXml(body).trim();
    if (!body) continue;

    plainLines.push(body);

    const beginMatch = pAttrs.match(/\bbegin=["']([^"']+)["']/i);
    if (beginMatch) {
      const seconds = parseTimeToSeconds(beginMatch[1]);
      timedLines.push(`${formatLrcTimestamp(seconds)} ${body}`);
    }
  }

  if (plainLines.length === 0) {
    return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
  }

  const isDynamic = timedLines.length > 0;
  // 若有动态时间轴，LRC 为带时间戳的格式；若无动态时间轴，自动降级为纯文本行
  const lrc = isDynamic ? timedLines.join('\n') : plainLines.join('\n');
  const plain = plainLines.join('\n');

  return {
    hasLyrics: true,
    isDynamic,
    lrc,
    plain,
    ttml: ttmlContent
  };
}

/* ==================== 官方翻译 → 双语 LRC ==================== */

// TTML 的 <translations><translation xml:lang="zh-Hans"><text for="L1">译文</text>...
// 通过 itunes:key 与原文 <p> 一一对齐。译文可含 <span ttm:role="x-bg">(和声)</span> 背景和声，剥离生成干净中文。
function buildBilingualLrc(ttmlContent, targetLang = 'zh-Hans-CN') {
  if (!ttmlContent || typeof ttmlContent !== 'string' || !ttmlContent.trim()) {
    return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
  }

  // 原文已是中文：跳过翻译，直接返回 null 让上层降级为单语原文
  const rootLang = (ttmlContent.match(/<tt\b[^>]*xml:lang=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
  if (rootLang.startsWith('zh')) return null;

  // 1. 提取翻译块：优先目标语言（zh-Hans），退回任意 language、排除自动生成
  let translationBlock = '';
  const translationRegex = /<translation\b[^>]*xml:lang=["']([^"']+)["'][^>]*>([\s\S]*?)<\/translation>/gi;
  const allTranslations = [];
  let tMatch;
  while ((tMatch = translationRegex.exec(ttmlContent)) !== null) {
    const lang = (tMatch[1] || '').toLowerCase();
    const auto = /\bautomaticallyCreated=["'](true|1)["']/i.test(tMatch[0]);
    const body = tMatch[2];
    allTranslations.push({ lang, auto, body });
    const langBase = lang.split('-')[0];
    const wantBase = targetLang.split('-')[0];
    if (!translationBlock && lang === targetLang.toLowerCase() && !auto) {
      translationBlock = body;
    } else if (!translationBlock && langBase === wantBase && !auto) {
      translationBlock = body;
    }
  }
  if (!translationBlock) {
    // 退回首个非自动翻译
    const fallback = allTranslations.find((t) => !t.auto) || allTranslations[0];
    translationBlock = fallback ? fallback.body : '';
  }
  if (!translationBlock) {
    // 无翻译：返回原文的单语解析结果（优雅降级）
    return null;
  }

  // 2. 建立 for=KEY -> 译文文本 映射（剥离背景和声 span，仅保留正文）
  const transMap = {};
  const textRegex = /<text\b[^>]*for=["']([^"']+)["'][^>]*>([\s\S]*?)<\/text>/gi;
  let textMatch;
  while ((textMatch = textRegex.exec(translationBlock)) !== null) {
    const key = textMatch[1];
    const raw = textMatch[2]
      .replace(/<span[^>]*ttm:role=["']x-bg["'][^>]*>[\s\S]*?<\/span>/gi, '') // 剥离背景和声
      .replace(/<[^>]+>/g, '');
    const text = unescapeXml(raw).trim();
    if (key && text) transMap[key] = text;
  }

  // 3. 遍历原文 <p begin itunes:key>，按时间戳生成 原文 + 译文 双行
  const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  const lrcLines = [];
  let pMatch;
  while ((pMatch = pRegex.exec(ttmlContent)) !== null) {
    const pAttrs = pMatch[1] || '';
    const body = unescapeXml(pMatch[2].replace(/<[^>]+>/g, '')).trim();
    if (!body) continue;
    const beginMatch = pAttrs.match(/\bbegin=["']([^"']+)["']/i);
    const keyMatch = pAttrs.match(/\bitunes:key=["']([^"']+)["']/i);
    if (!beginMatch) continue;
    const seconds = parseTimeToSeconds(beginMatch[1]);
    const ts = formatLrcTimestamp(seconds);
    lrcLines.push(`${ts} ${body}`);
    if (keyMatch && transMap[keyMatch[1]]) {
      lrcLines.push(`${ts} ${transMap[keyMatch[1]]}`);
    }
  }

  if (lrcLines.length === 0) {
    return null;
  }
  return {
    hasLyrics: true,
    isDynamic: true,
    lrc: lrcLines.join('\n'),
    plain: lrcLines.join('\n'),
    ttml: ttmlContent
  };
}

/* ==================== 原生 MP4 标签注入 ==================== */

function createDataAtom(type, flags, payload) {
  // MP4 fourcc 必须精确 4 字节，非 ASCII (如 \xa9) 必须用 charCodeAt 保证单字节
  const typeBytes = Uint8Array.from(type, c => c.charCodeAt(0));
  const dataHeader = new Uint8Array(16);
  const dataView = new DataView(dataHeader.buffer);
  const dataSize = 16 + payload.length;
  dataView.setUint32(0, dataSize, false);
  dataHeader.set(new TextEncoder().encode('data'), 4);
  dataView.setUint32(8, flags, false);
  dataView.setUint32(12, 0, false);

  const atomSize = 8 + dataSize;
  const atomHeader = new Uint8Array(8);
  new DataView(atomHeader.buffer).setUint32(0, atomSize, false);
  atomHeader.set(typeBytes, 4);

  const res = new Uint8Array(atomSize);
  res.set(atomHeader, 0);
  res.set(dataHeader, 8);
  res.set(payload, 24);
  return res;
}

function createTextAtom(name, text) {
  if (!text) return new Uint8Array(0);
  return createDataAtom(name, 1, new TextEncoder().encode(text));
}

function createTrackAtom(trackNum, totalTracks = 0) {
  const buf = new Uint8Array(8);
  const v = new DataView(buf.buffer);
  v.setUint16(2, Number(trackNum) || 0, false);
  v.setUint16(4, Number(totalTracks) || 0, false);
  return createDataAtom('trkn', 0, buf);
}

function createDiscAtom(discNum, totalDiscs = 0) {
  const buf = new Uint8Array(6);
  const v = new DataView(buf.buffer);
  v.setUint16(2, Number(discNum) || 0, false);
  v.setUint16(4, Number(totalDiscs) || 0, false);
  return createDataAtom('disk', 0, buf);
}

function createCoverAtom(imageBuf) {
  if (!imageBuf || !imageBuf.length) return new Uint8Array(0);
  const isPng = imageBuf[0] === 0x89 && imageBuf[1] === 0x50 && imageBuf[2] === 0x4e && imageBuf[3] === 0x47;
  const flag = isPng ? 14 : 13;
  return createDataAtom('covr', flag, imageBuf);
}

function tagMp4(mp4Bytes, tags) {
  const atoms = [];
  if (tags.title) atoms.push(createTextAtom('\xa9nam', tags.title));
  if (tags.artist) atoms.push(createTextAtom('\xa9ART', tags.artist));
  if (tags.album) atoms.push(createTextAtom('\xa9alb', tags.album));
  if (tags.albumArtist) atoms.push(createTextAtom('aART', tags.albumArtist));
  if (tags.date) atoms.push(createTextAtom('\xa9day', String(tags.date)));
  if (tags.genre) atoms.push(createTextAtom('\xa9gen', tags.genre));
  if (tags.composer) atoms.push(createTextAtom('\xa9wrt', tags.composer));
  if (tags.copyright) atoms.push(createTextAtom('cprt', tags.copyright));
  if (tags.lyrics) atoms.push(createTextAtom('\xa9lyr', tags.lyrics));
  if (tags.trackNumber) atoms.push(createTrackAtom(tags.trackNumber, tags.totalTracks || 0));
  if (tags.discNumber) atoms.push(createDiscAtom(tags.discNumber, tags.totalDiscs || 0));
  if (tags.cover) atoms.push(createCoverAtom(tags.cover));

  const totalPayloadLen = atoms.reduce((sum, a) => sum + a.length, 0);
  if (totalPayloadLen === 0) return mp4Bytes;

  const ilstSize = 8 + totalPayloadLen;
  const fullNewIlst = new Uint8Array(ilstSize);
  new DataView(fullNewIlst.buffer).setUint32(0, ilstSize, false);
  fullNewIlst.set(new TextEncoder().encode('ilst'), 4);
  let pos = 8;
  for (const a of atoms) {
    fullNewIlst.set(a, pos);
    pos += a.length;
  }

  const dv = new DataView(mp4Bytes.buffer, mp4Bytes.byteOffset, mp4Bytes.byteLength);
  let moovOffset = -1;
  let moovSize = 0;
  let mdatOffset = -1;
  let offset = 0;
  while (offset + 8 <= mp4Bytes.length) {
    const size = dv.getUint32(offset, false);
    const type = String.fromCharCode(...mp4Bytes.subarray(offset + 4, offset + 8));
    if (type === 'moov') {
      moovOffset = offset;
      moovSize = size;
      if (mdatOffset !== -1) break;
    }
    if (type === 'mdat') {
      mdatOffset = offset;
      if (moovOffset !== -1) break;
    }
    if (size === 0) break;
    offset += size;
  }
  if (moovOffset === -1) return mp4Bytes;

  const moovBytes = mp4Bytes.subarray(moovOffset, moovOffset + moovSize);
  let udtaOffset = -1;
  let udtaSize = 0;
  let uOffset = 8;
  const mdv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  while (uOffset + 8 <= moovBytes.length) {
    const size = mdv.getUint32(uOffset, false);
    const type = String.fromCharCode(...moovBytes.subarray(uOffset + 4, uOffset + 8));
    if (type === 'udta') {
      udtaOffset = uOffset;
      udtaSize = size;
      break;
    }
    if (size === 0) break;
    uOffset += size;
  }

  // 标准 iTunes Metadata Handler (33 字节，所有播放器与系统属性读取器均强制要求)
  const hdlrBox = new Uint8Array([
    0x00, 0x00, 0x00, 0x21, // size: 33
    0x68, 0x64, 0x6c, 0x72, // 'hdlr'
    0x00, 0x00, 0x00, 0x00, // version & flags
    0x00, 0x00, 0x00, 0x00, // predefined
    0x6d, 0x64, 0x69, 0x72, // handler type: 'mdir'
    0x61, 0x70, 0x70, 0x6c, // handler subtype: 'appl'
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
    0x00                     // name
  ]);

  const metaSize = 12 + hdlrBox.length + fullNewIlst.length;
  const metaBox = new Uint8Array(metaSize);
  new DataView(metaBox.buffer).setUint32(0, metaSize, false);
  metaBox.set(new TextEncoder().encode('meta'), 4);
  metaBox.set(hdlrBox, 12);
  metaBox.set(fullNewIlst, 12 + hdlrBox.length);

  const udtaTotal = 8 + metaBox.length;
  const finalUdta = new Uint8Array(udtaTotal);
  new DataView(finalUdta.buffer).setUint32(0, udtaTotal, false);
  finalUdta.set(new TextEncoder().encode('udta'), 4);
  finalUdta.set(metaBox, 8);

  const newMoovSize = (udtaOffset === -1 ? moovSize : moovSize - udtaSize) + finalUdta.length;
  const newMoov = new Uint8Array(newMoovSize);
  const moovBeforeUdta = udtaOffset === -1 ? moovBytes : moovBytes.subarray(0, udtaOffset);
  const moovAfterUdta = udtaOffset === -1 ? new Uint8Array(0) : moovBytes.subarray(udtaOffset + udtaSize);

  newMoov.set(moovBeforeUdta, 0);
  newMoov.set(finalUdta, moovBeforeUdta.length);
  newMoov.set(moovAfterUdta, moovBeforeUdta.length + finalUdta.length);
  new DataView(newMoov.buffer).setUint32(0, newMoovSize, false);

  const finalMp4 = new Uint8Array(mp4Bytes.length - moovSize + newMoovSize);
  finalMp4.set(mp4Bytes.subarray(0, moovOffset), 0);
  finalMp4.set(newMoov, moovOffset);
  finalMp4.set(mp4Bytes.subarray(moovOffset + moovSize), moovOffset + newMoovSize);

  // ⚠️ moov 增大（注入 udta/meta/ilst）后，若 mdat 位于 moov 之后，整个 mdat 的
  // 文件偏移会后移 delta 字节；stco/co64 记录的是绝对文件偏移，必须同步 +delta，
  // 否则播放器/ffmpeg 按旧偏移读到错误字节流（典型症状：开头能放、随即卡死/杂音）。
  // 普通 HLS fMP4 路径 stbl 为空不受影响；cenc-tool 输出的 progressive MP4 必须有此修补。
  const moovDelta = newMoovSize - moovSize;
  if (moovDelta !== 0 && mdatOffset > moovOffset) {
    const fdv = new DataView(finalMp4.buffer, finalMp4.byteOffset, finalMp4.byteLength);
    const patchStco = (q, end) => {
      while (q + 8 <= end) {
        const size = fdv.getUint32(q, false);
        const type = String.fromCharCode(...finalMp4.subarray(q + 4, q + 8));
        if (type === 'stco' || type === 'co64') {
          const entryCount = fdv.getUint32(q + 12, false);
          const entrySize = type === 'co64' ? 8 : 4;
          const base = q + 16;
          for (let i = 0; i < entryCount; i++) {
            const at = base + i * entrySize;
            if (entrySize === 4) {
              fdv.setUint32(at, fdv.getUint32(at, false) + moovDelta, false);
            } else {
              fdv.setBigUint64(at, fdv.getBigUint64(at, false) + BigInt(moovDelta), false);
            }
          }
        }
        if (size === 0) break;
        q += size;
      }
    };
    // 递归遍历 moov 子树，修补所有 stbl 下的 stco/co64
    const walk = (q, end) => {
      while (q + 8 <= end) {
        const size = fdv.getUint32(q, false);
        const type = String.fromCharCode(...finalMp4.subarray(q + 4, q + 8));
        if (type === 'stbl') patchStco(q + 8, q + size);
        else if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf') walk(q + 8, q + size);
        if (size === 0) break;
        q += size;
      }
    };
    walk(moovOffset + 8, moovOffset + newMoovSize);
  }

  return finalMp4;
}

/**
 * 将 HLS fragmented MP4 (fMP4) 极速解碎片并重封装为标准 Progressive M4A (ftyp M4A, moov faststart, mdat)
 * 采用 ffmpeg -c copy (纯容器重封装，0 编解码，无损音质 100% 保持，耗时仅 ~0.05s)
 * 彻底消除 moof 分片结构，写入完整 stbl 索引与 faststart 头部，
 * 彻底解决 Android ExoPlayer / MediaCodec / 椒盐音乐 等播放器报 "编码错误" (无法识别 moof 分片) 的问题
 */
async function defragMp4Buffer(inputBuf) {
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmpIn = `/tmp/am_defrag_in_${Date.now()}_${rnd}.m4a`;
  const tmpOut = `/tmp/am_defrag_out_${Date.now()}_${rnd}.m4a`;
  try {
    await fs.promises.writeFile(tmpIn, inputBuf);
    await execFileAsync('ffmpeg', [
      '-y',
      '-v', 'error',
      '-i', tmpIn,
      '-c', 'copy',
      '-movflags', '+faststart',
      tmpOut
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const outBuf = await fs.promises.readFile(tmpOut);
    return new Uint8Array(outBuf);
  } catch (err) {
    console.warn('[Cloud-Transfer] ffmpeg 解碎片重封装异常，回退原始缓冲:', err.message);
    return inputBuf;
  } finally {
    try { await fs.promises.unlink(tmpIn); } catch {}
    try { await fs.promises.unlink(tmpOut); } catch {}
  }
}

function sanitizeFilename(name, maxBytes = 120) {
  if (!name) return 'track';
  let cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
  while (Buffer.byteLength(cleaned, 'utf8') > maxBytes) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned || 'track';
}

/* ==================== CENC fMP4 重组 ==================== */

/**
 * 从 Apple webplayback 的 HLS 拉取并重组为标准 fragmented MP4（含 init moov）。
 *
 * 为何不能直接用 ffmpeg -c copy：该 m3u8 把 init segment 放在
 * `#EXT-X-MAP:URI="xxx.mp4",BYTERANGE="1247@0"` 里，媒体分片全是
 * `#EXT-X-BYTERANGE`；ffmpeg 的 HLS demuxer 在 -c copy 输出裸 MP4 时
 * 会丢弃 EXT-X-MAP 的 init moov，产物只剩 ftyp+mdat，无法被 cenc-tool 解析。
 * 故这里手动按 byterange 拼接：init（moov）+ 各 moof/mdat 分片。
 *
 * @param {string} m3u8Url webplayback 返回的 media playlist URL
 * @param {string} encOut  输出加密 fMP4 的本地路径
 */
async function fetchCencFmp4(m3u8Url, encOut) {
  const base = m3u8Url.replace(/[^/]+$/, '');
  const plRes = await fetch(m3u8Url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(30000)
  });
  if (!plRes.ok) throw new Error(`拉取 HLS playlist 失败: HTTP ${plRes.status}`);
  const playlist = await plRes.text();

  let initUri = null, initRange = null;
  let pendingRange = null;
  const segments = [];
  for (const rawLine of playlist.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriM = line.match(/URI="([^"]+)"/);
      if (uriM) initUri = uriM[1];
      const rM = line.match(/BYTERANGE="(\d+)@(\d+)"/);
      if (rM) initRange = { offset: Number(rM[2]), length: Number(rM[1]) };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const rM = line.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)/);
      if (rM) pendingRange = { offset: Number(rM[2]), length: Number(rM[1]) };
    } else if (line && !line.startsWith('#')) {
      segments.push({ uri: line, range: pendingRange });
      pendingRange = null;
    }
  }
  if (!initUri || !initRange) throw new Error('HLS 缺少 EXT-X-MAP 初始化段');

  const fetchRange = async (uri, range) => {
    const full = uri.startsWith('http') ? uri : base + uri;
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const res = await fetch(full, { headers, signal: AbortSignal.timeout(60000) });
    if (!res.ok && res.status !== 206) throw new Error(`拉取分片失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 服务端忽略 Range 时会返回整个文件，按需截取
    if (range && buf.length > range.length) {
      return buf.subarray(range.offset, range.offset + range.length);
    }
    return buf;
  };

  const parts = [await fetchRange(initUri, initRange)];
  for (const seg of segments) {
    parts.push(await fetchRange(seg.uri, seg.range));
  }
  await fs.promises.writeFile(encOut, Buffer.concat(parts));
  return segments.length;
}

/* ==================== 核心转存处理 ==================== */

async function processTransfer(body) {
  const t0 = performance.now();
  const {
    adamId,
    quality = 'Lossless',
    hookFileUrl: directHookUrl,
    meta = {},
    lyrics: passedLyrics,
    saveLrc = false,
    saveLyricsFile,
    embedLyrics = true,
    lyricsFormat = 'lrc',
    translateLyrics = false,
    folderId,
    token,
    batchId,
    isLastTrack,
    zipFilename,
    zip = false,
    finalizeBatch = false,
    noUpload = false,
    outputDir
  } = body;

  // 0. 如果是批处理全辑最终打包请求 (3 线程并发转存全部就绪后统一打包上传)
  if (finalizeBatch && batchId) {
    const sessionDir = `/tmp/am_sessions/${batchId}`;
    if (!fs.existsSync(sessionDir)) {
      throw new Error(`批处理会话不存在或已过期: ${batchId}`);
    }
    const finalZipName = sanitizeFilename(toSimplifiedChinese(zipFilename || (meta.album ? `${meta.album} [${quality}].zip` : 'Album.zip')));
    const zipFilePath = `/tmp/${batchId}.zip`;
    const files = fs.readdirSync(sessionDir);
    const splitMaxMB = Number(body.splitMaxMB || 0);
    console.log(`[Cloud-Transfer] 收到全辑并发转存打包请求，正在将会话 ${batchId} (${files.length} 个文件) 打包为 .zip...`);

    // 大专辑分卷 (noUpload / Telegram 场景)：按累计大小贪心切卷，每卷均为完整独立 ZIP，规避 TG 单文件 2000MB 硬上限
    if (noUpload && splitMaxMB > 0) {
      const fileSizes = files
        .map((name) => ({ name, size: fs.statSync(path.join(sessionDir, name)).size }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const totalBytes = fileSizes.reduce((s, f) => s + f.size, 0);
      // 按 splitMaxMB 切卷，多文件卷贪心保证 <=limit；仅单文件超限（实际不存在的极端曲目）才可能超出，
      // 由 unifiedSendMedia 的 2000MB 检查兜底。1900 已留 100MB 余量在硬限内。
      const limitBytes = splitMaxMB * 1024 * 1024;
      if (totalBytes > limitBytes) {
        // 贪心切卷：累计大小达到 limit 即开新卷。若某单文件本身超过 limit（极端超长曲目），
        // 则单独成卷并继续，避免后续所有曲目被它连带卡死；该卷可能>limit，但 unifiedSendMedia 的 2000MB 检查仍为最终兜底。
        const groups = [];
        let cur = [];
        let curBytes = 0;
        for (const f of fileSizes) {
          if (cur.length && curBytes + f.size > limitBytes) {
            groups.push(cur);
            cur = [];
            curBytes = 0;
          }
          cur.push(f.name);
          curBytes += f.size;
        }
        if (cur.length) groups.push(cur);

        const baseName = finalZipName.replace(/\.zip$/i, '');
        const zipParts = [];
        for (let i = 0; i < groups.length; i++) {
          const partPath = `/tmp/${batchId}.part${i + 1}.zip`;
          const partName = groups.length > 1 ? `${baseName} [part ${i + 1}].zip` : finalZipName;
          await packZipFolder(sessionDir, partPath, groups[i]);
          const partStat = fs.statSync(partPath);
          const trackFiles = groups[i].filter((name) => /\.(m4a|mp3|flac)$/i.test(name)).length;
          zipParts.push({ filePath: partPath, fileName: partName, fileSize: partStat.size, totalFiles: groups[i].length, trackFiles });
          console.log(`[Cloud-Transfer] 📦 全辑 ZIP 分卷 ${i + 1}/${groups.length} 本地就绪: ${partName} (大小: ${(partStat.size / (1024 * 1024)).toFixed(1)}MB, ${groups[i].length} 个文件含 ${trackFiles} 首音频)`);
        }
        const tEnd = performance.now();
        return {
          local: true,
          isZip: true,
          sessionDir,
          zipParts,
          zipFilePath: zipParts[0].filePath,
          zipFileName: finalZipName,
          fileSize: totalBytes,
          totalFiles: files.length,
          album: meta.album || '',
          qualityName: quality,
          elapsedMs: Math.round(tEnd - t0)
        };
      }
    }

    await packZipFolder(sessionDir, zipFilePath);

    if (noUpload) {
      const zipStat = fs.statSync(zipFilePath);
      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 📦 全辑 ZIP 本地就绪: ${finalZipName} (大小: ${(zipStat.size / (1024 * 1024)).toFixed(1)}MB, 耗时: ${((tEnd - t0) / 1000).toFixed(2)}s)`);
      return {
        local: true,
        isZip: true,
        sessionDir,
        zipFilePath,
        zipFileName: finalZipName,
        fileSize: zipStat.size,
        totalFiles: files.length,
        album: meta.album || '',
        qualityName: quality,
        elapsedMs: Math.round(tEnd - t0)
      };
    }

    try {
      const zipStat = fs.statSync(zipFilePath);
      console.log(`[Cloud-Transfer] 全辑 ZIP 封装完成 (${(zipStat.size / (1024 * 1024)).toFixed(1)}MB, 共 ${files.length} 个文件)，正在直传 Gofile (流式直传，零内存压力)...`);

      const srv = await getGofileServer();
      const form = new FormData();
      // 使用 fs.openAsBlob 流式传输，不占用任何 Node.js 堆内存，彻底杜绝大包 OOM
      const zipBlob = await fs.openAsBlob(zipFilePath, { type: 'application/zip' });
      form.append('file', zipBlob, finalZipName);
      if (folderId) form.append('folderId', folderId);
      if (token) form.append('token', token);

      const upRes = await fetch(`https://${srv}.gofile.io/contents/uploadfile`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300000)
      });
      const upData = await upRes.json();
      if (upData.status !== 'ok') {
        throw new Error(`Gofile 上传 ZIP 失败: ${upData.status || '未知错误'}`);
      }

      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 🎉 全辑 ZIP 并发转存完成! 总耗时: ${((tEnd - t0) / 1000).toFixed(2)}s, 链接: ${upData.data?.downloadPage}`);
      return {
        downloadPage: upData.data?.downloadPage,
        folderId: upData.data?.parentFolder || folderId,
        guestToken: upData.data?.guestToken || token,
        fileId: upData.data?.fileId,
        fileName: finalZipName,
        isZip: true,
        totalFiles: files.length,
        qualityName: quality,
        elapsedMs: Math.round(tEnd - t0)
      };
    } finally {
      // 无论上传成功还是失败，均立刻销毁会话与临时 ZIP，杜绝磁盘爆满残留
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(zipFilePath, { force: true }); } catch {}
    }
  }

  const shouldSaveLyricsFile = saveLyricsFile !== undefined 
    ? Boolean(saveLyricsFile) 
    : Boolean(saveLrc);
  const shouldEmbedLyrics = Boolean(embedLyrics);
  const shouldTranslateLyrics = Boolean(translateLyrics);
  const chosenLyricsFormat = (lyricsFormat || 'lrc').toLowerCase() === 'ttml' ? 'ttml' : 'lrc';
  // 外置歌词多格式：saveLyricsFormats 数组（'lrc'/'ttml' 可同时出现），缺省用主格式
  const saveLyricsFormats = Array.isArray(body.saveLyricsFormats) && body.saveLyricsFormats.length
    ? body.saveLyricsFormats.filter((f) => f === 'lrc' || f === 'ttml')
    : (shouldSaveLyricsFile ? [chosenLyricsFormat] : []);
  // 仅下载歌词：跳过音频拉流/解密/标签注入，只产出歌词文件
  const lyricsOnly = Boolean(body.lyricsOnly);

  let audioHookUrl = directHookUrl;
  let chosenFormatName = '';

  // 1. 如果没有直接传 hookFileUrl，通过 127.0.0.1:31408/parse/song/{adamId} 获取
  let webplaybackM3u8 = null; // 当 master 为 M4P 单文件时，回退 /webplayback 标准 HLS
  if (!audioHookUrl) {
    if (!adamId) throw new Error('缺少 adamId 或 hookFileUrl');
    const parseRes = await fetch(`${HOOK_BASE}/parse/song/${adamId}`, { signal: AbortSignal.timeout(30000) });
    if (!parseRes.ok) {
      const parseErr = await parseRes.json().catch(() => ({}));
      // master m3u8 解析不出变体（wrapper 返回 M4P 单文件 + accessKey）：改用 /webplayback 拿标准 HLS
      if (parseErr.msg?.includes('No variants') || parseErr.msg?.includes('failed to get m3u8')) {
        try {
          const wpRes = await fetch(`${WRAPPER_BASE}/webplayback?adamId=${adamId}`, { signal: AbortSignal.timeout(15000) });
          if (wpRes.ok) {
            const wpData = await wpRes.json();
            const wpUrl = wpData?.data?.m3u8;
            if (wpUrl && wpUrl.includes('.m3u8')) {
              webplaybackM3u8 = wpUrl;
              // webplayback 为 ISO-23001-7 (CENC) 抽样加密 HLS，音质为 AAC 256kbps 上限（Apple 端格式限制）
              chosenFormatName = 'AAC (webplayback)';
              console.log(`[Cloud-Transfer] master 为 M4P 单文件，回退 webplayback CENC HLS 拉流+解密: ${adamId}`);
            }
          }
        } catch (e) {
          console.warn(`[Cloud-Transfer] webplayback 回退拉流失败: ${e.message}`);
        }
      }
      if (!webplaybackM3u8) {
        if (parseErr.msg === 'failed to get m3u8' || parseErr.msg?.includes('无资源') || parseErr.msg?.includes('无版权') || parseRes.status === 404 || parseRes.status === 500) {
          throw new Error('此歌曲在解析账号所属地区（土耳其区）无资源或未上架（可能为日区/美区独占版权），无法转存');
        }
        throw new Error(`解析歌曲失败: ${parseErr.msg || 'HTTP ' + parseRes.status}`);
      }
    } else {
      const parseData = await parseRes.json();
      const variants = parseData.variants || [];
      if (!variants.length) throw new Error('未找到可用的音频流（该地区可能无播放版权）');

      const base = (parseData.masterUrl || '').replace(/[^\/]+$/, '');

      let selected = null;
      const qLower = quality.toLowerCase();
      if (qLower.includes('hi-res') || qLower.includes('hires')) {
        selected = variants.find(v => (v.codecs === 'alac') && (v.sample_rate > 48000 || v.bit_depth > 16)) ||
                   variants.find(v => v.codecs === 'alac');
      } else if (qLower.includes('atmos') || qLower.includes('ec-3') || qLower.includes('ec3')) {
        selected = variants.find(v => (v.codecs && v.codecs.includes('ec-3')) || (v.group_id && v.group_id.includes('atmos'))) ||
                   variants.find(v => v.codecs === 'alac');
      } else if (qLower.includes('aac')) {
        selected = variants.find(v => (v.codecs && v.codecs.includes('mp4a')) || (v.group_id && v.group_id.includes('256'))) || variants[0];
      } else {
        // 默认 Lossless
        selected = variants.find(v => v.codecs === 'alac' || (v.group_id && v.group_id.includes('alac'))) || variants[0];
      }
      if (!selected) selected = variants[0];

      audioHookUrl = `${HOOK_BASE}/${base}${selected.file_uri}`;
      chosenFormatName = selected.group_id || selected.codecs || 'Lossless';
    }
  }

  // 确保 audioHookUrl 指向本地 HOOK_BASE (webplayback 回退路径不走此逻辑)
  let targetAudioUrl = audioHookUrl;
  if (targetAudioUrl && targetAudioUrl.startsWith('/')) {
    targetAudioUrl = `${HOOK_BASE}${targetAudioUrl}`;
  } else if (targetAudioUrl && !targetAudioUrl.startsWith('http://127.0.0.1:31408') && !targetAudioUrl.startsWith('http://localhost:31408')) {
    // 如果是远程域名例如 https://example.com:3140/... 则转换为本地 127.0.0.1:31408
    try {
      const u = new URL(targetAudioUrl);
      targetAudioUrl = `${HOOK_BASE}${u.pathname}${u.search}`;
    } catch {}
  }

  // 2. 并行抓取: 音频流、封面图、歌词
  console.log(`[Cloud-Transfer] 开始处理 ${meta.artist || ''} - ${meta.title || adamId} (音质: ${quality})`);
  const tasks = [];

  // 音频抓取
  let fetchAudio = async () => {
    if (webplaybackM3u8) {
      // M4P 单文件 / CENC 老歌回退：webplayback 的 HLS 采用 ISO-23001-7 (CENC) 抽样加密，
      // m3u8 里 EXT-X-KEY 的 base64 只是 KID（密钥编号），并非解密密钥；
      // 必须通过 Widevine CDM 向 wrapper-lite /license 换取真实 Content Key，再用 cenc-tool 解密。
      const rnd = Math.random().toString(36).slice(2, 8);
      const encOut = `/tmp/am_wp_${Date.now()}_${rnd}.enc.mp4`; // 重组后的加密 fMP4
      const decOut = `/tmp/am_wp_${Date.now()}_${rnd}.m4a`;     // cenc-tool 解密后的标准 m4a
      try {
        // 1. 从 HLS 按 byterange 重组加密 fMP4（含 init moov，ffmpeg -c copy 会丢）
        await fetchCencFmp4(webplaybackM3u8, encOut);

        // 2. Widevine CDM 换取真实 Content Key（python 脚本，约 0.5s）
        let contentKey = '';
        try {
          const { stdout } = await execFileAsync(WV_PY, [WV_KEY_SCRIPT, String(adamId)], {
            timeout: 30000,
            maxBuffer: 1024 * 1024
          });
          contentKey = stdout.trim();
        } catch (keyErr) {
          throw new Error(`获取解密密钥失败: ${(keyErr.stderr || keyErr.message || '').toString().trim().slice(0, 200)}`);
        }
        if (!/^[0-9a-fA-F]{32}$/.test(contentKey)) {
          throw new Error('获取解密密钥失败: 返回的密钥格式非法');
        }

        // 3. cenc-tool 用真实 Key 解密为标准 m4a
        await execFileAsync(CENC_TOOL_PATH, [encOut, contentKey, decOut], {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        });

        // 4. 兜底校验：确保解密后音频可解码（防止任何残留密文交付）
        try {
          await execFileAsync('ffmpeg', [
            '-v', 'error', '-xerror',
            '-i', decOut,
            '-t', '1', '-f', 'null', '-'
          ], { timeout: 15000 });
        } catch (checkErr) {
          throw new Error('此歌曲解密校验失败，暂无法转存');
        }

        return new Uint8Array(await fs.promises.readFile(decOut));
      } finally {
        try { await fs.promises.unlink(encOut); } catch {}
        try { await fs.promises.unlink(decOut); } catch {}
      }
    }
    const aRes = await fetch(targetAudioUrl, { signal: AbortSignal.timeout(300000) });
    if (!aRes.ok) throw new Error(`获取音频流失败: HTTP ${aRes.status}`);
    return new Uint8Array(await aRes.arrayBuffer());
  };
  // 仅下载歌词模式：跳过音频与封面拉流，避免浪费资源
  if (lyricsOnly) {
    fetchAudio = async () => new Uint8Array(0);
  }
  tasks.push(fetchAudio());

  // 封面图抓取 (优先命中内存缓存，杜绝 Apple CDN 批量请求抖动导致封面丢失)
  const fetchCover = async () => {
    if (lyricsOnly) return null;
    if (!meta.coverUrl) return null;
    const now = Date.now();
    const cached = coverCache.get(meta.coverUrl);
    if (cached && cached.expiresAt > now) {
      return cached.buf;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const cRes = await fetch(meta.coverUrl, { signal: AbortSignal.timeout(8000) });
        if (cRes.ok) {
          const buf = new Uint8Array(await cRes.arrayBuffer());
          coverCache.set(meta.coverUrl, { buf, expiresAt: now + 3600000 });
          return buf;
        }
      } catch (e) {
        if (attempt === 2) console.warn('[Cloud-Transfer] 封面抓取失败:', e.message);
      }
    }
    return null;
  };
  tasks.push(fetchCover());

  // 歌词抓取与多格式/降级解析（translateLyrics 时带 language=zh-Hans-CN 拉取官方中文翻译）
  const fetchLyricsData = async () => {
    if (passedLyrics !== undefined && passedLyrics !== null) {
      if (typeof passedLyrics === 'string' && passedLyrics.trim()) {
        return parseLyrics(passedLyrics);
      }
      return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    }
    if (!adamId) return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    try {
      const lyricsUrl = `${HOOK_BASE}/lyrics/${adamId}${shouldTranslateLyrics ? '?language=zh-Hans-CN' : ''}`;
      const lRes = await fetch(lyricsUrl, { signal: AbortSignal.timeout(5000) });
      if (lRes.ok) {
        const rawTtml = await lRes.text();
        if (shouldTranslateLyrics) {
          const bilingual = buildBilingualLrc(rawTtml, 'zh-Hans-CN');
          if (bilingual) return bilingual;
        }
        return parseLyrics(rawTtml);
      }
    } catch (e) {
      console.warn('[Cloud-Transfer] 歌词抓取失败:', e.message);
    }
    return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
  };
  tasks.push(fetchLyricsData());

  let [rawAudioBuf, coverBuf, lyricsData] = await Promise.all(tasks);
  const tFetch = performance.now();
  console.log(`[Cloud-Transfer] 资源获取完成 (${((tFetch - t0) / 1000).toFixed(2)}s, 音频大小: ${(rawAudioBuf.length / (1024 * 1024)).toFixed(1)}MB)`);

  // 智能日区元数据嗅探：若为日语曲目且标题或艺人为罗马音，自动向日区 /amp/v1/catalog/jp/songs/${adamId}?l=ja 抓取正统日文名
  const isLikelyJapanese = (meta.genre && /j-pop|anime|japanese|アニメ/i.test(meta.genre)) ||
    Boolean(meta.isJapanese) ||
    /[\u3040-\u309F\u30A0-\u30FF]/.test((meta.title || '') + (meta.artist || '') + (meta.album || ''));

  if (adamId && isLikelyJapanese && (!meta.title || !/[\u3040-\u309F\u30A0-\u30FF]/.test(meta.title))) {
    try {
      const jpRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/jp/songs/${adamId}?l=ja`, { signal: AbortSignal.timeout(3000) });
      if (jpRes.ok) {
        const jData = await jpRes.json();
        const jAttr = jData.data?.[0]?.attributes;
        if (jAttr) {
          if (jAttr.name) meta.title = jAttr.name;
          if (jAttr.artistName) meta.artist = jAttr.artistName;
          if (jAttr.albumName) meta.album = jAttr.albumName;
          console.log(`[Cloud-Transfer] 成功从日区同步日文原名: ${meta.artist} - ${meta.title}`);
        }
      }
    } catch {}
  }

  // 智能华语元数据嗅探：若歌曲标题或艺人名缺少中文，自动跨区优先向 (cn -> tw -> hk -> us) 同步正统中文名
  const hasChineseInTitle = /[\u4e00-\u9fa5]/.test(meta.title || '');
  const hasChineseInArtist = /[\u4e00-\u9fa5]/.test(meta.artist || '');
  if (adamId && (!hasChineseInTitle || !hasChineseInArtist) && !isLikelyJapanese) {
    for (const sf of ['cn', 'tw', 'hk', 'us']) {
      try {
        const sfRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/songs/${adamId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(3000) });
        if (sfRes.ok) {
          const sData = await sfRes.json();
          const sAttr = sData.data?.[0]?.attributes;
          if (sAttr) {
            let updated = false;
            if (!hasChineseInTitle && sAttr.name && /[\u4e00-\u9fa5]/.test(sAttr.name)) {
              meta.title = toSimplifiedChinese(sAttr.name);
              updated = true;
            }
            if (!hasChineseInArtist && sAttr.artistName && /[\u4e00-\u9fa5]/.test(sAttr.artistName)) {
              meta.artist = normalizeArtistName(toSimplifiedChinese(sAttr.artistName));
              updated = true;
            }
            if (sAttr.albumName && (!meta.album || !/[\u4e00-\u9fa5]/.test(meta.album))) {
              meta.album = toSimplifiedChinese(sAttr.albumName);
              updated = true;
            }
            if (updated) {
              console.log(`[Cloud-Transfer] 成功从 ${sf.toUpperCase()} 华语区同步正统中文元数据: ${meta.artist} - ${meta.title}`);
              if (/[\u4e00-\u9fa5]/.test(meta.title) && /[\u4e00-\u9fa5]/.test(meta.artist)) {
                break;
              }
            }
          }
        }
      } catch {}
    }
  }

  // 华语艺人英文名与官方别名规范化 + 繁简转换 (智能保护日文与英文曲名)
  if (meta.artist) meta.artist = normalizeArtistName(meta.artist);
  if (meta.albumArtist) meta.albumArtist = normalizeArtistName(meta.albumArtist || meta.artist);
  if (meta.composer) meta.composer = normalizeArtistName(meta.composer);
  if (meta.title) meta.title = toSimplifiedChinese(meta.title);
  if (meta.album) meta.album = toSimplifiedChinese(meta.album);
  if (meta.genre) meta.genre = toSimplifiedChinese(meta.genre);
  if (meta.copyright) meta.copyright = toSimplifiedChinese(meta.copyright);
  if (lyricsData.hasLyrics) {
    if (lyricsData.lrc) lyricsData.lrc = toSimplifiedChinese(lyricsData.lrc);
    if (lyricsData.plain) lyricsData.plain = toSimplifiedChinese(lyricsData.plain);
    if (lyricsData.ttml) lyricsData.ttml = toSimplifiedChinese(lyricsData.ttml);
  }

  // 计算内嵌歌词（支持不内嵌，无动态歌词自动降级为纯文本内嵌；chosenLyricsFormat==='ttml' 时内嵌 TTML 原文）
  let embedLyricsText = '';
  if (shouldEmbedLyrics && lyricsData.hasLyrics && !lyricsOnly) {
    if (chosenLyricsFormat === 'ttml' && lyricsData.ttml) {
      embedLyricsText = lyricsData.ttml;
    } else {
      embedLyricsText = lyricsData.isDynamic ? lyricsData.lrc : lyricsData.plain;
    }
  }

  // 3. 标签注入
  const cleanTitle = sanitizeFilename(meta.title || 'Unknown Title');
  const cleanArtist = sanitizeFilename(meta.artist || 'Unknown Artist');
  const standardM4aName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.m4a`;

  // 准备外挂独立歌词文件 (支持多格式：主文件 + extraLyrics 附加格式)
  const buildLyricsFile = (fmt) => {
    if (fmt === 'ttml' && lyricsData.ttml) {
      return {
        filename: `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.ttml`,
        content: lyricsData.ttml,
        mime: 'application/xml;charset=utf-8'
      };
    }
    if (fmt === 'lrc' && lyricsData.lrc) {
      return {
        filename: `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.lrc`,
        content: lyricsData.lrc,
        mime: 'text/plain;charset=utf-8'
      };
    }
    return null;
  };

  let lyricsFilename = null;
  let lyricsContent = null;
  let lyricsMime = 'text/plain;charset=utf-8';
  /** 额外外置歌词文件（与主文件同时交付，如 .lrc + .ttml 并存） */
  const extraLyrics = [];
  if (lyricsData.hasLyrics) {
    // 主文件 = 用户首选格式
    const primary = buildLyricsFile(saveLyricsFormats[0] || chosenLyricsFormat) || buildLyricsFile(chosenLyricsFormat);
    if (primary) {
      lyricsFilename = primary.filename;
      lyricsContent = primary.content;
      lyricsMime = primary.mime;
    }
    // 额外文件 = saveLyricsFormats 中其余格式
    const extraFmts = saveLyricsFormats.slice(1);
    for (const fmt of extraFmts) {
      const f = buildLyricsFile(fmt);
      if (f && f.filename !== lyricsFilename) extraLyrics.push(f);
    }
  }

  // 仅下载歌词早退：跳过音频标签注入/解碎片/上传，只返回歌词文件产物（音频拉流已在入口跳过）
  if (lyricsOnly) {
    const lyricsFiles = [];
    if (lyricsFilename && lyricsContent) lyricsFiles.push({ filename: lyricsFilename, content: lyricsContent, mime: lyricsMime });
    for (const f of extraLyrics) lyricsFiles.push({ filename: f.filename, content: f.content, mime: f.mime });
    if (!lyricsFiles.length) {
      throw new Error('无歌词可下载（纯音乐或地区无歌词资源）');
    }
    return {
      lyricsOnly: true,
      lyricsFiles,
      artist: meta.artist || '',
      title: meta.title || '',
      album: meta.album || ''
    };
  }

  const taggedMp4Buf = tagMp4(rawAudioBuf, {
    title: meta.title || '',
    artist: meta.artist || '',
    album: meta.album || '',
    albumArtist: meta.albumArtist || meta.artist || '',
    date: meta.date || '',
    genre: meta.genre || '',
    composer: meta.composer || '',
    copyright: meta.copyright || '',
    lyrics: embedLyricsText || '',
    trackNumber: meta.trackNumber,
    totalTracks: meta.totalTracks,
    discNumber: meta.discNumber,
    totalDiscs: meta.totalDiscs,
    cover: coverBuf
  });
  const tTag = performance.now();
  console.log(`[Cloud-Transfer] MP4 标签注入完成 (${((tTag - tFetch) / 1000).toFixed(3)}s, 内嵌歌词: ${embedLyricsText ? '已写入' : '无/跳过'})`);

  // 3.1 容器解碎片重封装：消除 HLS moof 分片，重建完整 sample tables 与 faststart，标准 Progressive M4A 封装
  // 彻底解决 Android / 椒盐音乐 / ExoPlayer 等播放器显示 "编码错误" (无法解析 moof 分片) 的问题
  const finalAudioBuf = await defragMp4Buffer(taggedMp4Buf);
  const tDefrag = performance.now();
  console.log(`[Cloud-Transfer] 容器解碎片完成 (${((tDefrag - tTag) / 1000).toFixed(3)}s, 标准 M4A faststart 封装)`);

  // 4. 上传模式判定 (ZIP 打包上传 或 直接文件流上传)
  // 4.1 批处理会话模式 (支持全辑归集为单 .zip 压缩包)
  if (batchId) {
    const sessionDir = `/tmp/am_sessions/${batchId}`;
    fs.mkdirSync(sessionDir, { recursive: true });

    let finalM4aName = standardM4aName;
    let finalLyricsName = lyricsFilename;
    if (fs.existsSync(path.join(sessionDir, finalM4aName))) {
      const trackPrefix = meta.trackNumber ? `${String(meta.trackNumber).padStart(2, '0')}. ` : '';
      finalM4aName = `${trackPrefix}${standardM4aName}`;
      if (finalLyricsName) {
        finalLyricsName = `${trackPrefix}${lyricsFilename}`;
      }
    }

    fs.writeFileSync(path.join(sessionDir, finalM4aName), finalAudioBuf);

    if (finalLyricsName && lyricsContent) {
      fs.writeFileSync(path.join(sessionDir, finalLyricsName), lyricsContent, 'utf8');
      console.log(`[Cloud-Transfer] 缓存歌词: ${finalLyricsName} 到 session: ${batchId}`);
    }
    for (const extra of extraLyrics) {
      const extraName = finalLyricsName && extra.filename === lyricsFilename ? finalLyricsName : `${meta.trackNumber ? String(meta.trackNumber).padStart(2, '0') + '. ' : ''}${extra.filename}`;
      fs.writeFileSync(path.join(sessionDir, extraName), extra.content, 'utf8');
      console.log(`[Cloud-Transfer] 缓存歌词(附加): ${extraName} 到 session: ${batchId}`);
    }

    // 若非最后一首曲目，缓存后快速返回，不浪费上传时间
    if (!isLastTrack) {
      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] ✔ 批处理就绪: ${finalM4aName} (耗时: ${((tEnd - t0) / 1000).toFixed(2)}s)`);
      return {
        queued: true,
        fileName: finalM4aName,
        qualityName: chosenFormatName,
        elapsedMs: Math.round(tEnd - t0)
      };
    }

    // 最后一首曲目：打包为单个 .zip 压缩包并极速直传 Gofile
    console.log(`[Cloud-Transfer] 最后一首曲目已就绪，正在将全辑打包为 .zip 压缩包...`);
    const finalZipName = sanitizeFilename(zipFilename || (meta.album ? `${meta.album} [${quality}].zip` : 'Album.zip'));
    const zipFilePath = `/tmp/${batchId}.zip`;
    const files = fs.readdirSync(sessionDir);
    await packZipFolder(sessionDir, zipFilePath);

    if (noUpload) {
      const zipStat = fs.statSync(zipFilePath);
      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 📦 全辑 ZIP 本地就绪: ${finalZipName} (大小: ${(zipStat.size / (1024 * 1024)).toFixed(1)}MB, 耗时: ${((tEnd - t0) / 1000).toFixed(2)}s)`);
      return {
        local: true,
        isZip: true,
        sessionDir,
        zipFilePath,
        zipFileName: finalZipName,
        fileSize: zipStat.size,
        totalFiles: files.length,
        album: meta.album || '',
        qualityName: chosenFormatName,
        elapsedMs: Math.round(tEnd - t0)
      };
    }

    try {
      const zipStat = fs.statSync(zipFilePath);
      console.log(`[Cloud-Transfer] 全辑 ZIP 封装完成 (${(zipStat.size / (1024 * 1024)).toFixed(1)}MB, 共 ${files.length} 个文件)，正在直传 Gofile (流式直传，零内存压力)...`);

      const srv = await getGofileServer();
      const form = new FormData();
      // 使用 fs.openAsBlob 流式传输，不占用任何 Node.js 堆内存，彻底杜绝大包 OOM
      const zipBlob = await fs.openAsBlob(zipFilePath, { type: 'application/zip' });
      form.append('file', zipBlob, finalZipName);
      if (folderId) form.append('folderId', folderId);
      if (token) form.append('token', token);

      const upRes = await fetch(`https://${srv}.gofile.io/contents/uploadfile`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300000)
      });
      const upData = await upRes.json();
      if (upData.status !== 'ok') {
        throw new Error(`Gofile 上传 ZIP 失败: ${upData.status || '未知错误'}`);
      }

      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 🎉 全辑 ZIP 转存完成! 总耗时: ${((tEnd - t0) / 1000).toFixed(2)}s, 链接: ${upData.data?.downloadPage}`);
      return {
        downloadPage: upData.data?.downloadPage,
        folderId: upData.data?.parentFolder || folderId,
        guestToken: upData.data?.guestToken || token,
        fileId: upData.data?.fileId,
        fileName: finalZipName,
        isZip: true,
        totalFiles: files.length,
        qualityName: chosenFormatName,
        elapsedMs: Math.round(tEnd - t0)
      };
    } finally {
      // 无论上传成功还是失败，均立刻销毁会话与临时 ZIP，杜绝磁盘爆满残留
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(zipFilePath, { force: true }); } catch {}
    }
  }

  // 4.2 单曲压缩模式 (可选将单曲与对应歌词打包为单个 .zip 上传)
  if (zip) {
    const singleDir = `/tmp/am_single_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    fs.mkdirSync(singleDir, { recursive: true });
    fs.writeFileSync(path.join(singleDir, standardM4aName), finalAudioBuf);

    if (lyricsFilename && lyricsContent) {
      fs.writeFileSync(path.join(singleDir, lyricsFilename), lyricsContent, 'utf8');
    }
    for (const extra of extraLyrics) {
      if (extra.filename === lyricsFilename) continue;
      fs.writeFileSync(path.join(singleDir, extra.filename), extra.content, 'utf8');
    }

    const finalZipName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.zip`;
    const zipFilePath = `${singleDir}.zip`;
    const files = fs.readdirSync(singleDir);
    await packZipFolder(singleDir, zipFilePath);

    if (noUpload) {
      try { fs.rmSync(singleDir, { recursive: true, force: true }); } catch {}
      const zipStat = fs.statSync(zipFilePath);
      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 📦 单曲 ZIP 本地就绪: ${finalZipName} (大小: ${(zipStat.size / (1024 * 1024)).toFixed(1)}MB, 耗时: ${((tEnd - t0) / 1000).toFixed(2)}s)`);
      return {
        local: true,
        isZip: true,
        zipFilePath,
        zipFileName: finalZipName,
        fileSize: zipStat.size,
        artist: meta.artist || '',
        title: meta.title || '',
        album: meta.album || '',
        albumArtist: meta.albumArtist || '',
        qualityName: chosenFormatName,
        duration: meta.durationInMillis ? Math.round(meta.durationInMillis / 1000) : 0,
        elapsedMs: Math.round(tEnd - t0)
      };
    }

    try {
      const srv = await getGofileServer();
      const form = new FormData();
      const zipBlob = await fs.openAsBlob(zipFilePath, { type: 'application/zip' });
      form.append('file', zipBlob, finalZipName);
      if (folderId) form.append('folderId', folderId);
      if (token) form.append('token', token);

      const upRes = await fetch(`https://${srv}.gofile.io/contents/uploadfile`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(180000)
      });
      const upData = await upRes.json();
      if (upData.status !== 'ok') {
        throw new Error(`Gofile 上传失败: ${upData.status || '未知错误'}`);
      }

      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 🎉 单曲 ZIP 转存完成! 总耗时: ${((tEnd - t0) / 1000).toFixed(2)}s, 链接: ${upData.data?.downloadPage}`);
      return {
        downloadPage: upData.data?.downloadPage,
        folderId: upData.data?.parentFolder || folderId,
        guestToken: upData.data?.guestToken || token,
        fileId: upData.data?.fileId,
        fileName: finalZipName,
        isZip: true,
        qualityName: chosenFormatName,
        elapsedMs: Math.round(tEnd - t0)
      };
    } finally {
      try { fs.rmSync(singleDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(zipFilePath, { force: true }); } catch {}
    }
  }

  // 4.2.5 本地处理模式 (免上传至 Gofile，供 Telegram Bot 或内网其他服务直接取用)
  if (noUpload) {
    const targetDir = outputDir || path.join('/tmp', `am_tg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(targetDir, { recursive: true });
    const audioFilePath = path.join(targetDir, standardM4aName);
    fs.writeFileSync(audioFilePath, finalAudioBuf);

    let lrcFilePath = null;
    if (lyricsFilename && lyricsContent) {
      lrcFilePath = path.join(targetDir, lyricsFilename);
      fs.writeFileSync(lrcFilePath, lyricsContent, 'utf8');
    }
    for (const extra of extraLyrics) {
      if (extra.filename === lyricsFilename) continue;
      fs.writeFileSync(path.join(targetDir, extra.filename), extra.content, 'utf8');
    }

    let thumbFilePath = null;
    if (coverBuf && coverBuf.length > 0) {
      const coverRawPath = path.join(targetDir, 'cover_raw.jpg');
      thumbFilePath = path.join(targetDir, 'thumb.jpg');
      try {
        fs.writeFileSync(coverRawPath, coverBuf);
        // 使用 ffmpeg 压缩为标准 320x320 JPEG 缩略图 (Telegram Bot 官方规范：JPEG, <=320x320, <=200KB)
        await execFileAsync('ffmpeg', [
          '-y',
          '-v', 'error',
          '-i', coverRawPath,
          '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
          '-q:v', '2',
          thumbFilePath
        ], { timeout: 10000 });
      } catch (thumbErr) {
        console.warn('[Cloud-Transfer] 生成封面缩略图失败:', thumbErr.message);
        thumbFilePath = null;
      } finally {
        try { fs.rmSync(coverRawPath, { force: true }); } catch {}
      }
    }

    const tEnd = performance.now();
    console.log(`[Cloud-Transfer] 🎧 本地就绪: ${standardM4aName} (大小: ${(finalAudioBuf.length / (1024 * 1024)).toFixed(1)}MB, 缩略图: ${thumbFilePath ? '就绪' : '无'}, 耗时: ${((tEnd - t0) / 1000).toFixed(2)}s)`);

    return {
      local: true,
      audioFilePath,
      lrcFilePath,
      thumbFilePath,
      fileName: standardM4aName,
      lyricsFileName: lyricsFilename,
      extraLyricsFiles: extraLyrics.map((f) => ({ filename: f.filename, mime: f.mime })),
      fileSize: finalAudioBuf.length,
      artist: meta.artist || '',
      title: meta.title || '',
      album: meta.album || '',
      albumArtist: meta.albumArtist || '',
      qualityName: chosenFormatName,
      duration: meta.durationInMillis ? Math.round(meta.durationInMillis / 1000) : 0,
      coverUrl: meta.coverUrl || '',
      elapsedMs: Math.round(tEnd - t0)
    };
  }

  // 4.3 常规单文件上传至 Gofile (支持同一 folderId 归集)
  const srv = await getGofileServer();
  const upUrl = `https://${srv}.gofile.io/contents/uploadfile`;

  // 上传音频
  const form = new FormData();
  form.append('file', new Blob([finalAudioBuf], { type: 'audio/mp4' }), standardM4aName);
  if (folderId) form.append('folderId', folderId);
  if (token) form.append('token', token);

  const upRes = await fetch(upUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const upData = await upRes.json();
  if (upData.status !== 'ok') {
    throw new Error(`Gofile 上传失败: ${upData.status || '未知错误'}`);
  }

  const resultData = upData.data || {};
  const currentParentFolder = resultData.parentFolder || folderId;
  const currentGuestToken = resultData.guestToken || token;

  // 5. 可选: 上传独立歌词文件到同一文件夹（主文件 + 附加格式）
  if (lyricsFilename && lyricsContent) {
    try {
      const lrcForm = new FormData();
      lrcForm.append('file', new Blob([lyricsContent], { type: lyricsMime }), lyricsFilename);
      if (currentParentFolder) lrcForm.append('folderId', currentParentFolder);
      if (currentGuestToken) lrcForm.append('token', currentGuestToken);

      await fetch(upUrl, { method: 'POST', body: lrcForm, signal: AbortSignal.timeout(10000) });
      console.log(`[Cloud-Transfer] 同步上传独立歌词: ${lyricsFilename}`);
    } catch (e) {
      console.warn('[Cloud-Transfer] 歌词上传异常:', e.message);
    }
  }
  for (const extra of extraLyrics) {
    if (extra.filename === lyricsFilename) continue;
    try {
      const extraForm = new FormData();
      extraForm.append('file', new Blob([extra.content], { type: extra.mime }), extra.filename);
      if (currentParentFolder) extraForm.append('folderId', currentParentFolder);
      if (currentGuestToken) extraForm.append('token', currentGuestToken);
      await fetch(upUrl, { method: 'POST', body: extraForm, signal: AbortSignal.timeout(10000) });
      console.log(`[Cloud-Transfer] 同步上传独立歌词(附加): ${extra.filename}`);
    } catch (e) {
      console.warn('[Cloud-Transfer] 附加歌词上传异常:', e.message);
    }
  }

  const tEnd = performance.now();
  console.log(`[Cloud-Transfer] 🎉 转存完成! 总耗时: ${((tEnd - t0) / 1000).toFixed(2)}s, 链接: ${resultData.downloadPage}`);

  return {
    downloadPage: resultData.downloadPage,
    folderId: currentParentFolder,
    guestToken: currentGuestToken,
    fileId: resultData.fileId,
    fileName: standardM4aName,
    qualityName: chosenFormatName,
    elapsedMs: Math.round(tEnd - t0)
  };
}

/* ==================== 全局顺序排队调度器 (Global Sequential FIFO Queue) ==================== */

class GlobalTransferQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.queue = [];
    this.activeCount = 0;
  }

  get status() {
    return {
      active: this.activeCount,
      waiting: this.queue.length,
      concurrency: this.concurrency
    };
  }

  enqueue(taskFn, meta = {}) {
    return new Promise((resolve, reject) => {
      const taskItem = {
        taskFn,
        meta,
        resolve,
        reject,
        enqueuedAt: Date.now()
      };
      this.queue.push(taskItem);
      console.log(`[Queue] 任务入队: ${meta.name || '未知任务'} (等待排队中: ${this.queue.length}, 正在执行: ${this.activeCount})`);
      this._processNext();
    });
  }

  async _processNext() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    this.activeCount++;
    const waitTime = ((Date.now() - item.enqueuedAt) / 1000).toFixed(1);
    console.log(`[Queue] ▶ 调度出队执行: ${item.meta.name || '任务'} (排队耗时: ${waitTime}s, 队列剩余: ${this.queue.length})`);

    try {
      const result = await item.taskFn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.activeCount--;
      setImmediate(() => this._processNext());
    }
  }
}

// 全局排队调度器，并发默认为 2（支持环境变量 CLOUD_CONCURRENCY 配置），兼顾极速下载与服务器负载
const CLOUD_CONCURRENCY = parseInt(process.env.CLOUD_CONCURRENCY || '2', 10);
const globalQueue = new GlobalTransferQueue(CLOUD_CONCURRENCY);

// ==================== Web 访问防刷限流器 (支持环境变量白名单配置) ====================
const OWNER_IPS = new Set([
  '127.0.0.1', '::1', 'localhost',
  ...(process.env.OWNER_IPS ? process.env.OWNER_IPS.split(',').map(s => s.trim()) : [])
]);
const webIpLimitMap = new Map(); // ip -> { count, resetAt, dailyCount, dailyResetAt }

// 定期清理过期的 IP 限流记录，防止长期运行内存累积
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of webIpLimitMap.entries()) {
    if (now > rec.dailyResetAt) {
      webIpLimitMap.delete(ip);
    }
  }
}, 60 * 60 * 1000).unref();

function nextBeijingMidnight() {
  // 计算下一个北京时间 (UTC+8) 00:00 的毫秒时间戳，用于每日配额到点精确重置
  const now = Date.now();
  const bjOffsetMs = 8 * 3600 * 1000;
  const bjNow = new Date(now + bjOffsetMs);
  // 北京时间的日期部分
  const y = bjNow.getUTCFullYear();
  const m = bjNow.getUTCMonth();
  const d = bjNow.getUTCDate();
  // 北京时间下一个 00:00 => 以 UTC 表示就是 (y,m,d+1) 的 00:00 UTC 再减 8h
  const nextBjMidnightUtc = Date.UTC(y, m, d + 1) - bjOffsetMs;
  return nextBjMidnightUtc > now ? nextBjMidnightUtc : now + 86400000; // 兜底防负值
}

function checkWebRateLimit(clientIp, adminKeyHeader) {
  // 1. 本地回环、内部调用与管理员静态 IP -> 100% 豁免放行
  if (!clientIp || OWNER_IPS.has(clientIp) || clientIp.includes('127.0.0.1')) {
    return { ok: true, isOwner: true };
  }
  for (const ip of OWNER_IPS) {
    if (ip && clientIp.includes(ip)) {
      return { ok: true, isOwner: true };
    }
  }

  // 2. 携带管理员专属 Key -> 100% 豁免放行
  const ADMIN_SECRET = process.env.ADMIN_KEY || 'am_admin_secret_key';
  if (adminKeyHeader && adminKeyHeader === ADMIN_SECRET) {
    return { ok: true, admin: true };
  }

  // 3. 公网访客 IP 限流 (每分钟最多 60 次，支持整辑一键并发入队；每天最多 200 次)
  // 底层已有 GlobalTransferQueue(1) 严格串行调度，CPU/RAM 绝不会过载
  const now = Date.now();
  let rec = webIpLimitMap.get(clientIp);
  if (!rec) {
    rec = { count: 0, resetAt: now + 60000, dailyCount: 0, dailyResetAt: nextBeijingMidnight() };
    webIpLimitMap.set(clientIp, rec);
  }

  if (now > rec.resetAt) {
    rec.count = 0;
    rec.resetAt = now + 60000;
  }
  if (now > rec.dailyResetAt) {
    rec.dailyCount = 0;
    rec.dailyResetAt = nextBeijingMidnight();
  }

  if (rec.count >= 60) {
    return { ok: false, error: '⚠️ 请求提交过快，已触发服务器安全保护。请稍候 1 分钟后再试 (429 Too Many Requests)' };
  }
  if (rec.dailyCount >= 200) {
    return { ok: false, error: '⚠️ 今日网页端转存配额已达上限 (每日限额 200 首曲目)。配额将在明日北京时间 00:00 自动重置刷新。' };
  }

  rec.count++;
  rec.dailyCount++;
  return { ok: true };
}

/* ==================== HTTP 服务 ==================== */

const server = http.createServer(async (req, res) => {
  // CORS 响应头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && u.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', msg: 'am-cloud running' }));
    return;
  }

  if (req.method === 'GET' && (u.pathname === '/queue' || u.pathname === '/api/queue-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data: globalQueue.status }));
    return;
  }

  // 只读配额查询：供批量转存前置预检查，不消耗任何配额（绝不调用 checkWebRateLimit，其内部会 rec.count++）
  if (req.method === 'GET' && u.pathname === '/api/quota') {
    let clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
    const adminKey = req.headers['x-admin-key'] || u.searchParams.get('admin_key') || '';
    const isOwnerIp = !clientIp || OWNER_IPS.has(clientIp) || clientIp.includes('127.0.0.1') || Array.from(OWNER_IPS).some(ip => ip && clientIp.includes(ip));
    const ADMIN_SECRET = process.env.ADMIN_KEY || 'am_admin_secret_key';
    if (isOwnerIp || (adminKey && adminKey === ADMIN_SECRET)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', data: { unlimited: true } }));
      return;
    }
    const now = Date.now();
    let rec = webIpLimitMap.get(clientIp);
    if (!rec) {
      rec = { count: 0, resetAt: now + 60000, dailyCount: 0, dailyResetAt: nextBeijingMidnight() };
      webIpLimitMap.set(clientIp, rec);
    }
    if (now > rec.resetAt) rec.count = 0;
    if (now > rec.dailyResetAt) {
      rec.dailyCount = 0;
      rec.dailyResetAt = nextBeijingMidnight();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', data: { unlimited: false, used: rec.dailyCount, max: 200, remaining: Math.max(0, 200 - rec.dailyCount) } }));
    return;
  }

  // 配额预扣：本机下载同样消耗 VPS 出站带宽，纳入每日配额；owner/admin 豁免
  if (req.method === 'POST' && u.pathname === '/api/quota/consume') {
    let clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
    const adminKey = req.headers['x-admin-key'] || u.searchParams.get('admin_key') || '';
    const isOwnerIp = !clientIp || OWNER_IPS.has(clientIp) || clientIp.includes('127.0.0.1') || Array.from(OWNER_IPS).some(ip => ip && clientIp.includes(ip));
    const ADMIN_SECRET = process.env.ADMIN_KEY || 'am_admin_secret_key';
    if (isOwnerIp || (adminKey && adminKey === ADMIN_SECRET)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', data: { unlimited: true } }));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let tracks = 1;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        tracks = Math.max(1, parseInt(body.tracks, 10) || 1);
      } catch {}
      const now = Date.now();
      let rec = webIpLimitMap.get(clientIp);
      if (!rec) {
        rec = { count: 0, resetAt: now + 60000, dailyCount: 0, dailyResetAt: nextBeijingMidnight() };
        webIpLimitMap.set(clientIp, rec);
      }
      if (now > rec.dailyResetAt) {
        rec.dailyCount = 0;
        rec.dailyResetAt = nextBeijingMidnight();
      }
      if (rec.dailyCount + tracks > 200) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: `⚠️ 今日转存配额不足：本批 ${tracks} 首，今日仅剩 ${Math.max(0, 200 - rec.dailyCount)} 首。请明日北京时间 00:00 后重试或缩小范围` }));
        return;
      }
      rec.dailyCount += tracks;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', data: { remaining: Math.max(0, 200 - rec.dailyCount) } }));
    });
    return;
  }

  if (req.method === 'POST' && (u.pathname === '/transfer' || u.pathname === '/api/cloud-transfer')) {
    let clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.slice(7);
    }
    const adminKey = req.headers['x-admin-key'] || u.searchParams.get('admin_key') || '';
    const rateCheck = checkWebRateLimit(clientIp, adminKey);
    if (!rateCheck.ok) {
      console.warn(`[WebRateLimit] ⚠️ 拦截请求来源 IP: ${clientIp}, 原因: ${rateCheck.error}`);
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: rateCheck.error }));
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', err => {
      console.warn('[Cloud-Transfer] 客户端传输中断:', err.message);
    });
    req.on('end', async () => {
      let body;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        body = JSON.parse(raw);
      } catch (jsonErr) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: `请求体 JSON 格式不合法: ${jsonErr.message}` }));
        return;
      }

      try {
        const taskName = body.meta?.title ? `${body.meta.artist || ''} - ${body.meta.title} (${body.quality || 'Lossless'})` : (body.adamId || 'Transfer');
        const result = await globalQueue.enqueue(() => processTransfer(body), {
          name: taskName,
          source: body.noUpload ? 'Telegram' : 'WebUI'
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', data: result }));
      } catch (err) {
        // wrapper-lite 卡死特征：terminated / internal error / Fairplay -42786 等。
        // 后台 wrapper-watchdog 已会自动重启 wrapper-lite，这里把原生态错误翻译成友好提示，
        // 让用户/日志能明确看到"wrapper 卡死已自愈，请重试"，而非晦涩的 terminated。
        const rawMsg = err.message || String(err);
        const wrapperStuck = /terminated|internal error|Fairplay|KDCanProcessCKC|-42786/i.test(rawMsg);
        console.error(wrapperStuck ? '[Cloud-Transfer] 错误(wrapper卡死):' : '[Cloud-Transfer] 错误:', rawMsg);
        const userErr = wrapperStuck
          ? `解密鉴权服务(wrapper)临时卡死，已自动重启。请稍候重试本次下载。（原始: ${rawMsg.slice(0, 80)}）`
          : rawMsg;
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: userErr }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
});

/* ==================== 磁盘与临时会话自动清理 ==================== */

function cleanupStaleSessions() {
  try {
    const sessionsRoot = '/tmp/am_sessions';
    if (fs.existsSync(sessionsRoot)) {
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000; // 2 小时
      const entries = fs.readdirSync(sessionsRoot);
      for (const entry of entries) {
        const entryPath = path.join(sessionsRoot, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (now - stat.mtimeMs > maxAge) {
            fs.rmSync(entryPath, { recursive: true, force: true });
            console.log(`[am-cloud] 自动清理过期临时会话目录: ${entry}`);
          }
        } catch {}
      }
    }
  } catch {}

  try {
    const tmpDir = '/tmp';
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 分钟自动过期，防止异常终止导致残余堆积
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (((entry.startsWith('album_') || entry.startsWith('playlist_') || entry.startsWith('am_single_')) && entry.endsWith('.zip')) ||
          (entry.startsWith('am_defrag_') && entry.endsWith('.m4a')) ||
          entry.startsWith('am_tg_')) {
        const p = path.join(tmpDir, entry);
        try {
          const stat = fs.statSync(p);
          if (now - stat.mtimeMs > maxAge) {
            fs.rmSync(p, { recursive: true, force: true });
            console.log(`[am-cloud] 自动清理过期临时文件或目录: ${entry}`);
          }
        } catch {}
      }
    }
  } catch {}
}

server.requestTimeout = 600000; // 10 分钟队列等待防护
server.headersTimeout = 610000;
server.keepAliveTimeout = 60000;

server.listen(PORT, HOST, () => {
  console.log(`[am-cloud] VPS 2000M 云端极速转存服务已就绪: http://${HOST}:${PORT}`);
  cleanupStaleSessions();
  setInterval(cleanupStaleSessions, 30 * 60 * 1000);
});

// 全局异常与未处理 Promise 拒绝守护，确保服务 7x24 小时稳定在线，永不崩溃闪退
process.on('uncaughtException', err => {
  console.error('[am-cloud] 全局未捕获异常 (已拦截，服务维持稳定运行):', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[am-cloud] 全局未捕获 Promise 拒绝 (已拦截):', reason);
});

