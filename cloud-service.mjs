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

// Gofile 单次上传硬上限：实测 >4GB 会被服务端直接断连（UND_ERR_SOCKET other side closed），
// 3GB/4GB 正常，5GB/5.6GB 必挂。因此超过该阈值必须分卷，阈值留 200MB 余量。
const GOFILE_MAX_PART_BYTES = 3.8 * 1024 * 1024 * 1024;

/**
 * 上传单个文件到 Gofile（游客或指定 folderId/token）。成功返回 Gofile 的 data 载荷。
 * 注意：Gofile 无「预先建空文件夹」的公开端点；游客首次上传时服务端会自动建好文件夹，
 * 后续文件把该 folderId/token 传回来即可全部归集到同一分享页。
 */
async function uploadFileToGofile(filePath, fileName, { folderId, token, timeoutMs = 300000 } = {}) {
  const srv = await getGofileServer();
  const form = new FormData();
  // 使用 fs.openAsBlob 流式传输，不占用任何 Node.js 堆内存，彻底杜绝大包 OOM
  const blob = await fs.openAsBlob(filePath, { type: 'application/zip' });
  form.append('file', blob, fileName);
  if (folderId) form.append('folderId', folderId);
  if (token) form.append('token', token);

  const upRes = await fetch(`https://${srv}.gofile.io/contents/uploadfile`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await upRes.text();
  let upData;
  try {
    upData = JSON.parse(raw);
  } catch {
    throw new Error(`Gofile 返回非 JSON 响应 (HTTP ${upRes.status}): ${raw.slice(0, 160)}`);
  }
  if (upData.status !== 'ok') {
    throw new Error(`Gofile 上传失败: ${upData.status || '未知错误'}`);
  }
  return upData.data || {};
}

/**
 * 把会话目录按累计大小贪心切卷：每卷均为完整独立 ZIP，最后一卷收尾。
 * 单文件本身超限时单独成卷（避免后续曲目被它连带卡死）。
 */
function groupFilesByLimit(fileSizes, limitBytes) {
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
  return groups;
}

/**
 * 生成打包内的 error.log（英文内容，仅在确有失败曲目时生成）。
 * 由前端把逐曲失败信息随 finalize 请求带上来，避免服务端重复探测。
 * 返回写入的文件名，无失败则返回 null。
 */
function writeBatchErrorLog(sessionDir, failedTracks, albumName) {
  const list = Array.isArray(failedTracks) ? failedTracks.filter(Boolean) : [];
  if (!list.length) return null;

  const lines = [];
  lines.push('am-hook transfer error report');
  lines.push('==============================');
  lines.push(`Album / Playlist : ${albumName || 'Unknown'}`);
  lines.push(`Generated (UTC)  : ${new Date().toISOString()}`);
  lines.push(`Failed tracks    : ${list.length}`);
  lines.push('');
  lines.push('The following tracks could NOT be included in this archive:');
  lines.push('');
  list.forEach((t, i) => {
    const title = t.title || 'Unknown title';
    const artist = t.artist || 'Unknown artist';
    const album = t.album || '';
    const reason = String(t.error || 'Unknown error').replace(/\s+/g, ' ').trim();
    lines.push(`${String(i + 1).padStart(2, ' ')}. ${artist} - ${title}${album ? ` [${album}]` : ''}`);
    lines.push(`    Reason: ${reason}`);
    if (t.adamId) lines.push(`    Track ID: ${t.adamId}`);
    lines.push('');
  });
  lines.push('Possible causes:');
  lines.push('  - Track is not available in the storefront of the resolving account (regional exclusivity).');
  lines.push('  - Track is DRM-only and the web playback stream is incomplete or malformed.');
  lines.push('  - Upstream request timed out or was rate-limited; re-run the transfer for these tracks.');

  const fileName = '_INTERNAL_error.log.txt';
  try {
    fs.writeFileSync(path.join(sessionDir, fileName), lines.join('\n'), 'utf8');
    console.log(`[Cloud-Transfer] 已写入错误清单: ${fileName} (${list.length} 首失败)`);
    return fileName;
  } catch (err) {
    console.warn('[Cloud-Transfer] 写入错误清单失败:', err.message);
    return null;
  }
}

/**
 * 在目录内以「排他创建」方式写入文件，杜绝并发下的同名覆盖 (TOCTOU)。
 * 先尝试原名；若已存在，则依次尝试 `<prefix><原名>`、`<原名> (2)`、`(3)`…
 * 返回 { fileName, prefix, collisionSeq }，collisionSeq > 0 表示发生了重命名。
 */
function writeFileExclusive(dir, baseName, data, trackPrefix = '') {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);

  // 候选名生成器：0 = 原名；1 = 曲目号前缀；2+ = 编号后缀
  const candidates = function* () {
    yield { name: baseName, prefix: '' };
    if (trackPrefix) yield { name: `${trackPrefix}${baseName}`, prefix: trackPrefix };
    for (let n = 2; n <= 999; n++) {
      yield { name: `${stem} (${n})${ext}`, prefix: trackPrefix };
    }
  };

  let seq = 0;
  for (const cand of candidates()) {
    seq++;
    const full = path.join(dir, cand.name);
    try {
      // 'wx' = 排他创建，文件已存在则抛 EEXIST，且检查与创建是原子的
      const fd = fs.openSync(full, 'wx');
      try {
        fs.writeFileSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
      return { fileName: cand.name, prefix: cand.prefix, collisionSeq: seq - 1 };
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`无法为 ${baseName} 分配唯一文件名（同名过多）`);
}

/**
 * 给目录内文件取一个不冲突的名字（不实际创建，仅计算），用于歌词等附属文件。
 */
function uniqueNameInDir(dir, baseName, trackPrefix = '') {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  const exists = (n) => fs.existsSync(path.join(dir, n));
  if (!exists(baseName)) return baseName;
  if (trackPrefix && !exists(`${trackPrefix}${baseName}`)) return `${trackPrefix}${baseName}`;
  for (let n = 2; n <= 999; n++) {
    const cand = `${stem} (${n})${ext}`;
    if (!exists(cand)) return cand;
  }
  return baseName;
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

/**
 * Apple 的日文歌词正文里混入了康熙部首码位（U+2E80–U+2FFF）：「⼆⼈」实为「二人」、「⾔」实为「言」。
 * 这些不是正常汉字，多数播放器会渲染成方块，NFKC 归一化后等价还原。
 * 只处理：康熙部首 (2E80–2FFF) / 兼容汉字 (F900–FAFF) / 全角 ASCII (FF01–FF5E) / 半全角片假名 (FF61–FF9F)。
 * ⚠️ 不可整段处理 U+FF00–FFEF：其中 U+FFA0–FFDC 是半角谚文，NFKC 会拆成组合字母，正文出现就会乱码。
 */
function normalizeLyricGlyphs(str) {
  if (!str) return str;
  return str.replace(/[\u2E80-\u2FFF\uF900-\uFAFF\uFF01-\uFF5E\uFF61-\uFF9F]/g, (ch) => ch.normalize('NFKC'));
}

/* ==================== 注音（罗马音 / 假名）==================== */

/**
 * 罗马音 → 平假名（用于「注音」开关的假名模式；Apple 只提供罗马音，假名由这里反推）
 *
 * ⚠️ 本函数在 `cloud-service.mjs` 与 `src/ui/views/local-download.mjs` 各有一份**完全相同**的副本
 *    （浏览器端不能 import 服务端文件，只能复制）。**改一边必须同步改另一边**，
 *    两份分叉会导致 TG 与网页端对同一首歌产出不同的假名。
 *
 * 转换策略：
 *  1. 三字母（拗音 / shi chi tsu she che je fa fi fe fo）→ 两字母 → 单位元音，逐级回退
 *  2. n 后接元音或 y 时读「ん」（shinjuku → しんじゅく），否则 n 后接辅音仍为「ん」
 *  3. 促音（kko → っこ）：同辅音双写，排除 n（nn 表示拨音）
 *  4. **无法完整识别的词整词回退为原始罗马音**，绝不产出「wひ」「jえt」这类半成品
 */
function romanToHiragana(roman) {
  if (!roman) return '';
  // 三字母优先于两字母（否则 sh/ny/j 等前缀会抢占）
  const TRIPLE = {
    kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
    sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
    cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
    nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ', hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
    bya: 'びゃ', byu: 'びゅ', byo: 'びょ', pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
    mya: 'みゃ', myu: 'みゅ', myo: 'みょ', rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
    dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
    // n + 拗音 / n + j（shinjuku → しんじゅく），必须早于两字母 nj / ja
    nja: 'んじゃ', nju: 'んじゅ', njo: 'んじょ',
    nji: 'んじ', nje: 'んじぇ',
    // nn 表拨音而非促音
    nna: 'んな', nni: 'んに', nnu: 'んぬ', nne: 'んね', nno: 'んの',
    // 三字母基本音节（否则会先撞上两字母的 sh/ch/ts 前缀而落空）
    shi: 'し', chi: 'ち', tsu: 'つ', she: 'しぇ', che: 'ちぇ', je: 'じぇ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
    dhi: 'でぃ', dhu: 'でゅ',
  };
  const PAIR = {
    ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
    sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ', za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
    ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と', da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
    na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の', ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
    ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ', pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
    ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も', ya: 'や', yu: 'ゆ', yo: 'よ',
    ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ', wa: 'わ', wo: 'を',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
    wi: 'うぃ', we: 'うぇ',
    // 外来语两字母写法（fe 等三字母表同名项在此也需保留，否则 fensu → ふえんす）
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
  };
  const SINGLE = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', n: 'ん' };
  // 单个辅音字母（法语词 fensu、德语词 等罗马音里偶尔出现的非日语音节）的近似转写，
  // 保证假名模式下**不残留拉丁字母**
  const LONE = {
    k: 'く', g: 'ぐ', s: 'す', z: 'ず', j: 'じ', t: 'と', d: 'ど',
    h: 'ふ', f: 'ふ', b: 'ぶ', p: 'ぷ', m: 'む', y: 'い', r: 'る', w: 'う',
    c: 'く', v: 'ゔ', l: 'る', q: 'く', x: 'く',
  };
  const isVowel = (c) => 'aiueo'.includes(c);
  const isConsonant = (c) => c >= 'a' && c <= 'z' && !isVowel(c) && c !== 'n';

  /** 转换单个纯字母片段；返回 { text, complete }。complete=false 表示有字母没转成假名 */
  const convertChunk = (s) => {
    const out = [];
    let i = 0;
    let complete = true;
    while (i < s.length) {
      const ch = s[i];
      // 促音：同辅音双写（kko → っこ），n 双写表示拨音不算促音
      if (ch !== 'n' && isConsonant(ch) && s[i + 1] === ch) {
        out.push('っ');
        i += 1;
        continue;
      }
      // n 结尾，或 n 后接辅音（非 y/j）→ ん；n + y/j 能构成拗音时才合并（konya → こにゃ、shinjuku → しんじゅく）
      if (ch === 'n') {
        const next = s[i + 1];
        const mergesWithN = (next === 'y' || next === 'j') && TRIPLE[s.slice(i, i + 3)];
        if (next === undefined || (next !== 'y' && next !== 'j' && !isVowel(next)) || ((next === 'y' || next === 'j') && !mergesWithN)) {
          out.push('ん');
          i += 1;
          continue;
        }
      }
      const tri = s.slice(i, i + 3);
      if (TRIPLE[tri]) { out.push(TRIPLE[tri]); i += 3; continue; }
      const pair = s.slice(i, i + 2);
      if (PAIR[pair]) { out.push(PAIR[pair]); i += 2; continue; }
      if (SINGLE[ch]) { out.push(SINGLE[ch]); i += 1; continue; }
      // 兜底：单字母近似，不让拉丁字母漏进假名行
      complete = false;
      out.push(LONE[ch] || ch);
      i += 1;
    }
    return { text: out.join(''), complete };
  };

  // 按拉丁字母段切分，空格 / 标点 / 数字原样保留。
  // 转换失败的字母按单字母近似兜底（fensu → ふぇんす），保证假名行不残留拉丁字母。
  return String(roman)
    .split(/([a-z]+)/i)
    .map((part) => (/[a-z]/i.test(part) ? convertChunk(part.toLowerCase()).text : part))
    .join('')
    .replace(/ー+/g, 'ー');
}

/** 从 TTML 的 <transliterations> 里按 itunes:key 提取罗马音行（逐词 span 拼成整行） */
function extractTransliterationMap(ttmlContent) {
  const blockMatch = ttmlContent.match(/<transliterations\b[^>]*>([\s\S]*?)<\/transliterations>/i);
  if (!blockMatch) return null;
  // 优先 ja-Latn（日语罗马音）；英文歌若有其他音译则不采用，避免给英文歌乱注音
  const latinMatch = blockMatch[1].match(/<transliteration\b[^>]*xml:lang=["']ja-Latn["'][^>]*>([\s\S]*?)<\/transliteration>/i);
  if (!latinMatch) return null;
  const map = {};
  const textRegex = /<text\b[^>]*for=["']([^"']+)["'][^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = textRegex.exec(latinMatch[1])) !== null) {
    const body = unescapeXml(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (m[1] && body) map[m[1]] = body;
  }
  return Object.keys(map).length ? map : null;
}

/**
 * 注音 LRC：在每个原文行下方插入同时间戳的注音行。
 * mode = 'roman'（罗马音，Apple 原样）| 'kana'（平假名，由罗马音反推）
 * 每行输出顺序固定为「原文 / 注音 / 译文」，保证不同歌之间排版一致可预期。
 */
function annotateLyricLines(ttmlContent, baseLines, mode = 'roman') {
  if (!ttmlContent || !Array.isArray(baseLines) || !baseLines.length) return null;
  const transMap = extractTransliterationMap(ttmlContent);
  if (!transMap) return null;
  const out = [];
  let injected = 0;
  for (const line of baseLines) {
    const prefix = line.time ? `${line.time} ` : '';
    out.push(`${prefix}${line.text}`);
    // ⚠️ 只有带 itunes:key 的行才能对齐罗马音。纯文本降级路径的 key 为 ''，
    //    此处若不加判断会命中 transMap[''] 的残留值，把同一句注音重复灌进每一行。
    const roman = line.key ? transMap[line.key] : '';
    if (roman) {
      const plainBody = String(line.text || '').replace(/\s+/g, '').toLowerCase();
      let note = '';
      if (roman.replace(/\s+/g, '').toLowerCase() !== plainBody) {
        note = mode === 'kana' ? romanToHiragana(roman) : roman;
      }
      if (note) {
        out.push(`${prefix}${note}`);
        injected += 1;
      }
    }
    if (line.translation) out.push(`${prefix}${line.translation}`);
  }
  return injected ? out : null;
}

function parseLyrics(ttmlContent) {
  if (!ttmlContent || typeof ttmlContent !== 'string' || !ttmlContent.trim()) {
    return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
  }
  ttmlContent = normalizeLyricGlyphs(ttmlContent);

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
  const structLines = [];
  let match;

  while ((match = pRegex.exec(cleaned)) !== null) {
    const pAttrs = match[1] || '';
    let body = match[2].replace(/<[^>]+>/g, '');
    body = unescapeXml(body).trim();
    if (!body) continue;

    plainLines.push(body);

    const beginMatch = pAttrs.match(/\bbegin=["']([^"']+)["']/i);
    const keyMatch = pAttrs.match(/\bitunes:key=["']([^"']+)["']/i);
    if (beginMatch) {
      const seconds = parseTimeToSeconds(beginMatch[1]);
      const ts = formatLrcTimestamp(seconds);
      timedLines.push(`${ts} ${body}`);
      structLines.push({ key: keyMatch ? keyMatch[1] : '', time: ts, text: body, translation: '' });
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
    ttml: ttmlContent,
    lines: structLines
  };
}

/* ==================== 官方翻译 → 双语 LRC ==================== */

// Apple 的译文块按 <span> 逐词切分，词与词之间留有真实的空格文本节点。英文里这些空格有意义，
// 中文里却是噪音：「徘徊过 多少 橱窗 住 过 多少 旅 馆」正确写法是「徘徊过多少橱窗住过多少旅馆」。
// 只删除「两侧都是全角 CJK」的空格，中英混排（如「love 你」）与纯英文均原样保留。
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
function collapseCjkSpaces(str) {
  const trimmed = String(str || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  let out = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === ' ') {
      const prev = out.slice(-1);
      const next = trimmed[i + 1] || '';
      if (prev && next && CJK_RE.test(prev) && CJK_RE.test(next)) continue;
    }
    out += ch;
  }
  return out;
}

// TTML 的 <translations><translation xml:lang="zh-Hans"><text for="L1">译文</text>...
// 通过 itunes:key 与原文 <p> 一一对齐。译文可含 <span ttm:role="x-bg">(和声)</span> 背景和声，剥离生成干净中文。
function buildBilingualLrc(ttmlContent, targetLang = 'zh-Hans-CN') {
  if (!ttmlContent || typeof ttmlContent !== 'string' || !ttmlContent.trim()) {
    return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
  }
  ttmlContent = normalizeLyricGlyphs(ttmlContent);

  // 旧逻辑只要原文语种以 `zh` 开头就整首跳过翻译，但粤语/台语歌词的 xml:lang 是 zh-Hant，
  // 此时 Apple 返回的译文块正是用户勾选「翻译」时要的繁→简对照（type="replacement"）。
  // 结果粤语歌开翻译后仍拿到纯繁体，看起来像「翻译失效」。
  // 现在只在原文语种与目标语种完全一致（zh-Hant→zh-Hant、en→en）时才跳过，
  // 其余情形（zh-Hant→zh-Hans、en→zh-Hans…）一律按翻译块处理。
  const rootLang = (ttmlContent.match(/<tt\b[^>]*xml:lang=["']([^"']+)["']/i)?.[1] || '').toLowerCase().replace(/_/g, '-');
  const target = targetLang.toLowerCase().replace(/_/g, '-');
  const script = (lang) => lang.split('-')[1] || '';
  // 原文就是目标语种本身（zh-Hant→zh-Hant、en→en、zh-Hans→zh-Hans-CN）：没有可对照的差异，降级单语
  if (rootLang && rootLang === target) return null;
  // 中文之间只有繁体/简体（script 子标签）不同才值得对照，同写法则跳过
  if (rootLang.startsWith('zh') && target.startsWith('zh') && script(rootLang) === script(target)) return null;
  // 中文原文不翻成外语
  if (rootLang.startsWith('zh') && !target.startsWith('zh')) return null;

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
    const text = collapseCjkSpaces(unescapeXml(raw));
    if (key && text) transMap[key] = text;
  }

  // 3. 遍历原文 <p begin itunes:key>，按时间戳生成 原文 + 译文 双行
  const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  const lrcLines = [];
  const structLines = [];
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
    const key = keyMatch ? keyMatch[1] : '';
    const translation = key && transMap[key] ? transMap[key] : '';
    lrcLines.push(`${ts} ${body}`);
    if (translation) {
      lrcLines.push(`${ts} ${translation}`);
    }
    structLines.push({ key, time: ts, text: body, translation });
  }

  if (lrcLines.length === 0) {
    return null;
  }
  // plain 语义与 parseLyrics 保持一致：**去时间戳的纯文本行**（原文+译文，不含注音）。
  // 之前误用 lrcLines.join('\n')（带时间戳的整段 LRC），会让调用方把时间戳当正文重复处理。
  const plainLines = [];
  for (const l of structLines) {
    if (l.text) plainLines.push(l.text);
    if (l.translation) plainLines.push(l.translation);
  }
  return {
    hasLyrics: true,
    isDynamic: true,
    lrc: lrcLines.join('\n'),
    plain: plainLines.join('\n'),
    ttml: ttmlContent,
    lines: structLines
  };
}

/* ==================== 原生 MP4 标签注入 ==================== */

function createDataAtom(type, flags, payload) {
  // MP4 fourcc 必须精确 4 字节，非 ASCII (如 \xa9) 必须用 charCodeAt 保证单字节
  const typeBytes = Uint8Array.from(type, c => c.charCodeAt(0));
  // `data` box：8B header + 4B type_indicator + 4B locale = 16B，payload 紧随其后
  const dataSize = 16 + payload.length;
  const dataHeader = new Uint8Array(dataSize);
  const dataView = new DataView(dataHeader.buffer);
  dataView.setUint32(0, dataSize, false);
  dataHeader.set(new TextEncoder().encode('data'), 4);
  dataView.setUint32(8, flags, false);
  dataView.setUint32(12, 0, false);
  dataHeader.set(payload, 16);

  const atomSize = 8 + dataSize;
  const atomHeader = new Uint8Array(8);
  new DataView(atomHeader.buffer).setUint32(0, atomSize, false);
  atomHeader.set(typeBytes, 4);

  const res = new Uint8Array(atomSize);
  res.set(atomHeader, 0);
  res.set(dataHeader, 8);
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

/* ==================== Dolby Atmos (dec3 / JOC) 保持 ==================== */
/**
 * 遍历 MP4 的 box 树，回调每个 box：`cb(kind, start, size)` 返回 true 时停止。
 * 只下降到轨道容器层级，样本条目（`stsd` 的 entry）单独处理——它不是普通容器。
 */
function walkMp4Boxes(buf, start, end, cb, parentKind = '') {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return false;
      size = Number(buf.readBigUInt64BE(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) return false;
    if (cb(kind, p, size, parentKind, hdr)) return true;
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf'].includes(kind)) {
      if (walkMp4Boxes(buf, p + hdr, p + size, cb, kind)) return true;
    }
    p += size;
  }
  return false;
}

/**
 * 取 `stsd` 里第一个音频样本条目的 `dec3`（EC3SpecificBox）原始字节。
 * Atmos 的 JOC 标志（`flag_ec3_extension_type_a` / `complexity_index_type_a`，
 * Apple 写的是 `0x01 0x10`）是挂在 `dec3` 尾部的**保留字节**，没有它播放器只会当普通 E-AC-3。
 */
function extractDec3Box(buf) {
  let found = null;
  walkMp4Boxes(buf, 0, buf.length, (kind, p, size, parent, hdr) => {
    if (kind !== 'stsd' || parent !== 'stbl') return false;
    // stsd: fullbox(4) + entry_count(4)，之后是样本条目
    let q = p + hdr + 8;
    while (q + 8 <= p + size) {
      const esize = buf.readUInt32BE(q);
      if (esize < 8 || q + esize > p + size) break;
      // 音频样本条目固定 28B 字段（视频是 78B，这里只关心音频）
      let r = q + 8 + 28;
      while (r + 8 <= q + esize) {
        const csize = buf.readUInt32BE(r);
        const ckind = buf.toString('latin1', r + 4, r + 8);
        if (csize < 8 || r + csize > q + esize) break;
        if (ckind === 'dec3') {
          found = buf.subarray(r + 8, r + csize); // 只取负载（不含 8B header）
          return true;
        }
        r += csize;
      }
      q += esize;
    }
    return false;
  });
  return found;
}

/**
 * `dec3` 的尾部保留字节里，前 1 字节 `flag_ec3_extension_type_a` 为 1 时
 * 紧跟 1 字节 `complexity_index_type_a`；都没有则是普通 E-AC-3。
 */
function dec3JocTail(dec3) {
  if (!dec3 || dec3.length < 5) return null;
  const numIndSub = dec3[0] & 0x07;
  // 每个独立子流：3B；num_dep_sub>0 时再多 1B chan_loc
  let p = 1;
  for (let i = 0; i <= numIndSub; i++) {
    if (p + 3 > dec3.length) return null;
    const numDepSub = (dec3[p + 2] >> 1) & 0x0f;
    p += numDepSub > 0 ? 4 : 3;
  }
  if (p >= dec3.length) return null;
  const flag = dec3[p];
  const need = flag !== 0 ? 2 : 1;
  if (p + need > dec3.length) return null;
  return Buffer.from(dec3.subarray(p, p + need));
}

/**
 * ffmpeg 重封装 E-AC-3 时只按 ETSI TS 102 366 的固定 4 个子流字段写 `dec3`，
 * **会丢掉尾部 JOC 扩展字节**——产物被识别成普通 E-AC-3，Dolby Atmos 全部消失。
 * 这里把 `dst` 里的 `dec3` 负载替换为 `src` 的原始负载，并修正外层 box 尺寸。
 * 仅当目标缺少尾部字节时才改写，已是完整结构则原样返回。
 */
function restoreAtmosDec3(dst, srcDec3) {
  const tail = dec3JocTail(srcDec3);
  if (!tail) return dst; // 源本身没有 Atmos 标志，无需处理
  // 音频样本条目 4CC（`dec3` 的父级），决定下降 28B 音频字段后才是子 box
  const sampleEntryKinds = new Set(['ec-3', 'ac-3', 'mp4a', 'alac', 'samr', 'sawb', 'lpcm']);

  let patch = null;
  const find = (buf) => {
    let hit = null;
    walkMp4Boxes(buf, 0, buf.length, (kind, p, size, parent, hdr) => {
      if (kind !== 'stsd' || parent !== 'stbl') return false;
      let q = p + hdr + 8;
      while (q + 8 <= p + size) {
        const esize = buf.readUInt32BE(q);
        if (esize < 8 || q + esize > p + size) break;
        let r = q + 8 + 28;
        while (r + 8 <= q + esize) {
          const csize = buf.readUInt32BE(r);
          const ckind = buf.toString('latin1', r + 4, r + 8);
          if (csize < 8 || r + csize > q + esize) break;
          if (ckind === 'dec3') {
            hit = { start: r, size: csize, payload: buf.subarray(r + 8, r + csize) };
            return true;
          }
          r += csize;
        }
        q += esize;
      }
      return false;
    });
    return hit;
  };

  patch = find(dst);
  if (!patch) return dst;
  // 目标已带尾部扩展（含相同尾字节）→ 不动
  if (patch.payload.length >= srcDec3.length && dec3JocTail(patch.payload)) {
    const curTail = dec3JocTail(patch.payload);
    if (curTail && Buffer.compare(curTail, tail) === 0) return dst;
  }

  const delta = srcDec3.length - patch.payload.length;
  if (delta === 0) {
    srcDec3.copy(dst, patch.start + 8);
    return dst;
  }

  // 尺寸变化：先把 dec3 及所有祖先 box 的 size 字段改好，再拼接新缓冲
  // 祖先链必须包含样本条目本身（`dec3` 的父级是 `ec-3`，不是 `stsd`），
  // 因此这里复用与 walkMp4Boxes 完全一致的下降规则。
  const sizeFields = [];
  const collectAncestors = (targetStart) => {
    const walk = (start, end) => {
      let p = start;
      while (p + 8 <= end) {
        let size = dst.readUInt32BE(p);
        const kind = dst.toString('latin1', p + 4, p + 8);
        let hdr = 8;
        if (size === 1) {
          size = Number(dst.readBigUInt64BE(p + 8));
          hdr = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < hdr || p + size > end) return false;
        if (targetStart >= p && targetStart < p + size) {
          sizeFields.push(p);
          if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(kind)) {
            return walk(p + hdr, p + size);
          }
          if (kind === 'stsd') {
            // stsd 的条目区起点：p+8 hdr +4 version/flags +4 entry_count
            return walk(p + 16, p + size);
          }
          // 样本条目（`ec-3`/`mp4a`…）：固定 28B 音频字段后才是 `dec3` 等子 box
          if (sampleEntryKinds.has(kind)) {
            return walk(p + hdr + 28, p + size);
          }
          return true;
        }
        p += size;
      }
      return false;
    };
    walk(0, dst.length);
  };
  collectAncestors(patch.start);

  const out = Buffer.allocUnsafe(dst.length + delta);
  // dec3 之后的数据整体后移 delta
  dst.copy(out, 0, 0, patch.start + 8);
  srcDec3.copy(out, patch.start + 8);
  dst.copy(out, patch.start + 8 + srcDec3.length, patch.start + 8 + patch.payload.length);
  for (const sf of sizeFields) {
    const cur = out.readUInt32BE(sf);
    if (cur !== 1 && cur !== 0) out.writeUInt32BE(cur + delta, sf);
  }
  // dec3 位于 moov 内，插入字节会把其后 mdat 整体后移 delta，而 stco/co64 记的是
  // mdat 内的绝对偏移 → 必须同步平移，否则所有样本指针错位。
  // 只在「moov 在 mdat 之前」时平移；ffmpeg 的 +faststart 必然是这个布局。
  const shiftChunkOffsets = (buf, minOffset) => {
    const visit = (start, end) => {
      let p = start;
      while (p + 8 <= end) {
        let size = buf.readUInt32BE(p);
        const kind = buf.toString('latin1', p + 4, p + 8);
        let hdr = 8;
        if (size === 1) {
          size = Number(buf.readBigUInt64BE(p + 8));
          hdr = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < hdr || p + size > end) return;
        if (kind === 'stco') {
          const n = buf.readUInt32BE(p + 12);
          for (let i = 0; i < n; i++) {
            const at = p + 16 + i * 4;
            if (at + 4 > p + size) break;
            const v = buf.readUInt32BE(at);
            if (v >= minOffset) buf.writeUInt32BE(v + delta, at);
          }
        } else if (kind === 'co64') {
          const n = buf.readUInt32BE(p + 12);
          for (let i = 0; i < n; i++) {
            const at = p + 16 + i * 8;
            if (at + 8 > p + size) break;
            const v = Number(buf.readBigUInt64BE(at));
            if (v >= minOffset) buf.writeBigUInt64BE(BigInt(v + delta), at);
          }
        }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(kind)) visit(p + hdr, p + size);
        p += size;
      }
    };
    visit(0, buf.length);
  };
  // mdat 的负载起点在插入点之后，就是需要平移的阈值
  let mdatPayloadStart = -1;
  (function findMdat(start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = dst.readUInt32BE(p);
      const kind = dst.toString('latin1', p + 4, p + 8);
      let hdr = 8;
      if (size === 1) { size = Number(dst.readBigUInt64BE(p + 8)); hdr = 16; }
      if (kind === 'mdat') { mdatPayloadStart = p + hdr; return; }
      if (size < hdr) return;
      p += size;
    }
  })(0, dst.length);
  if (mdatPayloadStart > patch.start) shiftChunkOffsets(out, mdatPayloadStart);
  return out;
}

/**
 * 剥除音频样本条目里的 `btrt`（BitRateBox）。
 *
 * ffmpeg 重封装时总会往样本条目塞一个 20 字节的 `btrt`，使 `stsd` 从 67B（Apple 原生形态）
 * 膨胀到 87B。Android MediaExtractor / 椒盐音乐（Salt Player）等严格实现会因此拒绝该文件。
 * 实测：同一份音频剥掉 `btrt` 后 `stsd` 回到 67B，与能正常播放的参考样本逐字段一致。
 * 剥除后同步修正 `ec-3` 条目及全部祖先 box（`stsd`→`stbl`→`minf`→`mdia`→`trak`→`moov`）
 * 的尺寸，并按 `mdat` 负载起点平移 `stco`/`co64` 绝对偏移。
 */
function stripBitrateBox(dst) {
  const sampleEntryKinds = new Set(['ec-3', 'ac-3', 'mp4a', 'alac', 'samr', 'sawb', 'lpcm']);

  // 只处理 moov 内部的音频轨样本条目：stsd 的条目子 box 里若含 btrt 就摘掉
  const moovEl = dst.indexOf(Buffer.from('moov', 'latin1'));
  if (moovEl < 4) return dst;
  const stsdEl = dst.indexOf(Buffer.from('stsd', 'latin1'), moovEl);
  if (stsdEl < 4) return dst;
  const stsdPos = stsdEl - 4;
  const stsdSize = dst.readUInt32BE(stsdPos);
  if (stsdSize < 16 || stsdPos + stsdSize > dst.length) return dst;

  // stsd: 8B 头 + 4B version/flags + 4B entry_count + N 个样本条目
  const entryCount = dst.readUInt32BE(stsdPos + 12);
  if (entryCount < 1) return dst;

  let hit = null;
  let q = stsdPos + 16;
  for (let e = 0; e < entryCount && q + 8 <= stsdPos + stsdSize; e++) {
    const esize = dst.readUInt32BE(q);
    const ekind = dst.toString('latin1', q + 4, q + 8);
    if (esize < 8 || q + esize > stsdPos + stsdSize) break;
    if (sampleEntryKinds.has(ekind)) {
      // 音频样本条目：8B 头 + 28B 固定字段，之后才是子 box（dec3 / btrt / esds ...）
      let r = q + 8 + 28;
      while (r + 8 <= q + esize) {
        const csize = dst.readUInt32BE(r);
        const ckind = dst.toString('latin1', r + 4, r + 8);
        if (csize < 8 || r + csize > q + esize) break;
        if (ckind === 'btrt') { hit = r; break; }
        r += csize;
      }
      if (hit !== null) break;
    }
    q += esize;
  }
  if (hit === null) return dst;

  const btrtSize = dst.readUInt32BE(hit);
  if (btrtSize < 8 || hit + btrtSize > dst.length) return dst;
  const delta = -btrtSize;

  // 祖先链：命中位置必须落在该 box 的 [pos, pos+size) 区间内。
  // 只在 moov 范围内向上找，避免把 mdat 等大块误判。
  const chain = [];
  (function walk(start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = dst.readUInt32BE(p);
      const kind = dst.toString('latin1', p + 4, p + 8);
      let hdr = 8;
      if (size === 1) { size = Number(dst.readBigUInt64BE(p + 8)); hdr = 16; }
      else if (size === 0) { size = end - p; }
      if (size < hdr) return;
      if (hit >= p && hit < p + size) {
        chain.push({ pos: p, hdr, size, kind });
        const moovPos = dst.indexOf(Buffer.from('moov', 'latin1')) - 4;
        if (kind === 'moov' || kind === 'trak' || kind === 'mdia' || kind === 'minf' || kind === 'stbl') {
          walk(p + hdr, p + size);
        } else if (kind === 'stsd') {
          walk(p + hdr + 8, p + size);
        } else if (sampleEntryKinds.has(kind)) {
          walk(p + hdr + 28, p + size);
        }
        return;
      }
      p += size;
    }
  })(moovEl - 4, dst.length);

  const out = Buffer.allocUnsafe(dst.length + delta);
  dst.copy(out, 0, 0, hit);
  dst.copy(out, hit, hit + btrtSize, dst.length);
  for (const c of chain) {
    // 跳过被删除的 btrt 自身：它的头部位置已被尾部数据覆盖，
    // 再写一次 size 会把搬过来的下一个 box（stts）的 size 字段清零。
    if (c.pos >= hit && c.pos < hit + btrtSize) continue;
    if (c.size === 0) continue;
    if (c.hdr === 16) out.writeBigUInt64BE(BigInt(c.size + delta), c.pos + 8);
    else out.writeUInt32BE(c.size + delta, c.pos);
  }

  // mdat 若在 btrt 之后，其内所有 stco/co64 绝对偏移都要同步前移
  const mdatEl = out.indexOf(Buffer.from('mdat', 'latin1'));
  if (mdatEl > hit) {
    const mdatPos = mdatEl - 4;
    (function shift(start, end) {
      let p = start;
      while (p + 8 <= end) {
        let size = out.readUInt32BE(p);
        const kind = out.toString('latin1', p + 4, p + 8);
        let hdr = 8;
        if (size === 1) { size = Number(out.readBigUInt64BE(p + 8)); hdr = 16; }
        else if (size === 0) { size = end - p; }
        if (size < hdr) return;
        if (kind === 'stco') {
          const n = out.readUInt32BE(p + 12);
          for (let k = 0; k < n && p + 16 + k * 4 + 4 <= p + size; k++) {
            const at = p + 16 + k * 4;
            const v = out.readUInt32BE(at);
            if (v >= mdatPos) out.writeUInt32BE(v + delta, at);
          }
        } else if (kind === 'co64') {
          const n = out.readUInt32BE(p + 12);
          for (let k = 0; k < n && p + 16 + k * 8 + 8 <= p + size; k++) {
            const at = p + 16 + k * 8;
            const v = Number(out.readBigUInt64BE(at));
            if (v >= mdatPos) out.writeBigUInt64BE(BigInt(v + delta), at);
          }
        }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(kind)) shift(p + hdr, p + size);
        p += size;
      }
    })(moovEl - 4, out.length);
  }
  return out;
}

/**
 * 将 HLS fragmented MP4 (fMP4) 极速解碎片并重封装为标准 Progressive M4A (ftyp M4A, moov faststart, mdat)
 * 采用 ffmpeg -c copy (纯容器重封装，0 编解码，无损音质 100% 保持，耗时仅 ~0.05s)
 * 彻底消除 moof 分片结构，写入完整 stbl 索引与 faststart 头部，
 * 彻底解决 Android ExoPlayer / MediaCodec / 椒盐音乐 等播放器报 "编码错误" (无法识别 moof 分片) 的问题
 * ⚠️ ffmpeg 会丢掉 E-AC-3 的 `dec3` JOC 尾部字节（Atmos 标志），必须用 `restoreAtmosDec3` 补回。
 */
/**
 * 解碎片产物自检。
 *
 * 必需满足：
 *  1. `moov` 存在且顶层没有 `moof`（分片未消除 → Android/椒盐音乐报「编码错误」）
 *  2. 音频轨 `stbl` 五子盒齐全（`stsd`/`stts`/`stsc`/`stsz`/`stco` 或 `co64`）
 *  3. `stsz` 的 sample_count > 0
 *
 * 返回 null 表示通过，否则返回问题描述字符串。
 */
function validateDefragged(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  const topKinds = [];
  let p = 0;
  while (p + 8 <= b.length) {
    let size = b.readUInt32BE(p);
    const kind = b.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = b.length - p;
    if (size < hdr || p + size > b.length) break;
    topKinds.push(kind);
    p += size;
  }

  if (!topKinds.includes('moov')) return '缺少 moov';
  if (topKinds.includes('moof')) return '仍残留 moof 分片';
  if (!topKinds.includes('mdat')) return '缺少 mdat';

  // 找第一个音频轨的 stbl
  const moovEl = b.indexOf(Buffer.from('moov', 'latin1'));
  const stblEl = b.indexOf(Buffer.from('stbl', 'latin1'), moovEl);
  if (stblEl < 4) return '未找到 stbl';

  const stblPos = stblEl - 4;
  const stblSize = b.readUInt32BE(stblPos);
  if (stblSize < 8 || stblPos + stblSize > b.length) return 'stbl 尺寸非法';

  const kids = new Set();
  let sizes = null;
  let q = stblPos + 8;
  while (q + 8 <= stblPos + stblSize) {
    let size = b.readUInt32BE(q);
    const kind = b.toString('latin1', q + 4, q + 8);
    let hdr = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(q + 8)); hdr = 16; }
    else if (size === 0) size = (stblPos + stblSize) - q;
    if (size < hdr) return `stbl 内 ${kind} 尺寸非法`;
    kids.add(kind);
    if (kind === 'stsz') sizes = { pos: q, size };
    q += size;
  }

  for (const need of ['stsd', 'stts', 'stsc', 'stsz']) {
    if (!kids.has(need)) return `stbl 缺少 ${need}`;
  }
  if (!kids.has('stco') && !kids.has('co64')) return 'stbl 缺少 stco/co64';

  if (sizes) {
    // stsz: 8B 头 + 4B version/flags + 4B sample_size + 4B sample_count
    if (sizes.size >= 20) {
      const count = b.readUInt32BE(sizes.pos + 16);
      if (count === 0) return 'stsz sample_count 为 0';
    }
  }

  return null;
}

async function defragMp4Buffer(inputBuf, codecHint = null) {
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmpIn = `/tmp/am_defrag_in_${Date.now()}_${rnd}.m4a`;
  const tmpOut = `/tmp/am_defrag_out_${Date.now()}_${rnd}.m4a`;
  try {
    await fs.promises.writeFile(tmpIn, inputBuf);
    // ⚠️ 必须显式 `-f mp4`：Ubuntu 打包的 FFmpeg 6.x 里 m4a 扩展名走的是 `ipod` muxer，
    // 而 `ipod` 不带 eac3 tag → "Could not find tag for codec eac3" 直接失败，
    // 整个解碎片会静默回退成未解碎片的 fMP4（椒盐音乐「编码错误」的真正根因）。
    // ⚠️ 必须 `-map 0:a` + `-map 0:v?`：封面是 `udta/meta/ilst/covr` 标签，
    // 但 ffmpeg 的 mov demuxer 会把它同时暴露成一路 mjpeg 视频流。
    // 若只 `-map 0:a`，ffmpeg 丢弃该流的同时会把 `covr` 标签一并剥掉（封面丢失；
    // Android 系播放器取封面正是读 `covr`）。保留该流则 `covr` 完整保留。
    await execFileAsync('ffmpeg', [
      '-y',
      '-v', 'error',
      '-i', tmpIn,
      '-map', '0:a',
      '-map', '0:v?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-f', 'mp4',
      tmpOut
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    let outBuf = await fs.promises.readFile(tmpOut);
    // ffmpeg 的 E-AC-3 重封装会丢掉 dec3 的 JOC 尾部 → 从原始流补回，保住 Atmos 标志
    if (codecHint) {
      try {
        const srcDec3 = extractDec3Box(codecHint);
        if (srcDec3) {
          const fixed = restoreAtmosDec3(outBuf, srcDec3);
          if (fixed !== outBuf) {
            outBuf = fixed;
            console.log('[Cloud-Transfer] 已补回 dec3 JOC 扩展字节（Dolby Atmos 标志）');
          }
        }
      } catch (e) {
        console.warn('[Cloud-Transfer] 恢复 Atmos dec3 失败 (非致命):', e.message);
      }
    }
    // ffmpeg 会往样本条目塞 `btrt`，使 stsd 从 67B 膨胀到 87B，严格解析器（椒盐音乐）会拒绝
    try {
      const noBtrt = stripBitrateBox(outBuf);
      if (noBtrt !== outBuf) {
        outBuf = noBtrt;
        console.log('[Cloud-Transfer] 已剥除 btrt，stsd 恢复 Apple 原生形态');
      }
    } catch (e) {
      console.warn('[Cloud-Transfer] 剥除 btrt 失败 (非致命):', e.message);
    }
    // 产物自检：必须已消除 moof 分片、且 stbl 五子盒齐全，否则宁可报错也不外发坏文件
    const problem = validateDefragged(outBuf);
    if (problem) {
      throw new Error(`解碎片产物结构异常（${problem}），拒绝交付损坏文件`);
    }
    return new Uint8Array(outBuf);
  } catch (err) {
    // 绝不静默回退：未解碎片的分片 MP4 在多数播放器上表现为「文件损坏」，
    // 静默交付比直接失败更糟（用户拿到坏文件却以为是资源问题）。
    console.error('[Cloud-Transfer] ffmpeg 解碎片重封装失败:', err.message);
    throw new Error(`音频容器解碎片失败: ${err.message}`);
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
    ruby = false,
    rubyMode = 'roman',
    folderId,
    token,
    batchId,
    isLastTrack,
    zipFilename,
    zip = false,
    finalizeBatch = false,
    noUpload = false,
    outputDir,
    failedTracks
  } = body;

  // 0. 如果是批处理全辑最终打包请求 (3 线程并发转存全部就绪后统一打包上传)
  if (finalizeBatch && batchId) {
    const sessionDir = `/tmp/am_sessions/${batchId}`;
    if (!fs.existsSync(sessionDir)) {
      throw new Error(`批处理会话不存在或已过期: ${batchId}`);
    }
    const finalZipName = sanitizeFilename(toSimplifiedChinese(zipFilename || (meta.album ? `${meta.album} [${quality}].zip` : 'Album.zip')));
    const zipFilePath = `/tmp/${batchId}.zip`;
    // 仅在存在失败曲目时写入 error.log，全部成功则完全不生成该文件
    const errorLogName = writeBatchErrorLog(sessionDir, failedTracks, meta.album || meta.title || finalZipName);
    const files = fs.readdirSync(sessionDir).filter((n) => n !== errorLogName);
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
        const groups = groupFilesByLimit(fileSizes, limitBytes);

        const baseName = finalZipName.replace(/\.zip$/i, '');
        const zipParts = [];
        for (let i = 0; i < groups.length; i++) {
          const partPath = `/tmp/${batchId}.part${i + 1}.zip`;
          const partName = groups.length > 1 ? `${baseName} [part ${i + 1}].zip` : finalZipName;
          // 每一卷都附带错误清单，用户拿到任意一卷都能看到完整失败原因
          const partFiles = errorLogName ? [...groups[i], errorLogName] : groups[i];
          await packZipFolder(sessionDir, partPath, partFiles);
          const partStat = fs.statSync(partPath);
          const trackFiles = groups[i].filter((name) => /\.(m4a|mp3|flac)$/i.test(name)).length;
          zipParts.push({ filePath: partPath, fileName: partName, fileSize: partStat.size, totalFiles: partFiles.length, trackFiles });
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

    // Gofile 直传：整包一旦超过 Gofile 单次上传硬上限（实测 >4GB 必断连），
    // 必须先切卷再逐卷上传，否则 5GB+ 歌单 100% 失败。切卷后所有卷上传到同一个新建文件夹，
    // 前端只展示一个 share 链接。
    const sessionFileSizes = files
      .map((name) => ({ name, size: fs.statSync(path.join(sessionDir, name)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sessionTotalBytes = sessionFileSizes.reduce((s, f) => s + f.size, 0);
    const needGofileSplit = !noUpload && sessionTotalBytes > GOFILE_MAX_PART_BYTES;

    if (needGofileSplit) {
      const groups = groupFilesByLimit(sessionFileSizes, GOFILE_MAX_PART_BYTES);
      const baseName = finalZipName.replace(/\.zip$/i, '');
      console.log(`[Cloud-Transfer] 全辑 ${(sessionTotalBytes / (1024 * 1024)).toFixed(1)}MB 超过 Gofile 单次上传上限，自动切分为 ${groups.length} 卷...`);

      const partPaths = [];
      try {
        let currentFolderId = folderId || null;
        let currentToken = token || null;
        let downloadPage = null;
        const uploadedParts = [];

        // 逐卷串行打包 + 上传（串行可避免多卷同时抢占上行带宽）。
        // 第一卷由 Gofile 自动创建文件夹，拿到 folderId 后其余卷都传进去，最终只给一个分享链接。
        for (let i = 0; i < groups.length; i++) {
          const partPath = `/tmp/${batchId}.part${i + 1}.zip`;
          partPaths.push(partPath);
          const partName = `${baseName} [part ${i + 1}].zip`;
          // 每一卷都附带错误清单，用户下载任意一卷都能看到完整失败原因
          const partFiles = errorLogName ? [...groups[i], errorLogName] : groups[i];
          await packZipFolder(sessionDir, partPath, partFiles);
          const partStat = fs.statSync(partPath);
          console.log(`[Cloud-Transfer] 📦 分卷 ${i + 1}/${groups.length} 打包完成: ${partName} (${(partStat.size / (1024 * 1024)).toFixed(1)}MB)，正在上传...`);
          const upData = await uploadFileToGofile(partPath, partName, { folderId: currentFolderId, token: currentToken });
          currentFolderId = upData.parentFolder || currentFolderId;
          currentToken = upData.guestToken || currentToken;
          if (upData.downloadPage) downloadPage = upData.downloadPage;
          uploadedParts.push({ fileName: partName, fileSize: partStat.size, fileId: upData.id || upData.fileId });
          console.log(`[Cloud-Transfer] ✔ 分卷 ${i + 1}/${groups.length} 上传完成 (${(partStat.size / (1024 * 1024)).toFixed(1)}MB)`);
          // 立刻删掉分卷 ZIP，避免多卷叠加占满磁盘
          try { fs.rmSync(partPath, { force: true }); } catch {}
        }

        downloadPage = downloadPage || (currentFolderId ? `https://gofile.io/d/${currentFolderId}` : null);
        const tEnd = performance.now();
        console.log(`[Cloud-Transfer] 🎉 全辑 ZIP 分卷转存完成 (${uploadedParts.length} 卷)! 总耗时: ${((tEnd - t0) / 1000).toFixed(2)}s, 链接: ${downloadPage}`);
        return {
          downloadPage,
          folderId: currentFolderId,
          guestToken: currentToken,
          fileId: uploadedParts[0]?.fileId,
          fileName: finalZipName,
          isZip: true,
          isSplit: true,
          parts: uploadedParts,
          partCount: uploadedParts.length,
          totalFiles: files.length,
          qualityName: quality,
          elapsedMs: Math.round(tEnd - t0)
        };
      } finally {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        for (const p of partPaths) { try { fs.rmSync(p, { force: true }); } catch {} }
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

      const upData = await uploadFileToGofile(zipFilePath, finalZipName, { folderId, token, timeoutMs: 300000 });

      const tEnd = performance.now();
      console.log(`[Cloud-Transfer] 🎉 全辑 ZIP 并发转存完成! 总耗时: ${((tEnd - t0) / 1000).toFixed(2)}s, 链接: ${upData.downloadPage}`);
      return {
        downloadPage: upData.downloadPage,
        folderId: upData.parentFolder || folderId,
        guestToken: upData.guestToken || token,
        fileId: upData.fileId,
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
  // 注音：日文歌的罗马音（roman，Apple 原样）或平假名（kana，由罗马音反推）附加在原文行下
  const shouldRuby = Boolean(ruby);
  const chosenRubyMode = String(rubyMode || 'roman').toLowerCase() === 'kana' ? 'kana' : 'roman';
  const chosenLyricsFormat = (lyricsFormat || 'lrc').toLowerCase() === 'ttml' ? 'ttml' : 'lrc';
  // 外置歌词多格式：saveLyricsFormats 数组（'lrc'/'ttml' 可同时出现），缺省用主格式
  const saveLyricsFormats = Array.isArray(body.saveLyricsFormats) && body.saveLyricsFormats.length
    ? body.saveLyricsFormats.filter((f) => f === 'lrc' || f === 'ttml')
    : (shouldSaveLyricsFile ? [chosenLyricsFormat] : []);
  // 仅下载歌词：跳过音频拉流/解密/标签注入，只产出歌词文件
  const lyricsOnly = Boolean(body.lyricsOnly);

  let audioHookUrl = directHookUrl;
  let chosenFormatName = '';
  // 音质回退说明：请求杜比但该曲目无杜比版本时记录，随结果返回给前端 / TG
  let qualityFallback = '';

  // 1. 如果没有直接传 hookFileUrl，通过 127.0.0.1:31408/parse/song/{adamId} 获取
  let webplaybackM3u8 = null; // 当 master 为 M4P 单文件时，回退 /webplayback 标准 HLS
  if (!audioHookUrl) {
    if (!adamId) throw new Error('缺少 adamId 或 hookFileUrl');
    const parseRes = await fetch(`${HOOK_BASE}/parse/song/${adamId}`, { signal: AbortSignal.timeout(30000) });
    if (!parseRes.ok) {
      const parseErr = await parseRes.json().catch(() => ({}));
      // master m3u8 解析不出变体（wrapper 返回 M4P 单文件 + accessKey）：改用 /webplayback 拿标准 HLS
      // 注意：`failed to get m3u8` 已被 src/ui.rs 改写成中文提示，此处只按实际可命中的 msg 判断
      if (parseErr.msg?.includes('No variants')) {
        try {
          const wpRes = await fetch(`${WRAPPER_BASE}/webplayback?adamId=${adamId}`, { signal: AbortSignal.timeout(15000) });
          if (wpRes.ok) {
            const wpData = await wpRes.json();
            const wpUrl = wpData?.data?.m3u8;
            if (wpUrl && wpUrl.includes('.m3u8')) {
              webplaybackM3u8 = wpUrl;
              // webplayback 为 ISO-23001-7 (CENC) 抽样加密 HLS，音质为 AAC 256kbps 上限（Apple 端格式限制）
              chosenFormatName = 'AAC (webplayback)';
              // 用户要的是 ALAC/Hi-Res/杜比但该曲只有 M4P 单文件（无变体可选）时，明确告知降级，
              // 与「杜比无版本回退 ALAC」保持一致，避免用户以为拿到的是无损
              const wantsLossless = !/aac/i.test(quality || '');
              if (wantsLossless) {
                qualityFallback = '该曲目仅提供 AAC 256k 单文件源（无无损/Hi-Res 版本），已回退为 AAC (webplayback)';
              }
              console.log(`[Cloud-Transfer] master 为 M4P 单文件，回退 webplayback CENC HLS 拉流+解密: ${adamId}（请求音质 ${quality}）`);
            }
          }
        } catch (e) {
          console.warn(`[Cloud-Transfer] webplayback 回退拉流失败: ${e.message}`);
        }
      }
      if (!webplaybackM3u8) {
        // `failed to get m3u8` 在 ui.rs 会被改写成中文提示，故一并匹配中文关键词
        const rawMsg = parseErr.msg || '';
        if (rawMsg === 'failed to get m3u8' || rawMsg.includes('无资源') || rawMsg.includes('无版权') || rawMsg.includes('无资源或未上架') || parseRes.status === 404 || parseRes.status === 500) {
          throw new Error('此歌曲在解析账号所属地区（土耳其区）无资源或未上架（可能为日区/美区独占版权），无法转存');
        }
        throw new Error(`解析歌曲失败: ${rawMsg || 'HTTP ' + parseRes.status}`);
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
        // 该曲目无杜比版本时回退 ALAC：记下来，避免专辑批量时静默降级
        if (selected && !(selected.codecs && selected.codecs.includes('ec-3')) && !(selected.group_id && selected.group_id.includes('atmos'))) {
          qualityFallback = '该曲目无杜比全景声版本，已回退为无损 ALAC';
        }
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

  // 歌词抓取与多格式/降级解析（translateLyrics / ruby 时带 language=zh-Hans-CN 拉取官方翻译与罗马音）
  /** 给已解析的歌词附加注音行；无罗马音（非日文歌）时原样返回，静默跳过 */
  const applyRuby = (parsed) => {
    if (!shouldRuby || !parsed || !parsed.hasLyrics) return parsed;
    try {
      const lines = parsed.lines && parsed.lines.length ? parsed.lines : [];
      // 无结构化行（纯文本歌词）时按原文行切分，保持可读顺序
      const baseLines = lines.length
        ? lines
        : String(parsed.lrc || parsed.plain || '').split('\n').filter(Boolean).map((raw) => {
            const m = raw.match(/^(\[[^\]]+\])\s*(.*)$/);
            return m ? { key: '', time: m[1], text: m[2], translation: '' } : { key: '', time: '', text: raw, translation: '' };
          });
      const annotated = annotateLyricLines(parsed.ttml, baseLines, chosenRubyMode);
      if (!annotated) return parsed; // 该曲无罗马音：保持原文
      const body = annotated.join('\n');
      // rubyApplied 让后续的简繁转换跳过（注音行交错，逐行转换会破坏上下行对齐）
      return { ...parsed, lrc: body, plain: body, rubyApplied: true };
    } catch (e) {
      console.warn('[Cloud-Transfer] 注音生成失败，降级为原文:', e.message);
      return parsed;
    }
  };

  const fetchLyricsData = async () => {
    if (passedLyrics !== undefined && passedLyrics !== null) {
      if (typeof passedLyrics === 'string' && passedLyrics.trim()) {
        return applyRuby(parseLyrics(passedLyrics));
      }
      return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    }
    if (!adamId) return { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };
    try {
      const needsMeta = shouldTranslateLyrics || shouldRuby;
      const lyricsUrl = `${HOOK_BASE}/lyrics/${adamId}${needsMeta ? '?language=zh-Hans-CN' : ''}`;
      const lRes = await fetch(lyricsUrl, { signal: AbortSignal.timeout(5000) });
      if (lRes.ok) {
        const rawTtml = await lRes.text();
        let base = null;
        if (shouldTranslateLyrics) {
          base = buildBilingualLrc(rawTtml, 'zh-Hans-CN');
        }
        if (!base) base = parseLyrics(rawTtml);
        return applyRuby(base);
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
    // ⚠️ 注音模式下 lrc 是「原文 / 罗马音 / 译文」逐行交错，罗马音行不含假名，
    //    逐行过 toSimplifiedChinese 会把罗马音行拆成单字，且与原文行的假名判定不一致，
    //    导致上下行最终被转换成不同的字形体系。此时整体跳过简繁转换（日文歌本来也不需要）。
    const hasRuby = shouldRuby && lyricsData.rubyApplied;
    // ⚠️ 双语繁简对照（原文繁体 + 译文简体）时同样必须跳过：整体转简体会把原文行也转成简体，
    //    结果变成「简体 + 简体」两行重复，繁简对照彻底消失。
    const isZhPair = shouldTranslateLyrics && lyricsData.lines?.some((l) => l.translation);
    if (!hasRuby && !isZhPair) {
      if (lyricsData.lrc) lyricsData.lrc = toSimplifiedChinese(lyricsData.lrc);
      if (lyricsData.plain) lyricsData.plain = toSimplifiedChinese(lyricsData.plain);
      if (lyricsData.ttml) lyricsData.ttml = toSimplifiedChinese(lyricsData.ttml);
    }
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
  if (lyricsData.hasLyrics && saveLyricsFormats.length > 0) {
    // 主文件 = 用户显式勾选的首选外置格式；未勾选任何外置格式时一律不外发文件
    const primary = buildLyricsFile(saveLyricsFormats[0]);
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
  const finalAudioBuf = await defragMp4Buffer(
    taggedMp4Buf,
    // 零拷贝视图，避免为 17MB 音频再复制一份
    Buffer.from(rawAudioBuf.buffer, rawAudioBuf.byteOffset, rawAudioBuf.byteLength)
  );
  const tDefrag = performance.now();
  console.log(`[Cloud-Transfer] 容器解碎片完成 (${((tDefrag - tTag) / 1000).toFixed(3)}s, 标准 M4A faststart 封装)`);

  // 4. 上传模式判定 (ZIP 打包上传 或 直接文件流上传)
  // 4.1 批处理会话模式 (支持全辑归集为单 .zip 压缩包)
  if (batchId) {
    const sessionDir = `/tmp/am_sessions/${batchId}`;
    fs.mkdirSync(sessionDir, { recursive: true });

    // 音频落盘：必须用排他创建 (wx)，不能用「先 existsSync 再 writeFileSync」。
    // 批量转存是 3 线程并发，同名单曲（同名不同专辑、feature 版等）会在检查与写入之间的窗口期
    // 同时通过检查，导致后者静默覆盖前者，歌单里凭空少歌且无任何报错。
    // 这里改为排他创建后按序号递增重试，保证每一首都能落地且名字唯一。
    const trackPrefix = meta.trackNumber ? `${String(meta.trackNumber).padStart(2, '0')}. ` : '';
    const written = writeFileExclusive(sessionDir, standardM4aName, finalAudioBuf, trackPrefix);
    const finalM4aName = written.fileName;
    let finalLyricsName = lyricsFilename
      ? `${written.prefix}${lyricsFilename}`
      : lyricsFilename;
    if (written.collisionSeq > 0) {
      // 序号前缀拼接后仍可能重名（如曲目号相同），歌词名也走一次唯一化
      if (finalLyricsName) finalLyricsName = uniqueNameInDir(sessionDir, finalLyricsName, '');
      console.log(`[Cloud-Transfer] ⚠️ 检测到同名曲目，已自动重命名避免覆盖: ${finalM4aName}`);
    }

    if (finalLyricsName && lyricsContent) {
      try {
        const fd = fs.openSync(path.join(sessionDir, finalLyricsName), 'wx');
        try { fs.writeFileSync(fd, lyricsContent, 'utf8'); } finally { fs.closeSync(fd); }
        console.log(`[Cloud-Transfer] 缓存歌词: ${finalLyricsName} 到 session: ${batchId}`);
      } catch (lyrErr) {
        if (lyrErr.code === 'EEXIST') {
          // 并发下歌词撞名：换个唯一名写入，绝不覆盖别人的歌词
          const alt = uniqueNameInDir(sessionDir, finalLyricsName, trackPrefix);
          try {
            fs.writeFileSync(path.join(sessionDir, alt), lyricsContent, 'utf8');
            console.log(`[Cloud-Transfer] 缓存歌词(重命名): ${alt} 到 session: ${batchId}`);
          } catch {}
        } else {
          throw lyrErr;
        }
      }
    }
    for (const extra of extraLyrics) {
      const baseExtraName = finalLyricsName && extra.filename === lyricsFilename ? finalLyricsName : `${trackPrefix}${extra.filename}`;
      const extraName = uniqueNameInDir(sessionDir, baseExtraName, trackPrefix);
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
        qualityFallback: qualityFallback || undefined,
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
        qualityFallback: qualityFallback || undefined,
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
        qualityFallback: qualityFallback || undefined,
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
        qualityFallback: qualityFallback || undefined,
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
        qualityFallback: qualityFallback || undefined,
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
      qualityFallback: qualityFallback || undefined,
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
    qualityFallback: qualityFallback || undefined,
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
// 整单额度预留台账：`${clientIp}|${batchId}` -> { reserved, consumed }
// 网页批量 ZIP 是一次下单 + N 次逐首请求 + 1 次收尾，必须整单只扣一次。
const webBatchQuotaLedger = new Map();

// 批量转存结果缓存：`${clientIp}|${batchId}` -> { downloadPage, folderId, guestToken, partCount, ... }
// finalize 一次要打包+上传数 GB，耗时可达数分钟。浏览器标签页被切到后台或休眠时可能直接掐断
// 连接，前端 fetch 永远拿不到结果，用户会看到「转存失败」而服务端其实已经成功。
// 这里把成品结果留档，前端超时/断线后可用 batchId 补查，链接不会再丢。
const webBatchResultCache = new Map();
const BATCH_RESULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

// 定期清理过期的 IP 限流记录与孤儿配额台账，防止长期运行内存累积
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of webIpLimitMap.entries()) {
    // 超过配额重置点再给 1 小时宽限即回收（此前只比 dailyResetAt，跨天后若该 IP 不再访问会永久滞留）
    if (now > rec.dailyResetAt + 60 * 60 * 1000) {
      webIpLimitMap.delete(ip);
    }
  }
  // 孤儿台账：收尾请求丢失（客户端关闭页面/崩溃）留下的条目，2 小时后回收
  for (const [key, led] of webBatchQuotaLedger.entries()) {
    if (!led.createdAt || now - led.createdAt > 2 * 60 * 60 * 1000) {
      webBatchQuotaLedger.delete(key);
    }
  }
  // 过期的成品结果缓存
  for (const [key, rec] of webBatchResultCache.entries()) {
    if (!rec.createdAt || now - rec.createdAt > 2 * 60 * 60 * 1000) {
      webBatchResultCache.delete(key);
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

// 网页端每日总配额（单位：曲目数）。单曲 / 专辑 / 歌单全部合并计入同一个池子。
const WEB_DAILY_TRACK_QUOTA = parseInt(process.env.WEB_DAILY_TRACK_QUOTA || '200', 10);

function getClientIp(req) {
  let clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
  return clientIp;
}

/**
 * 特权判定：站长静态 IP 白名单 或 管理员 Key。特权用户额度无限、且独占「歌手全辑」等高成本入口。
 */
function isPrivilegedClient(clientIp, adminKeyHeader) {
  if (!clientIp || OWNER_IPS.has(clientIp) || clientIp.includes('127.0.0.1')) return true;
  for (const ip of OWNER_IPS) {
    if (ip && clientIp.includes(ip)) return true;
  }
  const ADMIN_SECRET = process.env.ADMIN_KEY || 'am_admin_secret_key';
  return Boolean(adminKeyHeader && adminKeyHeader === ADMIN_SECRET);
}

/** 取（并按需重置）每日额度记录 */
function getDailyRecord(clientIp) {
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
  return rec;
}

/** 只读查询剩余额度 */
function getWebQuota(clientIp) {
  const rec = getDailyRecord(clientIp);
  return {
    used: rec.dailyCount,
    max: WEB_DAILY_TRACK_QUOTA,
    remaining: Math.max(0, WEB_DAILY_TRACK_QUOTA - rec.dailyCount)
  };
}

/**
 * 开跑前一次性预留整单额度（原子操作）。额度不足直接返回 ok=false，调用方必须在此中止、
 * 绝不触发任何下载，避免跑一半才发现不够、白烧带宽和用户时间。
 */
function reserveWebQuota(clientIp, tracks) {
  const count = Math.max(0, Math.floor(Number(tracks) || 0));
  const rec = getDailyRecord(clientIp);
  const remaining = Math.max(0, WEB_DAILY_TRACK_QUOTA - rec.dailyCount);
  if (count > remaining) {
    return {
      ok: false,
      reserved: false,
      used: rec.dailyCount,
      max: WEB_DAILY_TRACK_QUOTA,
      remaining,
      error: `⚠️ 今日转存配额不足：本单共 ${count} 首，今日仅剩 ${remaining} 首 (每日上限 ${WEB_DAILY_TRACK_QUOTA} 首，已用 ${rec.dailyCount} 首)。已取消下载，未消耗任何额度。配额将在明日北京时间 00:00 重置。`
    };
  }
  rec.dailyCount += count;
  return { ok: true, reserved: true, reservedCount: count, used: rec.dailyCount, max: WEB_DAILY_TRACK_QUOTA, remaining: WEB_DAILY_TRACK_QUOTA - rec.dailyCount };
}

/** 预留了但未实际消耗时退回，避免误伤用户 */
function refundWebQuota(clientIp, tracks) {
  const refund = Math.max(0, Math.floor(Number(tracks) || 0));
  if (!refund) return;
  const rec = getDailyRecord(clientIp);
  rec.dailyCount = Math.max(0, rec.dailyCount - refund);
}

function checkWebRateLimit(clientIp, adminKeyHeader) {
  // 1. 特权（站长 IP / 管理员 Key）-> 100% 豁免放行
  if (isPrivilegedClient(clientIp, adminKeyHeader)) {
    return { ok: true, isOwner: true };
  }

  // 2. 公网访客：仅做每分钟 60 次的防刷保护。
  // 每日 200 首额度【不在这里】消耗，改由 reserveWebQuota 按整单一次性预扣，
  // 否则整单并发入队会被逐首计费、也无法在下载前准确拦截。
  const rec = getDailyRecord(clientIp);
  if (rec.count >= 60) {
    return { ok: false, error: '⚠️ 请求提交过快，已触发服务器安全保护。请稍候 1 分钟后再试 (429 Too Many Requests)' };
  }
  rec.count++;
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

  // 批量转存结果补查：finalize 耗时长，浏览器断线/超时后可用 batchId 取回成品链接
  if (req.method === 'GET' && u.pathname === '/api/cloud-transfer-result') {
    const clientIp = getClientIp(req);
    const batchId = u.searchParams.get('batchId') || '';
    const rec = webBatchResultCache.get(`${clientIp}|${batchId}`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (rec && Date.now() - rec.createdAt < BATCH_RESULT_TTL_MS) {
      res.end(JSON.stringify({ status: 'ok', data: rec.data }));
    } else {
      res.end(JSON.stringify({ status: 'error', error: '该批次结果不存在或已过期（服务端仍在处理中请稍候再查）' }));
    }
    return;
  }

  // 只读配额查询：供批量转存前置预检查，不消耗任何配额（绝不调用 checkWebRateLimit，其内部会 rec.count++）
  if (req.method === 'GET' && u.pathname === '/api/quota') {
    const clientIp = getClientIp(req);
    const adminKey = req.headers['x-admin-key'] || u.searchParams.get('admin_key') || '';
    if (isPrivilegedClient(clientIp, adminKey)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', data: { unlimited: true, privileged: true } }));
      return;
    }
    const quota = getWebQuota(clientIp);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', data: { unlimited: false, privileged: false, ...quota } }));
    return;
  }

  // 整单额度预留（原子）：本机下载 / 本机打包同样消耗 VPS 出站带宽，纳入每日配额；特权用户豁免。
  // 额度不足直接 429 拒绝，调用方必须在收到 429 时不开始任何下载。
  if (req.method === 'POST' && u.pathname === '/api/quota/consume') {
    const clientIp = getClientIp(req);
    const adminKey = req.headers['x-admin-key'] || u.searchParams.get('admin_key') || '';
    if (isPrivilegedClient(clientIp, adminKey)) {
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
      const reserved = reserveWebQuota(clientIp, tracks);
      if (!reserved.ok) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: reserved.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', data: { reserved: tracks, remaining: reserved.remaining } }));
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

      // ---------- 整单额度：开跑前一次性预留，不足则直接拒绝，不触发任何下载 ----------
      // 网页批量 ZIP 模式是一次「整单请求」+ N 次逐首请求 + 1 次 finalize，逐首扣费既不准也会
      // 跑到一半才喊停。因此整单在 quotaTracks 里一次性预留，后续逐首请求只认 batchId 放行。
      let quotaReserved = 0;
      try {
        const privileged = isPrivilegedClient(clientIp, adminKey);
        // 歌手全辑（Discography）为站长专属：普通访客直接拒绝，不进入队列、不消耗任何资源
        if (body.discography === true && !privileged) {
          console.warn(`[WebQuota] 🔒 拒绝非特权用户下载歌手全辑: ${clientIp}`);
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            status: 'error',
            error: '🔒 歌手全辑批量转存为站长专属功能。您仍可单独转存该歌手的单张专辑、歌单或单曲。'
          }));
          return;
        }
        const batchKey = body.batchId ? `${clientIp}|${body.batchId}` : null;

        if (body.finalizeBatch && batchKey) {
          // 收尾请求：额度已在下单时预留过，这里只确认台账存在；不存在则按整单曲目数兜底预留
          if (!webBatchQuotaLedger.has(batchKey) && !privileged) {
            const tracks = Math.max(0, parseInt(body.quotaTracks, 10) || 0);
            if (tracks > 0) {
              const r = reserveWebQuota(clientIp, tracks);
              if (!r.ok) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ status: 'error', error: r.error }));
                return;
              }
              quotaReserved = tracks;
            }
          }
        } else if (!privileged && !batchKey) {
          // 非批量路径（单曲直转）：按本请求曲目数预留
          const tracks = Math.max(1, parseInt(body.quotaTracks, 10) || 1);
          const r = reserveWebQuota(clientIp, tracks);
          if (!r.ok) {
            console.warn(`[WebQuota] ⚠️ 拒绝 ${clientIp}: 需要 ${tracks} 首，仅剩 ${r.remaining} 首`);
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ status: 'error', error: r.error }));
            return;
          }
          quotaReserved = tracks;
        } else if (!privileged && batchKey) {
          // 批量首请求一次性预留整单额度；后续同 batchId 请求不再重复扣。
          // 若台账不存在（首请求失败/服务重启），退化为按单首计费，杜绝整单免费跑。
          if (!webBatchQuotaLedger.has(batchKey)) {
            const tracks = Math.max(1, parseInt(body.quotaTracks, 10) || 1);
            const r = reserveWebQuota(clientIp, tracks);
            if (!r.ok) {
              console.warn(`[WebQuota] ⚠️ 拒绝 ${clientIp}: 需要 ${tracks} 首，仅剩 ${r.remaining} 首`);
              res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ status: 'error', error: r.error }));
              return;
            }
            quotaReserved = tracks;
            webBatchQuotaLedger.set(batchKey, { reserved: tracks, consumed: 0, createdAt: Date.now() });
          }
        }
      } catch (quotaErr) {
        console.warn('[WebQuota] 预留异常(继续):', quotaErr.message);
      }

      try {
        const taskName = body.meta?.title ? `${body.meta.artist || ''} - ${body.meta.title} (${body.quality || 'Lossless'})` : (body.adamId || 'Transfer');
        const result = await globalQueue.enqueue(() => processTransfer(body), {
          name: taskName,
          source: body.noUpload ? 'Telegram' : 'WebUI'
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', data: result }));
        // 批量收尾成功后清理台账，避免常驻进程内存无限累积
        if (body.finalizeBatch && body.batchId) {
          webBatchQuotaLedger.delete(`${clientIp}|${body.batchId}`);
          // 留档成品结果：浏览器断线/超时后可凭 batchId 补查，避免「服务端成功但前端报失败」
          if (result) {
            webBatchResultCache.set(`${clientIp}|${body.batchId}`, {
              data: result,
              createdAt: Date.now()
            });
          }
        }
      } catch (err) {
        // 本请求失败：把该请求涉及的预留额度退回，不让用户为失败任务付费
        if (quotaReserved > 0) {
          try { refundWebQuota(clientIp, quotaReserved); } catch {}
        }
        if (body.batchId) {
          // 批量会话中任一请求失败即撤销整单台账，避免「首请求失败退款、后续请求免费跑」
          const batchKey = `${clientIp}|${body.batchId}`;
          const led = webBatchQuotaLedger.get(batchKey);
          if (led && led.reserved > led.consumed && led.reserved !== quotaReserved) {
            try { refundWebQuota(clientIp, led.reserved - led.consumed); } catch {}
          }
          webBatchQuotaLedger.delete(batchKey);
        }
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
          entry.startsWith('am_tg_') ||
          // 临时歌词文件：原先无任何清理逻辑，会长期堆积
          entry.startsWith('am_lyr_only_') ||
          entry.startsWith('am_lyr_fix_')) {
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

