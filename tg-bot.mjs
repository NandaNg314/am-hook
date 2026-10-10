/**
 * tg-bot.mjs
 * 
 * Apple Music Telegram 机器人中枢 (v2.3 官方 Telegram Local Bot API 高速安全直发版)
 * 核心特性:
 * 1. 官方 Local Bot API 专线直发 (零封号风控风险，彻底移除小号/第三方上传):
 *    - 接入本地运行的官方 telegram-bot-api 服务端 (端口 8081)，直连 Telegram 数据中心
 *    - 单文件直传上限彻底解除 50MB 官方限制，提升至 2000MB (2GB)！
 *    - TDLib 底层原生并发多路复用，传输速度高达 20MB/s+
 *    - 频道与私聊完全统一：频道发什么格式，私聊 100% 对应同步（全辑ZIP / 原生MediaGroup合辑气泡）
 * 2. 严格权限防护: 
 *    - 唯一作者账号: 由 process.env.OWNER_USER_ID 指定
 *    - 唯一授权归档群组: 由 process.env.AUTHORIZED_GROUP_ID 指定
 *    - 任何非作者拉群行为，机器人立即警报并自动秒退群 (leaveChat)
 * 3. 任务级全局时间顺序排队 (Task-Level Global FIFO Queue):
 *    - 严格按顺序串行处理！当用户 A 正在下载整张专辑时，用户 B 的下载请求自动排队等待，
 *      待前序任务完整交付后自动启动后续任务，彻底保护服务器 CPU/内存/带宽。
 * 4. 0 秒秒传绕过排队:
 *    - 库内已存档资源（单曲/全辑/ZIP）秒传直发，无需进入下载排队队列，瞬间送达。
 * 5. 深度本地化与全量元数据修复:
 *    - 100% 简体中文智能嗅探 (即使美区/港区只有英文别名，也能精确匹配国区中文曲名)
 *    - 完整繁简转换与华语艺人字典映射 (张楚/田馥甄/周杰伦/陈奕迅等)
 * 6. 规避 Telegram 限制:
 *    - sendMediaGroup 2-10 items 限制: 遇单首余项自动走 sendAudio，杜绝 400 报错。
 *    - 单曲版权容灾: 个别无版权曲目自动跳过并提示，保证专辑其余曲目正常打包交付。
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 强制优先 IPv4 解析，彻底规避云服务商 IPv6 黑洞导致 Telegram 连接超时 (ETIMEDOUT)
dns.setDefaultResultOrder('ipv4first');

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

// ==================== 配置区 (支持环境变量配置，保护凭据隐私) ====================
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG_API_BASE = process.env.TG_API_BASE || 'http://127.0.0.1:8081'; // 官方 Local Bot API 服务端
const OWNER_USER_ID = String(process.env.OWNER_USER_ID || '');   // 作者专属账号 ID (由环境变量指定)
const AUTHORIZED_GROUP_ID = String(process.env.AUTHORIZED_GROUP_ID || ''); // 唯一授权归档群组 ID
const CLOUD_API = process.env.CLOUD_API || 'http://127.0.0.1:31409/api/cloud-transfer';
const QUEUE_API = process.env.QUEUE_API || 'http://127.0.0.1:31409/api/queue-status';
const HOOK_BASE = process.env.HOOK_BASE || 'http://127.0.0.1:31408';
const DB_FILE = path.join(__dirname, 'tg_bot_db.json');

// ==================== 繁简转换与华语艺人字典 ====================
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
  console.warn('[T2S] 加载 t2s.json 失败:', e.message);
}

const EXTRA_T2S = {
  '著': '着', '妳': '你', '牠': '它', '週': '周', '裡': '里',
  '麽': '么', '係': '系', '佈': '布', '併': '并', '傢': '家', '儘': '尽',
  '軼': '轶'
};
Object.assign(t2sMap, EXTRA_T2S);

function toSimplifiedChinese(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
    return text;
  }
  let out = '';
  for (const ch of text) {
    out += t2sMap[ch] || ch;
  }
  return out;
}

const CHINESE_ARTIST_ALIASES = {
  'amei': '张惠妹', 'a-mei': '张惠妹', 'amit': '张惠妹', 'chang hui-mei': '张惠妹',
  'cheer chen': '陈绮贞', 'chen chi-chen': '陈绮贞', 'eason chan': '陈奕迅',
  'chan yik-shun': '陈奕迅', 'khalil fong': '方大同',
  'jay chou': '周杰伦', 'chou chieh-lun': '周杰伦', 'david tao': '陶喆',
  'tao che-sheng': '陶喆', 'wang leehom': '王力宏', 'leehom wang': '王力宏',
  'jj lin': '林俊杰', 'wayne lin': '林俊杰',
  'zhang chu': '张楚', 'dou wei': '窦唯', 'he yong': '何勇', 'tang dynasty': '唐朝',
  'black panther': '黑豹', 'cui jian': '崔健', 'wang feng': '汪峰', 'xu wei': '许巍', 'pu shu': '朴树',
  'faye wong': '王菲', 'shirley wong': '王菲', 'g.e.m.': '邓紫棋', 'gem': '邓紫棋',
  'g.e.m': '邓紫棋', 'gloria tang': '邓紫棋', 'jolin tsai': '蔡依林', 'tsai i-ling': '蔡依林',
  'stefanie sun': '孙燕姿', 'sun yan-zi': '孙燕姿',
  'fish leong': '梁静茹', 'jasmine leong': '梁静茹', 'mayday': '五月天',
  'sodagreen': '苏打绿', 'oaeen': '苏打绿', 'crowd lu': '卢广仲', 'lu kwang-chung': '卢广仲',
  'yoga lin': '林宥嘉', 'lin yu-chia': '林宥嘉',
  's.h.e': 'S.H.E', 'she': 'S.H.E', 'hebe tien': '田馥甄', 'hebe': '田馥甄',
  'selina ren': '任家萱', 'selina': '任家萱', 'ella chen': '陈嘉桦', 'ella': '陈嘉桦',
  'tanya chua': '蔡健雅', 'penny tai': '戴佩妮', 'rene liu': '刘若英', 'karen mok': '莫文蔚',
  'rainie yang': '杨丞琳', 'cyndi wang': '王心凌', 'eric chou': '周兴哲',
  'jam hsiao': '萧敬腾', 'aska yang': '杨宗纬',
  'anpu': '安溥', 'deserts chang': '张悬', 'waa wei': '魏如萱', 'lala hsu': '徐佳莹',
  'eve ai': '艾怡良', 'joanna wang': '王若琳', 'a-lin': '黄丽玲', 'alin': '黄丽玲', 'huang li-ling': '黄丽玲',
  'jacky cheung': '张学友', 'andy lau': '刘德华', 'aaron kwok': '郭富城', 'leon lai': '黎明',
  'leslie cheung': '张国荣', 'anita mui': '梅艳芳', 'teresa teng': '邓丽君', 'beyond': 'Beyond',
  'wakin chau': '周华健', 'emil chau': '周华健', 'emil wakin chau': '周华健', 'jonathan lee': '李宗盛',
  'chyi chin': '齐秦', 'chyi yu': '齐豫', 'dave wang': '王杰', 'jeff chang': '张信哲',
  'phil chang': '张宇', 'angus tung': '童安格', 'samuel tai': '邰正宵', 'steve chou': '周传雄',
  'harlem yu': '庾澄庆', 'george lam': '林子祥', 'sally yeh': '叶倩文', 'sandy lam': '林忆莲',
  'priscilla chan': '陈慧娴', 'vivian chow': '周慧敏', 'kelly chen': '陈慧琳', 'sammi cheng': '郑秀文',
  'gigi leung': '梁咏琪', 'coco lee': '李玟',
  'hins cheung': '张敬轩', 'joey yung': '容祖儿', 'leo ku': '古巨基', 'miriam yeung': '杨千嬅',
  'hacken lee': '李克勤', 'edison chen': '陈冠希', 'shawn yue': '余文乐', 'pakho chau': '周柏豪',
  'terence lam': '林家谦', 'keung to': '姜涛', 'anson lo': '卢瀚霆', 'mc cheung': '张天赋',
  'gareth.t': '汤令山', 'jay fung': '冯允谦', 'aga': 'AGA 江海迦', 'gin lee': '李幸倪',
  'jace chan': '陈凯咏', 'cloud wan': '云浩影', 'panther chan': '陈蕾', 'kaho hung': '洪嘉豪',
  'jeffrey ngai': '魏浚笙', 'mike tsang': '曾比特', 'gigi yim': '炎明熹',
  'accusefive': '告五人', 'deca joins': 'deca joins', 'sunset rollercoaster': '落日飞车',
  'omnipotent youth society': '万能青年旅店', 'new pants': '新裤子', 'second hand rose': '二手玫瑰',
  'no party for cao dong': '草东没有派对', 'my little airport': 'my little airport',
  'yicheng shen': '沈以诚', 'joker xue': '薛之谦', 'vae xu': '许嵩', 'silence wang': '汪苏泷',
  'ronghao li': '李荣浩', 'hua chenyu': '华晨宇', 'mao buyi': '毛不易', 'charlie zhou': '周深',
  'mc hotdog': '热狗', 'soft lipa': '蛋堡', 'higher brothers': '更高兄弟',
  'yico tseng': '曾轶可', 'tseng yico': '曾轶可', 'yico': '曾轶可',
  'leah dou': '窦靖童', 'elva hsiao': '萧亚轩', 'angela chang': '张韶涵', 'angela zhang': '张韶涵',
  'yisa yu': '郁可唯', 'sara liu': '刘惜君', 'jane zhang': '张靓颖', 'chris lee': '李宇春',
  'bibi zhou': '周笔畅', 'shang wenjie': '尚雯婕', 'tan weiwei': '谭维维', 'della ding': '丁当', 'ding dang': '丁当',
  'momo wu': '吴莫愁', 'curley g': '希林娜依·高', 'vava': '毛衍七', 'sunnee': '杨芸晴',
  'amber kuo': '郭采洁', 'valen hsu': '许茹芸', 'tarcy su': '苏慧伦', 'winnie hsin': '辛晓琪',
  'mavis fan': '范晓萱', 'shunza': '顺子', 'wanfang': '万芳', 'peggy hsu': '许哲珮'
};

function normalizeArtistName(rawArtist) {
  if (!rawArtist || typeof rawArtist !== 'string') return rawArtist;
  const trimmed = rawArtist.trim();
  const lower = trimmed.toLowerCase();

  if (CHINESE_ARTIST_ALIASES[lower]) {
    return CHINESE_ARTIST_ALIASES[lower];
  }

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

// ==================== 本地缓存数据库 ====================
class JsonDb {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { items: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (e) {
      console.warn('[DB] 读取缓存失败，初始化为空:', e.message);
      this.data = { items: {} };
    }
  }

  save() {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error('[DB] 保存缓存失败:', e.message);
    }
  }

  get(key) {
    return this.data.items[key] || null;
  }

  set(key, value) {
    this.data.items[key] = value;
    this.save();
  }

  delete(key) {
    if (this.data.items[key]) {
      delete this.data.items[key];
      this.save();
    }
  }
}

const db = new JsonDb(DB_FILE);

// ==================== 国际化双语支持 (i18n) ====================
function getUserLang(chatId, fromLangCode = '') {
  const saved = db.get(`lang_${chatId}`);
  if (saved === 'zh' || saved === 'en') return saved;
  if (fromLangCode && !fromLangCode.toLowerCase().startsWith('zh')) {
    return 'en';
  }
  return 'zh';
}

const I18N = {
  zh: {
    code: 'zh',
    name: '简体中文',
    welcome: `👋 <b>你好！我是 Apple Music 高品质音乐点歌与转存助手。</b>

🎵 <b>使用说明：</b>
直接把 Apple Music 单曲或专辑链接发送给我，例如：
• <b>单曲链接：</b> <code>https://music.apple.com/cn/album/晴天/1468058165?i=1468058171</code>
• <b>专辑链接：</b> <code>https://music.apple.com/cn/album/叶惠美/1468058165</code>
• <b>纯歌曲ID：</b> <code>1468058171</code>

⚡ <b>核心功能亮点：</b>
• <b>支持全专辑下载：</b> 一键打包整张专辑，合为消息气泡极速直达
• <b>华语元数据修复：</b> 智能恢复正统中文歌名与歌手 (如张楚、周杰伦等)
• <b>智能队列加速：</b> 单曲优先插队，秒级立等可取
• <b>无损音质点选：</b> ALAC 无损 / Hi-Res / 杜比全景声 / AAC
• <b>媒体库秒传：</b> 已存档资源 0 秒直发，无需重复等待

🌐 <b>语言设置：</b> 发送 <code>/lang</code> 可随时切换中英文。`,
    firstWelcome: `👋 <b>欢迎使用 Apple Music 点歌转存助手！</b>
Welcome to Apple Music Hi-Fi Downloader!

🌐 <b>请选择您的显示语言 / Please select your preferred language:</b>`,
    langSwitched: '✅ 语言已成功切换为：<b>简体中文</b> 🇨🇳',
    resolvingSong: '🔍 <b>正在解析单曲元数据...</b>',
    resolvingAlbum: '🔍 <b>正在解析整张专辑曲目列表...</b>',
    invalidUrl: '💡 请发送有效的 Apple Music 单曲或专辑链接 (如包含 <code>?i=</code> 的歌曲链接或纯数字歌曲 ID)。',
    tooFrequent: (sec) => `⏳ <b>操作太频繁啦！</b>\n请稍候 <code>${sec}</code> 秒后再发送新任务。（系统设置 5 秒安全间隔保护）`,
    groupTip: '💡 <b>群聊仅作为音乐档案库浏览。</b>\n请私聊我发送歌曲或专辑链接进行点歌转存哦！'
  },
  en: {
    code: 'en',
    name: 'English',
    welcome: `👋 <b>Hello! I'm your Apple Music High-Fidelity Downloader & Bot.</b>

🎵 <b>How to Use:</b>
Simply send me an Apple Music song or album link, for example:
• <b>Song link:</b> <code>https://music.apple.com/us/album/cruel-summer/1468058165?i=1468058171</code>
• <b>Album link:</b> <code>https://music.apple.com/us/album/lover/1468058165</code>
• <b>Track ID:</b> <code>1468058171</code>

⚡ <b>Highlights:</b>
• <b>Full Album Batch:</b> 1-click batch download aggregated into clean playlist bubbles
• <b>Lossless Quality:</b> ALAC Lossless / Hi-Res / Dolby Atmos / AAC
• <b>Smart Priority Queue:</b> Single tracks jump ahead for near-instant 3s delivery
• <b>Instant Cache:</b> Archived tracks sent instantly with 0 wait time
• <b>Embedded Lyrics & Artwork:</b> High-res 1400px artwork + embedded TTML/LRC

🌐 <b>Language:</b> Type <code>/lang</code> anytime to switch language.`,
    firstWelcome: `👋 <b>Welcome to Apple Music Hi-Fi Downloader!</b>
欢迎使用 Apple Music 点歌转存助手！

🌐 <b>Please select your preferred language / 请选择您的显示语言:</b>`,
    langSwitched: '✅ Language successfully switched to: <b>English</b> 🇬🇧',
    resolvingSong: '🔍 <b>Resolving track metadata...</b>',
    resolvingAlbum: '🔍 <b>Resolving album tracks...</b>',
    invalidUrl: '💡 Please send a valid Apple Music song or album link (e.g. link with <code>?i=</code> or numeric track ID).',
    tooFrequent: (sec) => `⏳ <b>Too fast!</b>\nPlease wait <code>${sec}</code> seconds before sending another request.`,
    groupTip: '💡 <b>This group is an archive channel.</b>\nPlease send me a private message to download songs!'
  }
};

// ==================== 标签与文本工具 ====================
function sanitizeHashtag(str) {
  if (!str) return '';
  const cleaned = String(str)
    .replace(/[·・•\s\-_/\\|.,!?'"~`@#$%^&*()+=[\]{}<>:;]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned ? `#${cleaned}` : '';
}

function formatDuration(ms) {
  if (!ms) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeCaption(str, max = 1000) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ==================== 流量统计与监控 (Oracle 10TB 配额实时监控) ====================
function getTrafficStats() {
  let rxBytes = 0;
  let txBytes = 0;

  // 1. 优先尝试从 vnstat 获取精准月度流量
  try {
    const raw = execSync('vnstat --json m -i enp0s6', { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const data = JSON.parse(raw);
    const iface = data.interfaces?.find(i => i.name === 'enp0s6') || data.interfaces?.[0];
    const currentMonth = new Date().getMonth() + 1;
    const m = iface?.traffic?.month?.find(x => x.date?.month === currentMonth) || iface?.traffic?.month?.[0];
    if (m && (m.tx || m.rx)) {
      rxBytes = m.rx || 0;
      txBytes = m.tx || 0;
    }
  } catch {}

  // 2. 降级方案：从 /proc/net/dev 读取网卡实时总流量
  if (!txBytes && !rxBytes) {
    try {
      if (fs.existsSync('/proc/net/dev')) {
        const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n');
        for (const line of lines) {
          if (line.includes('enp0s6:')) {
            const parts = line.split(':')[1].trim().split(/\s+/);
            rxBytes = Number(parts[0]) || 0;
            txBytes = Number(parts[8]) || 0;
            break;
          }
        }
      }
    } catch {}
  }

  const txGB = Number((txBytes / (1024 * 1024 * 1024)).toFixed(2));
  const rxGB = Number((rxBytes / (1024 * 1024 * 1024)).toFixed(2));
  const maxQuotaGB = 10240; // 10TB
  const remainingGB = Math.max(0, Number((maxQuotaGB - txGB).toFixed(2)));
  const usagePercent = Number(((txGB / maxQuotaGB) * 100).toFixed(2));

  const filledBlocks = Math.min(10, Math.floor(usagePercent / 10));
  const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(10 - filledBlocks);

  return {
    txGB,
    rxGB,
    maxQuotaGB,
    remainingGB,
    usagePercent,
    progressBar
  };
}

// ==================== 防刷限流与配额管理 (作者专属无限制豁免) ====================
class UserQuotaManager {
  constructor() {
    this.cooldowns = new Map();
    this.dailyUsage = new Map();
  }

  getTodayStr() {
    // 强制使用北京时间 (UTC+8) 计算日期，确保每日配额在午夜 00:00 精确刷新
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  isOwner(userId) {
    return String(userId) === String(OWNER_USER_ID);
  }

  checkCooldown(userId, cooldownMs = 5000) {
    if (this.isOwner(userId)) return { ok: true };
    const now = Date.now();
    const last = this.cooldowns.get(String(userId)) || 0;
    if (now - last < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - last)) / 1000);
      return { ok: false, waitSec };
    }
    this.cooldowns.set(String(userId), now);
    return { ok: true };
  }

  checkQuota(userId, isAlbum = false) {
    if (this.isOwner(userId)) return { ok: true, isOwner: true };
    const today = this.getTodayStr();
    const key = String(userId);
    let record = this.dailyUsage.get(key);
    if (!record || record.dateStr !== today) {
      record = { dateStr: today, albumCount: 0, songCount: 0 };
      this.dailyUsage.set(key, record);
    }

    const maxAlbums = 20; // 每日最多 20 张全辑
    const maxSongs = 50;  // 每日最多 50 首单曲

    if (isAlbum && record.albumCount >= maxAlbums) {
      return { ok: false, limitType: 'album', current: record.albumCount, max: maxAlbums };
    }
    if (!isAlbum && record.songCount >= maxSongs) {
      return { ok: false, limitType: 'song', current: record.songCount, max: maxSongs };
    }
    return { ok: true, current: isAlbum ? record.albumCount : record.songCount, max: isAlbum ? maxAlbums : maxSongs };
  }

  incrementQuota(userId, isAlbum = false) {
    if (this.isOwner(userId)) return;
    const today = this.getTodayStr();
    const key = String(userId);
    let record = this.dailyUsage.get(key);
    if (!record || record.dateStr !== today) {
      record = { dateStr: today, albumCount: 0, songCount: 0 };
      this.dailyUsage.set(key, record);
    }
    if (isAlbum) record.albumCount++;
    else record.songCount++;
  }

  cleanupStale() {
    const today = this.getTodayStr();
    const now = Date.now();
    for (const [key, record] of this.dailyUsage.entries()) {
      if (record.dateStr !== today) {
        this.dailyUsage.delete(key);
      }
    }
    for (const [key, last] of this.cooldowns.entries()) {
      if (now - last > 3600000) {
        this.cooldowns.delete(key);
      }
    }
  }
}

const quotaManager = new UserQuotaManager();

/**
 * 轻量高可用并发执行器 (Worker Pool)
 * 严格保留任务序号，任务内部异常由各调用方自适应捕获
 */
async function pMap(items, concurrency, mapperFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await mapperFn(items[idx], idx);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 智能规划专辑合辑气泡分布 (黄金平衡版)
 * 严格遵循 Telegram sendMediaGroup 2-10 首限制：
 * - 1 首: 降级为标准单曲形式
 * - 2~10 首: 100% 聚合成 1 个气泡 (单张整洁卡片，贴合常规专辑视觉诉求)
 * - 11~14 首: 严格均分成 2 个气泡 (例如 11首拆为 6+5, 12首拆为 6+6, 14首拆为 7+7)
 * - >14 首: 均分为 3~N 个气泡，每组严格控制在 5~7 首黄金平衡区间，杜绝单包超大 (800MB~1GB) 导致频道频控卡死
 */
function planAlbumChunks(total) {
  if (total <= 0) return [];
  if (total === 1) return [1];
  if (total <= 10) return [total];
  if (total <= 14) {
    const half = Math.ceil(total / 2);
    return [half, total - half];
  }
  const targetChunkSize = 6;
  const numChunks = Math.max(2, Math.round(total / targetChunkSize));
  const base = Math.floor(total / numChunks);
  const rem = total % numChunks;
  const chunks = [];
  for (let i = 0; i < numChunks; i++) {
    chunks.push(base + (i < rem ? 1 : 0));
  }
  return chunks;
}

// ==================== Telegram API 封装 (含网络重试与限流退避) ====================
async function tgCall(method, body = {}, maxRetries = 3, timeoutMs = 60000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const url = `${TG_API_BASE}/bot${BOT_TOKEN}/${method}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await res.json();
      if (!data.ok) {
        let retrySec = data.parameters?.retry_after;
        if (!retrySec && data.description) {
          const m = data.description.match(/retry after (\d+)/i);
          if (m) retrySec = parseInt(m[1], 10);
        }
        if (retrySec) {
          const waitSec = Math.max(retrySec + 2, 3);
          console.warn(`[Telegram API] 调用 ${method} 触发速率限制，等待 ${waitSec} 秒后重试...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw new Error(`Telegram API [${method}] 错误: ${data.description || '未知错误'}`);
      }
      return data.result;
    } catch (err) {
      if (err.message.includes('message is not modified') || err.message.includes('query is too old')) {
        return null;
      }
      const m = err.message.match(/retry after (\d+)/i);
      const waitMs = m ? (parseInt(m[1], 10) + 2) * 1000 : 1000 * attempt;
      console.warn(`[Telegram API] 调用 ${method} 异常 (第 ${attempt}/${maxRetries} 次): ${err.message}`);
      if (attempt >= maxRetries) throw err;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function tgSendFile(method, fieldName, filePath, fileName, fields = {}, maxRetries = 3) {
  let attempt = 0;
  const absPath = path.resolve(filePath);
  const isLocalApi = TG_API_BASE.includes('127.0.0.1') || TG_API_BASE.includes('localhost');

  while (attempt < maxRetries) {
    attempt++;
    try {
      // 官方 Local Bot API 专线零拷贝极速直传 (毫秒级，0 内存膨胀，0 本地 HTTP 大文件流损耗)
      if (isLocalApi && fs.existsSync(absPath)) {
        const body = {
          ...fields,
          [fieldName]: `file://${absPath}`
        };
        if (fields.thumbnailPath && fs.existsSync(fields.thumbnailPath)) {
          body.thumbnail = `file://${path.resolve(fields.thumbnailPath)}`;
        }
        delete body.thumbnailPath;
        // 文件上传给予 300 秒 (5分钟) 上传窗口，杜绝 60 秒硬超时
        return await tgCall(method, body, maxRetries, 300000);
      }

      // 备用兼容链路：标准 multipart/form-data (仅在远端 API 时使用)
      const url = `${TG_API_BASE}/bot${BOT_TOKEN}/${method}`;
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'thumbnailPath') continue;
        if (v !== undefined && v !== null) {
          form.append(k, String(v));
        }
      }
      const fileBlob = await fs.openAsBlob(absPath);
      form.append(fieldName, fileBlob, fileName);

      if (fields.thumbnailPath && fs.existsSync(fields.thumbnailPath)) {
        const thumbBlob = await fs.openAsBlob(fields.thumbnailPath);
        form.append('thumbnail', thumbBlob, 'thumb.jpg');
      }

      const res = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300000)
      });
      const data = await res.json();
      if (!data.ok) {
        let retrySec = data.parameters?.retry_after;
        if (!retrySec && data.description) {
          const m = data.description.match(/retry after (\d+)/i);
          if (m) retrySec = parseInt(m[1], 10);
        }
        if (retrySec) {
          const waitSec = Math.max(retrySec + 2, 3);
          console.warn(`[Telegram API] 上传触发速率限制，等待 ${waitSec} 秒后重试...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw new Error(`Telegram API [${method}] 错误: ${data.description || '未知错误'}`);
      }
      return data.result;
    } catch (err) {
      const m = err.message.match(/retry after (\d+)/i);
      const waitMs = m ? (parseInt(m[1], 10) + 2) * 1000 : 2000 * attempt;
      console.warn(`[TG-Bot] 上传 ${fileName} 失败 (第 ${attempt}/${maxRetries} 次): ${err.message}`);
      if (attempt >= maxRetries) throw err;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function tgSendMediaGroup(chatId, mediaArray, filesMap = {}, maxRetries = 2) {
  let attempt = 0;
  const isLocalApi = TG_API_BASE.includes('127.0.0.1') || TG_API_BASE.includes('localhost');

  while (attempt < maxRetries) {
    attempt++;
    try {
      // 官方 Local Bot API 专线零拷贝模式：直接通过 JSON 传递 file:// 路径
      if (isLocalApi) {
        // sendMediaGroup 包含多首大体积无损音频，给足 300 秒 (5分钟) 上传窗口，杜绝 60 秒误超时与幽灵重发
        return await tgCall('sendMediaGroup', {
          chat_id: chatId,
          media: mediaArray
        }, maxRetries, 300000);
      }

      // 备用兼容链路：标准 multipart/form-data
      const url = `${TG_API_BASE}/bot${BOT_TOKEN}/sendMediaGroup`;
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('media', JSON.stringify(mediaArray));

      for (const [key, item] of Object.entries(filesMap)) {
        if (item.filePath && fs.existsSync(item.filePath)) {
          const fileBlob = await fs.openAsBlob(item.filePath);
          form.append(key, fileBlob, item.fileName || 'file');
        }
      }

      const res = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300000)
      });
      const data = await res.json();
      if (!data.ok) {
        let retrySec = data.parameters?.retry_after;
        if (!retrySec && data.description) {
          const m = data.description.match(/retry after (\d+)/i);
          if (m) retrySec = parseInt(m[1], 10);
        }
        if (retrySec) {
          const waitSec = Math.max(retrySec + 2, 8);
          console.warn(`[Telegram API] sendMediaGroup 触发速率限制，等待 ${waitSec} 秒后重试...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          if (attempt >= maxRetries) {
            throw new Error(`Telegram API [sendMediaGroup] 频控: ${data.description || '未知错误'}`);
          }
          continue;
        }
        throw new Error(`Telegram API [sendMediaGroup] 错误: ${data.description || '未知错误'}`);
      }
      return data.result;
    } catch (err) {
      const m = err.message.match(/retry after (\d+)/i);
      const waitMs = m ? (parseInt(m[1], 10) + 2) * 1000 : 3000 * attempt;
      console.warn(`[Telegram API] sendMediaGroup 异常 (第 ${attempt}/${maxRetries} 次): ${err.message}`);
      if (attempt >= maxRetries) throw err;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

/**
 * 统一极速上传引擎 (基于官方 Telegram Local Bot API 服务端)
 * 1. 采用官方 Local Bot API 专线架构，完全杜绝账号风控，单文件上限高达 2000MB (2GB)
 * 2. 统一将媒体文件首先归档发布至 AUTHORIZED_GROUP_ID 授权频道
 * 3. 归档成功后，通过官方 copyMessage 毫秒级无损瞬发至用户私聊 (0 重复上传、零带宽损耗)
 * 4. 频道与私聊的消息格式、音质与样式 100% 保持完全统一
 */
async function unifiedSendMedia({
  chatId,
  filePath,
  fileName,
  thumbPath = null,
  caption = '',
  isAudio = false,
  isZip = false,
  title = '',
  performer = '',
  duration = 0,
  replyToMessageId = null
}) {
  const stat = fs.statSync(filePath);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);

  if (stat.size > 2000 * 1024 * 1024) {
    throw new Error(`文件体积 (${sizeMb} MB) 超过 Telegram 上限 2000MB`);
  }

  const uploadStart = performance.now();
  let groupMsg = null;

  if (isAudio) {
    const audioFields = {
      chat_id: AUTHORIZED_GROUP_ID,
      caption: caption,
      parse_mode: 'HTML',
      title: title || fileName.replace(/\.(m4a|mp3|flac)$/, ''),
      performer: performer,
      duration: duration
    };
    if (thumbPath && fs.existsSync(thumbPath)) {
      audioFields.thumbnailPath = thumbPath;
    }
    groupMsg = await tgSendFile('sendAudio', 'audio', filePath, fileName, audioFields);
  } else {
    const docFields = {
      chat_id: AUTHORIZED_GROUP_ID,
      caption: caption,
      parse_mode: 'HTML'
    };
    if (replyToMessageId) {
      docFields.reply_to_message_id = replyToMessageId;
    }
    groupMsg = await tgSendFile('sendDocument', 'document', filePath, fileName, docFields);
  }

  if (!groupMsg || !groupMsg.message_id) {
    throw new Error(`归档发送失败，未能获取消息 ID`);
  }

  const groupMsgId = groupMsg.message_id;
  const fileId = groupMsg.audio?.file_id || groupMsg.document?.file_id || null;

  // 若用户私聊不是归档频道本身，则秒级调用 copyMessage 瞬发给用户私聊
  if (String(chatId) !== String(AUTHORIZED_GROUP_ID)) {
    try {
      await tgCall('copyMessage', {
        chat_id: chatId,
        from_chat_id: AUTHORIZED_GROUP_ID,
        message_id: groupMsgId
      });
    } catch (copyErr) {
      console.warn(`[UnifiedUpload] copyMessage 失败，尝试直接复用 file_id 推送: ${copyErr.message}`);
      if (isAudio && fileId) {
        await tgCall('sendAudio', {
          chat_id: chatId,
          audio: fileId,
          caption: caption,
          parse_mode: 'HTML',
          title: title || fileName.replace(/\.(m4a|mp3|flac)$/, ''),
          performer: performer
        });
      } else if (fileId) {
        await tgCall('sendDocument', {
          chat_id: chatId,
          document: fileId,
          caption: caption,
          parse_mode: 'HTML'
        });
      } else {
        throw copyErr;
      }
    }
  }

  const durationSec = Number(Math.max(0.01, (performance.now() - uploadStart) / 1000).toFixed(2));
  const speedMbS = Number((stat.size / (1024 * 1024) / durationSec).toFixed(2));

  return {
    ok: true,
    via: 'tg_bot_api',
    groupMsgId: groupMsgId,
    fileId: fileId,
    durationSec: durationSec,
    speedMbS: speedMbS,
    sizeMb: Number(sizeMb)
  };
}

// ==================== 任务级全局时间顺序排队器 (BotTaskQueue) ====================
// 严格按顺序串行执行：前序任务（无论是单曲还是整张专辑）彻底处理交付后，才处理下一个用户的请求！
class BotTaskQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.queue = [];
    this.runningCount = 0;
  }

  get isBusy() {
    return this.runningCount >= this.concurrency;
  }

  get length() {
    return this.queue.length;
  }

  enqueue(meta, taskFn) {
    return new Promise((resolve, reject) => {
      const isQueued = this.runningCount >= this.concurrency;
      const isPriority = meta.isSingle === true || meta.type === 'song';
      const item = {
        meta,
        taskFn,
        resolve,
        reject,
        notified: !isQueued,
        enqueuedAt: Date.now(),
        isPriority
      };

      // 单曲智能高优先插队：单曲任务优先插在排队中所有全辑任务之前，避免单曲点歌被大专辑阻塞
      if (isPriority && this.queue.length > 0) {
        const firstAlbumIndex = this.queue.findIndex(it => !it.isPriority);
        if (firstAlbumIndex !== -1) {
          this.queue.splice(firstAlbumIndex, 0, item);
        } else {
          this.queue.push(item);
        }
      } else {
        this.queue.push(item);
      }

      if (isQueued) {
        this._updateQueueNotifications();
      }
      this._processNext();
    });
  }

  async _updateQueueNotifications() {
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.meta.chatId && item.meta.messageId && !item.notified) {
        item.notified = true;
        const pos = i + 1;
        try {
          await tgCall('editMessageText', {
            chat_id: item.meta.chatId,
            message_id: item.meta.messageId,
            text: `⏳ <b>已加入全局下载队列 (排在第 ${pos} 位)</b>\n当前有其他任务正在下载处理中。为保护服务器负载与带宽稳定，系统严格按先后顺序执行，前面的任务完成后将立即自动开始您的下载，请耐心稍候...`,
            parse_mode: 'HTML'
          });
        } catch {}
      }
    }
  }

  async _processNext() {
    if (this.runningCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    this.runningCount++;

    // 更新后续排队用户的最新位次
    for (let i = 0; i < this.queue.length; i++) {
      const remaining = this.queue[i];
      if (remaining.meta.chatId && remaining.meta.messageId) {
        const newPos = i + 1;
        try {
          await tgCall('editMessageText', {
            chat_id: remaining.meta.chatId,
            message_id: remaining.meta.messageId,
            text: `⏳ <b>下载队列更新 (当前前进至第 ${newPos} 位)</b>\n正在等待前序任务完成，即将开始处理您的转存...`,
            parse_mode: 'HTML'
          });
        } catch {}
      }
    }

    try {
      const res = await item.taskFn();
      item.resolve(res);
    } catch (err) {
      item.reject(err);
    } finally {
      this.runningCount--;
      setImmediate(() => this._processNext());
    }
  }
}

const botTaskQueue = new BotTaskQueue(1);

// ==================== Apple Music 元数据解析 ====================
function parseAppleMusicUrl(text) {
  if (!text) return null;
  const str = text.trim();

  // 1. 纯数字 ID (默认优先港区 hk 大库，防国内删歌且保留汉字)
  if (/^\d{8,12}$/.test(str)) {
    return { type: 'song', songId: str, storefront: 'hk' };
  }

  // 2. 匹配包含 ?i= 的单曲链接 (优先判定单曲)
  const songInAlbumMatch = str.match(/music\.apple\.com\/(?:([a-z]{2})\/)?album\/(?:[^/?#\s]+\/)?(\d+)\?(?:[^#\s]*&)?i=(\d+)/i);
  if (songInAlbumMatch) {
    return {
      type: 'song',
      storefront: songInAlbumMatch[1] || 'hk',
      albumId: songInAlbumMatch[2],
      songId: songInAlbumMatch[3]
    };
  }

  // 3. /song/.../1468058171 或 /song/1468058171
  const songMatch = str.match(/music\.apple\.com\/(?:([a-z]{2})\/)?song\/(?:[^/?#\s]+\/)?(\d+)/i);
  if (songMatch) {
    return {
      type: 'song',
      storefront: songMatch[1] || 'hk',
      songId: songMatch[2]
    };
  }

  // 4. /album/.../1468058165 或 /album/1468058165 (整张专辑，无 ?i=)
  const albumMatch = str.match(/music\.apple\.com\/(?:([a-z]{2})\/)?album\/(?:[^/?#\s]+\/)?(\d+)/i);
  if (albumMatch) {
    return {
      type: 'album',
      storefront: albumMatch[1] || 'hk',
      albumId: albumMatch[2]
    };
  }

  // 5. 歌单链接: /playlist/.../pl.xxx 或个人歌单 pl.u-xxx
  const plMatch = str.match(/(?:music\.apple\.com\/(?:([a-z]{2})\/)?playlist\/(?:[^/?#\s]+\/)?|)(pl\.[a-zA-Z0-9_\-]+)/i);
  if (plMatch) {
    return {
      type: 'playlist',
      storefront: plMatch[1] || 'hk',
      playlistId: plMatch[2]
    };
  }

  // 6. 歌手/艺人主页链接: /artist/.../417697487 或 /artist/417697487
  const artistMatch = str.match(/music\.apple\.com\/(?:([a-z]{2})\/)?artist\/(?:[^/?#\s]+\/)?(\d+)/i);
  if (artistMatch) {
    return {
      type: 'artist',
      storefront: artistMatch[1] || 'hk',
      artistId: artistMatch[2]
    };
  }

  return null;
}

async function fetchSongDetails(songId, storefront = 'hk') {
  // 智能地区级联顺序：日韩链接优先原区；其余链接优先国区大库 (cn) 获取正统中文元数据，杜绝拼音/英文艺名；无资源时顺延回退原区、港台与美区
  let storefronts;
  if (storefront === 'jp' || storefront === 'kr') {
    storefronts = [storefront, 'cn', 'hk', 'tw', 'us', 'tr'];
  } else if (storefront === 'cn') {
    storefronts = ['cn', 'hk', 'tw', 'us', 'tr'];
  } else {
    storefronts = ['cn', storefront, 'hk', 'tw', 'us', 'tr'];
  }
  storefronts = storefronts.filter((v, i, a) => a.indexOf(v) === i);

  let songAttr = null;
  for (const sf of storefronts) {
    try {
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/songs/${songId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.data?.[0]?.attributes) {
          songAttr = data.data[0].attributes;
          break;
        }
      }
    } catch {}
  }

  if (!songAttr) {
    throw new Error(`未能从 Apple Music 获取到歌曲 (${songId}) 的元数据，请检查链接或版权`);
  }

  let variants = [];
  try {
    const pRes = await fetch(`${HOOK_BASE}/parse/song/${songId}`, { signal: AbortSignal.timeout(8000) });
    if (pRes.ok) {
      const pData = await pRes.json();
      variants = pData.variants || [];
    }
  } catch {}

  const hasHiRes = variants.some(v => v.codecs === 'alac' && (v.sample_rate > 48000 || v.bit_depth > 16));
  const hasAtmos = variants.some(v => (v.codecs && v.codecs.includes('ec-3')) || (v.group_id && v.group_id.includes('atmos')));
  const hasLossless = variants.some(v => v.codecs === 'alac') || true;
  const hasAac = variants.some(v => v.codecs && v.codecs.includes('mp4a')) || true;

  let title = toSimplifiedChinese(songAttr.name);
  let artist = normalizeArtistName(songAttr.artistName);
  let album = toSimplifiedChinese(songAttr.albumName);
  let albumArtist = normalizeArtistName(songAttr.albumArtistName || songAttr.artistName);
  let composer = normalizeArtistName(songAttr.composerName);

  // 若艺人名或曲名仍为英文/罗马音，向 cn 大库带入 l=zh-Hans-CN 再次精准补全正统中文名
  if (!/[\u4e00-\u9fa5]/.test(artist) || !/[\u4e00-\u9fa5]/.test(title)) {
    try {
      const cnRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/cn/songs/${songId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(3000) });
      if (cnRes.ok) {
        const cData = await cnRes.json();
        const cAttr = cData.data?.[0]?.attributes;
        if (cAttr) {
          if (!/[\u4e00-\u9fa5]/.test(artist) && cAttr.artistName && /[\u4e00-\u9fa5]/.test(cAttr.artistName)) {
            artist = normalizeArtistName(toSimplifiedChinese(cAttr.artistName));
            albumArtist = artist;
          }
          if (!/[\u4e00-\u9fa5]/.test(title) && cAttr.name && /[\u4e00-\u9fa5]/.test(cAttr.name)) {
            title = toSimplifiedChinese(cAttr.name);
          }
          if (cAttr.albumName && (!album || !/[\u4e00-\u9fa5]/.test(album))) {
            album = toSimplifiedChinese(cAttr.albumName);
          }
        }
      }
    } catch {}
  }

  return {
    songId,
    title,
    artist,
    album,
    albumArtist,
    releaseDate: songAttr.releaseDate,
    durationInMillis: songAttr.durationInMillis,
    trackNumber: songAttr.trackNumber,
    discNumber: songAttr.discNumber,
    genre: (songAttr.genreNames || []).map(g => toSimplifiedChinese(g)).join('/'),
    composer,
    hasLyrics: Boolean(songAttr.hasLyrics),
    coverUrl: (songAttr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    traits: {
      lossless: hasLossless,
      hires: hasHiRes,
      atmos: hasAtmos,
      aac: hasAac
    }
  };
}

async function fetchAlbumDetails(albumId, storefront = 'hk') {
  // tr 优先：专辑曲目 ID 必须与土区 wrapper 账号一致，避免跨区 adamId 不匹配
  let storefronts;
  if (storefront === 'jp' || storefront === 'kr') {
    storefronts = ['tr', storefront, 'cn', 'hk', 'tw', 'us'];
  } else if (storefront === 'cn') {
    storefronts = ['tr', 'cn', 'hk', 'tw', 'us'];
  } else {
    storefronts = ['tr', storefront, 'cn', 'hk', 'tw', 'us'];
  }
  storefronts = storefronts.filter((v, i, a) => a.indexOf(v) === i);

  let albumData = null;
  for (const sf of storefronts) {
    try {
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/albums/${albumId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.data?.[0]) {
          albumData = data.data[0];
          break;
        }
      }
    } catch {}
  }

  if (!albumData) {
    throw new Error(`未能获取到专辑信息 (${albumId})`);
  }

  const attr = albumData.attributes || {};
  let tracks = albumData.relationships?.tracks?.data || [];
  let albumName = toSimplifiedChinese(attr.name);
  let artistName = normalizeArtistName(attr.artistName);

  // 若艺人名或专辑名仍为英文/拼音，智能向 cn 大库精准嗅探补全
  if (!/[\u4e00-\u9fa5]/.test(artistName) || !/[\u4e00-\u9fa5]/.test(albumName)) {
    try {
      const cnRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/cn/albums/${albumId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(4000) });
      if (cnRes.ok) {
        const cData = await cnRes.json();
        const cAttr = cData.data?.[0]?.attributes;
        if (cAttr) {
          if (!/[\u4e00-\u9fa5]/.test(artistName) && cAttr.artistName && /[\u4e00-\u9fa5]/.test(cAttr.artistName)) {
            artistName = normalizeArtistName(toSimplifiedChinese(cAttr.artistName));
          }
          if (!/[\u4e00-\u9fa5]/.test(albumName) && cAttr.name && /[\u4e00-\u9fa5]/.test(cAttr.name)) {
            albumName = toSimplifiedChinese(cAttr.name);
          }
          if (cData.data?.[0]?.relationships?.tracks?.data?.length) {
            tracks = cData.data[0].relationships.tracks.data;
          }
        }
      }
    } catch {}
  }

  return {
    albumId,
    name: albumName,
    artistName: artistName,
    releaseDate: attr.releaseDate,
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    tracks: tracks.map(t => ({
      id: t.id,
      name: toSimplifiedChinese(t.attributes?.name || 'Track'),
      trackNumber: t.attributes?.trackNumber,
      artistName: normalizeArtistName(t.attributes?.artistName || artistName)
    }))
  };
}

async function fetchPlaylistDetails(playlistId, storefront = 'hk') {
  // tr 优先：wrapper-lite 是土区账号，曲目 ID 必须从土区目录解析，否则跨区 adamId 不匹配导致误判无版权
  let storefronts = ['tr', storefront, 'cn', 'hk', 'tw', 'us'].filter((v, i, a) => a.indexOf(v) === i);
  let plResolved = null;
  let plSf = null;
  for (const sf of storefronts) {
    try {
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/playlists/${playlistId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.data?.[0]) {
          plResolved = data.data[0];
          plSf = sf;
          break;
        }
      }
    } catch {}
  }

  if (!plResolved) {
    throw new Error(`未能获取到歌单信息 (${playlistId})`);
  }

  const attr = plResolved.attributes || {};

  // 分页拉取全部曲目：Apple Music 目录 API 对 tracks relationship 默认每页 100 首，
  // 通过 /playlists/{id}/tracks?offset=N 翻页直到 next 为空，彻底解决 >100 首歌单只取到前 100 首的问题
  const allTracks = [];
  let nextOffset = 0;
  let guard = 0;
  while (guard < 60) { // 防死循环保险（最多 60 页）
    guard++;
    let page = null;
    try {
      const tRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${plSf}/playlists/${playlistId}/tracks?l=zh-Hans-CN&offset=${nextOffset}`, { signal: AbortSignal.timeout(6000) });
      if (tRes.ok) page = await tRes.json();
    } catch {}
    if (!page || !page.data || !page.data.length) break;
    allTracks.push(...page.data);
    const next = page.next;
    if (!next) break;
    const m = String(next).match(/offset=(\d+)/);
    const newOffset = m ? parseInt(m[1], 10) : NaN;
    // 翻页未前进则视为已拉完（部分端点 next 指向当前页自身）
    if (!(newOffset > nextOffset)) break;
    nextOffset = newOffset;
  }

  return {
    albumId: playlistId, // 统一走批量转存调度
    isPlaylist: true,
    name: toSimplifiedChinese(attr.name || 'Playlist'),
    artistName: toSimplifiedChinese(attr.curatorName || 'Apple Music'),
    releaseDate: attr.lastModifiedDate ? attr.lastModifiedDate.slice(0, 10) : '近期',
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    tracks: allTracks.map((t, idx) => ({
      id: t.id,
      name: toSimplifiedChinese(t.attributes?.name || 'Track'),
      trackNumber: idx + 1,
      artistName: normalizeArtistName(t.attributes?.artistName || 'Various Artists')
    }))
  };
}

async function fetchArtistDetails(artistId, storefront = 'hk') {
  // tr 优先：top-songs/full-albums 里的曲目 ID 必须与土区 wrapper 账号一致
  let storefronts = ['tr', storefront, 'cn', 'hk', 'tw', 'us'].filter((v, i, a) => a.indexOf(v) === i);
  let artistData = null;
  for (const sf of storefronts) {
    try {
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/artists/${artistId}?views=top-songs,full-albums&l=zh-Hans-CN`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.data?.[0]) {
          artistData = data.data[0];
          break;
        }
      }
    } catch {}
  }

  if (!artistData) {
    throw new Error(`未能获取到艺人信息 (${artistId})`);
  }

  const attr = artistData.attributes || {};
  const topSongs = (artistData.views?.['top-songs']?.data || []).map(s => ({
    id: s.id,
    name: toSimplifiedChinese(s.attributes?.name || 'Song'),
    artistName: normalizeArtistName(s.attributes?.artistName || attr.name || ''),
    durationInMillis: s.attributes?.durationInMillis || 0
  }));

  const albums = (artistData.views?.['full-albums']?.data || []).map(al => ({
    id: al.id,
    name: toSimplifiedChinese(al.attributes?.name || 'Album'),
    releaseDate: al.attributes?.releaseDate || '',
    trackCount: al.attributes?.trackCount || 0
  }));

  return {
    artistId,
    name: normalizeArtistName(toSimplifiedChinese(attr.name || 'Artist')),
    genre: (attr.genreNames && attr.genreNames[0]) || '',
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    topSongs,
    albums
  };
}

function buildArtistCard(artistData, lang = 'zh') {
  const isEn = lang === 'en';
  const text = isEn ?
`👤 <b>Artist Profile: ${escapeHtml(artistData.name)}</b>
🎸 <b>Genre:</b> ${artistData.genre || 'Various'}
🔥 <b>Top Songs:</b> ${artistData.topSongs.length} tracks available
💿 <b>Studio Albums:</b> ${artistData.albums.length} releases

Please choose to browse top songs or albums below:` :
`👤 <b>艺人主页：${escapeHtml(artistData.name)}</b>
🎸 <b>流派风格：</b>${artistData.genre || '综合'}
🔥 <b>热门曲目：</b>共 ${artistData.topSongs.length} 首收录
💿 <b>发行专辑：</b>共 ${artistData.albums.length} 张录音室专辑

请在下方选择浏览热门曲目或专辑：`;

  const inlineKeyboard = [];
  if (artistData.topSongs.length > 0) {
    inlineKeyboard.push([
      {
        text: isEn ? `🔥 Top Songs (${artistData.topSongs.length}) ⬇️` : `🔥 浏览热门歌曲 (${artistData.topSongs.length}首) ⬇️`,
        callback_data: `art_songs:${artistData.artistId}`
      }
    ]);
  }
  if (artistData.albums.length > 0) {
    inlineKeyboard.push([
      {
        text: isEn ? `💿 Browse Albums (${artistData.albums.length}) ⬇️` : `💿 浏览发行专辑 (${artistData.albums.length}张) ⬇️`,
        callback_data: `art_albums:${artistData.artistId}`
      }
    ]);
  }

  return { text, reply_markup: { inline_keyboard: inlineKeyboard } };
}

async function showArtistSongs(chatId, artistData, lang = 'zh', messageId = null) {
  const isEn = lang === 'en';
  const songs = artistData.topSongs || [];
  const inlineKeyboard = [];

  for (let i = 0; i < songs.length; i += 2) {
    const row = [];
    const s1 = songs[i];
    const t1 = `${i + 1}. ${s1.name}`;
    row.push({
      text: t1.length > 18 ? t1.slice(0, 16) + '..' : t1,
      callback_data: `pick:${s1.id}:art_${artistData.artistId}`
    });

    if (i + 1 < songs.length) {
      const s2 = songs[i + 1];
      const t2 = `${i + 2}. ${s2.name}`;
      row.push({
        text: t2.length > 18 ? t2.slice(0, 16) + '..' : t2,
        callback_data: `pick:${s2.id}:art_${artistData.artistId}`
      });
    }
    inlineKeyboard.push(row);
  }

  inlineKeyboard.push([
    {
      text: isEn ? '🔙 Back to Artist Profile' : '🔙 返回艺人主页',
      callback_data: `art_back:${artistData.artistId}`
    }
  ]);

  const text = isEn
    ? `🔥 <b>Top Songs of ${escapeHtml(artistData.name)}:</b>\nTotal ${songs.length} songs. Tap any track to download:`
    : `🔥 <b>${escapeHtml(artistData.name)} 热门歌曲列表：</b>\n共 ${songs.length} 首，点击单曲可单独进入点歌下载：`;

  if (messageId) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard.slice(0, 52) }
    });
  } else {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard.slice(0, 52) }
    });
  }
}

async function showArtistAlbums(chatId, artistData, lang = 'zh', messageId = null) {
  const isEn = lang === 'en';
  const albums = artistData.albums || [];
  const inlineKeyboard = [];

  for (let i = 0; i < albums.length; i++) {
    const al = albums[i];
    const year = al.releaseDate ? ` (${al.releaseDate.slice(0, 4)})` : '';
    const title = `💿 ${al.name}${year}`;
    inlineKeyboard.push([
      {
        text: title.length > 36 ? title.slice(0, 34) + '..' : title,
        callback_data: `art_album:${al.id}:${artistData.artistId}`
      }
    ]);
  }

  inlineKeyboard.push([
    {
      text: isEn ? '🔙 Back to Artist Profile' : '🔙 返回艺人主页',
      callback_data: `art_back:${artistData.artistId}`
    }
  ]);

  const text = isEn
    ? `💿 <b>Albums by ${escapeHtml(artistData.name)}:</b>\nTotal ${albums.length} releases. Tap an album to open:`
    : `💿 <b>${escapeHtml(artistData.name)} 专辑列表：</b>\n共 ${albums.length} 张专辑，点击可进入专辑下载与选歌：`;

  if (messageId) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard.slice(0, 52) }
    });
  } else {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard.slice(0, 52) }
    });
  }
}

// ==================== 会话状态管理 (含 TTL 防内存泄漏) ====================
const userSessions = new Map();
const artistCache = new Map(); // artistId -> { data, createdAt }

async function getArtistData(artistId, storefront = 'hk') {
  const hit = artistCache.get(artistId);
  if (hit && Date.now() - hit.createdAt < 10 * 60 * 1000) return hit.data;
  const data = await fetchArtistDetails(artistId, storefront);
  artistCache.set(artistId, { data, createdAt: Date.now() });
  return data;
}

function cleanStaleUserSessions() {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 小时过期
  for (const [key, session] of userSessions.entries()) {
    if (session.createdAt && (now - session.createdAt > maxAge)) {
      userSessions.delete(key);
    }
  }
  for (const [key, entry] of artistCache.entries()) {
    if (now - entry.createdAt > 30 * 60 * 1000) artistCache.delete(key);
  }
  quotaManager.cleanupStale();
}
setInterval(cleanStaleUserSessions, 15 * 60 * 1000);

// ==================== 卡片构建器 ====================
function buildSongCard(details, selectedQuality = 'Lossless', needLrc = true, isZip = false, lang = 'zh', backAlbumId = null) {
  const isEn = lang === 'en';
  const cacheKey = `${details.songId}_${selectedQuality.toLowerCase()}_${isZip ? 'zip' : 'audio'}`;
  const isCached = Boolean(db.get(cacheKey));

  let traitsDesc = [];
  if (details.traits.lossless) traitsDesc.push(isEn ? 'ALAC Lossless' : 'ALAC 无损');
  if (details.traits.hires) traitsDesc.push(isEn ? 'Hi-Res Audio' : 'Hi-Res 高解析');
  if (details.traits.atmos) traitsDesc.push(isEn ? 'Dolby Atmos' : '杜比全景声');
  if (details.traits.aac) traitsDesc.push('AAC 256k');

  const text = isEn ?
`🎵 <b>${escapeHtml(details.title)}</b>
👤 <b>Artist:</b> ${escapeHtml(details.artist)}
💿 <b>Album:</b> ${escapeHtml(details.album)}
⏱ <b>Duration:</b> ${formatDuration(details.durationInMillis)}
📅 <b>Release:</b> ${details.releaseDate || 'Unknown'}
🎧 <b>Formats:</b> ${traitsDesc.join(' | ')}
${isCached ? '\n⚡ <b>Status: Archived in library. Tap to send instantly!</b>' : ''}
Please select quality, delivery format, and lyrics options:` :
`🎵 <b>${escapeHtml(details.title)}</b>
👤 <b>歌手：</b>${escapeHtml(details.artist)}
💿 <b>专辑：</b>${escapeHtml(details.album)}
⏱ <b>时长：</b>${formatDuration(details.durationInMillis)}
📅 <b>发行：</b>${details.releaseDate || '未知'}
🎧 <b>支持规格：</b>${traitsDesc.join(' | ')}
${isCached ? '\n⚡ <b>状态：群组已归档，点击将秒速直发！</b>' : ''}
请选择音质、交付文件格式与歌词选项：`;

  const inlineKeyboard = [];

  const row1 = [];
  row1.push({
    text: `🎧 ${isEn ? 'Lossless' : '无损 Lossless'} ${selectedQuality === 'Lossless' ? '✅' : ''}`,
    callback_data: `q:Lossless:${details.songId}`
  });
  if (details.traits.hires) {
    row1.push({
      text: `💎 ${isEn ? 'Hi-Res' : '高解析 Hi-Res'} ${selectedQuality === 'Hi-Res' ? '✅' : ''}`,
      callback_data: `q:Hi-Res:${details.songId}`
    });
  }
  inlineKeyboard.push(row1);

  const row2 = [];
  if (details.traits.atmos) {
    row2.push({
      text: `🌌 ${isEn ? 'Dolby Atmos' : '杜比全景声'} ${selectedQuality === 'Atmos' ? '✅' : ''}`,
      callback_data: `q:Atmos:${details.songId}`
    });
  }
  row2.push({
    text: `⚡ AAC 256k ${selectedQuality === 'AAC' ? '✅' : ''}`,
    callback_data: `q:AAC:${details.songId}`
  });
  inlineKeyboard.push(row2);

  inlineKeyboard.push([
    {
      text: isEn
        ? (isZip ? '📦 Delivery: Single ZIP (Song + Lyrics) ✅' : '🎵 Delivery: Single Audio (.m4a Native) ✅')
        : (isZip ? '📦 交付格式: ZIP 压缩包 (歌曲+歌词合为一个消息) ✅' : '🎵 交付格式: 独立音频 (.m4a 原生播放器) ✅'),
      callback_data: `fmt:${isZip ? 'audio' : 'zip'}:${details.songId}`
    }
  ]);

  inlineKeyboard.push([
    {
      text: isEn
        ? `📝 Separate Lyrics (.lrc): ${needLrc ? 'Yes ✅' : 'No ❌'}`
        : `📝 独立歌词 (.lrc): ${needLrc ? '需要 ✅' : '不需要 ❌'}`,
      callback_data: `lrc:${needLrc ? '0' : '1'}:${details.songId}`
    }
  ]);

  inlineKeyboard.push([
    {
      text: isCached
        ? (isEn ? '⚡ Instant Delivery (0s push)' : '⚡ 库内秒传 (0秒推送)')
        : (isEn ? '🚀 Confirm Download & Push' : '🚀 确认下载并推送'),
      callback_data: `dl:${details.songId}`
    }
  ]);

  // 返回上一级按钮 (支持专辑曲目列表 / 艺人热门歌曲两种来源)
  if (backAlbumId && String(backAlbumId).startsWith('art_')) {
    const artistId = String(backAlbumId).slice(4);
    inlineKeyboard.push([
      {
        text: isEn ? '🔙 Back to Artist Top Songs' : '🔙 返回艺人热门歌曲',
        callback_data: `art_songs:${artistId}`
      }
    ]);
  } else {
    const targetAlbumId = backAlbumId || details.albumId;
    if (targetAlbumId) {
      inlineKeyboard.push([
        {
          text: isEn ? '🔙 Back to Album Tracklist' : '🔙 返回专辑曲目列表',
          callback_data: `ashow:${targetAlbumId}`
        }
      ]);
    }
  }

  return { text, reply_markup: { inline_keyboard: inlineKeyboard } };
}

function buildAlbumCard(albumData, selectedQuality = 'Lossless', needLrc = true, deliveryMode = 'zip', lang = 'zh', isOwner = false, backArtistId = null) {
  const isEn = lang === 'en';
  const isPl = albumData.isPlaylist === true;
  const cacheKey = `album_${albumData.albumId}_${selectedQuality.toLowerCase()}_${deliveryMode}`;
  const isCached = Boolean(db.get(cacheKey));

  const typeLabel = isPl ? (isEn ? 'Playlist' : '歌单') : (isEn ? 'Album' : '专辑');
  const text = isEn ?
`💿 <b>${typeLabel} Batch: ${escapeHtml(albumData.name)}</b>
👤 <b>${isPl ? 'Curator' : 'Artist'}:</b> ${escapeHtml(albumData.artistName)}
📅 <b>Release Date:</b> ${albumData.releaseDate || 'Unknown'}
🎵 <b>Total Tracks:</b> <b>${albumData.tracks.length}</b> tracks
${isCached ? '\n⚡ <b>Status: Fully archived in library, tap for instant delivery!</b>' : ''}
${isOwner ? 'Select options to download full album or individual tracks below:' : 'Please tap [View & Pick Individual Tracks] below to select tracks to download:'}` :
`💿 <b>${typeLabel}全辑转存：${escapeHtml(albumData.name)}</b>
👤 <b>${isPl ? '歌单作者' : '艺人'}：</b>${escapeHtml(albumData.artistName)}
📅 <b>发行时间：</b>${albumData.releaseDate || '未知'}
🎵 <b>曲目总数：</b>共 <b>${albumData.tracks.length}</b> 首歌曲
${isCached ? '\n⚡ <b>状态：该全辑已完整归档，点击将秒速直发！</b>' : ''}
${isOwner ? '您可以一键下载整张专辑，或点击【展开单曲】单独选择单曲：' : '普通用户请点击【查看与单独点选单曲】选择您想下载的单曲：'}`;

  const inlineKeyboard = [];

  inlineKeyboard.push([
    {
      text: `🎧 ${isEn ? 'Lossless' : '无损 Lossless'} ${selectedQuality === 'Lossless' ? '✅' : ''}`,
      callback_data: `aq:Lossless:${albumData.albumId}`
    },
    {
      text: `⚡ AAC 256k ${selectedQuality === 'AAC' ? '✅' : ''}`,
      callback_data: `aq:AAC:${albumData.albumId}`
    }
  ]);

  if (isOwner) {
    inlineKeyboard.push([
      {
        text: deliveryMode === 'zip'
          ? (isEn ? '📦 Mode: Single ZIP Archive ✅' : '📦 交付模式: 全辑单 ZIP (合为一个文件消息) ✅')
          : (isEn ? '🎵 Mode: MediaGroup Playlist Bubbles ✅' : '🎵 交付模式: 原生音频合辑 (MediaGroup 组合消息) ✅'),
        callback_data: `afmt:${deliveryMode === 'zip' ? 'media' : 'zip'}:${albumData.albumId}`
      }
    ]);

    inlineKeyboard.push([
      {
        text: isEn
          ? `📝 Separate Lyrics (.lrc): ${needLrc ? 'Yes ✅' : 'No ❌'}`
          : `📝 包含独立歌词 (.lrc): ${needLrc ? '需要 ✅' : '不需要 ❌'}`,
        callback_data: `alrc:${needLrc ? '0' : '1'}:${albumData.albumId}`
      }
    ]);

    inlineKeyboard.push([
      {
        text: isCached
          ? (isEn ? '⚡ Instant Delivery (0s push)' : '⚡ 全辑秒传 (0秒推送)')
          : (isEn ? `🚀 Download Full ${typeLabel} (${albumData.tracks.length} tracks)` : `🚀 一键下载整张${typeLabel} (${albumData.tracks.length}首)`),
        callback_data: `adl:${albumData.albumId}`
      }
    ]);
  } else {
    // 非站长用户：给出明确权限提示
    inlineKeyboard.push([
      {
        text: isEn
          ? '🔒 Full Download (Admin Only)'
          : '🔒 全辑下载为站长专属特权',
        callback_data: `anotowner:${albumData.albumId}`
      }
    ]);
  }

  // 展开单曲点选按钮
  inlineKeyboard.push([
    {
      text: isEn ? '📜 View & Pick Individual Tracks ⬇️' : '📜 查看与单独点选单曲 ⬇️',
      callback_data: `ashow:${albumData.albumId}`
    }
  ]);

  // 从艺人专辑列表进入时，提供返回艺人专辑列表按钮
  if (backArtistId) {
    inlineKeyboard.push([
      {
        text: isEn ? '🔙 Back to Artist Albums' : '🔙 返回艺人专辑列表',
        callback_data: `art_albums:${backArtistId}`
      }
    ]);
  }

  return { text, reply_markup: { inline_keyboard: inlineKeyboard } };
}

// ==================== 单曲下载、归档与直发 ====================
async function handleDownload(chatId, messageId, details, quality, needLrc, isZip) {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const songId = details.songId;
  const cacheKey = `${songId}_${quality.toLowerCase()}_${isZip ? 'zip' : 'audio'}`;
  const cached = db.get(cacheKey);

  // 1. 命中缓存秒传 (0秒直发，完全无需进入排队队列)
  if (cached && (cached.groupMsgId || (isZip && cached.zipFileId) || (!isZip && cached.audioFileId))) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚡ <b>Archived track matched, sending instantly...</b>\n🎵 ${escapeHtml(cached.title)} - ${escapeHtml(cached.artist)}`
        : `⚡ <b>命中已归档曲目，正在为您秒速直发...</b>\n🎵 ${escapeHtml(cached.title)} - ${escapeHtml(cached.artist)}`,
      parse_mode: 'HTML'
    });

    const artistTag = sanitizeHashtag(cached.artist);
    const titleTag = sanitizeHashtag(cached.title);
    const albumTag = sanitizeHashtag(cached.album);

    let copySuccess = false;
    try {
      if (cached.groupMsgId) {
        await tgCall('copyMessage', {
          chat_id: chatId,
          from_chat_id: AUTHORIZED_GROUP_ID,
          message_id: cached.groupMsgId
        });
        if (needLrc && (cached.lrcGroupMsgId || cached.lrcFileId)) {
          try {
            if (cached.lrcGroupMsgId) {
              await tgCall('copyMessage', {
                chat_id: chatId,
                from_chat_id: AUTHORIZED_GROUP_ID,
                message_id: cached.lrcGroupMsgId
              });
            } else if (cached.lrcFileId) {
              await tgCall('sendDocument', {
                chat_id: chatId,
                document: cached.lrcFileId,
                caption: safeCaption(`📝 ${escapeHtml(cached.artist)} - ${escapeHtml(cached.title)}.lrc`)
              });
            }
          } catch {}
        }
        copySuccess = true;
      } else if (isZip && cached.zipFileId) {
        const zipCaption = safeCaption(
`📦 <b>${escapeHtml(cached.title)} [ZIP]</b>
👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(cached.artist)}
💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(cached.album)}
🎧 ${isEn ? 'Format:' : '规格：'}${escapeHtml(cached.qualityName || quality)}

${artistTag} ${titleTag} ${albumTag} #ZIP`);

        await tgCall('sendDocument', {
          chat_id: chatId,
          document: cached.zipFileId,
          caption: zipCaption,
          parse_mode: 'HTML'
        });
        copySuccess = true;
      } else {
        const audioCaption = safeCaption(
`🎵 <b>${escapeHtml(cached.title)}</b>
👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(cached.artist)}
💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(cached.album)}
🎧 ${isEn ? 'Format:' : '规格：'}${escapeHtml(cached.qualityName || quality)}

${artistTag} ${titleTag} ${albumTag}`);

        const audioMsg = await tgCall('sendAudio', {
          chat_id: chatId,
          audio: cached.audioFileId,
          caption: audioCaption,
          parse_mode: 'HTML',
          title: cached.title,
          performer: cached.artist
        });

        if (needLrc && cached.lrcFileId) {
          await tgCall('sendDocument', {
            chat_id: chatId,
            document: cached.lrcFileId,
            caption: safeCaption(`📝 ${escapeHtml(cached.artist)} - ${escapeHtml(cached.title)}.lrc`),
            reply_to_message_id: audioMsg.message_id
          });
        }
        copySuccess = true;
      }
    } catch (cacheErr) {
      console.warn(`[Cache] 归档群消息 (${cached.groupMsgId || cached.audioFileId}) 已失效或在群聊中被删除 (${cacheErr.message})，自动清除该缓存并重新从 Apple Music 下载！`);
      db.delete(cacheKey);
      copySuccess = false;
    }

    if (copySuccess) {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn ? `🎉 <b>Delivered!</b> File sent directly to your chat.` : `🎉 <b>秒传推送完成！</b> 已将文件直接发送给您。`,
        parse_mode: 'HTML'
      });
      return;
    }
  }
  // 检查讨论组/普通用户单曲下载配额 (作者专属账号 100% 豁免)
  const quotaCheck = quotaManager.checkQuota(chatId, false);
  if (!quotaCheck.ok) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚠️ <b>Daily single track download quota reached (${quotaCheck.current}/${quotaCheck.max})</b>\n\nTo ensure fair use and bandwidth safety, non-admin users have a daily quota of ${quotaCheck.max} songs.\n\n⏰ Resets daily at midnight (UTC+8).\n💡 <b>Tip</b>: Archived songs from library do NOT count towards quota!`
        : `⚠️ <b>您今日的单曲下载配额已达上限 (${quotaCheck.current}/${quotaCheck.max} 首)</b>\n\n为了保障小讨论组共享公平与 VPS 带宽安全，非特权用户每日限额下载 ${quotaCheck.max} 首全新单曲。\n\n⏰ <b>配额刷新时间</b>：北京时间每日午夜 00:00 自动重置，明日即可恢复使用。\n💡 <b>免配额小贴士</b>：所有已归档曲目均支持秒传直发，<b>秒传不计入任何配额</b>，欢迎随时取用！`,
      parse_mode: 'HTML'
    });
    return;
  }

  // 2. 加入机器人全局任务排队队列 (Task-Level FIFO，严格串行处理)
  return botTaskQueue.enqueue(
    { chatId, messageId, type: 'song', name: details.title },
    async () => {
      const taskStartTime = performance.now();
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn
          ? `⏳ <b>Fetching audio stream & injecting metadata from Apple Music...</b>\n🎵 ${escapeHtml(details.title)} - ${escapeHtml(details.artist)} [${quality}]`
          : `⏳ <b>正在从 Apple Music 抓取无损流并注入元数据标签...</b>\n🎵 ${escapeHtml(details.title)} - ${escapeHtml(details.artist)} [${quality}]`,
        parse_mode: 'HTML'
      });

      const payload = {
        adamId: songId,
        quality: quality,
        meta: {
          title: details.title,
          artist: details.artist,
          album: details.album,
          albumArtist: details.albumArtist,
          date: details.releaseDate,
          genre: details.genre,
          composer: details.composer,
          trackNumber: details.trackNumber,
          discNumber: details.discNumber,
          coverUrl: details.coverUrl,
          durationInMillis: details.durationInMillis
        },
        saveLrc: needLrc,
        embedLyrics: true,
        zip: Boolean(isZip),
        noUpload: true
      };

      let transferResult;
      try {
        const res = await fetch(CLOUD_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(180000)
        });
        const data = await res.json();
        if (data.status !== 'ok' || !data.data) {
          throw new Error(data.error || '解析中枢返回异常');
        }
        transferResult = data.data;
      } catch (err) {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn ? `❌ <b>Download or processing failed:</b> ${escapeHtml(err.message)}` : `❌ <b>下载或处理失败:</b> ${escapeHtml(err.message)}`,
          parse_mode: 'HTML'
        });
        return;
      }

      const { isZip: resIsZip, zipFilePath, zipFileName, audioFilePath, lrcFilePath, thumbFilePath, fileName, lyricsFileName, fileSize, artist, title, album, qualityName, duration } = transferResult;

      // 上传归档至指定的授权群组/频道并推送到私聊
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn
          ? `🚀 <b>Audio processed, archiving via official Local Bot API and pushing to chat...</b>`
          : `🚀 <b>音源处理完成，正在通过官方 Local Bot API 专线归档并推送到私聊...</b>`,
        parse_mode: 'HTML'
      });

      const artistTag = sanitizeHashtag(artist);
      const titleTag = sanitizeHashtag(title);
      const albumTag = sanitizeHashtag(album);

      let sendResult = null;

      try {
        if (resIsZip && zipFilePath) {
          const zipCaption = safeCaption(
`📦 <b>${escapeHtml(title)} [ZIP]</b>
👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(artist)}
💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(album)}
🎧 ${isEn ? 'Format:' : '规格：'}${escapeHtml(qualityName || quality)}

${artistTag} ${titleTag} ${albumTag} #ZIP`);

          sendResult = await unifiedSendMedia({
            chatId,
            filePath: zipFilePath,
            fileName: zipFileName,
            caption: zipCaption,
            isZip: true,
            isAudio: false
          });

          db.set(cacheKey, {
            adamId: songId,
            quality: quality,
            isZip: true,
            groupMsgId: sendResult.groupMsgId,
            channelMsgId: sendResult.groupMsgId,
            zipFileId: sendResult.fileId || null,
            artist,
            title,
            album,
            qualityName,
            createdAt: Date.now()
          });

        } else {
          const audioCaption = safeCaption(
`🎵 <b>${escapeHtml(title)}</b>
👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(artist)}
💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(album)}
🎧 ${isEn ? 'Format:' : '规格：'}${escapeHtml(qualityName || quality)}

${artistTag} ${titleTag} ${albumTag}`);

          sendResult = await unifiedSendMedia({
            chatId,
            filePath: audioFilePath,
            fileName: fileName,
            thumbPath: thumbFilePath || null,
            caption: audioCaption,
            isAudio: true,
            isZip: false,
            title: title,
            performer: artist,
            duration: duration || Math.round((details.durationInMillis || 0) / 1000)
          });

          let lrcFileId = null;
          let lrcGroupMsgId = null;
          if (needLrc && lrcFilePath && fs.existsSync(lrcFilePath)) {
            try {
              const lrcCaption = safeCaption(`📝 <b>${escapeHtml(title)}</b> - ${isEn ? 'Lyrics' : '歌词'}\n${artistTag} ${titleTag}`);
              const lrcResult = await unifiedSendMedia({
                chatId,
                filePath: lrcFilePath,
                fileName: lyricsFileName || `${artist} - ${title}.lrc`,
                caption: lrcCaption,
                isAudio: false,
                isZip: false,
                replyToMessageId: sendResult.groupMsgId
              });
              lrcGroupMsgId = lrcResult.groupMsgId;
              lrcFileId = lrcResult.fileId || null;
            } catch (lrcErr) {
              console.warn('[TG-Bot] 歌词发送失败 (非致命):', lrcErr.message);
            }
          }

          db.set(cacheKey, {
            adamId: songId,
            quality: quality,
            isZip: false,
            groupMsgId: sendResult.groupMsgId,
            channelMsgId: sendResult.groupMsgId,
            audioFileId: sendResult.fileId || null,
            lrcFileId: lrcFileId,
            lrcGroupMsgId: lrcGroupMsgId,
            artist,
            title,
            album,
            qualityName,
            createdAt: Date.now()
          });
        }

        const totalDurationSec = ((performance.now() - taskStartTime) / 1000).toFixed(1);
        const statsText = sendResult?.durationSec ? (
          isEn
            ? `\n\n📊 <b>Performance Stats:</b>\n• File Size: <code>${sendResult.sizeMb} MB</code>\n• Upload Time: <code>${sendResult.durationSec}s</code> (Speed: <code>${sendResult.speedMbS} MB/s</code>)\n• Total Elapsed: <code>${totalDurationSec}s</code>\n• Dedicated Tunnel: <code>Official Local Bot API</code>`
            : `\n\n📊 <b>性能统计：</b>\n• 文件大小：<code>${sendResult.sizeMb} MB</code>\n• 上传耗时：<code>${sendResult.durationSec} 秒</code> (速度: <code>${sendResult.speedMbS} MB/s</code>)\n• 全程总耗时：<code>${totalDurationSec} 秒</code>\n• 传输通道：<code>官方 Local Bot API 专线</code>`
        ) : '';

        quotaManager.incrementQuota(chatId, false);

        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `🎉 <b>Transfer complete!</b>\nDirectly delivered via official Local Bot API.${statsText}`
            : `🎉 <b>转存完成！</b>\n已通过官方 Local Bot API 专线为您直发。${statsText}`,
          parse_mode: 'HTML'
        });

      } catch (err) {
        console.error('[TG-Bot] 单曲转存处理异常:', err);
        try {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn ? `❌ <b>Transfer processing failed:</b> ${escapeHtml(err.message)}` : `❌ <b>转存处理失败:</b> ${escapeHtml(err.message)}`,
            parse_mode: 'HTML'
          });
        } catch {}
      } finally {
        try {
          if (zipFilePath) fs.rmSync(zipFilePath, { force: true });
          if (audioFilePath) {
            const dir = path.dirname(audioFilePath);
            if (dir.includes('am_tg_')) {
              fs.rmSync(dir, { recursive: true, force: true });
            }
          }
        } catch {}
      }
    }
  );
}

// ==================== 全专辑下载与合并消息发送 ====================
async function handleAlbumDownload(chatId, messageId, albumData, quality, needLrc, deliveryMode) {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const albumId = albumData.albumId;
  const isPl = albumData.isPlaylist === true;
  const typeLabel = isPl ? (isEn ? 'Playlist' : '歌单') : (isEn ? 'Album' : '专辑');
  const cacheKey = `album_${albumId}_${quality.toLowerCase()}_${deliveryMode}`;
  const cached = db.get(cacheKey);

  // 1. 命中全辑缓存秒传 (直接直发，无需进入排队队列)
  if (cached && (
    (deliveryMode === 'zip' && (cached.groupMsgId || cached.zipFileId)) ||
    (deliveryMode !== 'zip' && (cached.groupMsgIds?.length || cached.audioFileIds?.length))
  )) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚡ <b>Archived ${typeLabel.toLowerCase()} matched, sending instantly...</b>\n💿 ${escapeHtml(cached.albumName)} - ${escapeHtml(cached.artistName)}`
        : `⚡ <b>命中已归档全辑，正在为您秒速直发...</b>\n💿 ${escapeHtml(cached.albumName)} - ${escapeHtml(cached.artistName)}`,
      parse_mode: 'HTML'
    });

    const artistTag = sanitizeHashtag(cached.artistName);
    const albumTag = sanitizeHashtag(cached.albumName);

    let albumCopySuccess = false;
    try {
      if (deliveryMode === 'zip') {
        if (cached.groupMsgId) {
          await tgCall('copyMessage', {
            chat_id: chatId,
            from_chat_id: AUTHORIZED_GROUP_ID,
            message_id: cached.groupMsgId
          });
          albumCopySuccess = true;
        } else if (cached.zipFileId) {
          await tgCall('sendDocument', {
            chat_id: chatId,
            document: cached.zipFileId,
            caption: safeCaption(`📦 <b>${escapeHtml(cached.albumName)} [${typeLabel}ZIP]</b>\n👤 ${isEn ? 'Artist' : '艺人'}: ${escapeHtml(cached.artistName)}\n${artistTag} ${albumTag} #${typeLabel}ZIP`),
            parse_mode: 'HTML'
          });
          albumCopySuccess = true;
        }
      } else if (cached.groupMsgIds && Array.isArray(cached.groupMsgIds)) {
        await tgCall('copyMessages', {
          chat_id: chatId,
          from_chat_id: AUTHORIZED_GROUP_ID,
          message_ids: cached.groupMsgIds
        });
        albumCopySuccess = true;
      } else if (cached.audioFileIds && Array.isArray(cached.audioFileIds)) {
        for (let i = 0; i < cached.audioFileIds.length; i += 10) {
          const chunk = cached.audioFileIds.slice(i, i + 10);
          if (chunk.length === 1) {
            await tgCall('sendAudio', {
              chat_id: chatId,
              audio: chunk[0],
              caption: safeCaption(`💿 <b>${escapeHtml(cached.albumName)} (${isEn ? 'Track ' : '第 '}${i + 1}${isEn ? '' : ' 首'})</b>\n${artistTag} ${albumTag}`),
              parse_mode: 'HTML'
            });
          } else {
            const mediaGroup = chunk.map((fid, idx) => ({
              type: 'audio',
              media: fid,
              caption: idx === 0 ? safeCaption(`💿 <b>${escapeHtml(cached.albumName)} (${i + 1}-${i + chunk.length})</b>\n${artistTag} ${albumTag}`) : undefined,
              parse_mode: 'HTML'
            }));
            await tgCall('sendMediaGroup', {
              chat_id: chatId,
              media: mediaGroup
            });
          }
        }
        albumCopySuccess = true;
      }
    } catch (albumCacheErr) {
      console.warn(`[Cache] 全辑归档消息 (${cached.groupMsgId}) 已失效或在群聊中被删除 (${albumCacheErr.message})，自动清除该缓存并重新从 Apple Music 下载！`);
      db.delete(cacheKey);
      albumCopySuccess = false;
    }

    if (albumCopySuccess) {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn ? `🎉 <b>Instant ${typeLabel.toLowerCase()} delivery complete!</b>` : `🎉 <b>全辑秒传推送完成！</b>`,
        parse_mode: 'HTML'
      });
      return;
    }
  }
  // 检查讨论组/普通用户专辑下载配额 (作者专属账号 100% 豁免)
  const quotaCheck = quotaManager.checkQuota(chatId, true);
  if (!quotaCheck.ok) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚠️ <b>Daily ${typeLabel.toLowerCase()} download quota reached (${quotaCheck.current}/${quotaCheck.max})</b>`
        : `⚠️ <b>您今日的专辑下载配额已达上限 (${quotaCheck.current}/${quotaCheck.max} 张)</b>\n\n为了保障小讨论组共享公平与 VPS 带宽安全，非特权用户每日限额下载 ${quotaCheck.max} 张全新专辑。\n\n⏰ <b>配额刷新时间</b>：北京时间每日午夜 00:00 自动重置，明日即可恢复使用。\n💡 <b>免配额小贴士</b>：所有已归档专辑均支持秒传直发，<b>秒传不计入任何配额</b>，欢迎随时取用！`,
      parse_mode: 'HTML'
    });
    return;
  }

  // 2. 加入机器人全局任务排队队列 (Task-Level FIFO，前序专辑彻底交付后才会开始)
  return botTaskQueue.enqueue(
    { chatId, messageId, type: 'album', name: albumData.name },
    async () => {
      const totalTracks = albumData.tracks.length;
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn
          ? `⏳ <b>Starting ${typeLabel.toLowerCase()} transfer (Total ${totalTracks} tracks)...</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`
          : `⏳ <b>开始转存整张专辑 (共 ${totalTracks} 首)...</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`,
        parse_mode: 'HTML'
      });

      const albumStartTime = performance.now();
      const batchId = `album_${albumId}_${Date.now()}`;
      const allDownloadedFiles = [];
      const skippedTracks = [];
      const isLocalApi = TG_API_BASE.includes('127.0.0.1') || TG_API_BASE.includes('localhost');
      const artistTag = sanitizeHashtag(albumData.artistName);
      const albumTag = sanitizeHashtag(albumData.name);

      try {
        if (deliveryMode === 'zip') {
          // 3.A 全辑单个 ZIP 模式：并发下载所有单曲，然后打包并零拷贝极速直传
          let completedCount = 0;
          await pMap(albumData.tracks, 2, async (track, i) => {
            const trackOrder = i + 1;
            const payload = {
              adamId: track.id,
              quality: quality,
              meta: {
                title: track.name,
                artist: track.artistName || albumData.artistName,
                album: albumData.name,
                albumArtist: albumData.artistName,
                trackNumber: track.trackNumber || trackOrder,
                totalTracks: totalTracks,
                coverUrl: albumData.coverUrl
              },
              batchId: batchId,
              isLastTrack: false,
              saveLrc: needLrc,
              embedLyrics: true,
              noUpload: true
            };

            for (let retry = 0; retry < 2; retry++) {
              try {
                const res = await fetch(CLOUD_API, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                  signal: AbortSignal.timeout(180000)
                });
                const data = await res.json();
                if (data.status !== 'ok' || !data.data) {
                  throw new Error(data.error || '解析异常');
                }
                allDownloadedFiles.push({ ...data.data, track, orderIndex: trackOrder });
                completedCount++;
                try {
                  await tgCall('editMessageText', {
                    chat_id: chatId,
                    message_id: messageId,
                    text: `⏳ <b>正在高速打包全辑 [${completedCount}/${totalTracks}]</b>\n🎵 ${escapeHtml(track.name)}${skippedTracks.length ? `\n(已跳过 ${skippedTracks.length} 首不可用歌曲)` : ''}`,
                    parse_mode: 'HTML'
                  });
                } catch {}
                break;
              } catch (trackErr) {
                if (retry === 0) {
                  console.warn(`[TG-Bot] 专辑曲目 [${trackOrder}/${totalTracks}] ${track.name} 下载异常，1.5秒后重试: ${trackErr.message}`);
                  await new Promise(r => setTimeout(r, 1500));
                } else {
                  console.warn(`[TG-Bot] 专辑曲目 [${trackOrder}/${totalTracks}] 下载跳过:`, track.name, trackErr.message);
                  skippedTracks.push({ track, error: trackErr.message });
                }
              }
            }
          });

          if (allDownloadedFiles.length === 0) {
            throw new Error(`整张专辑的所有曲目均在当前地区无版权或下载失败，无法转存。`);
          }

          allDownloadedFiles.sort((a, b) => a.orderIndex - b.orderIndex);

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `⏳ <b>Packaging ${allDownloadedFiles.length} downloaded tracks into ${typeLabel.toLowerCase()} ZIP archive...</b>`
              : `⏳ <b>正在将成功下载的 ${allDownloadedFiles.length} 首曲目打包为全辑 ZIP 压缩包...</b>`,
            parse_mode: 'HTML'
          });

          const finRes = await fetch(CLOUD_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              finalizeBatch: true,
              batchId: batchId,
              quality: quality,
              meta: {
                album: albumData.name,
                artist: albumData.artistName
              },
              zipFilename: `${albumData.artistName} - ${albumData.name}.zip`,
              noUpload: true
            }),
            signal: AbortSignal.timeout(180000)
          });
          const finData = await finRes.json();
          if (finData.status !== 'ok' || !finData.data) {
            throw new Error(`封装全辑 ZIP 失败: ${finData.error || '未知错误'}`);
          }

          const zipPath = finData.data.zipFilePath;
          const zipName = finData.data.zipFileName || `${albumData.artistName} - ${albumData.name}.zip`;
          const zipStat = fs.statSync(zipPath);
          const zipSizeMb = (zipStat.size / (1024 * 1024)).toFixed(1);

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `🚀 <b>${typeLabel} ZIP ready (${zipSizeMb} MB), archiving via official Local Bot API...</b>`
              : `🚀 <b>全辑 ZIP 封装就绪 (${zipSizeMb} MB)，正在通过官方 Local Bot API 专线归档并推送...</b>`,
            parse_mode: 'HTML'
          });

          const zipCaption = safeCaption(
`📦 <b>${escapeHtml(albumData.name)} [${typeLabel}ZIP]</b>
👤 ${isEn ? 'Artist' : '艺人'}：${escapeHtml(albumData.artistName)}
🎵 ${isEn ? 'Tracks' : '曲目数'}：共 ${allDownloadedFiles.length} 首${skippedTracks.length ? ` (已跳过 ${skippedTracks.length} 首无版权歌曲)` : ''}
🎧 ${isEn ? 'Format' : '规格'}：${escapeHtml(quality)}

${artistTag} ${albumTag} #${typeLabel}ZIP`);

          const sendResult = await unifiedSendMedia({
            chatId,
            filePath: zipPath,
            fileName: zipName,
            caption: zipCaption,
            isZip: true,
            isAudio: false
          });

          db.set(cacheKey, {
            albumId,
            albumName: albumData.name,
            artistName: albumData.artistName,
            quality,
            groupMsgId: sendResult.groupMsgId,
            zipFileId: sendResult.fileId || null,
            totalTracks: allDownloadedFiles.length,
            createdAt: Date.now()
          });

          quotaManager.incrementQuota(chatId, true);

          const totalDurationSec = ((performance.now() - albumStartTime) / 1000).toFixed(1);
          const statsText = sendResult?.durationSec ? (
            isEn
              ? `\n\n📊 <b>Performance Stats:</b>\n• Total Size: <code>${sendResult.sizeMb || zipSizeMb} MB</code> (${allDownloadedFiles.length} tracks)\n• Official Upload Time: <code>${sendResult.durationSec}s</code> (Speed: <code>${sendResult.speedMbS} MB/s</code>)\n• Total Elapsed: <code>${totalDurationSec}s</code>\n• Dedicated Tunnel: <code>Official Local Bot API (Zero-Copy)</code>`
              : `\n\n📊 <b>全辑性能统计：</b>\n• 全辑体积：<code>${sendResult.sizeMb || zipSizeMb} MB</code> (共 ${allDownloadedFiles.length} 首)\n• 官方上传耗时：<code>${sendResult.durationSec} 秒</code> (速度: <code>${sendResult.speedMbS} MB/s</code>)\n• 全辑总耗时：<code>${totalDurationSec} 秒</code>\n• 传输通道：<code>官方 Local Bot API 专线 (零拷贝极速通道)</code>`
          ) : '';

          const skipNote = skippedTracks.length ? (
            isEn
              ? `\n\n⚠️ Note: ${skippedTracks.length} tracks skipped due to regional copyright restrictions.`
              : `\n\n⚠️ 注：有 ${skippedTracks.length} 首歌曲因地区版权未收录。`
          ) : '';
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `🎉 <b>Full ${typeLabel.toLowerCase()} transfer complete!</b>\nDelivered as a single ZIP archive file.${skipNote}${statsText}`
              : `🎉 <b>全辑转存完成！</b>\n整张专辑已打包为单个 ZIP 文件消息推送给您。${skipNote}${statsText}`,
            parse_mode: 'HTML'
          });
          return;
        }

        // 3.B 原生音频合辑 (MediaGroup 播放列表组合消息，黄金平衡规划 + 流水线预取)
        const chunkPlans = planAlbumChunks(totalTracks);
        const allGroupMsgIds = [];
        let trackOffset = 0;
        let lastChannelSendTime = 0;

        // 预先规划各分组曲目元信息
        const chunkTrackGroups = [];
        for (let i = 0; i < chunkPlans.length; i++) {
          const size = chunkPlans[i];
          const tracks = albumData.tracks.slice(trackOffset, trackOffset + size);
          chunkTrackGroups.push({
            chunkIdx: i,
            chunkSize: size,
            tracks: tracks,
            startNum: trackOffset + 1,
            endNum: trackOffset + tracks.length
          });
          trackOffset += size;
        }

        // 单组曲目下载器 (双线程并发拉取与解密)
        const downloadChunkTracks = async (group) => {
          const chunkFiles = [];
          await pMap(group.tracks, 2, async (track, relIdx) => {
            const globalIdx = group.startNum + relIdx;
            const payload = {
              adamId: track.id,
              quality: quality,
              meta: {
                title: track.name,
                artist: track.artistName || albumData.artistName,
                album: albumData.name,
                albumArtist: albumData.artistName,
                trackNumber: track.trackNumber || globalIdx,
                totalTracks: totalTracks,
                coverUrl: albumData.coverUrl
              },
              isLastTrack: false,
              saveLrc: needLrc,
              embedLyrics: true,
              noUpload: true
            };

            for (let retry = 0; retry < 2; retry++) {
              try {
                const res = await fetch(CLOUD_API, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                  signal: AbortSignal.timeout(180000)
                });
                const data = await res.json();
                if (data.status !== 'ok' || !data.data) {
                  throw new Error(data.error || '解析异常');
                }
                const fileObj = { ...data.data, track, orderIndex: globalIdx };
                chunkFiles.push(fileObj);
                // 实时登记到全生命周期文件列表，确保异常终止时 finally 能 100% 完整清理
                allDownloadedFiles.push(fileObj);
                break;
              } catch (trackErr) {
                if (retry === 0) {
                  console.warn(`[TG-Bot] 专辑曲目 [${globalIdx}/${totalTracks}] ${track.name} 下载异常，1.5秒后重试: ${trackErr.message}`);
                  await new Promise(r => setTimeout(r, 1500));
                } else {
                  console.warn(`[TG-Bot] 专辑曲目 [${globalIdx}/${totalTracks}] 下载跳过:`, track.name, trackErr.message);
                  skippedTracks.push({ track, error: trackErr.message });
                }
              }
            }
          });
          chunkFiles.sort((a, b) => a.orderIndex - b.orderIndex);
          return chunkFiles;
        };

        // 流水线初始化：预先发起第 1 组曲目下载
        let nextDownloadPromise = chunkTrackGroups.length > 0 ? downloadChunkTracks(chunkTrackGroups[0]) : null;

        for (let chunkIdx = 0; chunkIdx < chunkTrackGroups.length; chunkIdx++) {
          const group = chunkTrackGroups[chunkIdx];

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `⏳ <b>Batch downloading ${typeLabel.toLowerCase()} [Card #${chunkIdx + 1}/${chunkTrackGroups.length}] (${group.startNum}-${group.endNum}/${totalTracks})</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`
              : `⏳ <b>正在高速转存全辑 [第 ${chunkIdx + 1}/${chunkTrackGroups.length} 组卡片] (${group.startNum}-${group.endNum}/${totalTracks})</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`,
            parse_mode: 'HTML'
          });

          // 等待当前组下载就绪
          const chunkDownloadedFiles = await nextDownloadPromise;

          // 核心流水线优化：当前组下载完成后，立即在后台异步发起下一组的并发拉取！
          if (chunkIdx + 1 < chunkTrackGroups.length) {
            nextDownloadPromise = downloadChunkTracks(chunkTrackGroups[chunkIdx + 1]);
          } else {
            nextDownloadPromise = null;
          }

          if (chunkDownloadedFiles.length === 0) {
            console.warn(`[TG-Bot] 组 [${chunkIdx + 1}] 所有曲目下载失败，跳过该组归档`);
            continue;
          }

          // 自适应规避 Telegram 频道发送速率限制 (根据单包曲目数动态调节，每首 ~1.3s 令牌恢复)
          if (lastChannelSendTime > 0) {
            const elapsedSinceLastSend = Date.now() - lastChannelSendTime;
            const minIntervalMs = Math.min(Math.max(chunkDownloadedFiles.length * 1300, 5000), 10000);
            if (elapsedSinceLastSend < minIntervalMs) {
              const waitMs = minIntervalMs - elapsedSinceLastSend;
              console.log(`[TG-Bot] 距离上一组发送仅 ${(elapsedSinceLastSend / 1000).toFixed(1)}s，自适应等待 ${(waitMs / 1000).toFixed(1)}s 规避频道限流...`);
              await new Promise(r => setTimeout(r, waitMs));
            }
          }

          const chunkCaption = safeCaption(
`💿 <b>${escapeHtml(albumData.name)} (${group.startNum}-${group.endNum}/${totalTracks})</b>
👤 ${isEn ? 'Artist' : '艺人'}：${escapeHtml(albumData.artistName)}
🎧 ${isEn ? 'Format' : '规格'}：${escapeHtml(quality)}

${artistTag} ${albumTag} #${typeLabel}`);

          if (chunkDownloadedFiles.length === 1) {
            const f = chunkDownloadedFiles[0];
            const audioFields = {
              chat_id: AUTHORIZED_GROUP_ID,
              caption: chunkCaption,
              parse_mode: 'HTML',
              title: f.title,
              performer: f.artist || albumData.artistName,
              duration: f.duration || 0
            };
            if (f.thumbFilePath && fs.existsSync(f.thumbFilePath)) {
              audioFields.thumbnailPath = f.thumbFilePath;
            }
            const audioRes = await tgSendFile('sendAudio', 'audio', f.audioFilePath, f.fileName, audioFields);
            if (audioRes && audioRes.message_id) {
              allGroupMsgIds.push(audioRes.message_id);
            }
          } else {
            const mediaArray = [];
            const filesMap = {};

            chunkDownloadedFiles.forEach((f, idx) => {
              const attachKey = `audio_${idx}`;
              const thumbKey = `thumb_${idx}`;
              const itemObj = {
                type: 'audio',
                media: isLocalApi ? `file://${path.resolve(f.audioFilePath)}` : `attach://${attachKey}`,
                title: f.title,
                performer: f.artist || albumData.artistName,
                duration: f.duration || 0,
                ...(idx === 0 ? { caption: chunkCaption, parse_mode: 'HTML' } : {})
              };

              if (f.thumbFilePath && fs.existsSync(f.thumbFilePath)) {
                itemObj.thumbnail = isLocalApi ? `file://${path.resolve(f.thumbFilePath)}` : `attach://${thumbKey}`;
                filesMap[thumbKey] = {
                  filePath: f.thumbFilePath,
                  fileName: 'thumb.jpg'
                };
              }

              mediaArray.push(itemObj);
              filesMap[attachKey] = {
                filePath: f.audioFilePath,
                fileName: f.fileName
              };
            });

            let groupRes = null;
            try {
              groupRes = await tgSendMediaGroup(AUTHORIZED_GROUP_ID, mediaArray, filesMap);
            } catch (groupErr) {
              console.warn(`[TG-Bot] sendMediaGroup 失败，降级为逐首单曲上传: ${groupErr.message}`);
            }

            if (Array.isArray(groupRes) && groupRes.length > 0) {
              allGroupMsgIds.push(...groupRes.map(m => m.message_id));
            } else {
              console.log(`[TG-Bot] 正在逐首发送合辑曲目至频道 (${chunkDownloadedFiles.length} 首)...`);
              for (let trackIdx = 0; trackIdx < chunkDownloadedFiles.length; trackIdx++) {
                const f = chunkDownloadedFiles[trackIdx];
                const singleCaption = trackIdx === 0 ? chunkCaption : '';
                const audioFields = {
                  chat_id: AUTHORIZED_GROUP_ID,
                  ...(singleCaption ? { caption: singleCaption, parse_mode: 'HTML' } : {}),
                  title: f.title,
                  performer: f.artist || albumData.artistName,
                  duration: f.duration || 0
                };
                if (f.thumbFilePath && fs.existsSync(f.thumbFilePath)) {
                  audioFields.thumbnailPath = f.thumbFilePath;
                }
                try {
                  const audioRes = await tgSendFile('sendAudio', 'audio', f.audioFilePath, f.fileName, audioFields);
                  if (audioRes && audioRes.message_id) {
                    allGroupMsgIds.push(audioRes.message_id);
                  }
                  await new Promise(r => setTimeout(r, 2500));
                } catch (sendErr) {
                  console.error(`[TG-Bot] 逐首发送曲目 ${f.fileName} 失败: ${sendErr.message}`);
                }
              }
            }
          }

          lastChannelSendTime = Date.now();
        }

        if (allDownloadedFiles.length === 0) {
          throw new Error(`整张专辑的所有曲目均在当前地区无版权或下载失败，无法转存。`);
        }

        // 频道归档全部完成后，一次性将整张专辑的所有气泡/消息同步复制给私聊用户
        if (allGroupMsgIds.length > 0 && String(chatId) !== String(AUTHORIZED_GROUP_ID)) {
          console.log(`[TG-Bot] 频道全辑归档就绪 (${allGroupMsgIds.length} 首歌)，正在一次性同步推送到私聊...`);
          await new Promise(r => setTimeout(r, 1500));
          try {
            await tgCall('copyMessages', {
              chat_id: chatId,
              from_chat_id: AUTHORIZED_GROUP_ID,
              message_ids: allGroupMsgIds
            });
          } catch (copyAllErr) {
            console.warn(`[TG-Bot] copyMessages 批量复制失败，降级为逐首复制: ${copyAllErr.message}`);
            for (const mid of allGroupMsgIds) {
              await tgCall('copyMessage', {
                chat_id: chatId,
                from_chat_id: AUTHORIZED_GROUP_ID,
                message_id: mid
              });
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }

        if (allGroupMsgIds.length > 0) {
          db.set(cacheKey, {
            albumId,
            albumName: albumData.name,
            artistName: albumData.artistName,
            quality,
            groupMsgIds: allGroupMsgIds,
            totalTracks: allDownloadedFiles.length,
            createdAt: Date.now()
          });

          quotaManager.incrementQuota(chatId, true);

          const totalDurationSec = ((performance.now() - albumStartTime) / 1000).toFixed(1);
          const skipNote = skippedTracks.length ? (
            isEn
              ? `\n\n⚠️ Note: ${skippedTracks.length} tracks skipped due to regional copyright restrictions.`
              : `\n\n⚠️ 注：有 ${skippedTracks.length} 首歌曲因地区版权未收录。`
          ) : '';
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `🎉 <b>Full ${typeLabel.toLowerCase()} transfer complete!</b>\nAll tracks archived and pushed to your private chat as clean playlist bubbles (Total elapsed: <code>${totalDurationSec}s</code>).${skipNote}`
              : `🎉 <b>全辑转存完成！</b>\n整张专辑已作为统一播放列表合辑同步存入频道并推送到您的私聊 (总耗时: <code>${totalDurationSec}s</code>)。${skipNote}`,
            parse_mode: 'HTML'
          });
          return;
        }

      } catch (err) {
        console.error('[TG-Bot] 全辑下载处理异常:', err);
        try {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `❌ <b>${typeLabel} processing error:</b> ${escapeHtml(err.message)}`
              : `❌ <b>全辑处理遇到错误:</b> ${escapeHtml(err.message)}`,
            parse_mode: 'HTML'
          });
        } catch {}
      } finally {
        try {
          const sessionDir = `/tmp/am_sessions/${batchId}`;
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
        try {
          fs.rmSync(`/tmp/${batchId}.zip`, { force: true });
        } catch {}
        for (const f of allDownloadedFiles) {
          try {
            if (f.audioFilePath) fs.rmSync(path.dirname(f.audioFilePath), { recursive: true, force: true });
          } catch {}
        }
      }
    }
  );
}

// 展开单曲列表 (双列紧凑排版，最高可完整展示 100 首曲目，支持返回上级)
async function showAlbumTracks(chatId, albumData, lang = 'zh', messageId = null) {
  const isEn = lang === 'en';
  const tracks = albumData.tracks || [];
  const inlineKeyboard = [];

  for (let i = 0; i < tracks.length; i += 2) {
    const row = [];
    const t1 = tracks[i];
    const title1 = `${t1.trackNumber || (i + 1)}. ${t1.name || 'Track'}`;
    row.push({
      text: title1.length > 18 ? title1.slice(0, 16) + '..' : title1,
      callback_data: `pick:${t1.id}:${albumData.albumId}`
    });

    if (i + 1 < tracks.length) {
      const t2 = tracks[i + 1];
      const title2 = `${t2.trackNumber || (i + 2)}. ${t2.name || 'Track'}`;
      row.push({
        text: title2.length > 18 ? title2.slice(0, 16) + '..' : title2,
        callback_data: `pick:${t2.id}:${albumData.albumId}`
      });
    }
    inlineKeyboard.push(row);
  }

  // 底部增加 "🔙 返回专辑主菜单" 按钮
  inlineKeyboard.push([
    {
      text: isEn ? '🔙 Back to Album Menu' : '🔙 返回专辑主菜单',
      callback_data: `aback:${albumData.albumId}`
    }
  ]);

  const text = isEn
    ? `📜 <b>Album Tracks (${escapeHtml(albumData.name)}):</b>\nTotal ${tracks.length} tracks. Tap a track below to configure & download:`
    : `📜 <b>专辑曲目列表 (${escapeHtml(albumData.name)}):</b>\n共 ${tracks.length} 首，点击单曲可单独进入点歌下载：`;

  if (messageId) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard.slice(0, 52) }
    });
  } else {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard.slice(0, 52) }
    });
  }
}

// ==================== 权限与消息分发处理器 ====================
async function handleUpdate(update) {
  // 1. 群组安全巡逻: 严格限制仅允许作者账号将机器人拉入群聊
  if (update.my_chat_member) {
    const chat = update.my_chat_member.chat;
    const from = update.my_chat_member.from;
    const isOwner = String(from.id) === OWNER_USER_ID;

    if (!isOwner || String(chat.id) !== AUTHORIZED_GROUP_ID) {
      console.warn(`[Security] 拦截非作者 (${from.id}) 尝试拉入群聊 (${chat.id})，执行自动退群！`);
      try {
        await tgCall('sendMessage', {
          chat_id: chat.id,
          text: `⚠️ 本机器人为个人专属服务，仅允许作者本人 (ID: ${OWNER_USER_ID}) 进行群聊配置。即将自动退出。`
        });
      } catch {}
      try {
        await tgCall('leaveChat', { chat_id: chat.id });
      } catch {}
      return;
    }
  }

  // 2. 文本消息处理
  if (update.message && update.message.text) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const text = msg.text.trim();

    if ((chatType === 'group' || chatType === 'supergroup') && String(chatId) !== AUTHORIZED_GROUP_ID) {
      console.warn(`[Security] 收到外部未授权群聊消息 (${chatId})，执行安全退群`);
      try { await tgCall('leaveChat', { chat_id: chatId }); } catch {}
      return;
    }

    if (String(chatId) === AUTHORIZED_GROUP_ID) {
      if (text.startsWith('/') || text.includes('music.apple.com')) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '💡 <b>群聊仅作为音乐档案库浏览。</b>\n请私聊我发送歌曲或专辑链接进行点歌转存哦！',
          parse_mode: 'HTML'
        });
      }
      return;
    }

    if (chatType !== 'private') {
      return;
    }

    // 语言切换命令
    if (text === '/lang' || text === '/language') {
      const userLang = getUserLang(chatId, msg.from?.language_code);
      const t = I18N[userLang] || I18N.zh;
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: t.chooseLang || '🌐 <b>请选择您的显示语言 / Please choose your display language:</b>',
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🇨🇳 简体中文', callback_data: 'set_lang:zh' },
              { text: '🇬🇧 English', callback_data: 'set_lang:en' }
            ]
          ]
        }
      });
      return;
    }

    if (text === '/start' || text === '/help') {
      const savedLang = db.get(`lang_${chatId}`);
      const userLang = getUserLang(chatId, msg.from?.language_code);
      const t = I18N[userLang] || I18N.zh;

      const langMarkup = {
        inline_keyboard: [
          [
            { text: '🇨🇳 简体中文', callback_data: 'set_lang:zh' },
            { text: '🇬🇧 English', callback_data: 'set_lang:en' }
          ]
        ]
      };

      // 首次使用 (未记录语言偏好且发 /start)：展示双语欢迎卡片与直观切换引导
      if (!savedLang && text === '/start') {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: t.firstWelcome,
          parse_mode: 'HTML',
          reply_markup: langMarkup
        });
        return;
      }

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: t.welcome,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: userLang === 'zh' ? '🌐 切换为 English' : '🌐 Switch to 中文', callback_data: userLang === 'zh' ? 'set_lang:en' : 'set_lang:zh' }
            ]
          ]
        }
      });
      return;
    }

    if (text === '/stats' || text === '/traffic' || text === '/quota') {
      const stats = getTrafficStats();
      const isOwner = String(chatId) === String(OWNER_USER_ID);
      const userQuota = quotaManager.checkQuota(chatId, false);
      const albumQuota = quotaManager.checkQuota(chatId, true);

      const roleText = isOwner ? '👑 <b>站长/管理员 (拥有 100% 全面豁免权)</b>' : '👤 <b>讨论组成员</b>';
      const quotaText = isOwner
        ? '• 下载权限：<code>无限制 (100% 全面豁免)</code>\n• 冷却限制：<code>无限制 (0秒间隔)</code>'
        : `• 今日单曲：<code>${userQuota.current} / ${userQuota.max} 首</code>\n• 今日专辑：<code>${albumQuota.current} / ${albumQuota.max} 张</code>\n• 冷却间隔：<code>5 秒/次</code>`;

      const msgText = 
`📊 <b>VPS 服务器带宽与使用配额监控</b>

📡 <b>甲骨文云 (OCI) 带宽统计：</b>
• 进度条：[<code>${stats.progressBar}</code>] <code>${stats.usagePercent}%</code>
• 本月出站 (上行)：<code>${stats.txGB} GB</code> / <code>${stats.maxQuotaGB} GB (10TB)</code>
• 剩余出站额度：<code>${stats.remainingGB} GB</code>
• 服务器入站 (下行)：<code>${stats.rxGB} GB</code> (✨ 甲骨文云入站完全免费且不限量)

👤 <b>您的当前身份与配额：</b>
• 用户身份：${roleText}
${quotaText}

💡 <b>带宽流量小科普：</b>
1. <b>入站流量 (Apple Music -> VPS)</b>：完全免费且无上限，不会扣除 10TB 额度。
2. <b>秒传直发</b>：库内已有的单曲和全辑直接通过 Telegram 数据中心转发，<b>0 字节 VPS 上传带宽消耗</b>。
3. <b>仅全新上传</b>：只有 VPS 首次向 Telegram 上传新音乐才会消耗 VPS 出站带宽。`;

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: msgText,
        parse_mode: 'HTML'
      });
      return;
    }

    // ==================== 站长专属 VPS 运维指令区 (仅限 OWNER_USER_ID) ====================
    const isOwner = String(chatId) === String(OWNER_USER_ID);
    const adminCmdMatch = text.match(/^\/(admin|cmd|status|sys|clean|check|restart|history|logs)(?:\s+(.*))?$/i);
    if (adminCmdMatch) {
      if (!isOwner) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: `⚠️ <b>无权访问：</b> 此指令为站长专属运维命令 (您的 ID: <code>${chatId}</code> 未授权)。`,
          parse_mode: 'HTML'
        });
        return;
      }

      const cmd = adminCmdMatch[1].toLowerCase();
      const arg = (adminCmdMatch[2] || '').trim().toLowerCase();

      // 1. 管理员指令手册
      if (cmd === 'admin' || cmd === 'cmd') {
        const adminHelp = 
`👑 <b>站长专属 VPS 运维指令面板 (EnkinoAMDBot)</b>

🛠️ <b>可用指令列表：</b>
• <code>/history</code>：查看最近 1 小时全平台任务流水 (包含 Web 端与 TG 端的转存/解密状态)。
• <code>/status</code> 或 <code>/sys</code>：查看 VPS 系统资源 (CPU/内存/磁盘/开机时长)、各核心服务运行状态及当前任务队列。
• <code>/clean</code>：一键清理 VPS 临时垃圾文件 (扫描并删除 <code>/tmp</code> 中残留音频与目录)，即时释放磁盘。
• <code>/check</code>：系统全链路健康体检 (检测 am-hook、am-cloud、Widevine CDM 与 Local Bot API 各端口及解密拉流可用性)。
• <code>/restart &lt;服务&gt;</code>：远程重启指定服务，支持：
  - <code>/restart bot</code>：重启 Telegram Bot
  - <code>/restart cloud</code>：重启云端转存与元数据中枢 (am-cloud)
  - <code>/restart hook</code>：重启 Rust 核心与 Web 解密 (am-hook)
  - <code>/restart api</code>：重启 Local Bot API Docker 容器
  - <code>/restart all</code>：顺序重启全部服务

💡 <i>所有指令均在 VPS 底层实时安全执行，拥有最高管理员特权。普通用户输入斜杠时不会显示这些指令。</i>`;
        await tgCall('sendMessage', { chat_id: chatId, text: adminHelp, parse_mode: 'HTML' });
        return;
      }

      // 1.5 查看最近 1 小时全平台任务流水 (Web + TG)
      if (cmd === 'history' || cmd === 'logs') {
        const waitMsg = await tgCall('sendMessage', {
          chat_id: chatId,
          text: '📋 <b>正在检索最近 1 小时全平台转存与解密日志...</b>',
          parse_mode: 'HTML'
        });

        try {
          const rawLogs = execSync('journalctl -u am-cloud.service -u am-tgbot.service -u am-hook.service --since "1 hour ago" --no-pager', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

          const events = [];
          for (const line of rawLogs.split('\n')) {
            const timeMatch = line.match(/^(\w+\s+\d+\s+(\d{2}:\d{2}:\d{2}))/);
            const timeStr = timeMatch ? timeMatch[2] : '';

            if (line.includes('[Cloud-Transfer] ✔ 批处理就绪:')) {
              const m = line.match(/批处理就绪:\s*([^()]+)\.m4a\s*\(耗时:\s*([^)]+)\)/);
              if (m) events.push({ time: timeStr, type: '🌐 Web', text: `<b>${escapeHtml(m[1].trim())}</b> [${m[2].trim()}]` });
            } else if (line.includes('[Cloud-Transfer] 🎧 本地就绪:')) {
              const m = line.match(/本地就绪:\s*([^()]+)\.m4a\s*\(大小:\s*([^,]+),\s*缩略图:\s*[^,]+,\s*耗时:\s*([^)]+)\)/);
              if (m) events.push({ time: timeStr, type: '🎵 本地', text: `<b>${escapeHtml(m[1].trim())}</b> (${m[2].trim()}, ${m[3].trim()})` });
            } else if (line.includes('[Cloud-Transfer] 📦 全辑 ZIP 本地就绪:')) {
              const m = line.match(/全辑 ZIP 本地就绪:\s*([^()]+)\.zip\s*\(大小:\s*([^,]+),\s*耗时:\s*([^)]+)\)/);
              if (m) events.push({ time: timeStr, type: '📦 ZIP', text: `<b>${escapeHtml(m[1].trim())}</b> (${m[2].trim()})` });
            } else if (line.includes('[TG-Bot] 频道全辑归档就绪')) {
              const m = line.match(/频道全辑归档就绪\s*\(([0-9]+)\s*首歌\)/);
              if (m) events.push({ time: timeStr, type: '🤖 TG', text: `全辑推送私聊归档 (共 ${m[1]} 首)` });
            } else if (line.includes('当前歌曲在解析账号所属地区无资源或未上架')) {
              const m = line.match(/master\s*([0-9]+)/);
              events.push({ time: timeStr, type: '⚠️ 地区', text: `曲目 ID ${m ? m[1] : ''} 在土耳其区未上架 (已跳过)` });
            }
          }

          const recentEvents = events.slice(-30).reverse();
          let summaryText = `📋 <b>最近 1 小时全平台任务流水 (共检索到 ${events.length} 项)</b>\n\n`;
          if (events.length === 0) {
            summaryText += '🍃 <i>过去 1 小时内暂无下载、转存或解密任务 (系统空闲)</i>';
          } else {
            summaryText += recentEvents.map(e => `• <code>${e.time}</code> [${e.type}] ${e.text}`).join('\n');
            if (events.length > 30) {
              summaryText += `\n\n<i>... 更多早期记录省略，近 1 小时总计 ${events.length} 项</i>`;
            }
          }

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: summaryText,
            parse_mode: 'HTML'
          });
        } catch (err) {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `❌ 检索历史日志失败: ${escapeHtml(err.message)}`,
            parse_mode: 'HTML'
          });
        }
        return;
      }

      // 2. 查看 VPS 状态与服务健康度
      if (cmd === 'status' || cmd === 'sys') {
        let loadStr = '未知';
        try {
          loadStr = os.loadavg().map(n => n.toFixed(2)).join(', ');
        } catch {}

        const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
        const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(1);
        const usedMemGb = (totalMemGb - freeMemGb).toFixed(1);
        const memPct = Math.round((usedMemGb / totalMemGb) * 100);

        let diskInfo = '未知';
        try {
          const dfOut = execSync("df -h / | tail -n 1 | awk '{print $3 \" / \" $2 \" (已用 \" $5 \")\"}'", { encoding: 'utf8' }).trim();
          if (dfOut) diskInfo = dfOut;
        } catch {}

        const uptimeH = Math.floor(os.uptime() / 3600);
        const uptimeM = Math.floor((os.uptime() % 3600) / 60);

        // 检查 systemd 与 docker 状态
        let hookStatus = '❌ 离线';
        let cloudStatus = '❌ 离线';
        let botStatus = '✅ 运行中';
        let apiStatus = '❌ 离线';
        try {
          if (execSync('systemctl is-active am-hook.service', { encoding: 'utf8' }).trim() === 'active') hookStatus = '✅ 运行中';
        } catch {}
        try {
          if (execSync('systemctl is-active am-cloud.service', { encoding: 'utf8' }).trim() === 'active') cloudStatus = '✅ 运行中';
        } catch {}
        try {
          const dockerOut = execSync("sudo docker inspect -f '{{.State.Status}}' tg-bot-api 2>/dev/null", { encoding: 'utf8' }).trim();
          if (dockerOut === 'running') apiStatus = '✅ 运行中 (Local Mode)';
        } catch {}

        const sysMsg = 
`🖥️ <b>VPS 服务器实时监控报告</b>

⏱️ <b>系统状态：</b>
• 运行时间：<code>${uptimeH} 小时 ${uptimeM} 分钟</code>
• CPU 负载：<code>${loadStr}</code> (${os.cpus().length} vCPU)
• 物理内存：<code>${usedMemGb} GB / ${totalMemGb} GB (${memPct}%)</code> (可用: <code>${freeMemGb} GB</code>)
• 磁盘空间：<code>${diskInfo}</code>

⚙️ <b>核心组件拓扑：</b>
• <code>am-hook (Rust :31408)</code>: ${hookStatus}
• <code>am-cloud (Node :31409)</code>: ${cloudStatus}
• <code>am-tgbot (守护进程)</code>: ${botStatus}
• <code>tg-bot-api (Docker :8081)</code>: ${apiStatus}

📋 <b>机器人当前队列：</b>
• 正在执行任务：<code>${botTaskQueue.runningCount}</code>
• 排队等待中：<code>${botTaskQueue.length}</code>`;

        await tgCall('sendMessage', { chat_id: chatId, text: sysMsg, parse_mode: 'HTML' });
        return;
      }

      // 3. 一键磁盘清理
      if (cmd === 'clean') {
        const waitMsg = await tgCall('sendMessage', { chat_id: chatId, text: '🧹 <b>正在扫描并清理 VPS 临时缓存与孤立文件...</b>', parse_mode: 'HTML' });
        try {
          const beforeDisk = execSync("df -h / | tail -n 1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
          let cleanedCount = 0;
          const tmpDir = '/tmp';
          if (fs.existsSync(tmpDir)) {
            const entries = fs.readdirSync(tmpDir);
            for (const entry of entries) {
              if (entry.startsWith('am_tg_') || entry.startsWith('album_') || entry.startsWith('playlist_')) {
                try {
                  fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
                  cleanedCount++;
                } catch {}
              }
            }
          }
          const afterDisk = execSync("df -h / | tail -n 1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `✨ <b>VPS 磁盘清理完成！</b>\n• 清理遗留目录项：<code>${cleanedCount} 个</code>\n• 清理前可用：<code>${beforeDisk}</code>\n• 清理后可用：<code>${afterDisk}</code>`,
            parse_mode: 'HTML'
          });
        } catch (e) {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `❌ <b>清理执行异常:</b> ${escapeHtml(e.message)}`,
            parse_mode: 'HTML'
          });
        }
        return;
      }

      // 4. 全链路健康体检
      if (cmd === 'check') {
        const waitMsg = await tgCall('sendMessage', { chat_id: chatId, text: '🩺 <b>正在对全链路服务执行静默探活体检...</b>', parse_mode: 'HTML' });
        const results = [];

        // 探测 am-hook 31408
        const t0 = performance.now();
        try {
          const res = await fetch(`${HOOK_BASE}/`, { signal: AbortSignal.timeout(3000) });
          const ms = Math.round(performance.now() - t0);
          results.push(`• <code>am-hook (Web :31408)</code>: ${res.ok ? '✅ 正常' : '⚠️ HTTP ' + res.status} (${ms}ms)`);
        } catch (e) {
          results.push(`• <code>am-hook (Web :31408)</code>: ❌ 无法连接 (${e.message})`);
        }

        // 探测 Widevine CDM 12340
        const t1 = performance.now();
        try {
          const res = await fetch('http://127.0.0.1:12340/status', { signal: AbortSignal.timeout(3000) });
          const ms = Math.round(performance.now() - t1);
          results.push(`• <code>Widevine CDM (:12340)</code>: ${res.ok ? '✅ 密钥协商正常' : '⚠️ HTTP ' + res.status} (${ms}ms)`);
        } catch {
          // 部分 wrapper-lite 仅响应根路径
          try {
            await fetch('http://127.0.0.1:12340/', { signal: AbortSignal.timeout(2000) });
            results.push(`• <code>Widevine CDM (:12340)</code>: ✅ 端口响应正常`);
          } catch (e) {
            results.push(`• <code>Widevine CDM (:12340)</code>: ❌ 无法连接 (${e.message})`);
          }
        }

        // 探测 am-cloud 31409
        const t2 = performance.now();
        try {
          const res = await fetch(`${QUEUE_API}`, { signal: AbortSignal.timeout(3000) });
          const ms = Math.round(performance.now() - t2);
          results.push(`• <code>am-cloud (转存中枢 :31409)</code>: ${res.ok ? '✅ 正常' : '⚠️ HTTP ' + res.status} (${ms}ms)`);
        } catch (e) {
          results.push(`• <code>am-cloud (转存中枢 :31409)</code>: ❌ 无法连接 (${e.message})`);
        }

        // 探测 tg-bot-api 8081
        const t3 = performance.now();
        try {
          const res = await fetch(`${TG_API_BASE}/`, { signal: AbortSignal.timeout(3000) });
          const ms = Math.round(performance.now() - t3);
          results.push(`• <code>tg-bot-api (Local :8081)</code>: ✅ 响应正常 (${ms}ms)`);
        } catch (e) {
          results.push(`• <code>tg-bot-api (Local :8081)</code>: ❌ 无法连接 (${e.message})`);
        }

        // 探测 Apple Music Token & 歌词接口可用性 (以热门歌曲 1468058171 晴天 探活)
        const t4 = performance.now();
        try {
          const res = await fetch(`${HOOK_BASE}/lyrics/1468058171`, { signal: AbortSignal.timeout(5000) });
          const ms = Math.round(performance.now() - t4);
          if (res.ok) {
            results.push(`• <code>Apple Music 账号与解密探活</code>: ✅ 鉴权有效 (${ms}ms)`);
          } else {
            results.push(`• <code>Apple Music 账号与解密探活</code>: ⚠️ 异常 HTTP ${res.status}`);
          }
        } catch (e) {
          results.push(`• <code>Apple Music 账号与解密探活</code>: ❌ 探活失败 (${e.message})`);
        }

        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `🩺 <b>全链路健康检查报告：</b>\n\n${results.join('\n')}`,
          parse_mode: 'HTML'
        });
        return;
      }

      // 5. 远程重启指定服务
      if (cmd === 'restart') {
        if (!['bot', 'cloud', 'hook', 'api', 'all'].includes(arg)) {
          await tgCall('sendMessage', {
            chat_id: chatId,
            text: `💡 <b>请指定要重启的服务：</b>\n• <code>/restart bot</code> (重启 TG 机器人)\n• <code>/restart cloud</code> (重启 am-cloud)\n• <code>/restart hook</code> (重启 am-hook)\n• <code>/restart api</code> (重启 Local Bot API 容器)\n• <code>/restart all</code> (重启全部服务)`,
            parse_mode: 'HTML'
          });
          return;
        }

        if (arg === 'cloud') {
          try {
            execSync('sudo systemctl restart am-cloud.service');
            await tgCall('sendMessage', { chat_id: chatId, text: '✅ <code>am-cloud.service</code> 重启成功！', parse_mode: 'HTML' });
          } catch (e) {
            await tgCall('sendMessage', { chat_id: chatId, text: `❌ 重启失败: ${escapeHtml(e.message)}`, parse_mode: 'HTML' });
          }
          return;
        }

        if (arg === 'hook') {
          try {
            execSync('sudo systemctl restart am-hook.service');
            await tgCall('sendMessage', { chat_id: chatId, text: '✅ <code>am-hook.service</code> 重启成功！', parse_mode: 'HTML' });
          } catch (e) {
            await tgCall('sendMessage', { chat_id: chatId, text: `❌ 重启失败: ${escapeHtml(e.message)}`, parse_mode: 'HTML' });
          }
          return;
        }

        if (arg === 'api') {
          try {
            execSync('sudo docker restart tg-bot-api');
            await tgCall('sendMessage', { chat_id: chatId, text: '✅ <code>tg-bot-api</code> 容器重启成功！', parse_mode: 'HTML' });
          } catch (e) {
            await tgCall('sendMessage', { chat_id: chatId, text: `❌ 重启失败: ${escapeHtml(e.message)}`, parse_mode: 'HTML' });
          }
          return;
        }

        if (arg === 'bot' || arg === 'all') {
          await tgCall('sendMessage', {
            chat_id: chatId,
            text: `🔄 <b>正在重启 ${arg === 'all' ? '全部服务' : '机器人'}...</b>\n预计 3~5 秒后自动恢复在线。`,
            parse_mode: 'HTML'
          });
          setTimeout(() => {
            try {
              if (arg === 'all') {
                execSync('sudo systemctl restart am-cloud.service && sudo systemctl restart am-hook.service && sudo docker restart tg-bot-api && sudo systemctl restart am-tgbot.service');
              } else {
                execSync('sudo systemctl restart am-tgbot.service');
              }
            } catch (err) {
              console.error('Restart failed:', err);
            }
          }, 800);
          return;
        }
      }
    }

    const userLang = getUserLang(chatId, msg.from?.language_code);
    const isEn = userLang === 'en';
    const isOwnerUser = String(chatId) === String(OWNER_USER_ID);
    const t = I18N[userLang] || I18N.zh;

    // 操作冷却限制 (作者完全豁免)
    const cdCheck = quotaManager.checkCooldown(chatId, 5000);
    if (!cdCheck.ok) {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: t.tooFrequent ? t.tooFrequent(cdCheck.waitSec) : `⏳ <b>操作太频繁啦！</b>\n请稍候 <code>${cdCheck.waitSec}</code> 秒后再发送新任务。`,
        parse_mode: 'HTML'
      });
      return;
    }

    const parsed = parseAppleMusicUrl(text);
    if (!parsed) {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: t.invalidUrl || '💡 请发送有效的 Apple Music 单曲或专辑链接 (如包含 <code>?i=</code> 的歌曲链接或纯数字歌曲 ID)。',
        parse_mode: 'HTML'
      });
      return;
    }

    // 艺人主页流程
    if (parsed.type === 'artist') {
      const loadingMsg = await tgCall('sendMessage', {
        chat_id: chatId,
        text: isEn ? '🔍 <b>Resolving artist profile...</b>' : '🔍 <b>正在解析艺人主页信息...</b>',
        parse_mode: 'HTML'
      });
      try {
        const artistData = await getArtistData(parsed.artistId, parsed.storefront);
        const card = buildArtistCard(artistData, userLang);
        userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
          isArtist: true,
          artistData,
          lang: userLang,
          createdAt: Date.now()
        });
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
      } catch (e) {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          text: `❌ ${isEn ? 'Failed to resolve artist' : '解析艺人失败'}: ${escapeHtml(e.message)}`
        });
      }
      return;
    }

    // 整张专辑或歌单流程
    if (parsed.type === 'album' || parsed.type === 'playlist') {
      const isPl = parsed.type === 'playlist';
      const loadingMsg = await tgCall('sendMessage', {
        chat_id: chatId,
        text: isEn
          ? `🔍 <b>Resolving ${isPl ? 'playlist' : 'album'} tracks...</b>`
          : `🔍 <b>正在解析整张${isPl ? '歌单' : '专辑'}曲目列表...</b>`,
        parse_mode: 'HTML'
      });
      try {
        const albumData = isPl
          ? await fetchPlaylistDetails(parsed.playlistId, parsed.storefront)
          : await fetchAlbumDetails(parsed.albumId, parsed.storefront);

        const card = buildAlbumCard(albumData, 'Lossless', true, 'zip', userLang, isOwnerUser);
        userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
          isAlbum: true,
          albumData,
          quality: 'Lossless',
          needLrc: true,
          deliveryMode: 'zip',
          lang: userLang,
          createdAt: Date.now()
        });
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
      } catch (e) {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          text: `❌ ${isEn ? 'Failed to resolve' : '解析失败'}: ${escapeHtml(e.message)}`
        });
      }
      return;
    }

    // 单曲流程
    const loadingMsg = await tgCall('sendMessage', {
      chat_id: chatId,
      text: isEn
        ? '🔍 <b>Resolving Apple Music track metadata...</b>'
        : '🔍 <b>正在解析 Apple Music 元数据与音轨规格...</b>',
      parse_mode: 'HTML'
    });

    try {
      const details = await fetchSongDetails(parsed.songId, parsed.storefront);
      const card = buildSongCard(details, 'Lossless', true, false, userLang, parsed.albumId || null);

      userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
        isAlbum: false,
        details,
        quality: 'Lossless',
        needLrc: true,
        isZip: false,
        backAlbumId: parsed.albumId || null,
        lang: userLang,
        createdAt: Date.now()
      });

      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
    } catch (e) {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        text: `❌ ${isEn ? 'Failed to resolve track' : '解析单曲失败'}: ${escapeHtml(e.message)}`
      });
    }
    return;
  }

  // 3. 内联按钮交互
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const sessionKey = `${chatId}_${messageId}`;

    // 处理中英双语切换按钮回调
    if (data.startsWith('set_lang:')) {
      const selectedLang = data.split(':')[1];
      db.set(`lang_${chatId}`, selectedLang);
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: selectedLang === 'en' ? 'Language switched to English! 🇬🇧' : '已切换为简体中文！🇨🇳'
      });
      const t = I18N[selectedLang] || I18N.zh;
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${t.langSwitched}\n\n${t.welcome}`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: selectedLang === 'zh' ? '🌐 切换为 English' : '🌐 Switch to 中文', callback_data: selectedLang === 'zh' ? 'set_lang:en' : 'set_lang:zh' }
            ]
          ]
        }
      });
      return;
    }

    const userLang = getUserLang(chatId, cb.from?.language_code);
    const isEn = userLang === 'en';
    const isOwner = String(chatId) === String(OWNER_USER_ID);
    const session = userSessions.get(sessionKey);

    // ==================== 艺人浏览回调区 (无需 session，直接按 artistId 缓存/拉取) ====================
    if (data.startsWith('art_songs:') || data.startsWith('art_albums:') || data.startsWith('art_back:')) {
      const artistId = data.split(':')[1];
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      try {
        const artistData = await getArtistData(artistId);
        if (data.startsWith('art_songs:')) {
          await showArtistSongs(chatId, artistData, userLang, messageId);
        } else if (data.startsWith('art_albums:')) {
          await showArtistAlbums(chatId, artistData, userLang, messageId);
        } else {
          const card = buildArtistCard(artistData, userLang);
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: card.text,
            parse_mode: 'HTML',
            reply_markup: card.reply_markup
          });
        }
      } catch (err) {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: `❌ ${isEn ? 'Failed to load artist' : '加载艺人失败'}: ${escapeHtml(err.message)}`
        });
      }
      return;
    }

    // 从艺人专辑列表点入某张专辑
    if (data.startsWith('art_album:')) {
      const parts = data.split(':');
      const albumId = parts[1];
      const artistId = parts[2] || null;
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      try {
        const albumData = await fetchAlbumDetails(albumId);
        const card = buildAlbumCard(albumData, 'Lossless', true, 'zip', userLang, isOwner, artistId);
        userSessions.set(sessionKey, {
          isAlbum: true,
          albumData,
          quality: 'Lossless',
          needLrc: true,
          deliveryMode: 'zip',
          lang: userLang,
          backArtistId: artistId,
          createdAt: Date.now()
        });
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
      } catch (err) {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: `❌ ${isEn ? 'Failed to load album' : '加载专辑失败'}: ${escapeHtml(err.message)}`
        });
      }
      return;
    }

    if (data.startsWith('pick:')) {
      const parts = data.split(':');
      const songId = parts[1];
      const backAlbumId = parts[2] || null;
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      const loadingMsg = await tgCall('sendMessage', {
        chat_id: chatId,
        text: isEn ? '🔍 <b>Resolving track metadata...</b>' : '🔍 <b>正在解析所选单曲元数据...</b>',
        parse_mode: 'HTML'
      });
      try {
        const details = await fetchSongDetails(songId, 'hk');
        const card = buildSongCard(details, 'Lossless', true, false, userLang, backAlbumId);
        userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
          isAlbum: false,
          details,
          quality: 'Lossless',
          needLrc: true,
          isZip: false,
          backAlbumId,
          lang: userLang,
          createdAt: Date.now()
        });
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
      } catch (err) {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          text: `❌ ${isEn ? 'Failed to resolve' : '解析失败'}: ${escapeHtml(err.message)}`
        });
      }
      return;
    }

    // 展开单曲列表查看 (带返回主菜单)
    if (data.startsWith('ashow:')) {
      const albumId = data.split(':')[1];
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      let albumData = session?.albumData;
      if (!albumData) {
        try { albumData = await fetchAlbumDetails(albumId); } catch {}
      }
      if (albumData) {
        await showAlbumTracks(chatId, albumData, userLang, messageId);
      }
      return;
    }

    // 返回专辑主菜单
    if (data.startsWith('aback:')) {
      const albumId = data.split(':')[1];
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      let albumData = session?.albumData;
      if (!albumData) {
        try { albumData = await fetchAlbumDetails(albumId); } catch {}
      }
      if (albumData) {
        const card = buildAlbumCard(albumData, session?.quality || 'Lossless', session?.needLrc ?? true, session?.deliveryMode || 'zip', userLang, isOwner, session?.backArtistId || null);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
      }
      return;
    }

    // 非站长点击全辑下载按钮拦截提示
    if (data.startsWith('anotowner:')) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: isEn
          ? '🔒 Full album download is reserved for Admin. Please pick individual tracks below to download!'
          : '🔒 全辑下载为站长专属特权。请点击【查看与单独点选单曲】进行单曲下载！',
        show_alert: true
      });
      return;
    }

    if (!session) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: isEn ? 'Session expired. Please send link again!' : '会话已过期，请重新发送链接！',
        show_alert: true
      });
      return;
    }

    if (session.downloading && (data.startsWith('dl:') || data.startsWith('adl:'))) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: isEn ? 'Task is currently processing, please wait!' : '任务正在排队处理中，请勿重复点击！',
        show_alert: true
      });
      return;
    }

    // 专辑相关回调
    if (session.isAlbum) {
      if (data.startsWith('aq:')) {
        session.quality = data.split(':')[1];
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        return;
      }

      if (data.startsWith('afmt:')) {
        session.deliveryMode = data.split(':')[1];
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        return;
      }

      if (data.startsWith('alrc:')) {
        session.needLrc = data.split(':')[1] === '1';
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        return;
      }

      if (data.startsWith('adl:')) {
        if (!isOwner) {
          await tgCall('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: isEn
              ? '⚠️ Full album download is reserved for the bot admin. Please select individual tracks.'
              : '⚠️ 全辑下载为站长专属特权，普通用户请单独点选单曲下载。',
            show_alert: true
          });
          return;
        }

        const btnCd = quotaManager.checkCooldown(chatId, 3000);
        if (!btnCd.ok) {
          await tgCall('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: isEn ? `Too fast, please wait ${btnCd.waitSec}s!` : `操作太频繁，请稍候 ${btnCd.waitSec} 秒！`,
            show_alert: true
          });
          return;
        }
        session.downloading = true;
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        handleAlbumDownload(chatId, messageId, session.albumData, session.quality, session.needLrc, session.deliveryMode)
          .catch(e => console.error('[TG-Bot] 专辑转存任务出错:', e.message))
          .finally(() => userSessions.delete(sessionKey));
        return;
      }
    }

    // 单曲相关回调
    if (data.startsWith('q:')) {
      session.quality = data.split(':')[1];
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data.startsWith('fmt:')) {
      session.isZip = data.split(':')[1] === 'zip';
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data.startsWith('lrc:')) {
      session.needLrc = data.split(':')[1] === '1';
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }

    if (data.startsWith('dl:')) {
      const btnCd = quotaManager.checkCooldown(chatId, 3000);
      if (!btnCd.ok) {
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `操作太频繁，请稍候 ${btnCd.waitSec} 秒！`,
          show_alert: true
        });
        return;
      }
      session.downloading = true;
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      handleDownload(chatId, messageId, session.details, session.quality, session.needLrc, session.isZip)
        .catch(e => console.error('[TG-Bot] 单曲转存任务出错:', e.message))
        .finally(() => userSessions.delete(sessionKey));
      return;
    }
  }
}

// 清理异常终止遗留的临时目录 (兜底防护)
function cleanupStaleTgTempDirs() {
  try {
    const tmpDir = '/tmp';
    const now = Date.now();
    const maxAge = 15 * 60 * 1000; // 15分钟
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith('am_tg_')) {
        const p = path.join(tmpDir, entry);
        try {
          const stat = fs.statSync(p);
          if (now - stat.mtimeMs > maxAge) {
            fs.rmSync(p, { recursive: true, force: true });
            console.log(`[TG-Bot] 自动清理遗留临时目录: ${entry}`);
          }
        } catch {}
      }
    }
  } catch {}
}

// ==================== 主轮询守护 ====================
async function startBot() {
  console.log(`[TG-Bot] 🤖 EnkinoAMDBot (v2.3 黄金平衡流式传输与高可用版) 正在启动...`);
  console.log(`[TG-Bot] 授权作者 ID: ${OWNER_USER_ID}`);
  console.log(`[TG-Bot] 唯一授权归档群组: ${AUTHORIZED_GROUP_ID}`);

  cleanupStaleTgTempDirs();
  setInterval(cleanupStaleTgTempDirs, 30 * 60 * 1000);

  try {
    const me = await tgCall('getMe');
    console.log(`[TG-Bot] ✔ 机器人鉴权成功: @${me.username} (${me.first_name})`);

    // 注册 Telegram 原生指令菜单 (普通用户默认仅见常规 4 个指令；站长专属呈现全套运维指令)
    try {
      await tgCall('setMyCommands', {
        commands: [
          { command: 'start', description: 'Start Bot & Language Guide / 启动与语言切换' },
          { command: 'help', description: 'Usage & Tips / 使用帮助与格式说明' },
          { command: 'stats', description: 'Bandwidth & Quotas / 带宽流量与配额' },
          { command: 'lang', description: 'Switch Language / 切换中英语言' }
        ],
        scope: { type: 'default' }
      });

      if (OWNER_USER_ID) {
        await tgCall('setMyCommands', {
          commands: [
            { command: 'start', description: '启动与使用指南' },
            { command: 'history', description: '最近1小时全平台转存流水 (Web+TG)' },
            { command: 'status', description: 'VPS 硬件资源与服务监控仪表盘' },
            { command: 'check', description: '全链路服务与 Apple Music 账号探活' },
            { command: 'clean', description: '一键扫描清理 VPS 临时垃圾' },
            { command: 'restart', description: '远程重启指定服务 (bot/cloud/hook/api/all)' },
            { command: 'stats', description: '服务器流量与配额监控' },
            { command: 'lang', description: '切换语言 (Switch Language)' }
          ],
          scope: { type: 'chat', chat_id: Number(OWNER_USER_ID) }
        });
      }
      console.log('[TG-Bot] ✔ Telegram 指令菜单 (默认用户菜单 + 站长专属菜单) 已成功同步注册');
    } catch (cmdErr) {
      console.warn('[TG-Bot] 注册 Telegram 指令菜单失败:', cmdErr.message);
    }
  } catch (e) {
    console.error(`[TG-Bot] ❌ 机器人启动鉴权失败:`, e.message);
    process.exit(1);
  }

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(`${TG_API_BASE}/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`, {
        signal: AbortSignal.timeout(35000)
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          handleUpdate(update).catch(err => {
            console.error('[TG-Bot] 处理更新异常:', err);
          });
        }
      }
    } catch (e) {
      if (e.name !== 'TimeoutError') {
        console.warn('[TG-Bot] 轮询网络异常 (将在 3 秒后重试):', e.message);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

process.on('uncaughtException', err => {
  console.error('[TG-Bot] 全局未捕获异常 (已拦截维护在线):', err);
});
process.on('unhandledRejection', reason => {
  console.error('[TG-Bot] 全局未捕获 Promise 拒绝 (已拦截维护在线):', reason);
});

startBot();
