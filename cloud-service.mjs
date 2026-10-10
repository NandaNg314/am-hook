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
async function packZipFolder(sourceDir, outputZipPath) {
  const zipScript = path.join(__dirname, 'zip_pack.py');
  await execFileAsync('python3', [zipScript, outputZipPath, sourceDir], { timeout: 180000 });
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
  let offset = 0;
  while (offset + 8 <= mp4Bytes.length) {
    const size = dv.getUint32(offset, false);
    const type = String.fromCharCode(...mp4Bytes.subarray(offset + 4, offset + 8));
    if (type === 'moov') {
      moovOffset = offset;
      moovSize = size;
      break;
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
    console.log(`[Cloud-Transfer] 收到全辑并发转存打包请求，正在将会话 ${batchId} (${files.length} 个文件) 打包为 .zip...`);
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
  const chosenLyricsFormat = (lyricsFormat || 'lrc').toLowerCase() === 'ttml' ? 'ttml' : 'lrc';

  let audioHookUrl = directHookUrl;
  let chosenFormatName = '';

  // 1. 如果没有直接传 hookFileUrl，通过 127.0.0.1:31408/parse/song/{adamId} 获取
  let webplaybackM3u8 = null; // 当 master 为 M4P 单文件时，回退 /webplayback 标准 HLS
  if (!audioHookUrl) {
    if (!adamId) throw new Error('缺少 adamId 或 hookFileUrl');
    const parseRes = await fetch(`${HOOK_BASE}/parse/song/${adamId}`, { signal: AbortSignal.timeout(30000) });
    if (!parseRes.ok) {
      const parseErr = await parseRes.json().catch(() => ({}));
      // master m3u8 解析不出变体（wrapper 返回 M4P 单文件 + accessKey）：改用 /webplayback 拿标准 HLS（CENC key 内嵌）
      if (parseErr.msg?.includes('No variants') || parseErr.msg?.includes('failed to get m3u8')) {
        try {
          const wpRes = await fetch(`${WRAPPER_BASE}/webplayback?adamId=${adamId}`, { signal: AbortSignal.timeout(15000) });
          if (wpRes.ok) {
            const wpData = await wpRes.json();
            const wpUrl = wpData?.data?.m3u8;
            if (wpUrl && wpUrl.includes('.m3u8')) {
              webplaybackM3u8 = wpUrl;
              // webplayback 为标准 HLS（CENC key 内嵌），实际音质为 AAC 256kbps 上限（Apple 端格式限制）
              chosenFormatName = 'AAC (webplayback)';
              console.log(`[Cloud-Transfer] master 为 M4P 单文件，回退 webplayback 标准 HLS 拉流: ${adamId}`);
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
  const fetchAudio = async () => {
    if (webplaybackM3u8) {
      // M4P 单文件回退：ffmpeg 直接下载并解密 webplayback 标准 HLS（CENC key 内嵌于 m3u8，无需 wrapper /key）
      const rnd = Math.random().toString(36).slice(2, 8);
      const tmpOut = `/tmp/am_wp_${Date.now()}_${rnd}.m4a`;
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-v', 'error',
          '-allowed_extensions', 'ALL',
          '-user_agent', 'Mozilla/5.0',
          '-i', webplaybackM3u8,
          '-c', 'copy',
          tmpOut
        ], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
        return new Uint8Array(await fs.promises.readFile(tmpOut));
      } finally {
        try { await fs.promises.unlink(tmpOut); } catch {}
      }
    }
    const aRes = await fetch(targetAudioUrl, { signal: AbortSignal.timeout(300000) });
    if (!aRes.ok) throw new Error(`获取音频流失败: HTTP ${aRes.status}`);
    return new Uint8Array(await aRes.arrayBuffer());
  };
  tasks.push(fetchAudio());

  // 封面图抓取 (优先命中内存缓存，杜绝 Apple CDN 批量请求抖动导致封面丢失)
  const fetchCover = async () => {
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

  // 歌词抓取与多格式/降级解析
  const fetchLyricsData = async () => {
    if (passedLyrics !== undefined && passedLyrics !== null) {
      if (typeof passedLyrics === 'string' && passedLyrics.trim()) {
        return parseLyrics(passedLyrics);
      }
      return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    }
    if (!adamId) return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    try {
      const lRes = await fetch(`${HOOK_BASE}/lyrics/${adamId}`, { signal: AbortSignal.timeout(5000) });
      if (lRes.ok) {
        const rawTtml = await lRes.text();
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

  // 计算内嵌歌词（支持不内嵌，无动态歌词自动降级为纯文本内嵌）
  let embedLyricsText = '';
  if (shouldEmbedLyrics && lyricsData.hasLyrics) {
    embedLyricsText = lyricsData.isDynamic ? lyricsData.lrc : lyricsData.plain;
  }

  // 3. 标签注入
  const cleanTitle = sanitizeFilename(meta.title || 'Unknown Title');
  const cleanArtist = sanitizeFilename(meta.artist || 'Unknown Artist');
  const standardM4aName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.m4a`;

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

  // 准备外挂独立歌词文件 (若曲目完全没有歌词，则自动不保存任何歌词文件)
  let lyricsFilename = null;
  let lyricsContent = null;
  let lyricsMime = 'text/plain;charset=utf-8';
  if (shouldSaveLyricsFile && lyricsData.hasLyrics) {
    if (chosenLyricsFormat === 'ttml' && lyricsData.ttml) {
      lyricsFilename = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.ttml`;
      lyricsContent = lyricsData.ttml;
      lyricsMime = 'application/xml;charset=utf-8';
    } else if (lyricsData.lrc) {
      lyricsFilename = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.lrc`;
      lyricsContent = lyricsData.lrc;
      lyricsMime = 'text/plain;charset=utf-8';
    }
  }

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

  // 5. 可选: 上传独立歌词文件到同一文件夹
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
    rec = { count: 0, resetAt: now + 60000, dailyCount: 0, dailyResetAt: now + 86400000 };
    webIpLimitMap.set(clientIp, rec);
  }

  if (now > rec.resetAt) {
    rec.count = 0;
    rec.resetAt = now + 60000;
  }
  if (now > rec.dailyResetAt) {
    rec.dailyCount = 0;
    rec.dailyResetAt = now + 86400000;
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

