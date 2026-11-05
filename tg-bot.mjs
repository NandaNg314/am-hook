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
  'mavis fan': '范晓萱', 'shunza': '顺子', 'wanfang': '万芳', 'peggy hsu': '许哲珮',
  // 港台经典与独立音乐人补充
  'anthony wong': '黄耀明', 'wong yiu-ming': '黄耀明', 'denise ho': '何韵诗', 'hocc': '何韵诗',
  'tat ming pair': '达明一派', 'tom chang': '张雨生', 'chang yu-sheng': '张雨生',
  'bobby chen': '陈升', 'chen sheng': '陈升', 'samuel hui': '许冠杰', 'paula tsui': '徐小凤',
  'roman tam': '罗文', 'danny chan': '陈百强', 'alan tam': '谭咏麟', 'kenny bee': '钟镇涛',
  'shirley kwan': '关淑怡', 'cass phang': '彭羚', 'f.i.r.': '飞儿乐团', 'power station': '动力火车',
  'charlene choi': '蔡卓妍', 'gillian chung': '钟欣潼', 'fiona sit': '薛凯琪', 'kay tse': '谢安琪',
  'ivana wong': '王菀之', 'endy chau': '周国贤', 'juno mak': '麦浚龙', 'ellen loo': '卢凯彤',
  'eman lam': '林二汶', 'lo ta-yu': '罗大佑', 'luo dayou': '罗大佑', 'wu bai': '伍佰', 'wubai': '伍佰',
  'richie jen': '任贤齐', 'ronald cheng': '郑中基', 'andy hui': '许志安', 'william so': '苏永康',
  'edmond leung': '梁汉文', 'dicky cheung': '张卫健', 'nicholas tse': '谢霆锋', 'jordan chan': '陈小春',
  'ekin cheng': '郑伊健', 'raymond lam': '林峯', 'alfred hui': '许廷铿', 'hubert wu': '胡鸿钧',
  'jinny ng': '吴若希', 'hana kuk': '菊梓乔'
};

function isChineseArtistAlias(rawArtist) {
  if (!rawArtist || typeof rawArtist !== 'string') return false;
  const trimmed = rawArtist.trim();
  if (CHINESE_ARTIST_ALIASES[trimmed.toLowerCase()]) return true;
  const parts = trimmed.split(/\s*(?:,|&|\/|feat\.|ft\.)\s*/i);
  return parts.some((p) => Boolean(CHINESE_ARTIST_ALIASES[p.trim().toLowerCase()]));
}

function isChineseGenre(genre) {
  if (!genre) return false;
  const text = Array.isArray(genre) ? genre.join(' ') : String(genre);
  return /国语|粤语|华语|中国|台湾|香港|台语|mandopop|cantopop|c-pop|chinese|taiwan|hong\s*kong|hokkien/i.test(text);
}

function normalizeArtistName(rawArtist, isEn = false) {
  if (!rawArtist || typeof rawArtist !== 'string') return rawArtist;
  const trimmed = rawArtist.trim();
  if (isEn) return trimmed;
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
const CHANGELOG_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'changelog.json');

function loadChangelog() {
  try {
    return JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8'));
  } catch {
    return {
      latestVersion: '2.6',
      date: '2026-11-04',
      oneLiner: {
        zh: '支持直接发歌名搜索点歌、英文模式全英文音乐标签、歌单整包向所有用户开放',
        en: 'Direct song/artist search in bot, native English .m4a tags, and full playlist downloads for all users'
      },
      releases: []
    };
  }
}

function buildChangelogCard(lang = 'zh', mode = 'latest') {
  const isEn = lang === 'en';
  const cl = loadChangelog();
  const allReleases = cl.releases || [];
  const showHistory = mode === 'history';
  const targetReleases = showHistory ? allReleases : allReleases.slice(0, 1);

  const blocks = targetReleases.map((rel, idx) => {
    const title = (isEn ? rel.title?.en : rel.title?.zh) || '';
    const items = (isEn ? rel.items?.en : rel.items?.zh) || [];
    const lines = items.map((it) => `• ${escapeHtml(it)}`).join('\n');
    const tag = (!showHistory || idx === 0) ? (isEn ? ' [LATEST]' : ' [当前版本]') : '';
    // TG 专属更新（audience: tg）标注一下，免得以为网页端也有这个改动
    const scope = rel.audience === 'tg'
      ? (isEn ? ' · TG Bot only' : ' · 仅 TG Bot')
      : '';
    return `📌 <b>v${escapeHtml(rel.version)} (${escapeHtml(rel.date)})${tag} — ${escapeHtml(title)}${scope}</b>\n${lines}`;
  });

  const header = showHistory
    ? (isEn
        ? `📜 <b>Full Release History (v2.0 → v${escapeHtml(cl.latestVersion)})</b>\n\n`
        : `📜 <b>历史版本更新全记录 (v2.0 → v${escapeHtml(cl.latestVersion)})</b>\n\n`)
    : (isEn
        ? `✨ <b>What's New in Apple Music Bot & Web (v${escapeHtml(cl.latestVersion)})</b>\n\n`
        : `✨ <b>Apple Music 助手与网页端最新更新 (v${escapeHtml(cl.latestVersion)})</b>\n\n`);

  const modeBtn = showHistory
    ? {
        text: isEn ? `✨ Latest Only (v${cl.latestVersion})` : `✨ 仅看最新版 (v${cl.latestVersion})`,
        callback_data: `show_changelog:${isEn ? 'en' : 'zh'}:latest`
      }
    : {
        text: isEn ? `📜 Release History (${allReleases.length} versions)` : `📜 历史更新记录 (共 ${allReleases.length} 个版本)`,
        callback_data: `show_changelog:${isEn ? 'en' : 'zh'}:history`
      };

  return {
    text: header + blocks.join('\n\n'),
    reply_markup: {
      inline_keyboard: [
        [modeBtn],
        [
          {
            text: isEn ? '🌐 切换为中文' : '🌐 Switch to English',
            callback_data: `show_changelog:${isEn ? 'zh' : 'en'}:${mode}`
          },
          {
            text: isEn ? '🔙 Back to Guide' : '🔙 返回使用说明',
            callback_data: `set_lang:${isEn ? 'en' : 'zh'}`
          }
        ]
      ]
    }
  };
}

/**
 * 每个大版本仅在用户首次完成点歌时，在完成消息末尾顺带附一行简短的更新提示（绝不重复打扰）
 */
function consumeOneTimeUpdateNotice(chatId, lang = 'zh') {
  try {
    const cl = loadChangelog();
    const ver = String(cl.latestVersion || '');
    if (!ver) return '';
    const key = `seen_ver_${chatId}`;
    if (db.get(key) === ver) return '';
    db.set(key, ver);
    const isEn = lang === 'en';
    const line = (isEn ? cl.oneLiner?.en : cl.oneLiner?.zh) || '';
    if (!line) return '';
    return isEn
      ? `\n\n✨ <i>New in v${escapeHtml(ver)}: ${escapeHtml(line)} (Send /changelog for details)</i>`
      : `\n\n✨ <i>v${escapeHtml(ver)} 更新提示：${escapeHtml(line)}（发送 /changelog 查看详情）</i>`;
  } catch {
    return '';
  }
}

const inferredUserLang = new Map(); // chatId -> 'zh' | 'en'（记住客户端 language_code 推断结果，供无 from 参数的内部调用使用）

function getUserLang(chatId, fromLangCode = '') {
  const saved = db.get(`lang_${chatId}`);
  if (saved === 'zh' || saved === 'en') return saved;
  if (fromLangCode) {
    const detected = fromLangCode.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    inferredUserLang.set(String(chatId), detected);
    return detected;
  }
  const mem = inferredUserLang.get(String(chatId));
  if (mem === 'zh' || mem === 'en') return mem;
  return 'zh';
}

/* ==================== 音乐标签语言 (BCP-47) ====================
 * 与「界面语言」解耦：界面只有中英，但 .m4a 内嵌标签 + 文件名可以按用户指定的任意
 * BCP-47 标签（en-US / ja-JP / ar-EG / zh-Hant-HK …）向 Apple Music 请求官方本地化名称。
 *
 * ⚠️ 实测结论（2026-11-04，用周杰伦 1721449919 验证）：
 *   Apple Music 对「地区不支持的语言」不会报错，而是静默回退到该区默认语言。
 *   同一首歌 us 区 l=ar-EG 返回繁体（回退默认），l=en-US 返回英文，l=zh-Hans-CN 返回简体。
 *   因此必须按地区挨个试，从返回结果里挑**真正匹配目标语言**的那一份，不能只发一次。
 */

/** 常用标签快捷选择（按语言分组，实际可输入任意 BCP-47） */
const TAG_LANG_PRESETS = [
  { tag: 'auto', zh: '🌐 自动（跟随界面语言）', en: '🌐 Auto (follow UI language)' },
  { tag: 'en-US', zh: '🇺🇸 English (US)', en: '🇺🇸 English (US)' },
  { tag: 'en-GB', zh: '🇬🇧 English (UK)', en: '🇬🇧 English (UK)' },
  { tag: 'zh-Hans-CN', zh: '🇨🇳 简体中文', en: '🇨🇳 Chinese (Simplified)' },
  { tag: 'zh-Hant-TW', zh: '🇹🇼 繁體中文（台灣）', en: '🇹🇼 Chinese (Traditional, TW)' },
  { tag: 'zh-Hant-HK', zh: '🇭🇰 繁體中文（香港）', en: '🇭🇰 Chinese (Traditional, HK)' },
  { tag: 'ja', zh: '🇯🇵 日本語', en: '🇯🇵 Japanese' },
  { tag: 'ko', zh: '🇰🇷 한국어', en: '🇰🇷 Korean' },
  { tag: 'es-MX', zh: '🇲🇽 Español', en: '🇲🇽 Spanish' },
  { tag: 'fr-FR', zh: '🇫🇷 Français', en: '🇫🇷 French' },
  { tag: 'de-DE', zh: '🇩🇪 Deutsch', en: '🇩🇪 German' },
  { tag: 'pt-BR', zh: '🇧🇷 Português', en: '🇧🇷 Portuguese' },
  { tag: 'ru', zh: '🇷🇺 Русский', en: '🇷🇺 Russian' },
  { tag: 'ar-EG', zh: '🇪🇬 العربية', en: '🇪🇬 Arabic' },
  { tag: 'hi', zh: '🇮🇳 हिन्दी', en: '🇮🇳 Hindi' },
  { tag: 'vi', zh: '🇻🇳 Tiếng Việt', en: '🇻🇳 Vietnamese' },
  { tag: 'th', zh: '🇹🇭 ไทย', en: '🇹🇭 Thai' },
  { tag: 'tr', zh: '🇹🇷 Türkçe', en: '🇹🇷 Turkish' },
  { tag: 'id', zh: '🇮🇩 Bahasa Indonesia', en: '🇮🇩 Indonesian' },
];

/** BCP-47 语法校验（够用即可：primary(-subtag)*，仅 ASCII 字母数字） */
function isValidBcp47(tag) {
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(String(tag || ''));
}

/** 取语言主标签，如 zh-Hant-HK -> zh，en-US -> en */
function primarySubtag(tag) {
  return String(tag || '').toLowerCase().split('-')[0];
}

/** 用户设置的标签语言；未设置（或设为 auto）时返回 'auto' */
function getUserTagLang(chatId) {
  const saved = db.get(`taglang_${chatId}`);
  if (saved && typeof saved === 'string') return saved;
  return 'auto';
}

/** 解析出实际要用的 BCP-47：auto 时跟随界面语言（保持旧行为） */
function resolveTagLang(chatId, uiLang = null) {
  const saved = getUserTagLang(chatId);
  if (saved !== 'auto') return saved;
  const lang = uiLang || getUserLang(chatId);
  return lang === 'en' ? 'en-US' : 'zh-Hans-CN';
}

/**
 * 多地区尝试取到「真正匹配目标语言」的属性：命中目标语言就提前返回。
 * @returns {Promise<object|null>} 命中的 attributes；一个都没命中时返回第一个拿到的（保证有数据可用）
 */
async function fetchAttrsInTargetLang(pathBuilder, tagLang) {
  const targetPrimary = primarySubtag(tagLang);
  // 地区顺序按目标语言优化：中文优先大中华区，日文优先日区，英文优先美/英区，其余先用全球大库
  let storefronts;
  if (targetPrimary === 'zh') storefronts = ['cn', 'tw', 'hk', 'us', 'tr', 'jp'];
  else if (targetPrimary === 'ja') storefronts = ['jp', 'us', 'tr', 'hk', 'tw', 'cn'];
  else if (targetPrimary === 'ko') storefronts = ['kr', 'us', 'tr', 'hk', 'tw', 'cn'];
  else storefronts = ['us', 'gb', 'tr', 'hk', 'tw', 'cn', 'jp'];

  let firstSeen = null;
  for (const sf of storefronts) {
    try {
      const res = await fetch(`${HOOK_BASE}${pathBuilder(sf, tagLang)}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const attr = (await res.json()).data?.[0]?.attributes;
      if (!attr) continue;
      if (!firstSeen) firstSeen = attr;
      // 命中目标语言：audioLocale 主标签一致，或返回文本确实是该语言脚本
      const localeHit = primarySubtag(attr.audioLocale) === targetPrimary;
      if (localeHit) return attr;
    } catch {}
  }
  return firstSeen;
}


const I18N = {
  zh: {
    code: 'zh',
    name: '简体中文',
    welcome: `👋 <b>你好！我是 Apple Music 高品质音乐点歌与转存助手。</b>

🎵 <b>使用说明：</b>
直接把 Apple Music 单曲、专辑、歌单或艺人链接发送给我，例如：
• <b>单曲链接：</b> <code>https://music.apple.com/cn/album/晴天/1468058165?i=1468058171</code>
• <b>专辑链接：</b> <code>https://music.apple.com/cn/album/叶惠美/1468058165</code>
• <b>歌单链接：</b> <code>https://music.apple.com/us/playlist/top-100-global/pl.d25f5d1181894928af76c85c967f8f31</code>
• <b>纯歌曲ID：</b> <code>1468058171</code>

⚡ <b>核心功能亮点：</b>
• <b>全专辑 / 歌单下载：</b> 普通用户支持单曲、整张专辑与整张歌单下载（共享每日 200 首配额）
• <b>多选勾选下载：</b> 专辑/歌单曲目可勾选多首批量下载，已缓存曲目自动秒传跳过（不扣配额）
• <b>艺人全辑批量：</b> 一键勾选下载歌手名下全部专辑（计入每日额度；额度内直接下载，超额才需站长审批）
• <b>智能语言标签：</b> 中文模式自动为华语歌曲写入简体中文标签（欧美/古典歌手保持英文原名）；英文模式全英文标签
• <b>无损音质点选：</b> ALAC 无损 / Hi-Res / 杜比全景声 / AAC + 1400px 高清封面与内嵌/外置歌词

🌐 <b>语言设置：</b> 发送 <code>/lang</code> 可随时切换中英文（同时切换音乐文件内嵌标签语言）。`,
    firstWelcome: `👋 <b>欢迎使用 Apple Music 点歌转存助手！</b>
Welcome to Apple Music Hi-Fi Downloader!

🌐 <b>请选择您的显示语言 / Please select your preferred language:</b>`,
    langSwitched: '✅ 语言已成功切换为：<b>简体中文</b> 🇨🇳（音乐标签将对华语曲目使用简体中文）',
    resolvingSong: '🔍 <b>正在解析单曲元数据...</b>',
    resolvingAlbum: '🔍 <b>正在解析整张专辑曲目列表...</b>',
    invalidUrl: '💡 请发送有效的 Apple Music 单曲、专辑、歌单或艺人链接（支持直接粘贴手机端分享文本或纯数字歌曲 ID）。',
    tooFrequent: (sec) => `⏳ <b>操作太频繁啦！</b>\n请稍候 <code>${sec}</code> 秒后再发送新任务。（系统设置 5 秒安全间隔保护）`,
    groupTip: '💡 <b>群聊仅作为音乐档案库浏览。</b>\n请私聊我发送歌曲或专辑链接进行点歌转存哦！'
  },
  en: {
    code: 'en',
    name: 'English',
    welcome: `👋 <b>Hello! I'm your Apple Music Hi-Fi Downloader Bot.</b>

🎵 <b>How to Use:</b>
Send me any Apple Music song, album, playlist, or artist link, for example:
• <b>Song link:</b> <code>https://music.apple.com/us/album/cruel-summer/1468058165?i=1468058171</code>
• <b>Album link:</b> <code>https://music.apple.com/us/album/lover/1468058165</code>
• <b>Playlist link:</b> <code>https://music.apple.com/us/playlist/top-100-global/pl.d25f5d1181894928af76c85c967f8f31</code>
• <b>Track ID:</b> <code>1468058171</code>

⚡ <b>Highlights:</b>
• <b>Songs, Albums & Playlists:</b> Download single tracks, full albums, or playlists (200 tracks/day free quota; cached items are free!)
• <b>Multi-Select Download:</b> Tick specific tracks to batch download; archived items are delivered instantly
• <b>English Audio Tags:</b> In English mode, all <code>.m4a</code> metadata tags and filenames are written in English
• <b>Lossless Quality:</b> ALAC Lossless / Hi-Res / Dolby Atmos / AAC
• <b>Embedded Lyrics & Artwork:</b> 1400px artwork + embedded/external LRC & TTML lyrics

🌐 <b>Language:</b> Type <code>/lang</code> anytime to switch language (also switches <code>.m4a</code> tag language).`,
    firstWelcome: `👋 <b>Welcome to Apple Music Hi-Fi Downloader!</b>
欢迎使用 Apple Music 点歌转存助手！

🌐 <b>Please select your preferred language / 请选择您的显示语言:</b>`,
    langSwitched: '✅ Language switched to: <b>English</b> 🇬🇧 (Audio metadata tags & filenames will now use English)',
    resolvingSong: '🔍 <b>Resolving track metadata...</b>',
    resolvingAlbum: '🔍 <b>Resolving album tracks...</b>',
    invalidUrl: '💡 Please send a valid Apple Music song, album, playlist, or artist link (or a numeric track ID).',
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
// 每日额度持久化文件：额度若只存在内存，服务一重启就全部清零，用户瞬间拿回 200 首，
// 等于每日上限形同虚设（本项目一天内因部署重启过多次）。这里落盘保存，重启后按日期恢复。
const TG_QUOTA_STATE_FILE = path.join(__dirname, 'tg_quota_state.json');

class UserQuotaManager {
  constructor() {
    this.cooldowns = new Map();
    this.dailyUsage = new Map();
    this._saveTimer = null;
    this.loadState();
  }

  loadState() {
    try {
      if (!fs.existsSync(TG_QUOTA_STATE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(TG_QUOTA_STATE_FILE, 'utf8'));
      const today = this.getTodayStr();
      for (const [key, rec] of Object.entries(raw || {})) {
        // 只恢复今天的记录，跨天的历史数据直接丢弃
        if (rec && rec.dateStr === today && typeof rec.songCount === 'number') {
          this.dailyUsage.set(key, { dateStr: rec.dateStr, songCount: rec.songCount });
        }
      }
      if (this.dailyUsage.size) {
        console.log(`[Quota] 已恢复 ${this.dailyUsage.size} 个用户的今日额度记录`);
      }
    } catch (e) {
      console.warn('[Quota] 读取额度状态失败(忽略):', e.message);
    }
  }

  saveState() {
    // 防抖，避免批量任务里每首曲目都同步落盘
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const today = this.getTodayStr();
        const out = {};
        for (const [key, rec] of this.dailyUsage.entries()) {
          if (rec.dateStr === today) out[key] = rec;
        }
        const tmp = `${TG_QUOTA_STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
        fs.renameSync(tmp, TG_QUOTA_STATE_FILE);
      } catch (e) {
        console.warn('[Quota] 保存额度状态失败:', e.message);
      }
    }, 1000);
    if (this._saveTimer.unref) this._saveTimer.unref();
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

  getRecord(userId) {
    const today = this.getTodayStr();
    const key = String(userId);
    let record = this.dailyUsage.get(key);
    if (!record || record.dateStr !== today) {
      // songCount 为「今日已消耗曲目数」：单曲、批量勾选、整张专辑全部合并计入同一池，
      // 不再区分独立的专辑额度。
      record = { dateStr: today, songCount: 0 };
      this.dailyUsage.set(key, record);
    }
    return record;
  }

  /**
   * 查询今日剩余额度。isAlbum 参数仅为兼容旧调用签名保留，语义已统一为「曲目数」。
   */
  checkQuota(userId) {
    if (this.isOwner(userId)) return { ok: true, isOwner: true, current: 0, max: DAILY_TRACK_QUOTA, remaining: Infinity };
    const record = this.getRecord(userId);
    const remaining = Math.max(0, DAILY_TRACK_QUOTA - record.songCount);
    return {
      ok: remaining > 0,
      current: record.songCount,
      max: DAILY_TRACK_QUOTA,
      remaining
    };
  }

  /**
   * 开跑前一次性预留整单额度（原子操作）：额度不足时直接拒绝，绝不开始下载。
   * 这是「不够额度就直接不触发下载」的唯一入口，避免跑了一半才发现额度不够、
   * 白烧服务器带宽和用户时间。
   * 返回 { ok, reserved, reason, current, max, remaining }
   */
  reserveQuota(userId, trackCount) {
    const count = Math.max(0, Math.floor(Number(trackCount) || 0));
    if (this.isOwner(userId)) return { ok: true, isOwner: true, reserved: true, remaining: Infinity, current: 0, max: DAILY_TRACK_QUOTA };
    const record = this.getRecord(userId);
    const remaining = Math.max(0, DAILY_TRACK_QUOTA - record.songCount);
    if (count === 0) {
      return { ok: true, reserved: false, current: record.songCount, max: DAILY_TRACK_QUOTA, remaining };
    }
    if (count > remaining) {
      return { ok: false, reserved: false, reason: 'insufficient', current: record.songCount, max: DAILY_TRACK_QUOTA, remaining };
    }
    record.songCount += count;
    this.saveState();
    return { ok: true, reserved: true, reservedCount: count, current: record.songCount, max: DAILY_TRACK_QUOTA, remaining: DAILY_TRACK_QUOTA - record.songCount };
  }

  /**
   * 预留了但实际未消耗（如整单失败/提前中止）时，把多扣的额度退回，避免误伤用户。
   */
  refundQuota(userId, count) {
    if (this.isOwner(userId)) return;
    const refund = Math.max(0, Math.floor(Number(count) || 0));
    if (!refund) return;
    const record = this.getRecord(userId);
    record.songCount = Math.max(0, record.songCount - refund);
    this.saveState();
  }

  /**
   * 增量计数（兼容旧调用点）。统一计入曲目池。
   */
  incrementQuota(userId, count = 1) {
    if (this.isOwner(userId)) return;
    const record = this.getRecord(userId);
    record.songCount += Math.max(0, Math.floor(Number(count) || 0));
    this.saveState();
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

// 非特权用户每日总配额（单位：曲目数）。单曲、批量勾选、整张专辑全部合并计入同一个 200 首池子，
// 不再区分独立的「20 张专辑」额度。已归档秒传不消耗额度。
const DAILY_TRACK_QUOTA = parseInt(process.env.DAILY_TRACK_QUOTA || '200', 10);

/* ==================== 特权申请与审批 (TG 内审批，邮件仅提醒) ====================
 * 普通用户遇到「歌手全专辑」或「超出每日配额的歌单/专辑」时，可以申请一次授权：
 *   用户点申请 -> 机器人给站长发一条带 [同意][拒绝] 的审批消息 + 发一封提醒邮件
 *   站长点同意 -> 自动执行一次转存，产物推 Gofile，把链接同时发给申请人和站长
 *
 * 设计要点：
 *   1. 授权是「一次一单」，跑完即失效，避免用户拿一次授权无限跑。
 *   2. 频率限制对每个用户独立计算：1 小时 1 次 + 每天最多 3 次。
 *   3. 邮件只是通知（带 TG 跳转链接），审批只能在本机器人私聊里点，绝不暴露公网回调。
 *   4. SMTP 凭据只从 .env 读取，代码里不留明文（.env 已在 .gitignore）。
 */
const REQUEST_INTERVAL_MS = 60 * 60 * 1000;                     // 单个用户两次申请的最小间隔
const REQUEST_DAILY_CAP = parseInt(process.env.REQUEST_DAILY_CAP || '3', 10);
const REQUEST_STATE_FILE = path.join(__dirname, 'tg_request_state.json');
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO || 'i070314@qq.com';
const SMTP_USER = process.env.SMTP_USER || '2691394501@qq.com';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);

/** 申请状态：pending / approved / rejected，落盘防重启丢失 */
class RequestStore {
  constructor(file) {
    this.file = file;
    this.data = { seq: 0, requests: {}, throttle: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.data = { seq: raw.seq || 0, requests: raw.requests || {}, throttle: raw.throttle || {} };
        }
      }
    } catch (e) {
      console.warn('[Request] 读取申请状态失败(忽略):', e.message);
    }
  }

  save() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[Request] 保存申请状态失败:', e.message);
    }
  }

  nextId() {
    this.data.seq = (this.data.seq || 0) + 1;
    this.save();
    return this.data.seq;
  }

  get(id) {
    return this.data.requests[String(id)] || null;
  }

  put(req) {
    this.data.requests[String(req.id)] = req;
    // 只保留最近 200 条，避免文件无限增长
    const ids = Object.keys(this.data.requests).map(Number).sort((a, b) => b - a);
    for (const old of ids.slice(200)) delete this.data.requests[String(old)];
    this.save();
  }

  /** 频率检查：返回 { ok } 或 { ok:false, reason, waitSec } */
  checkThrottle(userId) {
    const key = String(userId);
    const now = Date.now();
    const today = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const rec = this.data.throttle[key] || { last: 0, day: '', count: 0 };
    if (rec.day !== today) { rec.day = today; rec.count = 0; }
    if (now - (rec.last || 0) < REQUEST_INTERVAL_MS) {
      return { ok: false, reason: 'interval', waitSec: Math.ceil((REQUEST_INTERVAL_MS - (now - rec.last)) / 1000) };
    }
    if (rec.count >= REQUEST_DAILY_CAP) {
      return { ok: false, reason: 'daily', limit: REQUEST_DAILY_CAP };
    }
    return { ok: true };
  }

  /** 记录一次成功申请 */
  markThrottle(userId) {
    const key = String(userId);
    const now = Date.now();
    const today = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const rec = this.data.throttle[key] || { last: 0, day: '', count: 0 };
    if (rec.day !== today) { rec.day = today; rec.count = 0; }
    rec.last = now;
    rec.count += 1;
    this.data.throttle[key] = rec;
    this.save();
  }
}

const requestStore = new RequestStore(REQUEST_STATE_FILE);

/** 取磁盘可用空间（GB），仅用于审批卡片上的提示 */
function getFreeDiskGBForApproval(dirPath = '/tmp') {
  try {
    const st = fs.statfsSync(dirPath);
    return (st.bavail * st.bsize) / (1024 ** 3);
  } catch {
    return null;
  }
}

/** 极简 SMTP 客户端（隐式 TLS over 465），避免为一个通知引入新依赖 */
import tls from 'node:tls';

function sendMail({ to, subject, text, html }) {
  if (!SMTP_PASS) {
    console.warn('[Mail] 未配置 SMTP_PASS，跳过邮件通知');
    return Promise.resolve({ skipped: true });
  }
  return new Promise((resolve) => {
    const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST, rejectUnauthorized: true }, () => {});
    let buffer = '';
    let step = -1; // -1 = 等待 220 问候，之后才发 EHLO
    let finished = false;

    const finish = (res) => {
      if (finished) return;
      finished = true;
      try { socket.destroy(); } catch {}
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 25000);

    // 统一响应解析：取最后一行完整的 "NNN " 响应（QQ Mail 的 220 问候不是多行）
    const CRLF = '\r\n';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(CRLF).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;   // 还没读到最后一行
      const code = Number(last.slice(0, 3));
      buffer = '';
      if (code >= 400) {
        clearTimeout(timer);
        console.warn('[Mail] SMTP refused:', code, last.slice(4, 84));
        return finish({ ok: false, error: `SMTP ${code}: ${last.slice(4, 84)}` });
      }
      if (step === -1) { step = 0; socket.write(`${steps[0]()}${CRLF}`); return; }
      if (step >= steps.length) { clearTimeout(timer); return finish({ ok: true }); }
      socket.write(`${steps[step]()}${CRLF}`);
      step++;
    };

    const steps = [
      () => `EHLO ${os.hostname() || 'am-hook'}`,
      () => 'AUTH LOGIN',
      () => Buffer.from(SMTP_USER).toString('base64'),
      () => Buffer.from(SMTP_PASS).toString('base64'),
      () => `MAIL FROM:<${SMTP_USER}>`,
      () => `RCPT TO:<${to}>`,
      () => 'DATA',
      () => [
        `From: ${SMTP_USER}`,
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(String(subject || '')).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        // 正文用 base64，避免中文与行首句点问题
        Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
        '.',
      ].join('\r\n'),
      () => 'QUIT',
    ];

    socket.setTimeout(25000);
    socket.on('timeout', () => { clearTimeout(timer); finish({ ok: false, error: 'timeout' }); });
    socket.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    socket.on('data', onData);
  }).catch((e) => ({ ok: false, error: e.message }));
}

/** 组装审批邮件正文（中英双语，带 TG 跳转链接） */
function buildRequestMail(req) {
  const when = new Date(req.createdAt + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const scale = estimateScale(req.tracks);
  const titleZh = req.titleZh;
  const titleEn = req.titleEn;
  const lines = [
    `【新申请 #${req.id}】${req.typeLabelZh}`,
    '',
    `申请人：${req.userName}${req.username ? ` (@${req.username})` : ''}`,
    `TG ID：${req.chatId}`,
    `内容：${titleZh}`,
    `规模：${scaleTextZh(scale)}`,
    `预估：${etaTextZh(scale)}`,
    `提交时间：${when} (UTC+8)`,
    `该用户今日第 ${req.dayCount} 次申请`,
    '',
    '请在 Telegram 里点按钮审批（邮件仅作提醒，不能直接批准）：',
    `https://t.me/${req.botUsername || ''}`,
    '',
    '---',
    '',
    `[New Request #${req.id}] ${req.typeLabelEn}`,
    `From: ${req.userName}${req.username ? ` (@${req.username})` : ''} (TG ID: ${req.chatId})`,
    `Details: ${titleEn}`,
    `Scale: ${scaleTextEn(scale)}`,
    `ETA: ${etaTextEn(scale)}`,
    `Submitted: ${when} (UTC+8)`,
    '',
    'Approve or reject directly in Telegram — the email is just a notification.',
  ];
  return lines.join('\n');
}

/** 由曲目数估算体积与耗时，用于审批卡片与申请回执 */
function estimateScale(tracks) {
  const n = Math.max(0, Number(tracks) || 0);
  // 实测约 25-33MB/首；按 30MB 估；ZIP 是 store 模式，体积基本等于原始音频
  const gb = (n * 30) / 1024;
  // 实测 83 首约 2 分钟（并发 2），线性外推，最少 1 分钟
  const minutes = Math.max(1, Math.round(n / 45));
  const parts = Math.ceil(gb / 3.8);
  return { tracks: n, gb, minutes, parts };
}

function scaleTextZh(s) {
  return `${s.tracks} 首 · 约 ${s.gb.toFixed(1)} GB${s.parts > 1 ? `（自动分 ${s.parts} 卷）` : ''}`;
}
function scaleTextEn(s) {
  return `${s.tracks} tracks · ~${s.gb.toFixed(1)} GB${s.parts > 1 ? ` (auto-split into ${s.parts} parts)` : ''}`;
}
function etaTextZh(s) {
  return `约 ${s.minutes} 分钟`;
}
function etaTextEn(s) {
  return `~${s.minutes} min`;
}

/** 已获批的请求再跑时不会二次扣额度（授权本身就是绕过额度），这里给 quota 管理器一个豁免标记 */
function grantQuotaExemption(chatId) {
  // 目前审批通过的任务直接调用 handleAlbumDownload(approved=true)，复用已有的额度预扣逻辑；
  // 额度不够时由调用方显式放行。保留该函数作为将来的扩展点。
}

/** 通知站长：某个 Gofile 任务已完成，附链接 */
async function notifyOwnerGofileDone({ chatId, userName, albumName, artistName, url, tracks, sizeMb, elapsedSec }) {
  try {
    const who = userName || (() => {
      try { return db.get(`name_${chatId}`) || `User ${chatId}`; } catch { return `User ${chatId}`; }
    })();
    await tgCall('sendMessage', {
      chat_id: OWNER_USER_ID,
      text: `☁️ <b>Gofile 转存完成</b>

👤 用户：${escapeHtml(who)}（<code>${chatId}</code>）
💿 ${escapeHtml(artistName || '')} — ${escapeHtml(albumName || '')}
🎵 <code>${tracks}</code> 首 · <code>${sizeMb ?? 0} MB</code> · <code>${elapsedSec}s</code>

🔗 ${escapeHtml(url)}`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '☁️ 打开 Gofile', url }]] }
    });
  } catch (e) {
    console.warn('[Notify] 给站长发完成通知失败:', e.message);
  }
}

/** 生成「申请授权」提示：超量或需要站长版功能时调用 */
async function offerApprovalRequest({ chatId, messageId, userInfo, quality, albumData, isPl, typeLabel, isEn, tracks, options = null, requestKind = 'sub' }) {
  const throttle = requestStore.checkThrottle(chatId);
  if (!throttle.ok) {
    const tip = throttle.reason === 'daily'
      ? (isEn ? `You've used all ${throttle.limit} requests today. Try again tomorrow.` : `今日申请次数已用完（${throttle.limit} 次/天），明天再来吧。`)
      : (isEn ? `Please wait ${Math.ceil(throttle.waitSec / 60)} more minutes before applying again.` : `请再等 ${Math.ceil(throttle.waitSec / 60)} 分钟后再申请。`);
    await tgCall('sendMessage', { chat_id: chatId, text: `⏳ ${tip}` });
    return;
  }

  const scale = estimateScale(tracks);
  // 让申请人在提交前就看到「批下来会用哪些参数下载」，避免批准后发现格式不是自己想要的
  const optZh = options ? [
    `🎧 音质：${options.quality || 'Lossless'}`,
    `📝 歌词：${options.embedLyricsMode === 'off' ? '不内嵌' : `内嵌 ${String(options.embedLyricsMode || 'lrc').toUpperCase()}`}`,
    `🇨🇳 中文翻译：${options.needTranslate ? '需要' : '不需要'}`,
    `あ 注音：${options.needRuby ? (options.rubyMode === 'kana' ? '平假名' : '罗马音') : '不需要'}`,
    `☁️ 交付：Gofile 云盘链接（审批单固定）`,
  ].join('\n') : '';
  const optEn = options ? [
    `🎧 Quality: ${options.quality || 'Lossless'}`,
    `📝 Lyrics: ${options.embedLyricsMode === 'off' ? 'No embed' : `Embed ${String(options.embedLyricsMode || 'lrc').toUpperCase()}`}`,
    `🇨🇳 Chinese translation: ${options.needTranslate ? 'Yes' : 'No'}`,
    `あ Ruby: ${options.needRuby ? (options.rubyMode === 'kana' ? 'Hiragana' : 'Romaji') : 'No'}`,
    `☁️ Delivery: Gofile link (fixed for approved jobs)`,
  ].join('\n') : '';

  // 把用户选好的选项编码进回调数据，避免依赖 session（申请卡是独立消息，点提交时原会话已对不上）
  // Telegram callback_data 上限 64 字节，这里用紧凑编码：
  //   q=音质  t=翻译  e=内嵌  s=外置  r=注音  m=注音模式
  //   音质缩写: L=Lossless H=Hi-Res A=Atmos C=AAC
  const QUAL_SHORT = { Lossless: 'L', 'Hi-Res': 'H', Atmos: 'A', AAC: 'C' };
  const SHORT_QUAL = { L: 'Lossless', H: 'Hi-Res', A: 'Atmos', C: 'AAC' };
  const optToken = options
    ? [
        `q=${QUAL_SHORT[options.quality] || 'L'}`,
        `t=${options.needTranslate ? 1 : 0}`,
        `e=${options.embedLyricsMode === 'ttml' ? 't' : options.embedLyricsMode === 'off' ? 'o' : 'l'}`,
        `s=${(options.saveLyricsFormats || []).map((f) => (f === 'ttml' ? 't' : 'l')).join('')}`,
        `r=${options.needRuby ? 1 : 0}`,
        `m=${options.rubyMode === 'kana' ? 'k' : 'r'}`,
      ].join(',')
    : '';

  const sent = await tgCall('sendMessage', {
    chat_id: chatId,
    text: isEn
      ? `📩 <b>Request Approval</b>\n\nThis ${typeLabel.toLowerCase()} needs admin approval (<code>${scale.tracks}</code> tracks, ~${scale.gb.toFixed(1)} GB).${optEn ? `\n\n${optEn}` : ''}\n\n⏱ The admin is in <b>UTC+8</b> and may be offline.\n⏳ Download only starts after approval.\n☁️ Result will be delivered as a <b>Gofile link</b> — please download it early, it expires after inactivity.`
      : `📩 <b>申请站长授权</b>\n\n该${typeLabel}需要站长批准（共 <code>${scale.tracks}</code> 首，约 ${scale.gb.toFixed(1)} GB）。${optZh ? `\n\n${optZh}` : ''}\n\n⏱ 站长在东八区时间（UTC+8），<b>可能不在线</b>。\n⏳ <b>审批通过后才开始下载</b>。\n☁️ 下载完成后以 <b>Gofile 链接</b>发放，<b>请尽快下载</b>，链接长期无访问会过期。`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{
        text: isEn ? '📩 Submit Request' : '📩 提交申请',
        callback_data: requestKind === 'disc'
          ? `req:disc:${albumData.albumId}:${optToken}`
          : `req:sub:${albumData.albumId}:${optToken}`
      }]]
    }
  });

  // 双保险：给这条申请卡也建一份会话，万一回调数据被截断还能从会话里取到选项
  if (sent?.message_id) {
    userSessions.set(`${chatId}_${sent.message_id}`, {
      isAlbum: true,
      albumData,
      quality: options?.quality || quality || 'Lossless',
      needLrc: true,
      embedLyricsMode: options?.embedLyricsMode || 'lrc',
      saveLyricsFormats: options?.saveLyricsFormats || [],
      needTranslate: options?.needTranslate || false,
      needRuby: options?.needRuby || false,
      rubyMode: options?.rubyMode || 'roman',
      deliveryMode: 'gofile',
      lang: isEn ? 'en' : 'zh',
      createdAt: Date.now(),
    });
  }
}

/** 申请/批准 后需要的东西，统一放在这里方便回溯 */
async function getBotUsername() {
  try {
    const me = await tgCall('getMe');
    return me?.username || '';
  } catch {
    return '';
  }
}

/** 用户提交「专辑/歌单超量」申请 */
async function submitAlbumRequest({ chatId, userInfo, albumData, quality, isPl, isEn, options = null }) {
  const tracks = (albumData.tracks || []).length;
  const scale = estimateScale(tracks);
  const titleZh = `${isPl ? '歌单' : '专辑'}《${albumData.name}》— ${albumData.artistName || '未知'}（${scale.tracks} 首，约 ${scale.gb.toFixed(1)} GB）`;
  const titleEn = `${isPl ? 'Playlist' : 'Album'} "${albumData.name}" — ${albumData.artistName || 'Unknown'} (${scale.tracks} tracks, ~${scale.gb.toFixed(1)} GB)`;

  const res = await createRequest({
    chatId,
    userInfo,
    type: isPl ? 'playlist' : 'album',
    typeLabelZh: isPl ? '超大歌单' : '超大专辑',
    typeLabelEn: isPl ? 'Oversized Playlist' : 'Oversized Album',
    titleZh,
    titleEn,
    tracks,
    noteZh: '超出每日额度或歌单过大',
    noteEn: 'Exceeds daily quota or playlist size',
    botUsername: await getBotUsername(),
    // albumData 与用户选好的选项必须随申请一起存盘（站长可能几小时后才审批，期间进程可能重启）
    payload: { albumData, quality, options },
  }).catch((e) => {
    console.warn('[Request] 提交失败:', e.message);
    return { ok: false, error: e.message };
  });

  return res;
}

/** 回执：申请提交结果（成功 / 频率拦截 / 失败） */
async function replyRequestResult(chatId, isEn, res, scale) {
  if (!res?.ok) {
    const th = res?.throttle;
    let msg;
    if (th && th.reason === 'daily') {
      msg = isEn
        ? `⏳ <b>Daily request limit reached</b> (${th.limit}/day). Try again tomorrow.`
        : `⏳ <b>今日申请次数已用完</b>（每日 ${th.limit} 次）。明天再来吧。`;
    } else if (th && th.reason === 'interval') {
      msg = isEn
        ? `⏳ <b>Please wait</b> ${Math.ceil(th.waitSec / 60)} more minutes before applying again.`
        : `⏳ <b>请稍候</b> ${Math.ceil(th.waitSec / 60)} 分钟后再申请（每小时最多 1 次）。`;
    } else {
      msg = isEn
        ? `❌ Request failed: ${escapeHtml(res?.error || 'unknown error')}`
        : `❌ 申请失败：${escapeHtml(res?.error || '未知错误')}`;
    }
    await tgCall('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  const req = res.req;
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: isEn
      ? `📩 <b>Request #${req.id} submitted</b>\n\n• Content: ${escapeHtml(req.titleEn)}\n• Scale: ${escapeHtml(scaleTextEn(scale))}\n• ETA after approval: ${escapeHtml(etaTextEn(scale))}\n\n⏱ The admin is in <b>UTC+8</b> and may be offline.\n⏳ Download starts <b>only after approval</b>.\n☁️ Result is delivered as a <b>Gofile link</b> — download it early.\n\nOne request per hour, up to ${REQUEST_DAILY_CAP} a day.`
      : `📩 <b>申请 #${req.id} 已提交</b>\n\n• 内容：${escapeHtml(req.titleZh)}\n• 规模：${escapeHtml(scaleTextZh(scale))}\n• 批准后预计耗时：${escapeHtml(etaTextZh(scale))}\n\n⏱ 站长在东八区时间（UTC+8），<b>可能不在线</b>。\n⏳ <b>审批通过后才开始下载</b>。\n☁️ 完成后以 <b>Gofile 链接</b>发放，<b>请尽快下载</b>。\n\n申请频率：每小时 1 次，每天最多 ${REQUEST_DAILY_CAP} 次。`,
    parse_mode: 'HTML'
  }).catch(() => {});
}

async function sendApprovalPrompt(req) {
  const scale = estimateScale(req.tracks);
  const freeGB = getFreeDiskGBForApproval();
  const diskLine = freeGB !== null
    ? `\n💾 磁盘可用：<code>${freeGB.toFixed(1)} GB</code>`
    : '';
  const text =
`📩 <b>新申请 #${req.id}</b>

👤 <b>申请人：</b>${escapeHtml(req.userName)}${req.username ? ` (@${escapeHtml(req.username)})` : ''}
🆔 <b>TG ID：</b><code>${req.chatId}</code>
📂 <b>类型：</b>${escapeHtml(req.typeLabelZh)}
🎵 <b>内容：</b>${escapeHtml(req.titleZh)}
📊 <b>规模：</b>${escapeHtml(scaleTextZh(scale))}
⏱ <b>预估耗时：</b><code>${etaTextZh(scale)}</code>
📅 <b>今日第 ${req.dayCount} 次申请</b>${diskLine}

${req.noteZh ? `📝 ${escapeHtml(req.noteZh)}\n\n` : ''}批准后会自动开始下载，产物推 Gofile，链接会同时发给你和申请人。`;

  const sent = await tgCall('sendMessage', {
    chat_id: OWNER_USER_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ 同意', callback_data: `apr:ok:${req.id}` },
        { text: '❌ 拒绝', callback_data: `apr:no:${req.id}` }
      ]]
    }
  });
  return sent.message_id;
}

/** 用户提交申请的统一入口 */
async function createRequest({ chatId, userInfo, type, typeLabelZh, typeLabelEn, titleZh, titleEn, tracks, noteZh, noteEn, botUsername, payload }) {
  const throttle = requestStore.checkThrottle(chatId);
  if (!throttle.ok) return { ok: false, throttle };

  const id = requestStore.nextId();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const tRec = requestStore.data.throttle[String(chatId)] || {};
  const dayCount = (tRec.day === today ? tRec.count : 0) + 1;

  const req = {
    id,
    chatId: String(chatId),
    userName: (userInfo && userInfo.name) || `User ${chatId}`,
    username: (userInfo && userInfo.username) || '',
    type,
    typeLabelZh,
    typeLabelEn,
    titleZh,
    titleEn,
    tracks: Number(tracks) || 0,
    noteZh: noteZh || '',
    noteEn: noteEn || '',
    botUsername: botUsername || '',
    status: 'pending',
    createdAt: Date.now(),
    dayCount,
    // 申请内容必须持久化：站长可能几小时后才审批，期间 TG 进程重启过也得能复原任务，
    // 否则批准后只能跑一个空任务（旧实现把 selection 只放内存，重启即丢）。
    payload: payload || {},
  };
  requestStore.put(req);
  requestStore.markThrottle(chatId);

  // 发给站长审批；失败不影响申请本身（再点一次即可）
  try {
    req.ownerMsgId = await sendApprovalPrompt(req);
    requestStore.put(req);
  } catch (e) {
    console.warn('[Request] 发送审批卡片失败:', e.message);
  }

  // 邮件只做提醒，失败不影响主流程
  sendMail({
    to: NOTIFY_EMAIL_TO,
    subject: `[am-hook] 新申请 #${id}：${typeLabelZh} — ${titleZh}`,
    text: buildRequestMail(req),
  }).catch(() => {});

  return { ok: true, req };
}



// TG 端曲目下载并发：与 am-cloud 的 CLOUD_CONCURRENCY 对齐。
// 原先三处硬编码为 2，导致 am-cloud 的 3 个队列槽只用得上 2 个，浪费三分之一处理能力。
// 2026-11-03 实测 am-cloud 最优并发为 3（71.22 MB/s @ 并发3，59.84 @ 并发4）。
const TG_TRACK_CONCURRENCY = Math.max(1, parseInt(process.env.CLOUD_CONCURRENCY || '3', 10));

// 整单额度预留台账：chatId -> 队列中【尚未对账】的预留曲目数。
// 开跑前 reserveQuota 按整单曲目数从预留，完成时按实际下载数对账多退少补，
// 这样排队中的第二个批量任务也能看到第一个任务已占用的额度，不会双重超卖。
const pendingQuotaReservations = new Map();

function addPendingReservation(chatId, count) {
  const key = String(chatId);
  const add = Math.max(0, Math.floor(Number(count) || 0));
  if (!add) return;
  pendingQuotaReservations.set(key, (pendingQuotaReservations.get(key) || 0) + add);
}

/**
 * 是否存在尚未对账的整单预留（供 transferAlbumCore 判定是否已预扣费）。
 */
function hasPendingReservation(chatId) {
  return (pendingQuotaReservations.get(String(chatId)) || 0) > 0;
}

/**
 * 整单结束对账：把预留的曲目数换成实际消耗数（多退少补），并从待对账台账移除。
 * 调用点必须保证无论成功失败都执行一次，失败时实际消耗传 0 即全额退回。
 */
function settleQuotaReservation(chatId, consumedTracks) {
  const key = String(chatId);
  const reserved = pendingQuotaReservations.get(key) || 0;
  if (!reserved) return;
  pendingQuotaReservations.delete(key);
  const consumed = Math.max(0, Math.floor(Number(consumedTracks) || 0));
  const delta = consumed - reserved;
  if (delta > 0) quotaManager.incrementQuota(chatId, delta);
  else if (delta < 0) quotaManager.refundQuota(chatId, -delta);
}

/**
 * 查询云端队列状态，用于「排队中」提示。失败返回 null（不阻塞主流程）。
 */
async function fetchQueueStatus() {
  try {
    const url = QUEUE_API.replace(/\/api\/queue-status$/, '/queue');
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data || null;
  } catch {
    return null;
  }
}

/**
 * 如果当前队列有积压，给用户发一条「排队中」提示（提示完即返回，不等待）。
 * 返回 true 表示已经提示过，调用方可选择跳过后续的普通进度文案。
 */
async function notifyQueueIfBusy(chatId, messageId, isEn, scopeLabel = '') {
  const q = await fetchQueueStatus();
  if (!q || !q.waiting) return false;
  const others = q.running?.[0]?.name ? `（${escapeHtml(q.running[0].name)}）` : '';
  const text = isEn
    ? `⏳ <b>Queued behind ${q.waiting} other task${q.waiting > 1 ? 's' : ''}${others}</b>\n\nServer processes transfers one at a time to keep speed stable. Yours will start automatically${scopeLabel ? ` (${scopeLabel})` : ''}.\n\n💡 Tip: switch to ☁️ <b>Gofile mode</b> to skip the queue and get a link much faster.`
    : `⏳ <b>已加入队列，前面还有 ${q.waiting} 个任务${others}</b>\n\n为保证速度稳定，服务器按顺序处理转存，轮到你会自动开始${scopeLabel ? `（${scopeLabel}）` : ''}。\n\n💡 提示：切换为 ☁️ <b>Gofile 模式</b> 可以跳过排队，更快拿到链接。`;
  await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  }).catch(() => {});
  return true;
}

/**
 * 轻量高可用并发执行器 (Worker Pool)
 * 严格保留任务序号，任务内部异常由各调用方自适应捕获
 */
async function pMap(items, concurrency, mapperFn) {  const results = new Array(items.length);
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

/**
 * sendMediaGroup 发送节流：两次媒体组之间至少间隔 N 秒。
 *
 * 为什么需要：批量转存时多个下载任务并发完成，媒体组会在极短时间内密集推送，
 * 必然触发 Telegram 429 限流。而限流重试存在「实际已发送但返回 429」的边界情况，
 * 重试就会让用户在频道里看到重复的两组卡片。
 * 从源头拉开间隔，比事后重试更可靠。代价是整体慢几十秒，属可接受开销。
 */
const TG_MEDIA_GROUP_INTERVAL_MS = Math.max(0, parseInt(process.env.TG_MEDIA_GROUP_INTERVAL_MS || '4000', 10));
let lastMediaGroupAt = 0;
let mediaGroupChain = Promise.resolve();

async function throttleMediaGroup() {
  if (TG_MEDIA_GROUP_INTERVAL_MS <= 0) return;
  // 串行化：并发调用时排队，保证任意两次发送之间有固定间隔
  const run = async () => {
    const wait = lastMediaGroupAt + TG_MEDIA_GROUP_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastMediaGroupAt = Date.now();
  };
  mediaGroupChain = mediaGroupChain.then(run, run);
  return mediaGroupChain;
}

async function tgSendMediaGroup(chatId, mediaArray, filesMap = {}, maxRetries = 2) {
  let attempt = 0;
  const isLocalApi = TG_API_BASE.includes('127.0.0.1') || TG_API_BASE.includes('localhost');

  // 发送前先排队节流，避免多个并发任务同一时刻扎堆推送
  await throttleMediaGroup();

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
          // 重试前再过一次节流队列，避免与其他并发任务叠加再次撞限流
          await throttleMediaGroup();
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
  replyToMessageId = null,
  privateCopy = true
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

  // 若用户私聊不是归档频道本身，则秒级调用 copyMessage 瞬发给用户私聊 (批量场景可关闭，由调用方最后统一推送)
  if (privateCopy && String(chatId) !== String(AUTHORIZED_GROUP_ID)) {
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
        const isEn = getUserLang(item.meta.chatId) === 'en';
        try {
          await tgCall('editMessageText', {
            chat_id: item.meta.chatId,
            message_id: item.meta.messageId,
            text: isEn
              ? `⏳ <b>Added to global download queue (Position #${pos})</b>\nAnother task is currently in progress. Tasks run in strict FIFO order to keep bandwidth stable—yours will start automatically as soon as the queue clears.`
              : `⏳ <b>已加入全局下载队列 (排在第 ${pos} 位)</b>\n当前有其他任务正在下载处理中。为保护服务器负载与带宽稳定，系统严格按先后顺序执行，前面的任务完成后将立即自动开始您的下载，请耐心稍候...`,
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
        const isEn = getUserLang(remaining.meta.chatId) === 'en';
        try {
          await tgCall('editMessageText', {
            chat_id: remaining.meta.chatId,
            message_id: remaining.meta.messageId,
            text: isEn
              ? `⏳ <b>Queue updated (Moved up to #${newPos})</b>\nWaiting for preceding tasks to finish, your transfer will start shortly...`
              : `⏳ <b>下载队列更新 (当前前进至第 ${newPos} 位)</b>\n正在等待前序任务完成，即将开始处理您的转存...`,
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

function catalogLangFor(sf, isEn = false) {
  const c = String(sf || 'hk').toLowerCase();
  if (isEn) return (c === 'us' || c === 'jp') ? 'en-US' : 'en-GB';
  if (c === 'hk') return 'zh-Hant-HK';
  if (c === 'tw') return 'zh-Hant-TW';
  if (c === 'cn' || c === 'us') return 'zh-Hans-CN';
  if (c === 'jp') return 'ja';
  return 'en-GB';
}

/**
 * 用户显式设定了标签语言（不是 auto）时，用它作为「首选语言」；
 * 但需按地区做一次可用性探测：Apple Music 对不支持的语言会静默回退，
 * 所以要先确认该地区返回的 audioLocale 主标签与目标一致，否则不采用。
 * @returns {Promise<string|null>} 该地区可安全使用的语言标签；null 表示沿用默认策略
 */
async function probeCatalogLang(sf, tagLang) {
  const target = String(tagLang || '').toLowerCase().split('-')[0];
  if (!target) return null;
  const fallback = catalogLangFor(sf, true);
  const candidates = [tagLang, target === String(fallback).toLowerCase().split('-')[0] ? null : fallback].filter(Boolean);
  for (const cand of candidates) {
    try {
      const res = await fetch(`${HOOK_BASE}/amp/v1/storefronts/${sf}`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const info = (await res.json()).data?.[0]?.attributes;
        const tags = info?.supportedLanguageTags || [];
        if (tags.length) {
          const hit = tags.find((t) => String(t).toLowerCase() === String(cand).toLowerCase()) ||
            tags.find((t) => String(t).toLowerCase().split('-')[0] === String(cand).toLowerCase().split('-')[0]);
          if (hit) return hit;
          return tags.includes(fallback) ? fallback : tags[0];
        }
      }
    } catch {}
    return cand;
  }
  return null;
}

async function fetchSongDetails(songId, storefront = 'hk', lang = 'zh', tagLang = null) {
  const isEn = lang === 'en';
  const explicitTag = tagLang && tagLang !== 'auto' ? String(tagLang) : null;
  const tagPrimary = explicitTag ? primarySubtag(explicitTag) : null;

  let variants = [];
  try {
    const pRes = await fetch(`${HOOK_BASE}/parse/song/${songId}`, { signal: AbortSignal.timeout(8000) });
    if (pRes.ok) {
      const pData = await pRes.json();
      variants = pData.variants || [];
    }
  } catch {}
  const traits = buildTraits(variants);

  // 用户显式指定了标签语言（非中文/英文两条既定策略）：按该语言跨区扫描取匹配结果
  if (explicitTag && tagPrimary !== 'zh' && tagPrimary !== 'en') {
    const attr = await fetchAttrsInTargetLang(
      (sf, l) => `/amp/v1/catalog/${sf}/songs/${songId}?l=${encodeURIComponent(l)}`,
      explicitTag
    );
    if (attr) return buildSongDetailsResult(songId, attr, { isEn, explicitTag, traits });
  }

  let storefronts;
  if (isEn) {
    // 外国用户：优先美区/原区/英区/港区拉取官方英文元数据
    storefronts = ['us', storefront, 'gb', 'hk', 'tw', 'cn', 'tr'].filter((v, i, a) => a.indexOf(v) === i);
  } else if (storefront === 'jp' || storefront === 'kr') {
    storefronts = [storefront, 'tr', 'us', 'hk', 'tw', 'cn'];
  } else {
    // 中文模式：先从 tr/us/原区获取原始元数据（保留外国歌手英文原名与 audioLocale），再对确属华语曲目精准补全中文
    storefronts = ['tr', storefront, 'us', 'hk', 'tw', 'cn'].filter((v, i, a) => a.indexOf(v) === i);
  }
  storefronts = storefronts.filter((v, i, a) => a.indexOf(v) === i);

  let songAttr = null;
  for (const sf of storefronts) {
    try {
      // 显式标签语言优先（经可用性探测），否则沿用中英策略
      const probed = explicitTag ? await probeCatalogLang(sf, explicitTag) : null;
      const l = probed || ((sf === 'jp' && !isEn) ? 'ja' : catalogLangFor(sf, true));
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/songs/${songId}?l=${l}`, { signal: AbortSignal.timeout(5000) });
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
    throw new Error(isEn
      ? `Failed to fetch track metadata (${songId}) from Apple Music. Please check the link or regional availability.`
      : `未能从 Apple Music 获取到歌曲 (${songId}) 的元数据，请检查链接或版权`);
  }

  // 显式标签语言：若当前结果不是目标语言，再跨区找一份真正匹配的
  if (explicitTag) {
    if (primarySubtag(songAttr.audioLocale) !== tagPrimary) {
      const better = await fetchAttrsInTargetLang(
        (sf, l) => `/amp/v1/catalog/${sf}/songs/${songId}?l=${encodeURIComponent(l)}`,
        explicitTag
      );
      if (better && primarySubtag(better.audioLocale) === tagPrimary) songAttr = better;
    }
    return buildSongDetailsResult(songId, songAttr, { isEn, explicitTag, traits });
  }

  let title = isEn ? (songAttr.name || '') : toSimplifiedChinese(songAttr.name);
  let artist = normalizeArtistName(songAttr.artistName, isEn);
  let album = isEn ? (songAttr.albumName || '') : toSimplifiedChinese(songAttr.albumName);
  let albumArtist = normalizeArtistName(songAttr.albumArtistName || songAttr.artistName, isEn);
  let composer = normalizeArtistName(songAttr.composerName, isEn);

  if (isEn) {
    // 外国用户若因源区仅有汉字而拿到中文名，按各区支持的英文语言码拉取英文名
    if (/[\u4e00-\u9fa5]/.test(title + artist + album)) {
      for (const enSf of ['us', 'gb', 'hk', 'tw', 'cn', 'tr']) {
        try {
          const enLang = catalogLangFor(enSf, true);
          const enRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${enSf}/songs/${songId}?l=${enLang}`, { signal: AbortSignal.timeout(3000) });
          if (enRes.ok) {
            const enAttr = (await enRes.json()).data?.[0]?.attributes;
            if (enAttr) {
              if (enAttr.name) title = enAttr.name;
              if (enAttr.artistName) {
                artist = enAttr.artistName;
                albumArtist = enAttr.albumArtistName || enAttr.artistName;
              }
              if (enAttr.albumName) album = enAttr.albumName;
              if (!/[\u4e00-\u9fa5]/.test(title + artist)) break;
            }
          }
        } catch {}
      }
    }
  } else {
    // 1) 日语曲目（audioLocale=ja 或 J-Pop/Anime）：向日区拉取日文原名
    const isJapanese = (songAttr.audioLocale || '').toLowerCase() === 'ja' ||
      (songAttr.genreNames || []).some(g => /j-pop|anime|japanese|アニメ/i.test(g)) ||
      /[\u3040-\u309F\u30A0-\u30FF]/.test(title + artist + album);
    if (isJapanese && !/[\u3040-\u309F\u30A0-\u30FF]/.test(title)) {
      try {
        const jpRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/jp/songs/${songId}?l=ja`, { signal: AbortSignal.timeout(3000) });
        if (jpRes.ok) {
          const jAttr = (await jpRes.json()).data?.[0]?.attributes;
          if (jAttr) {
            if (jAttr.name) title = jAttr.name;
            if (jAttr.artistName) {
              artist = jAttr.artistName;
              albumArtist = jAttr.albumArtistName || jAttr.artistName;
            }
            if (jAttr.albumName) album = jAttr.albumName;
          }
        }
      } catch {}
    } else if (!isJapanese) {
      // 2) 中文模式：向 ['cn', 'us', 'hk', 'tw'] 嗅探华语元数据；
      //    若远端歌名不含汉字、audioLocale 非华语，且艺人名含外文音译间隔号（· / ・，如「伊戈尔・列维特」「维伦·格罗弗」），
      //    判定为外国艺人音译，立即终止嗅探，保留英文原名！
      if (!/[\u4e00-\u9fa5]/.test(artist) || !/[\u4e00-\u9fa5]/.test(title) || !/[\u4e00-\u9fa5]/.test(album)) {
        for (const zhSf of ['cn', 'us', 'hk', 'tw']) {
          try {
            const zhLang = catalogLangFor(zhSf, false);
            const cnRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${zhSf}/songs/${songId}?l=${zhLang}`, { signal: AbortSignal.timeout(3000) });
            if (cnRes.ok) {
              const cData = await cnRes.json();
              const cAttr = cData.data?.[0]?.attributes;
              if (cAttr) {
                const localeIsZh = /^(zh|cmn|yue|hak|nan)/i.test(cAttr.audioLocale || songAttr.audioLocale || '');
                const isTransliteratedForeign = !localeIsZh &&
                  !isChineseGenre(cAttr.genreNames) &&
                  !isChineseGenre(songAttr.genreNames) &&
                  !/[\u4e00-\u9fa5]/.test(cAttr.name || '') &&
                  /[·・]/.test(cAttr.artistName || '');
                if (isTransliteratedForeign) break;

                if (!/[\u4e00-\u9fa5]/.test(artist) && cAttr.artistName && /[\u4e00-\u9fa5]/.test(cAttr.artistName)) {
                  artist = normalizeArtistName(toSimplifiedChinese(cAttr.artistName));
                  albumArtist = artist;
                }
                if (!/[\u4e00-\u9fa5]/.test(title) && cAttr.name && /[\u4e00-\u9fa5]/.test(cAttr.name)) {
                  title = toSimplifiedChinese(cAttr.name);
                }
                if (cAttr.albumName && (!album || !/[\u4e00-\u9fa5]/.test(album)) && /[\u4e00-\u9fa5]/.test(cAttr.albumName)) {
                  album = toSimplifiedChinese(cAttr.albumName);
                }
                if (/[\u4e00-\u9fa5]/.test(artist) && /[\u4e00-\u9fa5]/.test(title) && /[\u4e00-\u9fa5]/.test(album)) {
                  break;
                }
              }
            }
          } catch {}
        }
      }
    }
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
    genre: (songAttr.genreNames || []).map(g => isEn ? g : toSimplifiedChinese(g)).join('/'),
    composer,
    hasLyrics: Boolean(songAttr.hasLyrics),
    coverUrl: (songAttr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    traits
  };
}

/** 从 parse/song 的 variants 推导可用的音质标记 */
function buildTraits(variants) {
  return {
    lossless: variants.some(v => v.codecs === 'alac') || true,
    hires: variants.some(v => v.codecs === 'alac' && (v.sample_rate > 48000 || v.bit_depth > 16)),
    atmos: variants.some(v => (v.codecs && v.codecs.includes('ec-3')) || (v.group_id && v.group_id.includes('atmos'))),
    aac: variants.some(v => v.codecs && v.codecs.includes('mp4a')) || true
  };
}

/**
 * 显式标签语言命中时，直接由远端 attributes 组装结果：
 * 名字**不做**繁简转换、不做华语别名映射、不做跨区嗅探——用户要的就是这个语言的原样。
 */
function buildSongDetailsResult(songId, attr, { isEn, explicitTag, traits }) {
  return {
    songId,
    title: attr.name || '',
    artist: attr.artistName || '',
    album: attr.albumName || '',
    albumArtist: attr.albumArtistName || attr.artistName || '',
    releaseDate: attr.releaseDate,
    durationInMillis: attr.durationInMillis,
    trackNumber: attr.trackNumber,
    discNumber: attr.discNumber,
    genre: (attr.genreNames || []).join('/'),
    composer: attr.composerName || '',
    hasLyrics: Boolean(attr.hasLyrics),
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    traits,
    tagLang: explicitTag || null
  };
}

async function fetchAlbumDetails(albumId, storefront = 'hk', lang = 'zh', tagLang = null) {
  const isEn = lang === 'en';
  const explicitTag = tagLang && tagLang !== 'auto' ? String(tagLang) : null;
  // tr 优先：专辑曲目 ID 必须与土区 wrapper 账号一致，避免跨区 adamId 不匹配
  let storefronts = ['tr', storefront, 'us', 'cn', 'hk', 'tw'].filter((v, i, a) => a.indexOf(v) === i);

  // 显式标签语言：先用本地化名称（专辑名/艺人名/曲目名），但**曲目 ID 仍取自 tr**（不改结构）
  let locByName = new Map();
  let locArtistName = null;
  let locAlbumName = null;
  if (explicitTag) {
    const target = primarySubtag(explicitTag);
    for (const sf of ['tr', 'us', 'hk', 'tw', 'cn', 'jp']) {
      try {
        const l = await probeCatalogLang(sf, explicitTag) || explicitTag;
        const r = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/albums/${albumId}?l=${encodeURIComponent(l)}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const d = (await r.json()).data?.[0];
        if (!d?.attributes) continue;
        // 用 album 的 audioLocale 判断这份是不是真的目标语言
        const hit = primarySubtag(d.attributes.audioLocale || '') === target;
        if (hit) {
          if (d.attributes.name) locAlbumName = d.attributes.name;
          if (d.attributes.artistName) locArtistName = d.attributes.artistName;
          const trs = d.relationships?.tracks?.data || [];
          for (const t of trs) if (t.id && t.attributes?.name) locByName.set(String(t.id), t.attributes.name);
          break;
        }
      } catch {}
    }
  }

  let albumData = null;
  for (const sf of storefronts) {
    try {
      const l = catalogLangFor(sf, isEn);
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/albums/${albumId}?l=${l}`, { signal: AbortSignal.timeout(6000) });
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
    throw new Error(isEn ? `Failed to fetch album details (${albumId})` : `未能获取到专辑信息 (${albumId})`);
  }

  const attr = albumData.attributes || {};
  let tracks = albumData.relationships?.tracks?.data || [];

  // 显式标签语言：直接返回本地化名称，不做繁简转换与嗅探
  if (explicitTag) {
    return {
      albumId,
      name: locAlbumName || attr.name || '',
      artistName: locArtistName || attr.artistName || '',
      releaseDate: attr.releaseDate,
      coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
      tracks: tracks.map((t) => ({
        id: t.id,
        name: locByName.get(String(t.id)) || t.attributes?.name || 'Track',
        trackNumber: t.attributes?.trackNumber,
        artistName: t.attributes?.artistName || locArtistName || attr.artistName || ''
      })),
      tagLang: explicitTag
    };
  }
  let albumName = isEn ? (attr.name || '') : toSimplifiedChinese(attr.name);
  let artistName = normalizeArtistName(attr.artistName, isEn);

  let zhTrackTitleById = new Map();
  let zhTrackTitleByIndex = [];
  if (!isEn) {
    // 中文模式：仅在确属华语专辑/华语歌手时向 ['cn', 'us', 'hk', 'tw'] 补全中文专辑名、艺人名与曲目名，避免外国专辑被翻成译名
    const isGenuineChinese = /[\u4e00-\u9fa5]/.test(albumName + artistName) ||
      isChineseArtistAlias(attr.artistName) ||
      isChineseGenre(attr.genreNames) ||
      tracks.some(t => /[\u4e00-\u9fa5]/.test(t.attributes?.name || '') || /^(zh|cmn|yue)/i.test(t.attributes?.audioLocale || ''));
    const tracksMissingZh = tracks.some(t => !/[\u4e00-\u9fa5]/.test(t.attributes?.name || ''));
    if (isGenuineChinese && (!/[\u4e00-\u9fa5]/.test(artistName) || !/[\u4e00-\u9fa5]/.test(albumName) || tracksMissingZh)) {
      for (const zhSf of ['cn', 'us', 'hk', 'tw']) {
        try {
          const zhLang = catalogLangFor(zhSf, false);
          const cnRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${zhSf}/albums/${albumId}?l=${zhLang}`, { signal: AbortSignal.timeout(4000) });
          if (cnRes.ok) {
            const cData = await cnRes.json();
            const cAlb = cData.data?.[0];
            const cAttr = cAlb?.attributes;
            if (cAttr) {
              if (!/[\u4e00-\u9fa5]/.test(artistName) && cAttr.artistName && /[\u4e00-\u9fa5]/.test(cAttr.artistName)) {
                artistName = normalizeArtistName(toSimplifiedChinese(cAttr.artistName));
              }
              if (!/[\u4e00-\u9fa5]/.test(albumName) && cAttr.name && /[\u4e00-\u9fa5]/.test(cAttr.name)) {
                albumName = toSimplifiedChinese(cAttr.name);
              }
              const cTracks = cAlb?.relationships?.tracks?.data || [];
              if (cTracks.length && cTracks.some(ct => /[\u4e00-\u9fa5]/.test(ct.attributes?.name || ''))) {
                for (const ct of cTracks) {
                  if (ct.id && ct.attributes?.name && /[\u4e00-\u9fa5]/.test(ct.attributes.name)) {
                    zhTrackTitleById.set(String(ct.id), toSimplifiedChinese(ct.attributes.name));
                  }
                }
                if (cTracks.length === tracks.length) {
                  zhTrackTitleByIndex = cTracks.map(ct => ct.attributes?.name ? toSimplifiedChinese(ct.attributes.name) : '');
                }
              }
              if (/[\u4e00-\u9fa5]/.test(artistName) && /[\u4e00-\u9fa5]/.test(albumName) && zhTrackTitleById.size > 0) {
                break;
              }
            }
          }
        } catch {}
      }
    }
  }

  return {
    albumId,
    name: albumName,
    artistName: artistName,
    releaseDate: attr.releaseDate,
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    tracks: tracks.map((t, idx) => {
      const rawTrackName = t.attributes?.name || 'Track';
      const zhName = !isEn ? (zhTrackTitleById.get(String(t.id)) || zhTrackTitleByIndex[idx] || toSimplifiedChinese(rawTrackName)) : rawTrackName;
      return {
        id: t.id,
        name: isEn ? rawTrackName : zhName,
        trackNumber: t.attributes?.trackNumber,
        artistName: normalizeArtistName(t.attributes?.artistName || artistName, isEn)
      };
    })
  };
}

async function fetchPlaylistDetails(playlistId, storefront = 'hk', lang = 'zh', tagLang = null) {
  const isEn = lang === 'en';
  const explicitTag = tagLang && tagLang !== 'auto' ? String(tagLang) : null;
  // tr 优先：wrapper-lite 是土区账号，曲目 ID 必须从土区目录解析，否则跨区 adamId 不匹配导致误判无版权
  let storefronts = ['tr', storefront, 'us', 'cn', 'hk', 'tw'].filter((v, i, a) => a.indexOf(v) === i);
  // 显式标签语言：歌单名/策展人/曲目名优先用本地化版本，曲目 ID 仍取自列表结构
  let locByName = new Map();
  let locName = null;
  let locCurator = null;
  if (explicitTag) {
    const target = primarySubtag(explicitTag);
    for (const sf of ['tr', 'us', 'hk', 'tw', 'cn', 'jp']) {
      try {
        const l = await probeCatalogLang(sf, explicitTag) || explicitTag;
        const r = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/playlists/${playlistId}?l=${encodeURIComponent(l)}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const d = (await r.json()).data?.[0];
        if (!d?.attributes) continue;
        if (primarySubtag(d.attributes.audioLocale || '') !== target) continue;
        locName = d.attributes.name || null;
        locCurator = d.attributes.curatorName || null;
        for (const t of (d.relationships?.tracks?.data || [])) {
          if (t.id && t.attributes?.name) locByName.set(String(t.id), t.attributes.name);
        }
        break;
      } catch {}
    }
  }
  let plResolved = null;
  let plSf = null;
  for (const sf of storefronts) {
    try {
      const l = catalogLangFor(sf, isEn);
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/playlists/${playlistId}?l=${l}`, { signal: AbortSignal.timeout(6000) });
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
    throw new Error(isEn ? `Failed to fetch playlist details (${playlistId})` : `未能获取到歌单信息 (${playlistId})`);
  }

  const attr = plResolved.attributes || {};

  // 分页拉取全部曲目
  const allTracks = [];
  let nextOffset = 0;
  let guard = 0;
  const plLang = catalogLangFor(plSf, isEn);
  while (guard < 60) {
    guard++;
    let page = null;
    try {
      const tRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${plSf}/playlists/${playlistId}/tracks?l=${plLang}&offset=${nextOffset}`, { signal: AbortSignal.timeout(6000) });
      if (tRes.ok) page = await tRes.json();
    } catch {}
    if (!page || !page.data || !page.data.length) break;
    allTracks.push(...page.data);
    const next = page.next;
    if (!next) break;
    const m = String(next).match(/offset=(\d+)/);
    const newOffset = m ? parseInt(m[1], 10) : NaN;
    if (!(newOffset > nextOffset)) break;
    nextOffset = newOffset;
  }

  if (explicitTag) {
    return {
      albumId: playlistId,
      isPlaylist: true,
      name: locName || attr.name || 'Playlist',
      artistName: locCurator || attr.curatorName || 'Apple Music',
      releaseDate: attr.lastModifiedDate ? attr.lastModifiedDate.slice(0, 10) : 'Recent',
      coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
      tracks: allTracks.map((t, idx) => ({
        id: t.id,
        name: locByName.get(String(t.id)) || t.attributes?.name || 'Track',
        trackNumber: idx + 1,
        artistName: t.attributes?.artistName || 'Various Artists'
      })),
      tagLang: explicitTag
    };
  }

  return {
    albumId: playlistId,
    isPlaylist: true,
    name: isEn ? (attr.name || 'Playlist') : toSimplifiedChinese(attr.name || 'Playlist'),
    artistName: isEn ? (attr.curatorName || 'Apple Music') : toSimplifiedChinese(attr.curatorName || 'Apple Music'),
    releaseDate: attr.lastModifiedDate ? attr.lastModifiedDate.slice(0, 10) : (isEn ? 'Recent' : '近期'),
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    tracks: allTracks.map((t, idx) => ({
      id: t.id,
      name: isEn ? (t.attributes?.name || 'Track') : toSimplifiedChinese(t.attributes?.name || 'Track'),
      trackNumber: idx + 1,
      artistName: normalizeArtistName(t.attributes?.artistName || 'Various Artists', isEn)
    }))
  };
}

async function fetchArtistDetails(artistId, storefront = 'hk', lang = 'zh', tagLang = null) {
  const isEn = lang === 'en';
  const explicitTag = tagLang && tagLang !== 'auto' ? String(tagLang) : null;
  // tr 优先：top-songs/full-albums 里的曲目 ID 必须与土区 wrapper 账号一致
  let storefronts = ['tr', storefront, 'us', 'cn', 'hk', 'tw'].filter((v, i, a) => a.indexOf(v) === i);
  let artistData = null;
  let resolvedSf = 'tr';
  const viewNames = 'top-songs,full-albums,live-albums,singles,compilation-albums';
  for (const sf of storefronts) {
    try {
      const l = (explicitTag ? await probeCatalogLang(sf, explicitTag) : null) || catalogLangFor(sf, isEn);
      const res = await fetch(`${HOOK_BASE}/amp/v1/catalog/${sf}/artists/${artistId}?views=${viewNames}&l=${l}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        if (data.data?.[0]) {
          artistData = data.data[0];
          resolvedSf = sf;
          break;
        }
      }
    } catch {}
  }

  if (!artistData) {
    throw new Error(isEn ? `Failed to fetch artist details (${artistId})` : `未能获取到艺人信息 (${artistId})`);
  }

  // 分页拉取指定 view 的全部条目（解决默认只返回前 10 张专辑的问题）
  async function fetchAllViewItems(viewObj, maxPages = 10) {
    if (!viewObj) return [];
    const items = [...(viewObj.data || [])];
    let nextUrl = viewObj.next;
    let pageCount = 0;
    while (nextUrl && pageCount < maxPages) {
      pageCount++;
      try {
        const sep = nextUrl.includes('?') ? '&' : '?';
        const pageRes = await fetch(`${HOOK_BASE}/amp${nextUrl}${sep}limit=100`, { signal: AbortSignal.timeout(6000) });
        if (!pageRes.ok) break;
        const pageJson = await pageRes.json();
        if (!pageJson.data?.length) break;
        items.push(...pageJson.data);
        nextUrl = pageJson.next;
      } catch {
        break;
      }
    }
    return items;
  }

  const attr = artistData.attributes || {};
  const views = artistData.views || {};
  const [rawTopSongs, fullAlbums, liveAlbums, singleAlbums, compAlbums] = await Promise.all([
    fetchAllViewItems(views['top-songs'], 2),
    fetchAllViewItems(views['full-albums'], 10),
    fetchAllViewItems(views['live-albums'], 5),
    fetchAllViewItems(views['singles'], 10),
    fetchAllViewItems(views['compilation-albums'], 5)
  ]);

  // 中文模式下：若确属华语歌手，向 us/hk/cn 拉取全量中文专辑名与歌名映射（保留 tr 曲目/专辑 ID）
  const zhAlbumNameMap = new Map();
  const zhSongNameMap = new Map();
  let zhArtistName = '';
  const isGenuineChinese = !isEn && (
    /[\u4e00-\u9fa5]/.test(attr.name || '') ||
    isChineseArtistAlias(attr.name) ||
    isChineseGenre(attr.genreNames)
  );
  if (isGenuineChinese) {
    for (const zhSf of ['us', 'hk', 'cn', 'tw']) {
      if (zhSf === resolvedSf && /[\u4e00-\u9fa5]/.test(attr.name || '')) break;
      try {
        const zhLang = catalogLangFor(zhSf, false);
        const zhRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/${zhSf}/artists/${artistId}?views=${viewNames}&l=${zhLang}`, { signal: AbortSignal.timeout(6000) });
        if (!zhRes.ok) continue;
        const zhData = (await zhRes.json()).data?.[0];
        if (!zhData) continue;
        if (zhData.attributes?.name && /[\u4e00-\u9fa5]/.test(zhData.attributes.name)) {
          zhArtistName = normalizeArtistName(toSimplifiedChinese(zhData.attributes.name));
        }
        const zViews = zhData.views || {};
        const zLists = await Promise.all([
          fetchAllViewItems(zViews['full-albums'], 5),
          fetchAllViewItems(zViews['live-albums'], 3),
          fetchAllViewItems(zViews['singles'], 5),
          fetchAllViewItems(zViews['compilation-albums'], 3)
        ]);
        for (const list of zLists) {
          for (const al of list) {
            if (al.id && al.attributes?.name && /[\u4e00-\u9fa5]/.test(al.attributes.name)) {
              zhAlbumNameMap.set(String(al.id), toSimplifiedChinese(al.attributes.name));
            }
          }
        }
        for (const s of (zViews['top-songs']?.data || [])) {
          if (s.id && s.attributes?.name && /[\u4e00-\u9fa5]/.test(s.attributes.name)) {
            zhSongNameMap.set(String(s.id), toSimplifiedChinese(s.attributes.name));
          }
        }
        if (zhAlbumNameMap.size > 0) break;
      } catch {}
    }
  }

  const finalArtistName = explicitTag
    ? (zhArtistName || attr.name || 'Artist')
    : (isEn
      ? (attr.name || 'Artist')
      : (zhArtistName || normalizeArtistName(toSimplifiedChinese(attr.name || 'Artist'))));

  const topSongs = rawTopSongs.slice(0, 40).map(s => {
    const rawName = s.attributes?.name || 'Song';
    return {
      id: s.id,
      name: explicitTag
        ? (zhSongNameMap.get(String(s.id)) || rawName)
        : (isEn ? rawName : (zhSongNameMap.get(String(s.id)) || toSimplifiedChinese(rawName))),
      // 显式标签语言时不做华语艺名映射，保持官方原样
      artistName: explicitTag
        ? (s.attributes?.artistName || finalArtistName)
        : normalizeArtistName(s.attributes?.artistName || finalArtistName, isEn),
      durationInMillis: s.attributes?.durationInMillis || 0
    };
  });

  // 按「录音室专辑 -> Live 专辑 -> 单曲与 EP -> 精选辑」顺序合并去重
  const albumMap = new Map();
  const pushAlbums = (list, kind) => {
    for (const al of list) {
      if (!al || !al.id || albumMap.has(String(al.id))) continue;
      const rawName = al.attributes?.name || 'Album';
      albumMap.set(String(al.id), {
        id: al.id,
        kind, // 'full' | 'live' | 'single' | 'comp'
        name: explicitTag
          ? (zhAlbumNameMap.get(String(al.id)) || rawName)
          : (isEn ? rawName : (zhAlbumNameMap.get(String(al.id)) || toSimplifiedChinese(rawName))),
        releaseDate: al.attributes?.releaseDate || '',
        trackCount: al.attributes?.trackCount || 0
      });
    }
  };
  pushAlbums(fullAlbums, 'full');
  pushAlbums(liveAlbums, 'live');
  pushAlbums(singleAlbums, 'single');
  pushAlbums(compAlbums, 'comp');
  const albums = Array.from(albumMap.values());
  const studioCount = albums.filter(a => a.kind === 'full').length;

  rememberArtistName(artistId, finalArtistName);
  return {
    artistId,
    name: finalArtistName,
    genre: (attr.genreNames && attr.genreNames[0]) || '',
    coverUrl: (attr.artwork?.url || '').replace('{w}x{h}', '600x600'),
    topSongs,
    albums,
    studioCount
  };
}

function buildArtistCard(artistData, lang = 'zh') {
  const isEn = lang === 'en';
  const totalReleases = artistData.albums.length;
  const studioCount = artistData.studioCount || totalReleases;
  const otherCount = Math.max(0, totalReleases - studioCount);
  const text = isEn ?
`👤 <b>Artist Profile: ${escapeHtml(artistData.name)}</b>
🎸 <b>Genre:</b> ${artistData.genre || 'Various'}
🔥 <b>Top Songs:</b> ${artistData.topSongs.length} tracks available
💿 <b>All Releases:</b> ${totalReleases} total (${studioCount} Studio Albums${otherCount ? ` + ${otherCount} Live/Singles/EPs` : ''})

Please choose to browse top songs or full discography below:` :
`👤 <b>艺人主页：${escapeHtml(artistData.name)}</b>
🎸 <b>流派风格：</b>${artistData.genre || '综合'}
🔥 <b>热门曲目：</b>共 ${artistData.topSongs.length} 首收录
💿 <b>全部作品：</b>共 ${totalReleases} 张（含 ${studioCount} 张录音室专辑${otherCount ? ` + ${otherCount} 张 Live/单曲/EP` : ''}）

请在下方选择浏览热门曲目或全部专辑：`;

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
        text: isEn ? `💿 Browse All Releases (${artistData.albums.length}) ⬇️` : `💿 浏览全部专辑与作品 (${artistData.albums.length}张) ⬇️`,
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

// 记录用户在每个艺人专辑列表当前所处的页码: key=`${chatId}:${artistId}` -> pageIndex
const artistPageMap = new Map();

/**
 * 解析「当前用户在看的艺人」。
 * 优先级：回调里带的 ID > 当前会话的 artistId / backArtistId > 最近一次渲染的艺人页 > 唯一在勾选的艺人。
 * 用于那些 callback_data 里没带 artistId 的回调。
 */
function resolveArtistId(chatId, fromCallback) {
  if (fromCallback && fromCallback !== 'undefined') return String(fromCallback);
  const sess = userSessions.get(String(chatId));
  if (sess?.artistId) return String(sess.artistId);
  if (sess?.backArtistId) return String(sess.backArtistId);
  const prefix = `${chatId}:`;
  let latest = null;
  for (const key of artistPageMap.keys()) {
    if (!key.startsWith(prefix)) continue;
    latest = key.slice(prefix.length);
  }
  if (latest) return latest;
  // 兜底：该用户唯一一个非空勾选集所属的艺人
  const hits = [];
  for (const [key, entry] of selectionMap.entries()) {
    if (!key.startsWith(`${chatId}:art:`) || !entry.set?.size) continue;
    hits.push(key.slice(`${chatId}:art:`.length));
  }
  if (hits.length === 1) return hits[0];
  return null;
}

// 艺人专辑列表 (完整分页 + 分类勾选模式：⬜/✅ 勾选专辑、支持一键全选或仅选录音室专辑、支持翻页)
async function showArtistAlbums(chatId, artistData, lang = 'zh', messageId = null, isOwner = false, page = null) {
  const isEn = lang === 'en';
  const albums = artistData.albums || [];
  const studioAlbums = albums.filter(a => a.kind === 'full' || !a.kind);
  const selection = getSelection(chatId, 'art', artistData.artistId);
  const pageKey = `${chatId}:${artistData.artistId}`;
  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(albums.length / PAGE_SIZE));
  let curPage = page !== null && page !== undefined ? Number(page) : (artistPageMap.get(pageKey) || 0);
  if (Number.isNaN(curPage) || curPage < 0) curPage = 0;
  if (curPage >= totalPages) curPage = totalPages - 1;
  artistPageMap.set(pageKey, curPage);

  const inlineKeyboard = [];

  // 顶部快捷勾选栏：全选所有 / 仅选录音室专辑 / 取消全部
  const topRow = [
    {
      text: isEn ? `✅ All (${albums.length})` : `✅ 全选 (${albums.length}张)`,
      callback_data: `atsel_art_all:${artistData.artistId}`
    }
  ];
  if (studioAlbums.length > 0 && studioAlbums.length < albums.length) {
    topRow.push({
      text: isEn ? `💿 Studio (${studioAlbums.length})` : `💿 仅录音室 (${studioAlbums.length}张)`,
      callback_data: `atsel_art_studio:${artistData.artistId}`
    });
  }
  topRow.push({
    text: isEn ? '⬜ None' : '⬜ 取消全部',
    callback_data: `atsel_art_none:${artistData.artistId}`
  });
  inlineKeyboard.push(topRow);

  // 当前页专辑列表 (每页 20 张，完全避开 Telegram 100 按钮上限)
  const startIdx = curPage * PAGE_SIZE;
  const visibleAlbums = albums.slice(startIdx, startIdx + PAGE_SIZE);
  const kindIcon = (k) => (k === 'live' ? '🎤' : k === 'single' ? '🎵' : k === 'comp' ? '📚' : '💿');
  for (let i = 0; i < visibleAlbums.length; i++) {
    const al = visibleAlbums[i];
    const year = al.releaseDate ? ` (${al.releaseDate.slice(0, 4)})` : '';
    const checked = selection.has(String(al.id));
    const title = `${kindIcon(al.kind)} ${al.name}${year}`;
    inlineKeyboard.push([
      { text: checked ? '✅' : '⬜', callback_data: `atsel_art_toggle:${artistData.artistId}:${al.id}` },
      { text: title.length > 36 ? title.slice(0, 34) + '..' : title, callback_data: `art_album:${al.id}:${artistData.artistId}` }
    ]);
  }

  // 分页导航栏（当总页数 > 1 时展示）
  if (totalPages > 1) {
    const navRow = [];
    if (curPage > 0) {
      navRow.push({
        text: isEn ? '⬅️ Prev' : '⬅️ 上一页',
        callback_data: `atsel_art_page:${artistData.artistId}:${curPage - 1}`
      });
    }
    navRow.push({
      text: `📄 ${curPage + 1} / ${totalPages}`,
      callback_data: 'atsel_art_more'
    });
    if (curPage + 1 < totalPages) {
      navRow.push({
        text: isEn ? '➡️ Next' : '➡️ 下一页',
        callback_data: `atsel_art_page:${artistData.artistId}:${curPage + 1}`
      });
    }
    inlineKeyboard.push(navRow);
  }

  // 音质选择（与专辑卡一致的四档）
  const ao = getArtistOpts(chatId);
  const qMark = (q) => (ao.quality === q ? ' ✅' : '');
  inlineKeyboard.push([
    { text: `🎧 ${isEn ? 'Lossless' : '无损'}${qMark('Lossless')}`, callback_data: `aao:q:Lossless:${artistData.artistId}` },
    { text: `💎 ${isEn ? 'Hi-Res' : '高解析'}${qMark('Hi-Res')}`, callback_data: `aao:q:Hi-Res:${artistData.artistId}` }
  ]);
  inlineKeyboard.push([
    { text: `🌌 ${isEn ? 'Atmos' : '杜比全景声'}${qMark('Atmos')}`, callback_data: `aao:q:Atmos:${artistData.artistId}` },
    { text: `⚡ AAC${qMark('AAC')}`, callback_data: `aao:q:AAC:${artistData.artistId}` }
  ]);

  // 歌词内嵌
  const eMark = (m) => (ao.embedLyricsMode === m ? ' ✅' : '');
  const eLabel = (m) => (m === 'lrc' ? 'LRC' : m === 'ttml' ? 'TTML' : (isEn ? 'Off' : '关'));
  inlineKeyboard.push([
    { text: `📝 ${isEn ? 'Embed' : '内嵌'} ${eLabel('lrc')}${eMark('lrc')}`, callback_data: `aao:e:lrc:${artistData.artistId}` },
    { text: `${eLabel('ttml')}${eMark('ttml')}`, callback_data: `aao:e:ttml:${artistData.artistId}` },
    { text: `${eLabel('off')}${eMark('off')}`, callback_data: `aao:e:off:${artistData.artistId}` }
  ]);

  // 外置歌词
  inlineKeyboard.push([
    {
      text: `📄 ${isEn ? 'External' : '外置'} .lrc${ao.saveLyricsFormats.includes('lrc') ? ' ✅' : ''}`,
      callback_data: `aao:s:lrc:${artistData.artistId}`
    },
    {
      text: `.ttml${ao.saveLyricsFormats.includes('ttml') ? ' ✅' : ''}`,
      callback_data: `aao:s:ttml:${artistData.artistId}`
    }
  ]);

  // 中文翻译 + 注音
  inlineKeyboard.push([
    {
      text: isEn
        ? `🇨🇳 Translation: ${ao.needTranslate ? 'Yes ✅' : 'No ❌'}`
        : `🇨🇳 中文翻译: ${ao.needTranslate ? '需要 ✅' : '不需要 ❌'}`,
      callback_data: `aao:t:${artistData.artistId}`
    },
    {
      text: isEn
        ? `あ Ruby: ${ao.needRuby ? (ao.rubyMode === 'kana' ? 'Hiragana ✅' : 'Romaji ✅') : 'No ❌'}`
        : `あ 注音: ${ao.needRuby ? (ao.rubyMode === 'kana' ? '平假名 ✅' : '罗马音 ✅') : '不需要 ❌'}`,
      callback_data: `aao:r:${artistData.artistId}`
    }
  ]);
  if (ao.needRuby) {
    inlineKeyboard.push([
      {
        text: ao.rubyMode === 'kana' ? 'あ→Aa' : 'Aa→あ',
        callback_data: `aao:m:${artistData.artistId}`
      }
    ]);
  }

  // 底部：一键下载所选专辑。所有用户都能用（和普通下载一样）；
  // 只有超出每日额度时，执行阶段才会转为「申请站长授权」。
  inlineKeyboard.push([
    {
      text: selection.size > 0
        ? (isEn ? `🚀 Download Selected (${selection.size})` : `🚀 一键下载已勾选专辑 (${selection.size} 张)`)
        : (isEn ? '🚀 Download Selected Albums' : '🚀 一键下载勾选的专辑'),
      callback_data: `atsel_art_dl:${artistData.artistId}`
    }
  ]);

  inlineKeyboard.push([
    {
      text: isEn ? '🔙 Back to Artist Profile' : '🔙 返回艺人主页',
      callback_data: `art_back:${artistData.artistId}`
    }
  ]);

  const text = isEn
    ? `💿 <b>All Releases by ${escapeHtml(artistData.name)} (Page ${curPage + 1}/${totalPages}):</b>\nTotal <code>${albums.length}</code> releases (💿 Studio: ${studioAlbums.length} | 🎤 Live / 🎵 Singles & EPs: ${albums.length - studioAlbums.length}).\nSelected: <code>${selection.size}</code>. Tick releases across pages then tap [Batch Download], or tap a title to open it:`
    : `💿 <b>${escapeHtml(artistData.name)} 全部专辑与作品 (第 ${curPage + 1}/${totalPages} 页)：</b>\n共 <code>${albums.length}</code> 张（💿 录音室专辑 ${studioAlbums.length} 张 | 🎤 Live / 🎵 单曲与 EP ${albums.length - studioAlbums.length} 张）。\n当前已勾选：<code>${selection.size}</code> 张。支持跨页勾选后一键批量下载（已归档专辑自动秒传跳过）；点击专辑名可单独进入：`;

  if (messageId) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  } else {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  }
}

/** 标签语言设置面板的键盘与文案（命令与回调共用，避免两处维护漂移） */
function buildTagLangPanel(chatId, uiLang, expanded = false) {
  const isEn = uiLang === 'en';
  const curTag = getUserTagLang(chatId);
  const resolvedTag = resolveTagLang(chatId, uiLang);
  const label = curTag === 'auto' ? (isEn ? `Auto → ${resolvedTag}` : `自动 → ${resolvedTag}`) : curTag;
  const visible = expanded ? TAG_LANG_PRESETS : TAG_LANG_PRESETS.slice(0, 10);
  const kb = [];
  for (let i = 0; i < visible.length; i += 2) {
    kb.push(visible.slice(i, i + 2).map((p) => ({
      text: `${curTag === p.tag ? '✅ ' : ''}${isEn ? p.en : p.zh}`,
      callback_data: p.tag === 'auto' ? 'taglang:auto' : `taglang:pick:${p.tag}`
    })));
  }
  kb.push([
    expanded
      ? { text: isEn ? '▲ Show less' : '▲ 收起', callback_data: 'taglang:menu' }
      : { text: isEn ? '▼ More languages' : '▼ 更多语言', callback_data: 'taglang:more' },
    { text: isEn ? '⌨️ Enter custom code' : '⌨️ 手动输入代码', callback_data: 'taglang:custom' }
  ]);
  if (curTag !== 'auto') {
    kb.push([{ text: isEn ? '↩️ Reset to auto' : '↩️ 恢复自动', callback_data: 'taglang:auto' }]);
  }
  const text = isEn
    ? `🏷 <b>Audio Tag Language</b>\n\nYour <code>.m4a</code> title/artist/album/genre tags and filenames will be written in the language you pick here.\n\nCurrent: <code>${escapeHtml(label)}</code>\n\nPick a preset below, or just send any BCP-47 code (e.g. <code>ar-EG</code>, <code>ja-JP</code>) as a message.`
    : `🏷 <b>音乐标签语言</b>\n\n这里决定下载的 <code>.m4a</code> 里歌名/歌手/专辑/流派标签与文件名用哪种语言。\n\n当前：<code>${escapeHtml(label)}</code>\n\n点下方预设，或直接发送任意 BCP-47 代码（如 <code>ar-EG</code>、<code>ja-JP</code>）。`;
  return { text, reply_markup: { inline_keyboard: kb } };
}

/** 发送标签语言设置面板（/tags 命令用） */
async function sendTagLangPanel(chatId, uiLang) {
  const panel = buildTagLangPanel(chatId, uiLang, false);
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: panel.text,
    parse_mode: 'HTML',
    reply_markup: panel.reply_markup
  });
}

// ==================== 会话状态管理 (含 TTL 防内存泄漏) ====================
const userSessions = new Map();
const artistCache = new Map(); // artistId -> { data, createdAt }
/** artistId -> 艺人显示名（用作回调按钮文案，回调数据里只放 ID） */
const artistNameMap = new Map();
function rememberArtistName(artistId, name) {
  if (artistId && name) artistNameMap.set(String(artistId), name);
}
// 艺人对勾选状态: key=`${chatId}:${kind}:${id}` (kind: 'art' 艺人专辑 | 'trk' 专辑曲目) -> { set: Set, createdAt }
const selectionMap = new Map();

/**
 * 每个用户的「艺人全专辑下载选项」（音质 / 歌词 / 翻译 / 注音）。
 * 专辑卡用 userSessions 存，这个页面不是会话式消息，单独存一份，互不干扰。
 */
const artistOptsMap = new Map();
function getArtistOpts(chatId) {
  const key = String(chatId);
  let o = artistOptsMap.get(key);
  if (!o) {
    o = {
      quality: 'Lossless',
      embedLyricsMode: 'lrc',
      saveLyricsFormats: [],
      needTranslate: false,
      needRuby: false,
      rubyMode: 'roman',
      updatedAt: Date.now(),
    };
    artistOptsMap.set(key, o);
  }
  return o;
}

function getSelection(chatId, kind, id) {
  const key = `${chatId}:${kind}:${id}`;
  let entry = selectionMap.get(key);
  if (!entry) {
    entry = { set: new Set(), createdAt: Date.now() };
    selectionMap.set(key, entry);
  }
  return entry.set;
}

async function getArtistData(artistId, storefront = 'hk', lang = 'zh', tagLang = null) {
  const cacheKey = `${artistId}_${lang}_${tagLang || 'auto'}`;
  const hit = artistCache.get(cacheKey);
  if (hit && Date.now() - hit.createdAt < 10 * 60 * 1000) return hit.data;
  const data = await fetchArtistDetails(artistId, storefront, lang, tagLang);
  artistCache.set(cacheKey, { data, createdAt: Date.now() });
  return data;
}

function cleanStaleUserSessions() {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 小时过期
  for (const [key, session] of userSessions.entries()) {
    // "等待用户输入标签语言"的状态 10 分钟即可失效，避免长期占位
    const limit = session.awaitingTagLang ? 10 * 60 * 1000 : maxAge;
    if (session.createdAt && (now - session.createdAt > limit)) {
      userSessions.delete(key);
    }
  }
  for (const [key, entry] of artistCache.entries()) {
    if (now - entry.createdAt > 30 * 60 * 1000) artistCache.delete(key);
  }
  for (const [key, entry] of selectionMap.entries()) {
    if (now - entry.createdAt > 60 * 60 * 1000) selectionMap.delete(key);
  }
  quotaManager.cleanupStale();
}
setInterval(cleanStaleUserSessions, 15 * 60 * 1000);

// ==================== 卡片构建器 ====================
function buildSongCard(details, selectedQuality = 'Lossless', needLrc = true, isZip = false, lang = 'zh', backAlbumId = null, needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman') {
  // embedLyricsMode: 'lrc' | 'ttml' | 'off'（内嵌 ©lyr；off = 不内嵌）
  // saveLyricsFormats: [] | ['lrc'] | ['ttml'] | ['lrc','ttml']（外置歌词文件，可 0~2 个）
  const embedMode = ['lrc', 'ttml', 'off'].includes(embedLyricsMode) ? embedLyricsMode : 'lrc';
  const saveFormats = Array.isArray(saveLyricsFormats) ? saveLyricsFormats.filter((f) => f === 'lrc' || f === 'ttml') : [];
  const isEn = lang === 'en';
  const cacheKey = `${details.songId}_${selectedQuality.toLowerCase()}_${isZip ? 'zip' : 'audio'}${isEn ? '_en' : ''}`;
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

  // 歌词交付：内嵌格式二选一/关 + 外置歌词多选 + 翻译 + 仅下载歌词
  const embedLabel = (m) => m === 'lrc' ? 'LRC' : (m === 'ttml' ? 'TTML' : (isEn ? 'Off' : '关'));
  inlineKeyboard.push([
    { text: `📝 ${isEn ? 'Embed' : '内嵌'}: ${embedLabel('lrc')} ${embedMode === 'lrc' ? '✅' : ''}`, callback_data: `efmt:lrc:${details.songId}` },
    { text: `${embedLabel('ttml')} ${embedMode === 'ttml' ? '✅' : ''}`, callback_data: `efmt:ttml:${details.songId}` },
    { text: `${embedLabel('off')} ${embedMode === 'off' ? '✅' : ''}`, callback_data: `efmt:off:${details.songId}` }
  ]);

  inlineKeyboard.push([
    { text: `📄 ${isEn ? 'External' : '外置'}: .lrc ${saveFormats.includes('lrc') ? '✅' : ''}`, callback_data: `esave:lrc:${details.songId}` },
    { text: `.ttml ${saveFormats.includes('ttml') ? '✅' : ''}`, callback_data: `esave:ttml:${details.songId}` }
  ]);

  inlineKeyboard.push([
    {
      text: isEn
        ? `🇨🇳 Chinese Translation: ${needTranslate ? 'Yes ✅' : 'No ❌'}`
        : `🇨🇳 中文翻译歌词: ${needTranslate ? '需要 ✅' : '不需要 ❌'}`,
      callback_data: `tlrc:${needTranslate ? '0' : '1'}:${details.songId}`
    }
  ]);

  // 注音（日文歌词罗马音/平假名）：中文翻译是「译文」，注音是「读音」，两者可叠加
  inlineKeyboard.push([
    {
      text: isEn
        ? `あ Ruby (${rubyMode === 'kana' ? 'Hiragana' : 'Romaji'}): ${needRuby ? 'Yes ✅' : 'No ❌'}`
        : `あ 注音 (${rubyMode === 'kana' ? '平假名' : '罗马音'}): ${needRuby ? '需要 ✅' : '不需要 ❌'}`,
      callback_data: `ruby:${needRuby ? '0' : '1'}:${details.songId}`
    },
    {
      text: rubyMode === 'kana' ? 'あ→Aa' : 'Aa→あ',
      callback_data: `rubym:${rubyMode === 'kana' ? 'roman' : 'kana'}:${details.songId}`
    }
  ]);

  // 仅下载歌词：不发音频，直接推歌词文件（LRC/TTML/两者），用于自行补歌词场景
  inlineKeyboard.push([
    { text: `🎵 ${isEn ? 'Lyrics Only' : '仅歌词'}: LRC`, callback_data: `lyronly:lrc:${details.songId}` },
    { text: 'TTML', callback_data: `lyronly:ttml:${details.songId}` },
    { text: isEn ? 'Both' : '两者', callback_data: `lyronly:both:${details.songId}` }
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

function buildAlbumCard(albumData, selectedQuality = 'Lossless', needLrc = true, deliveryMode = 'zip', lang = 'zh', isOwner = false, backArtistId = null, needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman') {
  // embedLyricsMode: 'lrc' | 'ttml' | 'off'; saveLyricsFormats: [] | ['lrc'] | ['ttml'] | ['lrc','ttml']
  const embedMode = ['lrc', 'ttml', 'off'].includes(embedLyricsMode) ? embedLyricsMode : 'lrc';
  const saveFormats = Array.isArray(saveLyricsFormats) ? saveLyricsFormats.filter((f) => f === 'lrc' || f === 'ttml') : [];
  const isEn = lang === 'en';
  const isPl = albumData.isPlaylist === true;
  const cacheKey = `album_${albumData.albumId}_${selectedQuality.toLowerCase()}_${deliveryMode}${isEn ? '_en' : ''}`;
  const isCached = Boolean(db.get(cacheKey));
  // 所有用户都能下载整辑；额度内直接下载，超额时自动转为「申请站长授权」
  const canFullDownload = true;

  const typeLabel = isPl ? (isEn ? 'Playlist' : '歌单') : (isEn ? 'Album' : '专辑');
  // Gofile 模式对普通用户是默认推荐：上传更快、不受 2GB 限制、大专辑不刷屏。给一行明确提示。
  // 当前选择的摘要：让用户一眼看清「马上会用哪些参数下载」，而不是靠猜按钮含义
  const embedTxt = embedMode === 'lrc' ? 'LRC' : embedMode === 'ttml' ? 'TTML' : (isEn ? 'None' : '不内嵌');
  const extTxt = saveFormats.length ? saveFormats.map((f) => '.' + f).join(' + ') : (isEn ? 'None' : '不生成');
  const optSummary = isEn
    ? `\n\n⚙️ <b>Current:</b> ${selectedQuality} · Lyrics: ${embedTxt} · External: ${extTxt} · Translation: ${needTranslate ? 'Yes' : 'No'} · Ruby: ${needRuby ? (rubyMode === 'kana' ? 'Hiragana' : 'Romaji') : 'No'}`
    : `\n\n⚙️ <b>当前设置：</b>${selectedQuality} · 歌词：${embedTxt} · 外置：${extTxt} · 翻译：${needTranslate ? '需要' : '不需要'} · 注音：${needRuby ? (rubyMode === 'kana' ? '平假名' : '罗马音') : '不需要'}`;

  const gofileHint = deliveryMode === 'gofile'
    ? (isEn
      ? '\n\n☁️ <b>Gofile mode:</b> faster upload, no 2GB limit, no chat spam. The link is temporary — <b>download it early</b> before it expires.'
      : '\n\n☁️ <b>Gofile 模式：</b>上传更快、不受 2GB 限制、超大专辑不刷屏。链接为临时分享，<b>请尽快下载</b>以免过期。')
    : '';
  const text = isEn ?
`💿 <b>${typeLabel} Batch: ${escapeHtml(albumData.name)}</b>
👤 <b>${isPl ? 'Curator' : 'Artist'}:</b> ${escapeHtml(albumData.artistName)}
📅 <b>Release Date:</b> ${albumData.releaseDate || 'Unknown'}
🎵 <b>Total Tracks:</b> <b>${albumData.tracks.length}</b> tracks
${isCached ? '\n⚡ <b>Status: Fully archived in library, tap for instant delivery!</b>' : ''}
${canFullDownload ? 'Select options to download full album or individual tracks below:' : 'Please tap [View & Pick Individual Tracks] below to select tracks to download:'}${optSummary}${gofileHint}` :
`💿 <b>${typeLabel}全辑转存：${escapeHtml(albumData.name)}</b>
👤 <b>${isPl ? '歌单作者' : '艺人'}：</b>${escapeHtml(albumData.artistName)}
📅 <b>发行时间：</b>${albumData.releaseDate || '未知'}
🎵 <b>曲目总数：</b>共 <b>${albumData.tracks.length}</b> 首歌曲
${isCached ? '\n⚡ <b>状态：该全辑已完整归档，点击将秒速直发！</b>' : ''}
${canFullDownload ? '您可以一键下载整张专辑，或点击【展开单曲】单独选择单曲：' : '普通用户请点击【查看与单独点选单曲】选择您想下载的单曲：'}${optSummary}${gofileHint}`;

  const inlineKeyboard = [];

  // 音质选择：与单曲卡一致的四档（Lossless / Hi-Res / Dolby Atmos / AAC）
  // 专辑内可能存在不支持某音质的曲目，服务端选流时会自动降级到 alac，不会失败
  inlineKeyboard.push([
    {
      text: `🎧 ${isEn ? 'Lossless' : '无损 Lossless'} ${selectedQuality === 'Lossless' ? '✅' : ''}`,
      callback_data: `aq:Lossless:${albumData.albumId}`
    },
    {
      text: `💎 ${isEn ? 'Hi-Res' : '高解析 Hi-Res'} ${selectedQuality === 'Hi-Res' ? '✅' : ''}`,
      callback_data: `aq:Hi-Res:${albumData.albumId}`
    }
  ]);
  inlineKeyboard.push([
    {
      text: `🌌 ${isEn ? 'Dolby Atmos' : '杜比全景声'} ${selectedQuality === 'Atmos' ? '✅' : ''}`,
      callback_data: `aq:Atmos:${albumData.albumId}`
    },
    {
      text: `⚡ AAC 256k ${selectedQuality === 'AAC' ? '✅' : ''}`,
      callback_data: `aq:AAC:${albumData.albumId}`
    }
  ]);

  if (canFullDownload) {
    // 交付模式三态循环：ZIP -> 原生音频合辑 -> Gofile 云盘链接 -> ZIP
    const modeOrder = ['zip', 'media', 'gofile'];
    const nextMode = modeOrder[(modeOrder.indexOf(deliveryMode) + 1) % modeOrder.length] || 'zip';
    const modeLabel = deliveryMode === 'gofile'
      ? (isEn ? 'Mode: Gofile Link ✅' : '交付模式: Gofile 云盘链接 ✅')
      : deliveryMode === 'zip'
        ? (isEn ? 'Mode: Single ZIP Archive ✅' : '交付模式: 全辑单 ZIP (合为一个文件消息) ✅')
        : (isEn ? 'Mode: MediaGroup Playlist Bubbles ✅' : '交付模式: 原生音频合辑 (MediaGroup 组合消息) ✅');
    const modeIcon = deliveryMode === 'gofile' ? '☁️' : deliveryMode === 'zip' ? '📦' : '🎵';
    inlineKeyboard.push([
      {
        text: `${modeIcon} ${modeLabel}`,
        callback_data: `afmt:${nextMode}:${albumData.albumId}`
      }
    ]);

    const aEmbedLabel = (m) => m === 'lrc' ? 'LRC' : (m === 'ttml' ? 'TTML' : (isEn ? 'Off' : '关'));
    const aEmbedMark = (m) => (embedMode === m ? ' ✅' : '');
    inlineKeyboard.push([
      { text: `📝 ${isEn ? 'Embed' : '内嵌'} ${aEmbedLabel('lrc')}${aEmbedMark('lrc')}`, callback_data: `aefmt:lrc:${albumData.albumId}` },
      { text: `${aEmbedLabel('ttml')}${aEmbedMark('ttml')}`, callback_data: `aefmt:ttml:${albumData.albumId}` },
      { text: `${aEmbedLabel('off')}${aEmbedMark('off')}`, callback_data: `aefmt:off:${albumData.albumId}` }
    ]);

    inlineKeyboard.push([
      { text: `📄 ${isEn ? 'External' : '外置'}: .lrc ${saveFormats.includes('lrc') ? '✅' : ''}`, callback_data: `aesave:lrc:${albumData.albumId}` },
      { text: `.ttml ${saveFormats.includes('ttml') ? '✅' : ''}`, callback_data: `aesave:ttml:${albumData.albumId}` }
    ]);

    inlineKeyboard.push([
      {
        text: isEn
          ? `🇨🇳 Chinese Translation: ${needTranslate ? 'Yes ✅' : 'No ❌'}`
          : `🇨🇳 中文翻译歌词: ${needTranslate ? '需要 ✅' : '不需要 ❌'}`,
        callback_data: `atlrc:${needTranslate ? '0' : '1'}:${albumData.albumId}`
      }
    ]);

    // 注音（日文歌词罗马音/平假名）
    inlineKeyboard.push([
      {
        text: isEn
          ? `あ Ruby (${rubyMode === 'kana' ? 'Hiragana' : 'Romaji'}): ${needRuby ? 'Yes ✅' : 'No ❌'}`
          : `あ 注音 (${rubyMode === 'kana' ? '平假名' : '罗马音'}): ${needRuby ? '需要 ✅' : '不需要 ❌'}`,
        callback_data: `aruby:${needRuby ? '0' : '1'}:${albumData.albumId}`
      },
      {
        text: rubyMode === 'kana' ? 'あ→Aa' : 'Aa→あ',
        callback_data: `arubym:${rubyMode === 'kana' ? 'roman' : 'kana'}:${albumData.albumId}`
      }
    ]);

    // 仅下载歌词：不发音频，整辑每首只推歌词文件
    inlineKeyboard.push([
      { text: `🎵 ${isEn ? 'Lyrics Only' : '仅歌词'}: LRC`, callback_data: `alyronly:lrc:${albumData.albumId}` },
      { text: 'TTML', callback_data: `alyronly:ttml:${albumData.albumId}` },
      { text: isEn ? 'Both' : '两者', callback_data: `alyronly:both:${albumData.albumId}` }
    ]);

    inlineKeyboard.push([
      {
        text: isCached
          ? (isEn ? '⚡ Instant Delivery (0s push)' : '⚡ 全辑秒传 (0秒推送)')
          : (isEn ? `🚀 Download Full ${typeLabel} (${albumData.tracks.length} tracks)` : `🚀 一键下载整张${typeLabel} (${albumData.tracks.length}首)`),
        callback_data: `adl:${albumData.albumId}`
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

// 仅下载歌词（单曲）：不发音频，按需向 cloud-service 取 LRC/TTML 歌词文件并推送给用户
async function handleLyricsOnlyDownload(chatId, messageId, details, want, needTranslate = false, needRuby = false, rubyMode = 'roman') {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const wantFormats = want === 'both' ? ['lrc', 'ttml'] : [want];
  await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: isEn
      ? `⏳ <b>Fetching lyrics only...</b>\n🎵 ${escapeHtml(details.title)} - ${escapeHtml(details.artist)}`
      : `⏳ <b>正在获取歌词文件（无需下载音频）...</b>\n🎵 ${escapeHtml(details.title)} - ${escapeHtml(details.artist)}`,
    parse_mode: 'HTML'
  });
  try {
    const payload = {
      adamId: details.songId,
      quality: 'AAC',
      meta: { title: details.title, artist: details.artist, album: details.album || '' },
      lyricsOnly: true,
      saveLyricsFormats: wantFormats,
      translateLyrics: Boolean(needTranslate),
      ruby: Boolean(needRuby),
      rubyMode: rubyMode || 'roman',
      lang: userLang,
      noUpload: true
    };
    const res = await fetch(CLOUD_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json();
    if (data.status !== 'ok' || !data.data?.lyricsFiles?.length) {
      throw new Error(data.error || (isEn ? 'No lyrics available (instrumental or unavailable in region)' : '无歌词可下载（纯音乐或地区无歌词资源）'));
    }
    // cloud-service 在「无外置格式」时会把内嵌格式当主文件返回，仅歌词场景必须严格按 want 过滤，
    // 否则用户选「仅歌词 TTML」却收到 .lrc（内嵌模式默认 LRC 造成串味）
    const files = data.data.lyricsFiles.filter((f) => wantFormats.some((w) => String(f.filename || '').toLowerCase().endsWith(`.${w}`)));
    if (!files.length) {
      throw new Error(data.error || (isEn ? 'No lyrics available (instrumental or unavailable in region)' : '无歌词可下载（纯音乐或地区无歌词资源）'));
    }
    const sentIds = [];
    for (const f of files) {
      const fpath = `/tmp/am_lyr_only_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${f.filename.split('.').pop()}`;
      fs.writeFileSync(fpath, f.content, 'utf8');
      const cap = safeCaption(`📝 <b>${escapeHtml(details.title)}</b> - ${isEn ? 'Lyrics' : '歌词'}`);
      const r = await unifiedSendMedia({
        chatId,
        filePath: fpath,
        fileName: f.filename,
        caption: cap,
        isAudio: false,
        isZip: false
      });
      sentIds.push(r.groupMsgId || r.fileId);
      try { fs.rmSync(fpath, { force: true }); } catch {}
    }
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `🎉 <b>Lyrics delivered!</b> (${files.length} file${files.length > 1 ? 's' : ''})`
        : `🎉 <b>歌词已推送！</b>（${files.length} 个文件，未下载音频）`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.warn('[TG-Bot] 仅歌词下载失败:', err.message);
    try {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn ? `❌ <b>Lyrics fetch failed:</b> ${escapeHtml(err.message)}` : `❌ <b>歌词获取失败：</b>${escapeHtml(err.message)}`,
        parse_mode: 'HTML'
      });
    } catch {}
  }
}

// 缓存歌词字段归一化：兼容旧 `lrcFileId`/`lrcGroupMsgId` 单格式缓存,统一为 lyricsFiles{lrc,ttml}
function normalizeCachedLyrics(cached) {
  const lf = cached.lyricsFiles || {};
  if (!lf.lrc && (cached.lrcFileId || cached.lrcGroupMsgId)) {
    lf.lrc = { fileId: cached.lrcFileId || null, groupMsgId: cached.lrcGroupMsgId || null };
  }
  return lf;
}

// 缓存命中时按需补齐目标格式歌词：有缓存直接返回推送凭据；缺格式则现场向 cloud-service 补生成（几 KB 秒级，不重下音频）并回写缓存
async function ensureLyricsFiles(cacheKey, cached, wantFormats, details) {
  const lf = normalizeCachedLyrics(cached);
  const results = {}; // fmt -> { fileId, groupMsgId } | null（null = 无歌词）
  const missing = wantFormats.filter((f) => !lf[f]);
  // 先补生成缺失格式（并行）
  if (missing.length) {
    try {
      const payload = {
        adamId: String(details.songId || details.id),
        quality: 'AAC',
        meta: { title: details.title || details.attributes?.name || '', artist: details.artist || details.attributes?.artistName || '' },
        lyricsOnly: true,
        saveLyricsFormats: missing,
        noUpload: true
      };
      const res = await fetch(CLOUD_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json();
      if (data.status === 'ok' && data.data?.lyricsFiles?.length) {
        for (const f of data.data.lyricsFiles) {
          const fmt = String(f.filename || '').toLowerCase().endsWith('.ttml') ? 'ttml' : 'lrc';
          // 只吃用户勾选的格式：cloud-service 在内嵌关闭时会回落到内嵌格式，避免误归档
          if (!missing.includes(fmt)) continue;
          // 上传到归档频道，供后续用户秒传复用
          const fpath = `/tmp/am_lyr_fix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${fmt}`;
          fs.writeFileSync(fpath, f.content, 'utf8');
          const up = await unifiedSendMedia({
            chatId: AUTHORIZED_GROUP_ID,
            filePath: fpath,
            fileName: f.filename,
            caption: safeCaption(`📝 ${escapeHtml(payload.meta.artist)} - ${escapeHtml(payload.meta.title)}`),
            isAudio: false,
            isZip: false
          });
          try { fs.rmSync(fpath, { force: true }); } catch {}
          lf[fmt] = { fileId: up.fileId || null, groupMsgId: up.groupMsgId || null };
        }
        // 回写缓存
        const fresh = db.get(cacheKey);
        if (fresh) {
          fresh.lyricsFiles = lf;
          db.set(cacheKey, fresh);
        }
      }
    } catch (err) {
      console.warn('[Cache] 歌词补生成失败 (非致命):', err.message);
    }
  }
  for (const f of wantFormats) {
    results[f] = lf[f] || null;
  }
  return results;
}

// 歌词交付意图解析：内嵌开关（efmt）即用户对「歌词要不要+以什么格式给」的唯一选择，
// 外置文件（esave）只作为**额外补充格式**。历史上只看 esave 导致「选了内嵌 TTML 却默认收到 .lrc」。
function resolveLyricsIntent(embedLyricsMode, saveLyricsFormats) {
  const embed = ['lrc', 'ttml', 'off'].includes(embedLyricsMode) ? embedLyricsMode : 'lrc';
  const extra = Array.isArray(saveLyricsFormats) ? saveLyricsFormats.filter((f) => f === 'lrc' || f === 'ttml') : [];
  // 「内嵌」与「外置」是两组互相独立的开关，语义必须严格对立：
  //   内嵌 LRC / TTML → 歌词只写进音频 `©lyr` 标签，**不外发任何文件**
  //   外置 .lrc/.ttml → 仅在用户显式勾选时作为独立文件发送（与内嵌模式无关，可叠加）
  //   内嵌关 + 无勾选 → 不发歌词
  // 历史行为把「内嵌 LRC」额外补发一份 .lrc，导致默认状态下总是多推一个文件。
  const formats = [];
  for (const f of extra) if (!formats.includes(f)) formats.push(f);
  return { embedded: embed !== 'off', lyricsFormat: embed === 'ttml' ? 'ttml' : 'lrc', formats };
}

async function handleDownload(chatId, messageId, details, quality, needLrc, isZip, needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman') {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  // 外置歌词文件 = 内嵌模式对应的主格式 + 用户额外勾选的格式
  saveLyricsFormats = resolveLyricsIntent(embedLyricsMode, saveLyricsFormats).formats;
  const songId = details.songId;
  const cacheKey = `${songId}_${quality.toLowerCase()}_${isZip ? 'zip' : 'audio'}${isEn ? '_en' : ''}`;
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
        // 归档消息是「音频 + 当初归档时的歌词文件」的媒体组，整条 `copyMessage` 会把
        // 归档时的 `.lrc`/`.ttml` 原样带出来，与用户当前勾选无关 —— 这就是「选了只内嵌
        // 却仍收到 .lrc」的第二个来源。仅当当前需要的歌词格式与归档时完全一致才整条转发，
        // 否则退化为「只发音频 + 按需补发歌词」，保证交付严格跟随用户当前意图。
        const archivedFormats = Array.isArray(cached.lyricsFormats) ? cached.lyricsFormats : null;
        const sameLyrics = archivedFormats
          ? archivedFormats.length === saveLyricsFormats.length &&
            archivedFormats.every((f) => saveLyricsFormats.includes(f))
          : saveLyricsFormats.length === 0; // 老归档未记录格式时，仅在用户不要外置歌词时才敢整条复制

        if (sameLyrics) {
          await tgCall('copyMessage', {
            chat_id: chatId,
            from_chat_id: AUTHORIZED_GROUP_ID,
            message_id: cached.groupMsgId
          });
          copySuccess = true;
        } else if (cached.audioFileId) {
          // 拆开重发：只发音频，歌词按当前勾选单独补
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

          if (saveLyricsFormats.length) {
            const lfResults = await ensureLyricsFiles(cacheKey, cached, saveLyricsFormats, details);
            for (const fmt of saveLyricsFormats) {
              const entry = lfResults[fmt];
              if (!entry) continue;
              try {
                if (entry.groupMsgId) {
                  await tgCall('copyMessage', {
                    chat_id: chatId,
                    from_chat_id: AUTHORIZED_GROUP_ID,
                    message_id: entry.groupMsgId
                  });
                } else if (entry.fileId) {
                  await tgCall('sendDocument', {
                    chat_id: chatId,
                    document: entry.fileId,
                    caption: safeCaption(`📝 ${escapeHtml(cached.artist)} - ${escapeHtml(cached.title)}.${fmt}`),
                    reply_to_message_id: audioMsg.message_id
                  });
                }
              } catch {}
            }
          }
          copySuccess = true;
        } else {
          // 既无独立音频 FileId 又无法整条复制：放弃秒传，走完整下载流程
          copySuccess = false;
        }
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

        if (saveLyricsFormats.length) {
          const lfResults = await ensureLyricsFiles(cacheKey, cached, saveLyricsFormats, details);
          for (const fmt of saveLyricsFormats) {
            const entry = lfResults[fmt];
            if (!entry) continue;
            try {
              if (entry.groupMsgId) {
                await tgCall('copyMessage', {
                  chat_id: chatId,
                  from_chat_id: AUTHORIZED_GROUP_ID,
                  message_id: entry.groupMsgId
                });
              } else if (entry.fileId) {
                await tgCall('sendDocument', {
                  chat_id: chatId,
                  document: entry.fileId,
                  caption: safeCaption(`📝 ${escapeHtml(cached.artist)} - ${escapeHtml(cached.title)}.${fmt}`),
                  reply_to_message_id: audioMsg.message_id
                });
              }
            } catch {}
          }
        }
        copySuccess = true;
      }
    } catch (cacheErr) {
      console.warn(`[Cache] 归档群消息 (${cached.groupMsgId || cached.audioFileId}) 已失效或在群聊中被删除 (${cacheErr.message})，自动清除该缓存并重新从 Apple Music 下载！`);
      db.delete(cacheKey);
      copySuccess = false;
    }

    if (copySuccess) {
      const updateTip = consumeOneTimeUpdateNotice(chatId, userLang);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: (isEn ? `🎉 <b>Delivered!</b> File sent directly to your chat.` : `🎉 <b>秒传推送完成！</b> 已将文件直接发送给您。`) + updateTip,
        parse_mode: 'HTML'
      });
      return;
    }
  }
  // 开跑前预留 1 首额度：额度不足直接拒绝，绝不开始下载（作者专属账号 100% 豁免）
  const singleQuota = quotaManager.reserveQuota(chatId, 1);
  if (singleQuota.reserved) addPendingReservation(chatId, 1);
  if (!singleQuota.ok) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚠️ <b>Daily track download quota reached (${singleQuota.current}/${singleQuota.max})</b>\n\nTo ensure fair use and bandwidth safety, non-admin users have a daily quota of ${singleQuota.max} tracks (single songs, albums and playlists all share this pool).\n\n⏰ Resets daily at midnight (UTC+8).\n💡 <b>Tip</b>: Archived songs from library do NOT count towards quota!`
        : `⚠️ <b>您今日的下载配额已达上限 (${singleQuota.current}/${singleQuota.max} 首)</b>\n\n为了保障小讨论组共享公平与 VPS 带宽安全，非特权用户每日共限 ${singleQuota.max} 首（单曲、专辑、歌单共用同一份额度）。已取消本次下载，未消耗任何额度。\n\n⏰ <b>配额刷新时间</b>：北京时间每日午夜 00:00 自动重置，明日即可恢复使用。\n💡 <b>免配额小贴士</b>：所有已归档曲目均支持秒传直发，<b>秒传不计入任何配额</b>，欢迎随时取用！`,
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
        saveLrc: saveLyricsFormats.length > 0,
        embedLyrics: embedLyricsMode !== 'off',
        lyricsFormat: embedLyricsMode === 'ttml' ? 'ttml' : 'lrc',
        saveLyricsFormats,
        translateLyrics: needTranslate || false,
        ruby: needRuby || false,
        rubyMode: rubyMode || 'roman',
        lang: userLang,
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
          throw new Error(data.error || (isEn ? 'Transfer service returned an error' : '解析中枢返回异常'));
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

      const { isZip: resIsZip, zipFilePath, zipFileName, audioFilePath, lrcFilePath, thumbFilePath, fileName, lyricsFileName, extraLyricsFiles, fileSize, artist, title, album, qualityName, duration, qualityFallback } = transferResult;

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
${qualityFallback ? `⚠️ ${escapeHtml(qualityFallback)}\n` : ''}
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

          // 发送所有外置歌词文件（主文件 + 附加格式），并构建 lyricsFiles 多格式缓存凭据
          let lrcFileId = null;
          let lrcGroupMsgId = null;
          let lrcTtmlFileId = null;
          let lrcTtmlGroupMsgId = null;
          const sendOneLyric = async (fpath, fname, replyTo) => {
            const cap = safeCaption(`📝 <b>${escapeHtml(title)}</b> - ${isEn ? 'Lyrics' : '歌词'}\n${artistTag} ${titleTag}`);
            const r = await unifiedSendMedia({
              chatId,
              filePath: fpath,
              fileName: fname,
              caption: cap,
              isAudio: false,
              isZip: false,
              replyToMessageId: replyTo
            });
            return r;
          };
          if (lrcFilePath && fs.existsSync(lrcFilePath)) {
            try {
              const primaryExt = (lyricsFileName || '').endsWith('.ttml') ? 'ttml' : 'lrc';
              const r = await sendOneLyric(lrcFilePath, lyricsFileName || `${artist} - ${title}.${primaryExt}`, sendResult.groupMsgId);
              if (primaryExt === 'ttml') {
                lrcTtmlGroupMsgId = r.groupMsgId;
                lrcTtmlFileId = r.fileId || null;
              } else {
                lrcGroupMsgId = r.groupMsgId;
                lrcFileId = r.fileId || null;
              }
            } catch (lrcErr) {
              console.warn('[TG-Bot] 歌词发送失败 (非致命):', lrcErr.message);
            }
          }
          // 附加歌词文件（与主文件同目录，如 .lrc + .ttml 并存）
          if (extraLyricsFiles?.length && lrcFilePath) {
            const dir = path.dirname(lrcFilePath);
            for (const ext of extraLyricsFiles) {
              try {
                const fpath = path.join(dir, ext.filename);
                if (!fs.existsSync(fpath)) continue;
                const r = await sendOneLyric(fpath, ext.filename, sendResult.groupMsgId);
                if (ext.filename.endsWith('.ttml')) {
                  lrcTtmlGroupMsgId = r.groupMsgId;
                  lrcTtmlFileId = r.fileId || null;
                } else {
                  lrcGroupMsgId = r.groupMsgId;
                  lrcFileId = r.fileId || null;
                }
              } catch (extraErr) {
                console.warn('[TG-Bot] 附加歌词发送失败 (非致命):', extraErr.message);
              }
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
            lyricsFiles: {
              lrc: (lrcFileId || lrcGroupMsgId) ? { fileId: lrcFileId, groupMsgId: lrcGroupMsgId } : undefined,
              ttml: (lrcTtmlFileId || lrcTtmlGroupMsgId) ? { fileId: lrcTtmlFileId, groupMsgId: lrcTtmlGroupMsgId } : undefined
            },
            // 记录本次归档实际附带的歌词格式，缓存命中时据此判断能否整条复制
            lyricsFormats: [
              ...((lrcFileId || lrcGroupMsgId) ? ['lrc'] : []),
              ...((lrcTtmlFileId || lrcTtmlGroupMsgId) ? ['ttml'] : [])
            ],
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

        // 单曲额度已在开跑前预留 1 首，成功即消耗（失败路径在 catch 中退回）
        settleQuotaReservation(chatId, 1);
        const updateTip = consumeOneTimeUpdateNotice(chatId, userLang);

        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: (isEn
            ? `🎉 <b>Transfer complete!</b>\nDirectly delivered via official Local Bot API.${statsText}`
            : `🎉 <b>转存完成！</b>\n已通过官方 Local Bot API 专线为您直发。${statsText}`) + updateTip,
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
        // 失败或异常时预留额度尚未结算，退回这 1 首，不让用户为失败任务付费
        if (singleQuota.reserved && hasPendingReservation(chatId)) {
          settleQuotaReservation(chatId, 0);
        }
        try {
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

// ==================== 多选单曲批量下载 (专辑曲目勾选) ====================
// 逐首下载/命中缓存秒传归档到频道，最后一次性统一复制到用户私聊
async function handleMultiTrackDownload(chatId, messageId, albumData, trackIds, quality = 'Lossless', needLrc = true, isZip = false, needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman') {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const tracks = (albumData.tracks || []).filter(t => trackIds.has(String(t.id)));
  if (!tracks.length) return;
  saveLyricsFormats = resolveLyricsIntent(embedLyricsMode, saveLyricsFormats).formats;

  // 开跑前按勾选曲目数一次性预留额度：不够直接拒绝，绝不开始下载（秒传不计配额）
  const multiQuota = quotaManager.reserveQuota(chatId, tracks.length);
  if (!multiQuota.ok) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚠️ <b>Daily quota insufficient:</b> you selected <code>${tracks.length}</code> tracks but only have <code>${multiQuota.remaining}</code> of your daily <code>${multiQuota.max}</code>-track quota left. Nothing was downloaded.`
        : `⚠️ <b>今日配额不足，未开始下载</b>\n\n您勾选了 <code>${tracks.length}</code> 首，但今天只剩 <code>${multiQuota.remaining}</code> 首额度（每日上限 <code>${multiQuota.max}</code> 首）。已取消，未消耗任何额度。请减少勾选数量或明天再试。`,
      parse_mode: 'HTML'
    });
    return;
  }
  if (multiQuota.reserved) addPendingReservation(chatId, tracks.length);

  return botTaskQueue.enqueue(
    { chatId, messageId, type: 'album', name: `${albumData.name} 所选曲目` },
    async () => {
      const allMsgIds = [];
      const fileIdSends = []; // 老缓存仅有 fileId 无群消息时的兜底直发
      const skippedTracks = [];
      const downloadedFilePaths = []; // 本次新下载的文件，任务结束后统一清理
      let cachedHit = 0;
      let downloadedCount = 0;

      try {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `⏳ <b>Starting batch track transfer (${tracks.length} selected)...</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`
            : `⏳ <b>开始批量转存所选单曲 (共 ${tracks.length} 首)...</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`,
          parse_mode: 'HTML'
        });

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          const cacheKey = `${track.id}_${quality.toLowerCase()}_${isZip ? 'zip' : 'audio'}${isEn ? '_en' : ''}`;
          const cached = db.get(cacheKey);

          // 1. 命中单曲缓存秒传: 直接收集群消息 ID，跳过下载
          if (cached && (cached.groupMsgId || (isZip ? cached.zipFileId : cached.audioFileId))) {
            if (cached.groupMsgId) {
              allMsgIds.push(cached.groupMsgId);
              if (needLrc && cached.lrcGroupMsgId) allMsgIds.push(cached.lrcGroupMsgId);
            } else if (isZip && cached.zipFileId) {
              fileIdSends.push({ kind: 'doc', fileId: cached.zipFileId, title: cached.title, artist: cached.artist, album: cached.album });
            } else if (!isZip && cached.audioFileId) {
              fileIdSends.push({ kind: 'audio', fileId: cached.audioFileId, title: cached.title, artist: cached.artist, album: cached.album, lrcFileId: needLrc ? cached.lrcFileId : null });
            }
            cachedHit++;
            try {
              await tgCall('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: `⏳ <b>${isEn ? 'Batch transfer' : '批量转存'} [${i + 1}/${tracks.length}]</b>\n⚡ ${escapeHtml(track.name)} (${isEn ? 'archived, skipped download' : '已缓存，跳过下载'})`,
                parse_mode: 'HTML'
              });
            } catch {}
            continue;
          }

          // 2. 未缓存: 解析单曲并下载归档到频道 (不立即推私聊)
          let details;
          try {
            details = await fetchSongDetails(track.id, 'hk', userLang, getUserTagLang(chatId));
          } catch (err) {
            console.warn(`[TG-Bot] 批量曲目 ${track.name} 元数据解析失败: ${err.message}`);
            skippedTracks.push({ track, error: err.message });
            continue;
          }

          let transferResult;
          try {
            const payload = {
              adamId: track.id,
              quality: quality,
              meta: {
                title: details.title,
                artist: details.artist,
                album: details.album,
                albumArtist: details.albumArtist,
                date: details.releaseDate,
                genre: details.genre,
                trackNumber: details.trackNumber,
                discNumber: details.discNumber,
                coverUrl: details.coverUrl,
                durationInMillis: details.durationInMillis
              },
              saveLrc: saveLyricsFormats.length > 0,
              embedLyrics: embedLyricsMode !== 'off',
              lyricsFormat: embedLyricsMode === 'ttml' ? 'ttml' : 'lrc',
              saveLyricsFormats,
              translateLyrics: needTranslate || false,
              ruby: needRuby || false,
              rubyMode: rubyMode || 'roman',
              lang: userLang,
              zip: Boolean(isZip),
              noUpload: true
            };
            const res = await fetch(CLOUD_API, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(180000)
            });
            const data = await res.json();
            if (data.status !== 'ok' || !data.data) {
              throw new Error(data.error || (isEn ? 'Transfer service returned an error' : '解析中枢返回异常'));
            }
            transferResult = data.data;
          } catch (err) {
            console.warn(`[TG-Bot] 批量曲目 [${i + 1}/${tracks.length}] ${track.name} 下载失败: ${err.message}`);
            skippedTracks.push({ track, error: err.message });
            try {
              await tgCall('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: `⏳ <b>${isEn ? 'Batch transfer' : '批量转存'} [${i + 1}/${tracks.length}]</b>\n❌ ${escapeHtml(track.name)} (${escapeHtml(err.message)})`,
                parse_mode: 'HTML'
              });
            } catch {}
            continue;
          }

          const { zipFilePath, zipFileName, audioFilePath, lrcFilePath, thumbFilePath, fileName, lyricsFileName, artist, title, album, qualityName, duration, qualityFallback } = transferResult;
          downloadedFilePaths.push({ zipFilePath, audioFilePath, lrcFilePath, thumbFilePath });
          const artistTag = sanitizeHashtag(artist);
          const titleTag = sanitizeHashtag(title);
          const albumTag = sanitizeHashtag(album);

          let sendResult;
          if (transferResult.isZip && zipFilePath) {
            const zipCaption = safeCaption(
`📦 <b>${escapeHtml(title)} [ZIP]</b>
👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(artist)}
💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(album)}
🎧 ${isEn ? 'Format:' : '规格：'}${escapeHtml(qualityName || quality)}
${qualityFallback ? `⚠️ ${escapeHtml(qualityFallback)}\n` : ''}
${artistTag} ${titleTag} ${albumTag} #ZIP`);
            sendResult = await unifiedSendMedia({
              chatId,
              filePath: zipFilePath,
              fileName: zipFileName,
              caption: zipCaption,
              isZip: true,
              isAudio: false,
              privateCopy: false
            });
            db.set(cacheKey, {
              adamId: track.id,
              quality,
              isZip: true,
              groupMsgId: sendResult.groupMsgId,
              zipFileId: sendResult.fileId || null,
              artist, title, album, qualityName,
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
              title,
              performer: artist,
              duration: duration || Math.round((details.durationInMillis || 0) / 1000),
              privateCopy: false
            });

            let lrcGroupMsgId = null;
            let lrcFileId = null;
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
                  replyToMessageId: sendResult.groupMsgId,
                  privateCopy: false
                });
                lrcGroupMsgId = lrcResult.groupMsgId;
                lrcFileId = lrcResult.fileId || null;
              } catch (lrcErr) {
                console.warn('[TG-Bot] 批量歌词发送失败 (非致命):', lrcErr.message);
              }
            }

            db.set(cacheKey, {
              adamId: track.id,
              quality,
              isZip: false,
              groupMsgId: sendResult.groupMsgId,
              audioFileId: sendResult.fileId || null,
              lrcFileId,
              lrcGroupMsgId,
              artist, title, album, qualityName,
              createdAt: Date.now()
            });
          }

          // 额度在任务结束时按实际新下载首数统一结算（见 finally），此处仅计数
          downloadedCount++;

          if (sendResult?.groupMsgId) allMsgIds.push(sendResult.groupMsgId);
          try {
            await tgCall('editMessageText', {
              chat_id: chatId,
              message_id: messageId,
              text: `⏳ <b>${isEn ? 'Batch transfer' : '批量转存'} [${i + 1}/${tracks.length}]</b>\n🎵 ${escapeHtml(title)} (${isEn ? 'archived' : '已归档'})`,
              parse_mode: 'HTML'
            });
          } catch {}
        }

        // 3. 全部处理完毕后，统一推送到用户私聊
        await pushAlbumMsgsToPrivate(chatId, allMsgIds);
        for (const s of fileIdSends) {
          try {
            if (s.kind === 'audio') {
              await tgCall('sendAudio', {
                chat_id: chatId,
                audio: s.fileId,
                caption: safeCaption(`🎵 <b>${escapeHtml(s.title)}</b>\n👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(s.artist)}\n💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(s.album)}`),
                parse_mode: 'HTML',
                title: s.title,
                performer: s.artist
              });
              if (s.lrcFileId) {
                await tgCall('sendDocument', {
                  chat_id: chatId,
                  document: s.lrcFileId,
                  caption: safeCaption(`📝 ${escapeHtml(s.artist)} - ${escapeHtml(s.title)}.lrc`)
                });
              }
            } else {
              await tgCall('sendDocument', {
                chat_id: chatId,
                document: s.fileId,
                caption: safeCaption(`📦 <b>${escapeHtml(s.title)} [ZIP]</b>\n👤 ${isEn ? 'Artist:' : '歌手：'}${escapeHtml(s.artist)}\n💿 ${isEn ? 'Album:' : '专辑：'}${escapeHtml(s.album)}`),
                parse_mode: 'HTML'
              });
            }
          } catch (fidErr) {
            console.warn(`[TG-Bot] 批量 fileId 直发失败 (${s.title}):`, fidErr.message);
          }
        }

        const skipNote = skippedTracks.length ? (
          isEn
            ? `\n\n⚠️ <b>Note:</b> ${skippedTracks.length} ${skippedTracks.length > 1 ? 'tracks were' : 'track was'} skipped:\n${skippedTracks.map(s => `• ${escapeHtml(s.track?.name || s.track || 'Unknown')} — ${escapeHtml((s.error || 'unavailable').split('\n')[0])}`).join('\n')}`
            : `\n\n⚠️ <b>注明：</b>有 ${skippedTracks.length} 首歌曲未能收录：\n${skippedTracks.map(s => `• ${escapeHtml(s.track?.name || s.track || '未知曲目')} — ${escapeHtml((s.error || '不可用').split('\n')[0])}`).join('\n')}`
        ) : '';
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `🎉 <b>Batch track transfer complete!</b>\nDownloaded <code>${downloadedCount}</code>, instant-delivered <code>${cachedHit}</code>, all pushed to your chat.${skipNote}`
            : `🎉 <b>批量单曲转存完成！</b>\n新下载 <code>${downloadedCount}</code> 首、秒传跳过 <code>${cachedHit}</code> 首，已全部推送到您的私聊。${skipNote}`,
          parse_mode: 'HTML'
        });
      } catch (err) {
        console.error('[TG-Bot] 多选单曲批量下载异常:', err);
        try {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn ? `❌ <b>Batch transfer error:</b> ${escapeHtml(err.message)}` : `❌ <b>批量转存遇到错误:</b> ${escapeHtml(err.message)}`,
            parse_mode: 'HTML'
          });
        } catch {}
      } finally {
        // 整单对账：按实际新下载首数结算，多退少补（失败则全额退回预留）
        if (multiQuota.reserved && hasPendingReservation(chatId)) {
          settleQuotaReservation(chatId, downloadedCount);
        }
        // 统一清理本次批量新下载的临时文件 (zip / audio 目录 / lrc / 封面)
        for (const f of downloadedFilePaths) {
          try {
            if (f.zipFilePath) fs.rmSync(f.zipFilePath, { force: true });
            if (f.audioFilePath) {
              const dir = path.dirname(f.audioFilePath);
              if (dir.includes('am_tg_')) fs.rmSync(dir, { recursive: true, force: true });
            }
            if (f.lrcFilePath) fs.rmSync(f.lrcFilePath, { force: true });
            if (f.thumbFilePath) fs.rmSync(f.thumbFilePath, { force: true });
          } catch {}
        }
      }
    }
  );
}

// ==================== 艺人全专辑批量转存 ====================
// 规则：额度内直接下载（和普通专辑一样选音质/歌词/交付模式）；超出每日额度才走站长审批。
// 勾选的专辑逐张处理：群聊已缓存的直接跳过并收录消息，未缓存的下载归档；全部就绪后统一推送到私聊
async function handleArtistAlbumsDownload(chatId, messageId, artistId, quality = 'Lossless', needLrc = true, deliveryMode = 'zip', needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman', approved = false) {
  saveLyricsFormats = resolveLyricsIntent(embedLyricsMode, saveLyricsFormats).formats;
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const isAdmin = String(chatId) === String(OWNER_USER_ID);

  let artistData;
  try {
    artistData = await getArtistData(artistId, 'hk', userLang, getUserTagLang(chatId));
  } catch (err) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `❌ ${isEn ? 'Failed to load artist' : '加载艺人失败'}: ${escapeHtml(err.message)}`,
      parse_mode: 'HTML'
    }).catch(() => {});
    return;
  }
  const selection = getSelection(chatId, 'art', artistId);
  const selectedAlbums = (artistData.albums || []).filter(al => selection.has(String(al.id)));
  if (!selectedAlbums.length) return;

  // 预检：按是否已在群聊缓存，将勾选的专辑拆分为「秒传跳过」与「需下载」两组
  const cachedMeta = [];
  const toDownload = [];
  for (const al of selectedAlbums) {
    const cacheKey = `album_${al.id}_${quality.toLowerCase()}_${deliveryMode}${isEn ? '_en' : ''}`;
    const cached = db.get(cacheKey);
    const validCache = cached && (
      (deliveryMode === 'zip' && (cached.groupMsgId || cached.zipFileId)) ||
      (deliveryMode !== 'zip' && (cached.groupMsgIds?.length || cached.audioFileIds?.length))
    );
    if (validCache) cachedMeta.push({ al, cached });
    else toDownload.push(al);
  }

  return botTaskQueue.enqueue(
    { chatId, messageId, type: 'album', name: `${artistData.name} 全专辑批量` },
    async () => {
      const allMsgIds = [];
      const fileIdSends = [];
      const gofileLinks = [];
      const failedAlbums = [];
      const totalAlbums = selectedAlbums.length;
      let downloadedCount = 0;
      let downloadedTracks = 0;
      // 整单额度预留：按待下载专辑的曲目总数从严预留，不够则直接拒绝（不会开始任何下载）。
      // 获批的普通用户：审批本身就是放行，不再受每日额度限制。
      const plannedTracks = toDownload.reduce((s, al) => s + ((al.trackCount || 0) || 0), 0);
      const batchReserve = (!isAdmin && approved)
        ? { ok: true, reserved: false, current: 0, max: 0, remaining: Infinity }
        : quotaManager.reserveQuota(chatId, plannedTracks);
      if (!batchReserve.ok) {
        // 额度内直接下载；只有超出每日额度才打扰站长审批
        if (!isAdmin && !approved) {
          // 超额：走「歌手全专辑」申请通道（req:disc），带上艺人 ID 和已勾选专辑，批准后可精确复原
          const picked = toDownload.map((al) => String(al.id));
          selection.clear();
          picked.forEach((id) => selection.add(id));
          await offerApprovalRequest({
            chatId, messageId, userInfo: null,
            quality,
            albumData: { albumId: artistId, name: artistData.name, artistName: artistData.name, tracks: [] },
            isPl: false,
            typeLabel: isEn ? 'artist discography' : '歌手全专辑',
            isEn,
            tracks: plannedTracks,
            requestKind: 'disc',
            options: {
              quality, needTranslate, embedLyricsMode, saveLyricsFormats, needRuby, rubyMode,
            },
          });
          return;
        }
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `⚠️ <b>Daily quota insufficient:</b> this batch needs <code>${plannedTracks}</code> tracks, only <code>${batchReserve.remaining}</code> left today. Nothing was downloaded.`
            : `⚠️ <b>今日配额不足，未开始下载</b>\n\n本批共需 <code>${plannedTracks}</code> 首，今日仅剩 <code>${batchReserve.remaining}</code> 首（每日上限 <code>${batchReserve.max}</code> 首）。已取消，未消耗任何额度。`,
          parse_mode: 'HTML'
        });
        selection.clear();
        return;
      }
      if (batchReserve.reserved) addPendingReservation(chatId, plannedTracks);

      try {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `📀 <b>Artist Batch Transfer: ${escapeHtml(artistData.name)}</b>\n📦 Total ${totalAlbums} albums: <code>${toDownload.length}</code> to download, <code>${cachedMeta.length}</code> cached & will be skipped (instant delivery).`
            : `📀 <b>艺人全专辑批量转存：${escapeHtml(artistData.name)}</b>\n📦 共勾选 ${totalAlbums} 张专辑：<code>${toDownload.length}</code> 张需下载，<code>${cachedMeta.length}</code> 张群聊已缓存将秒传跳过。`,
          parse_mode: 'HTML'
        });

        // 阶段 1：流水线下载未缓存的专辑 (并发 2：前一张专辑归档上传到频道时，后一张已同时开始下载，
        // 下载与上传两个阶段跨专辑重叠，整批总耗时从「逐张串行和」大幅缩短为「首张下载 + 后续 max(下载,上传) + 末张上传」)
        // ⚠️ 专辑级并发保持 2 不改：每张专辑内部还会按 TG_TRACK_CONCURRENCY 并发下载曲目，
        // 两者是相乘关系。若专辑级也提到 3，瞬时并发会到 9，成倍放大 /tmp 占用与频道上传带宽争抢。
        const BATCH_ALBUM_CONCURRENCY = 2;
        await pMap(toDownload, BATCH_ALBUM_CONCURRENCY, async (al, i) => {
          const prefix = `📀 [${i + 1}/${toDownload.length}] ${escapeHtml(al.name)}：`;
          let albumData = null;
          try {
            albumData = await fetchAlbumDetails(al.id, 'hk', userLang, getUserTagLang(chatId));
          } catch (err) {
            console.warn(`[TG-Bot] 批量专辑 ${al.name} 解析失败: ${err.message}`);
            failedAlbums.push({ name: al.name, error: err.message });
            try {
              await tgCall('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: `${prefix}❌ ${isEn ? 'Failed to resolve album' : '解析专辑失败'}: ${escapeHtml(err.message)}`,
                parse_mode: 'HTML'
              });
            } catch {}
            return;
          }
          try {
            const res = await transferAlbumCore({ chatId, messageId, albumData, quality, needLrc, deliveryMode, progressPrefix: prefix, needTranslate, embedLyricsMode, saveLyricsFormats, needRuby, rubyMode });
            if (res && res.ok) {
              if (res.isGofile && res.gofileUrl) {
                // Gofile 模式：链接必须收进清单，否则用户永远拿不到（旧实现只接 allGroupMsgIds / zipFileId，
                // 导致整批跑完却一条链接都没有）
                gofileLinks.push({ name: res.albumName || al.name, url: res.gofileUrl, tracks: res.downloadedCount, sizeMb: res.totalSizeMb });
              } else if (res.allGroupMsgIds?.length) allMsgIds.push(...res.allGroupMsgIds);
              else if (res.zipFileId) fileIdSends.push({ kind: 'doc', fileId: res.zipFileId, name: res.albumName });
              downloadedCount++;
            }
          } catch (err) {
            console.warn(`[TG-Bot] 批量专辑 ${al.name} 下载失败: ${err.message}`);
            failedAlbums.push({ name: al.name, error: err.message });
            try {
              await tgCall('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: `${prefix}❌ ${isEn ? 'Album transfer failed' : '专辑转存失败'}: ${escapeHtml(err.message)}`,
                parse_mode: 'HTML'
              });
            } catch {}
          }
        });

        // 阶段 2：已缓存专辑跳过下载，直接收录群消息
        for (const { al, cached } of cachedMeta) {
          const cachedIds = deliveryMode === 'zip'
            ? (cached.groupMsgId ? [cached.groupMsgId] : [])
            : (cached.groupMsgIds && Array.isArray(cached.groupMsgIds) ? cached.groupMsgIds : []);
          if (cachedIds.length) {
            allMsgIds.push(...cachedIds);
          } else if (deliveryMode === 'zip' && cached.zipFileId) {
            fileIdSends.push({ kind: 'doc', fileId: cached.zipFileId, name: cached.albumName || al.name });
          } else {
            failedAlbums.push({ name: al.name, error: 'cache-invalid' });
          }
        }

        // 阶段 3：全部就绪后，统一推送到用户私聊
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `🚀 <b>All albums archived, pushing <code>${allMsgIds.length}</code> cached messages to your chat...</b>`
            : `🚀 <b>全部专辑已归档就绪，正在将 <code>${allMsgIds.length}</code> 条群消息统一推送到您的私聊...</b>`,
          parse_mode: 'HTML'
        });
        await pushAlbumMsgsToPrivate(chatId, allMsgIds);
        for (const s of fileIdSends) {
          try {
            await tgCall('sendDocument', {
              chat_id: chatId,
              document: s.fileId,
              caption: safeCaption(`📦 <b>${escapeHtml(s.name || 'Album')} [AlbumZIP]</b>`),
              parse_mode: 'HTML'
            });
          } catch (fidErr) {
            console.warn(`[TG-Bot] 批量专辑 fileId 直发失败 (${s.name}):`, fidErr.message);
          }
        }

        const failedNote = failedAlbums.length
          ? `\n\n❌ ${isEn ? 'Failed: ' : '失败：'}${failedAlbums.map(f => escapeHtml(f.name)).join('、')}`
          : '';

        // Gofile 模式：每张专辑一条链接，逐条推给申请人，并同步给站长抽查
        for (const g of gofileLinks) {
          await tgCall('sendMessage', {
            chat_id: chatId,
            text: isEn
              ? `☁️ <b>${escapeHtml(g.name)}</b> — ${g.tracks} tracks · ${g.sizeMb} MB\n🔗 ${g.url}\n\n<b>Download it early</b> — the link expires after inactivity.`
              : `☁️ <b>${escapeHtml(g.name)}</b> — ${g.tracks} 首 · ${g.sizeMb} MB\n🔗 ${g.url}\n\n<b>请尽快下载</b>，链接长期无访问会过期。`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: isEn ? '☁️ Open Gofile' : '☁️ 打开 Gofile', url: g.url }]] }
          }).catch(() => {});
          await notifyOwnerGofileDone({
            chatId, albumName: g.name, artistName: artistData.name,
            url: g.url, tracks: g.tracks, sizeMb: g.sizeMb, elapsedSec: 0,
          });
        }

        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEn
            ? `🎉 <b>Artist batch transfer complete!</b>\n📀 ${escapeHtml(artistData.name)}: downloaded <code>${downloadedCount}</code>, instant-delivered <code>${cachedMeta.length}</code>, total <code>${totalAlbums}</code> albums.${gofileLinks.length ? `\n☁️ <code>${gofileLinks.length}</code> Gofile link(s) sent above.` : ''}${failedNote}`
            : `🎉 <b>艺人全专辑批量转存完成！</b>\n📀 ${escapeHtml(artistData.name)}：新下载 <code>${downloadedCount}</code> 张、缓存秒传跳过 <code>${cachedMeta.length}</code> 张，共 ${totalAlbums} 张。${gofileLinks.length ? `\n☁️ 已在上方发送 <code>${gofileLinks.length}</code> 条 Gofile 链接。` : ''}${failedNote}`,
          parse_mode: 'HTML'
        });
      } catch (err) {
        console.error('[TG-Bot] 艺人全专辑批量转存异常:', err);
        try {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn ? `❌ <b>Batch transfer error:</b> ${escapeHtml(err.message)}` : `❌ <b>批量转存遇到错误:</b> ${escapeHtml(err.message)}`,
            parse_mode: 'HTML'
          });
        } catch {}
      } finally {
        // 整单对账：按实际下载曲目数结算，多退少补（失败则全额退回预留）
        if (batchReserve.reserved && hasPendingReservation(chatId)) {
          settleQuotaReservation(chatId, downloadedTracks);
        }
        selection.clear();
      }
    }
  );
}

// ==================== 全专辑下载与合并消息发送 ====================

// 将一批已归档群消息统一复制到用户私聊 (分批 ≤90 条/次，失败逐条降级重试)
async function pushAlbumMsgsToPrivate(chatId, msgIds) {
  if (!msgIds.length || String(chatId) === String(AUTHORIZED_GROUP_ID)) return;
  await new Promise(r => setTimeout(r, 1500));
  for (let i = 0; i < msgIds.length; i += 90) {
    const chunk = msgIds.slice(i, i + 90);
    try {
      await tgCall('copyMessages', {
        chat_id: chatId,
        from_chat_id: AUTHORIZED_GROUP_ID,
        message_ids: chunk
      });
    } catch (copyAllErr) {
      console.warn(`[TG-Bot] copyMessages 批量复制失败，降级为逐首复制: ${copyAllErr.message}`);
      for (const mid of chunk) {
        try {
          await tgCall('copyMessage', {
            chat_id: chatId,
            from_chat_id: AUTHORIZED_GROUP_ID,
            message_id: mid
          });
          await new Promise(r => setTimeout(r, 500));
        } catch (singleErr) {
          console.warn(`[TG-Bot] 单条复制失败: ${singleErr.message}`);
        }
      }
    }
  }
}

// 仅下载歌词（专辑）：不发音频，整辑每首只取歌词文件推送（LRC/TTML/both）
async function handleAlbumLyricsOnlyDownload(chatId, messageId, albumData, want, needTranslate = false, needRuby = false, rubyMode = 'roman') {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const wantFormats = want === 'both' ? ['lrc', 'ttml'] : [want];
  const tracks = albumData.tracks || [];
  const typeLabel = albumData.isPlaylist === true ? (isEn ? 'Playlist' : '歌单') : (isEn ? 'Album' : '专辑');
  await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: isEn
      ? `⏳ <b>Fetching ${typeLabel.toLowerCase()} lyrics only (${tracks.length} tracks)...</b>`
      : `⏳ <b>正在获取整张${typeLabel}的歌词文件（${tracks.length} 首，无需下载音频）...</b>`,
    parse_mode: 'HTML'
  });

  const okFiles = [];
  const failList = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const attr = t.attributes || {};
    const title = attr.name || 'Unknown';
    const artist = attr.artistName || albumData.artistName || '';
    try {
      const payload = {
        adamId: t.id,
        quality: 'AAC',
        meta: { title, artist, album: albumData.name || '' },
        lyricsOnly: true,
        saveLyricsFormats: wantFormats,
        translateLyrics: Boolean(needTranslate),
        ruby: Boolean(needRuby),
        rubyMode: rubyMode || 'roman',
        lang: userLang,
        noUpload: true
      };
      const res = await fetch(CLOUD_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json();
      if (data.status !== 'ok' || !data.data?.lyricsFiles?.length) {
        failList.push(`${i + 1}. ${title} (${isEn ? 'no lyrics' : '无歌词'})`);
        continue;
      }
      for (const f of data.data.lyricsFiles) {
        const fpath = `/tmp/am_lyr_only_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${f.filename.split('.').pop()}`;
        fs.writeFileSync(fpath, f.content, 'utf8');
        await unifiedSendMedia({
          chatId,
          filePath: fpath,
          fileName: f.filename,
          caption: safeCaption(`📝 <b>${escapeHtml(title)}</b> - ${isEn ? 'Lyrics' : '歌词'}`),
          isAudio: false,
          isZip: false
        });
        try { fs.rmSync(fpath, { force: true }); } catch {}
        okFiles.push(f.filename);
      }
    } catch (err) {
      console.warn(`[TG-Bot] 仅歌词 ${title} 失败:`, err.message);
      failList.push(`${i + 1}. ${title} (${err.message})`);
    }
  }

  const failNote = failList.length
    ? (isEn
      ? `\n❌ Skipped ${failList.length} tracks:\n${failList.slice(0, 12).join('\n')}${failList.length > 12 ? `\n…and ${failList.length - 12} more` : ''}`
      : `\n❌ 未收录 ${failList.length} 首：\n${failList.slice(0, 12).join('\n')}${failList.length > 12 ? `\n…等 ${failList.length} 首` : ''}`)
    : '';
  await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: isEn
      ? `🎉 <b>${typeLabel} lyrics delivered!</b> (${okFiles.length} files)${failNote}`
      : `🎉 <b>整张${typeLabel}歌词已推送！</b>（${okFiles.length} 个文件，未下载音频）${failNote}`,
    parse_mode: 'HTML'
  });
}

// 单张专辑下载入口：命中缓存秒传直发 -> 配额检查 -> 入队 -> transferAlbumCore 下载归档 -> 统一推送私聊
async function handleAlbumDownload(chatId, messageId, albumData, quality, needLrc, deliveryMode, needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman', approved = false) {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const isAdmin = String(chatId) === String(OWNER_USER_ID);
  const albumId = albumData.albumId;
  const isPl = albumData.isPlaylist === true;
  const typeLabel = isPl ? (isEn ? 'Playlist' : '歌单') : (isEn ? 'Album' : '专辑');
  const cacheKey = `album_${albumId}_${quality.toLowerCase()}_${deliveryMode}${isEn ? '_en' : ''}`;
  const cached = db.get(cacheKey);

  // 1. 命中全辑缓存秒传 (直接直发，无需进入排队队列)
  if (cached && (
    (deliveryMode === 'zip' && (cached.groupMsgId || cached.zipFileId || cached.groupMsgIds?.length)) ||
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
        if (cached.groupMsgIds && Array.isArray(cached.groupMsgIds) && cached.groupMsgIds.length > 1) {
          await tgCall('copyMessages', {
            chat_id: chatId,
            from_chat_id: AUTHORIZED_GROUP_ID,
            message_ids: cached.groupMsgIds
          });
          albumCopySuccess = true;
        } else if (cached.groupMsgId) {
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
            // 秒传复用路径同样要节流，否则密集推送仍会触发 429 并导致重复卡片
            await throttleMediaGroup();
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
      const updateTip = consumeOneTimeUpdateNotice(chatId, userLang);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: (isEn ? `🎉 <b>Instant ${typeLabel.toLowerCase()} delivery complete!</b>` : `🎉 <b>全辑秒传推送完成！</b>`) + updateTip,
        parse_mode: 'HTML'
      });
      return;
    }
  }
  // 开跑前一次性预估整单额度：按专辑实际曲目数从严预留，不够直接拒绝，绝不开始下载
  // (已归档秒传在上面的缓存分支就已返回，不消耗额度；作者专属账号 100% 豁免)
  // 获批的普通用户：额度不是门槛（审批本身就是放行），直接按 0 首预留
  const albumTrackCount = (albumData.tracks || []).length;
  const quotaReserve = (!isAdmin && approved)
    ? { ok: true, reserved: false, current: 0, max: 0, remaining: Infinity }
    : quotaManager.reserveQuota(chatId, albumTrackCount);
  if (quotaReserve.ok && quotaReserve.reserved) addPendingReservation(chatId, albumTrackCount);
  if (!quotaReserve.ok) {
    // 超量 + 非站长 + 未获批：改为提供「申请授权」入口，而不是直接拒绝
    if (!isAdmin && !approved) {
      await offerApprovalRequest({
        chatId, messageId, userInfo: null, quality, albumData, isPl, typeLabel, isEn,
        tracks: albumTrackCount,
        // 必须带上用户已选好的选项，否则申请卡看不到参数、批准后也会跑成默认值
        options: {
          quality,
          needTranslate,
          embedLyricsMode,
          saveLyricsFormats,
          needRuby,
          rubyMode,
        },
      });
      return;
    }
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: isEn
        ? `⚠️ <b>Daily quota insufficient</b>\n\nThis ${typeLabel.toLowerCase()} has <code>${albumTrackCount}</code> tracks, but you only have <code>${quotaReserve.remaining}</code> of your daily <code>${quotaReserve.max}</code>-track quota left (used <code>${quotaReserve.current}</code>).\n\n⏰ Resets daily at midnight (UTC+8).\n💡 Archived ${typeLabel.toLowerCase()}s still deliver instantly and do NOT count towards quota.`
        : `⚠️ <b>今日配额不足，未开始下载</b>\n\n该${typeLabel}共 <code>${albumTrackCount}</code> 首，而您今天剩余的额度只有 <code>${quotaReserve.remaining}</code> 首（每日上限 <code>${quotaReserve.max}</code> 首，已用 <code>${quotaReserve.current}</code> 首）。\n\n⏰ <b>配额刷新时间</b>：北京时间每日午夜 00:00 自动重置，明日即可恢复使用。\n💡 <b>免配额小贴士</b>：所有已归档${typeLabel}仍支持秒传直发，<b>秒传不计入任何配额</b>。`,
      parse_mode: 'HTML'
    });
    return;
  }

  // 2. 加入机器人全局任务排队队列 (Task-Level FIFO，前序专辑彻底交付后才会开始)
  //    排队时先给用户提示「前面还有几个任务」，并在提示里推荐 Gofile 模式
  if (botTaskQueue.queue.length > 0) {
    await notifyQueueIfBusy(chatId, messageId, isEn, typeLabel).catch(() => {});
  }
  return botTaskQueue.enqueue(
    { chatId, messageId, type: 'album', name: albumData.name },
    async () => {
      try {
        const res = await transferAlbumCore({ chatId, messageId, albumData, quality, needLrc, deliveryMode, progressPrefix: '', needTranslate, embedLyricsMode, saveLyricsFormats, needRuby, rubyMode });
        if (!res || !res.ok) {
          // transferAlbumCore 内部已把失败原因写进这条消息，这里直接收尾即可，避免任务一直挂着
          return;
        }

        // Gofile 模式：链接已由 transferAlbumCore 发到用户私聊，这里只需同步给站长
        if (res.isGofile && res.gofileUrl) {
          await notifyOwnerGofileDone({
            chatId, albumName: albumData.name,
            artistName: albumData.artistName, url: res.gofileUrl,
            tracks: res.downloadedCount, sizeMb: res.totalSizeMb, elapsedSec: res.totalDurationSec,
          });
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `🎉 <b>Done!</b> ${res.downloadedCount} tracks uploaded to Gofile in ${res.totalDurationSec}s. Link sent above.`
              : `🎉 <b>完成！</b> ${res.downloadedCount} 首已上传至 Gofile，耗时 ${res.totalDurationSec} 秒。链接见上方消息。`,
            parse_mode: 'HTML'
          }).catch(() => {});
          return;
        }

        await pushAlbumMsgsToPrivate(chatId, res.allGroupMsgIds);
        const useTotalSizeMb = res.zipSizeMb || res.sendResult?.sizeMb || 0;
        const useUploadSec = res.uploadDurationSec || res.sendResult?.durationSec || 0;
        const useSpeedMbS = useTotalSizeMb && useUploadSec ? Number((useTotalSizeMb / useUploadSec).toFixed(2)) : (res.sendResult?.speedMbS || 0);
        const statsText = res.sendResult?.durationSec ? (
          isEn
            ? `\n\n📊 <b>Performance Stats:</b>\n• Total Size: <code>${useTotalSizeMb} MB</code> (${res.downloadedCount} tracks, ${res.zipPartCount || 1} zip ${res.zipPartCount > 1 ? 'parts' : 'part'})\n• Official Upload Time: <code>${useUploadSec}s</code> (Speed: <code>${useSpeedMbS} MB/s</code>)\n• Total Elapsed: <code>${res.totalDurationSec}s</code>\n• Dedicated Tunnel: <code>Official Local Bot API (Zero-Copy)</code>`
            : `\n\n📊 <b>全辑性能统计：</b>\n• 全辑体积：<code>${useTotalSizeMb} MB</code> (共 ${res.downloadedCount} 首${res.zipPartCount > 1 ? `，${res.zipPartCount} 卷分卷` : ''})\n• 官方上传耗时：<code>${useUploadSec} 秒</code> (速度: <code>${useSpeedMbS} MB/s</code>)\n• 全辑总耗时：<code>${res.totalDurationSec} 秒</code>\n• 传输通道：<code>官方 Local Bot API 专线 (零拷贝极速通道)</code>`
        ) : '';

        const skipNote = res.skippedTracks?.length ? (
          isEn
            ? `\n\n⚠️ <b>Note:</b> ${res.skippedTracks.length} ${res.skippedTracks.length > 1 ? 'tracks were' : 'track was'} skipped:\n${res.skippedTracks.map(s => `• ${escapeHtml(s.track?.name || s.track || 'Unknown')} — ${escapeHtml((s.error || 'unavailable').split('\n')[0])}`).join('\n')}`
            : `\n\n⚠️ <b>注明：</b>有 ${res.skippedTracks.length} 首歌曲未能收录：\n${res.skippedTracks.map(s => `• ${escapeHtml(s.track?.name || s.track || '未知曲目')}— ${escapeHtml((s.error || '不可用').split('\n')[0])}`).join('\n')}`
        ) : '';

        const updateTip = consumeOneTimeUpdateNotice(chatId, userLang);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: (res.sendResult?.durationSec
            ? (isEn
              ? `🎉 <b>Full ${typeLabel.toLowerCase()} transfer complete!</b>\nWhole album delivered as a single message to your chat.${skipNote}${statsText}`
              : `🎉 <b>全辑转存完成！</b>\n整张${typeLabel}已作为完整合辑消息推送给您。${skipNote}${statsText}`)
            : (isEn
              ? `🎉 <b>Full ${typeLabel.toLowerCase()} transfer complete!</b>\nAll tracks archived and pushed to your private chat as clean playlist bubbles (Total elapsed: <code>${res.totalDurationSec}s</code>).${skipNote}`
              : `🎉 <b>全辑转存完成！</b>\n整张${typeLabel}已作为统一播放列表合辑同步存入频道并推送到您的私聊 (总耗时: <code>${res.totalDurationSec}s</code>)。${skipNote}`)) + updateTip,
          parse_mode: 'HTML'
        });
      } catch (err) {
        console.error('[TG-Bot] 全辑下载处理异常:', err);
        try {
          const contactHint = isEn
            ? `\n\n⚠️ If the issue persists, please contact the admin: <a href="https://t.me/whyResetmytelegramaccount">🧑‍💻 @whyResetmytelegramaccount</a>`
            : `\n\n⚠️ 若问题持续，请点击联系站长：<a href="https://t.me/whyResetmytelegramaccount">🧑‍💻 @whyResetmytelegramaccount</a>`;
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `❌ <b>${typeLabel} processing error:</b> ${escapeHtml(err.message)}${contactHint}`
              : `❌ <b>全辑处理遇到错误:</b> ${escapeHtml(err.message)}${contactHint}`,
            parse_mode: 'HTML'
          });
        } catch {}
      } finally {
        // 整单失败/异常：退回尚未对账的预留额度，不让用户为失败任务付费
        // （成功路径已在 transferAlbumCore 内按实际下载数对账）
        if (quotaReserve.reserved && hasPendingReservation(chatId)) {
          settleQuotaReservation(chatId, 0);
        }
      }
    }
  );
}

// 全辑转存核心：(下载 -> 频道归档 -> 写入缓存)，不负责私聊推送，由调用方决定何时统一 copyMessages。
// progressPrefix 用于批量场景在进度消息前标注 [i/N] 专辑名。
async function transferAlbumCore({ chatId, messageId, albumData, quality, needLrc, deliveryMode, progressPrefix = '', needTranslate = false, embedLyricsMode = 'lrc', saveLyricsFormats = [], needRuby = false, rubyMode = 'roman' }) {
  const userLang = getUserLang(chatId);
  const isEn = userLang === 'en';
  const albumId = albumData.albumId;
  const isPl = albumData.isPlaylist === true;
  saveLyricsFormats = resolveLyricsIntent(embedLyricsMode, saveLyricsFormats).formats;
  const typeLabel = isPl ? (isEn ? 'Playlist' : '歌单') : (isEn ? 'Album' : '专辑');
  // Gofile 模式在 TG 侧不落任何群消息，缓存 key 与 zip/media 分开，避免秒传命中错误的分支
  const cacheKey = `album_${albumId}_${quality.toLowerCase()}_${deliveryMode}${isEn ? '_en' : ''}`;
  const totalTracks = albumData.tracks.length;
  // 外置歌词（.lrc / .ttml）改为用户可选：
  // 勾了就真的生成并写进压缩包/文件夹；不勾就只保留内嵌歌词。
  // 唯一例外是「原生音频合辑」模式 —— 它走 TG 媒体组逐条发送，外置文件无法随包附带，
  // 强行保留会变成一堆零散消息，所以该模式仍收敛为空。
  if (deliveryMode === 'media') saveLyricsFormats = [];
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: isEn
          ? `${progressPrefix}⏳ <b>Starting ${typeLabel.toLowerCase()} transfer (Total ${totalTracks} tracks)...</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`
          : `${progressPrefix}⏳ <b>开始转存整张专辑 (共 ${totalTracks} 首)...</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`,
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
        if (deliveryMode === 'gofile') {
          // 3.G Gofile 云盘模式：直接由 cloud-service 打包并上传到 Gofile，TG 只回一个链接。
          // 相比 ZIP 直发 Telegram，这个模式不占 TG 上行带宽、不受 2GB 单文件限制，适合超大歌手全辑。
          let completedCount = 0;
          const batchGofileId = batchId;
          // 单曲异常绝不能逃逸出 worker：pMap 内部是 Promise.all，任一 worker 抛错会立刻 reject，
          // 整个批次中断，已经成功上传的曲目全部作废，用户一条链接都收不到。这里整段兜底。
          await pMap(albumData.tracks, TG_TRACK_CONCURRENCY, async (track, i) => {
            const trackOrder = i + 1;
            try {
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
              batchId: batchGofileId,
              isLastTrack: false,
              saveLrc: saveLyricsFormats.length > 0,
              embedLyrics: embedLyricsMode !== 'off',
              lyricsFormat: embedLyricsMode === 'ttml' ? 'ttml' : 'lrc',
              saveLyricsFormats,
              translateLyrics: needTranslate || false,
              ruby: needRuby || false,
              rubyMode: rubyMode || 'roman',
              lang: userLang,
              // 与 ZIP 模式不同：这里让 cloud-service 上传，产物落在 Gofile 而不是本地
              noUpload: false
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
                  throw new Error(data.error || (isEn ? 'Transfer service error' : '解析异常'));
                }
                allDownloadedFiles.push({ ...data.data, track, orderIndex: trackOrder });
                completedCount++;
                try {
                  await tgCall('editMessageText', {
                    chat_id: chatId,
                    message_id: messageId,
                    text: isEn
                      ? `${progressPrefix}⏳ <b>Uploading to Gofile [${completedCount}/${totalTracks}]</b>\n🎵 ${escapeHtml(track.name)}${skippedTracks.length ? `\n(${skippedTracks.length} unavailable skipped)` : ''}`
                      : `${progressPrefix}⏳ <b>正在上传至 Gofile [${completedCount}/${totalTracks}]</b>\n🎵 ${escapeHtml(track.name)}${skippedTracks.length ? `\n(已跳过 ${skippedTracks.length} 首不可用歌曲)` : ''}`,
                    parse_mode: 'HTML'
                  });
                } catch {}
                break;
              } catch (trackErr) {
                if (retry === 0) {
                  console.warn(`[TG-Bot] Gofile 曲目 [${trackOrder}/${totalTracks}] ${track.name} 异常，1.5秒后重试: ${trackErr.message}`);
                  await new Promise(r => setTimeout(r, 1500));
                } else {
                  console.warn(`[TG-Bot] Gofile 曲目 [${trackOrder}/${totalTracks}] 跳过:`, track.name, trackErr.message);
                  skippedTracks.push({ track, error: trackErr.message });
                }
              }
            }
            } catch (outerErr) {
              // 组装 payload、推送进度等任何环节出错，都只影响这一首，不牵连整批
              console.warn(`[TG-Bot] Gofile 曲目 [${trackOrder}/${totalTracks}] ${track?.name} 彻底失败:`, outerErr.message);
              skippedTracks.push({ track, error: outerErr.message });
            }
          });

          if (allDownloadedFiles.length === 0) {
            throw new Error(isEn
              ? `All tracks in this ${typeLabel.toLowerCase()} are unavailable in the resolving region or failed to download.`
              : `整张专辑的所有曲目均在当前地区无版权或下载失败，无法转存。`);
          }

          // 汇总 folderId / guestToken / downloadPage：逐曲上传时 cloud-service 会把它们带回来
          const parentFolder = allDownloadedFiles.find(f => f.folderId)?.folderId || null;
          const guestToken = allDownloadedFiles.find(f => f.guestToken)?.guestToken || null;
          const downloadPage = allDownloadedFiles.map(f => f.downloadPage).filter(Boolean).pop()
            || (parentFolder ? `https://gofile.io/d/${parentFolder}` : '');

          if (hasPendingReservation(chatId)) settleQuotaReservation(chatId, allDownloadedFiles.length);
          else quotaManager.incrementQuota(chatId, allDownloadedFiles.length);

          const goTotalDurationSec = ((performance.now() - albumStartTime) / 1000).toFixed(1);
          const totalMb = (allDownloadedFiles.reduce((s, f) => s + (f.fileSize || 0), 0) / (1024 * 1024)).toFixed(1);

          if (downloadPage) {
            await tgCall('sendMessage', {
              chat_id: chatId,
              text: isEn
                ? `☁️ <b>${typeLabel} uploaded to Gofile!</b>\n💿 ${escapeHtml(albumData.name)}\n🎵 ${allDownloadedFiles.length} tracks · ${totalMb} MB\n${skippedTracks.length ? `⚠️ ${skippedTracks.length} unavailable skipped\n` : ''}\n🔗 ${downloadPage}`
                : `☁️ <b>整张${typeLabel}已上传至 Gofile！</b>\n💿 ${escapeHtml(albumData.name)}\n🎵 ${allDownloadedFiles.length} 首 · ${totalMb} MB\n${skippedTracks.length ? `⚠️ 已跳过 ${skippedTracks.length} 首无版权曲目\n` : ''}\n🔗 ${downloadPage}`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: isEn ? '☁️ Open Gofile Folder' : '☁️ 打开 Gofile 文件夹', url: downloadPage }
                ]]
              }
            });
          }

          return {
            ok: true,
            allGroupMsgIds: [],
            albumName: albumData.name,
            artistName: albumData.artistName,
            downloadedCount: allDownloadedFiles.length,
            skippedTracks,
            totalDurationSec: goTotalDurationSec,
            gofileUrl: downloadPage,
            gofileFolderId: parentFolder,
            gofileGuestToken: guestToken,
            totalSizeMb: Number(totalMb),
            isGofile: true,
            sendResult: null
          };
        }

        if (deliveryMode === 'zip') {
          // 3.A 全辑单个 ZIP 模式：并发下载所有单曲，然后打包并零拷贝极速直传
          let completedCount = 0;
          await pMap(albumData.tracks, TG_TRACK_CONCURRENCY, async (track, i) => {
            const trackOrder = i + 1;
            // 单曲异常绝不能逃逸出 worker：pMap 是 Promise.all，任一 worker 抛错会中断整批
            try {
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
              saveLrc: saveLyricsFormats.length > 0,
              embedLyrics: embedLyricsMode !== 'off',
              lyricsFormat: embedLyricsMode === 'ttml' ? 'ttml' : 'lrc',
              saveLyricsFormats,
              translateLyrics: needTranslate || false,
              ruby: needRuby || false,
              rubyMode: rubyMode || 'roman',
              lang: userLang,
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
                  throw new Error(data.error || (isEn ? 'Transfer service error' : '解析异常'));
                }
                allDownloadedFiles.push({ ...data.data, track, orderIndex: trackOrder });
                completedCount++;
                try {
                  await tgCall('editMessageText', {
                    chat_id: chatId,
                    message_id: messageId,
                    text: isEn
                      ? `${progressPrefix}⏳ <b>Downloading & tagging ${typeLabel.toLowerCase()} [${completedCount}/${totalTracks}]</b>\n🎵 ${escapeHtml(track.name)}${skippedTracks.length ? `\n(${skippedTracks.length} unavailable skipped)` : ''}`
                      : `${progressPrefix}⏳ <b>正在高速打包全辑 [${completedCount}/${totalTracks}]</b>\n🎵 ${escapeHtml(track.name)}${skippedTracks.length ? `\n(已跳过 ${skippedTracks.length} 首不可用歌曲)` : ''}`,
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
            } catch (outerErr) {
              console.warn(`[TG-Bot] 专辑曲目 [${trackOrder}/${totalTracks}] ${track?.name} 彻底失败:`, outerErr.message);
              skippedTracks.push({ track, error: outerErr.message });
            }
          });

          if (allDownloadedFiles.length === 0) {
            throw new Error(isEn
              ? `All tracks in this ${typeLabel.toLowerCase()} are unavailable in the resolving region or failed to download.`
              : `整张专辑的所有曲目均在当前地区无版权或下载失败，无法转存。`);
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
              lang: userLang,
              noUpload: true,
              splitMaxMB: 1900
            }),
            // 大专辑（如 100+ 曲）多卷打包可能耗时数分钟，放宽至 600s 防止中途超时导致 sessionDir 被误删
            signal: AbortSignal.timeout(600000)
          });
          const finData = await finRes.json();
          if (finData.status !== 'ok' || !finData.data) {
            throw new Error(isEn ? `Failed to package ${typeLabel} ZIP: ${finData.error || 'Unknown error'}` : `封装全辑 ZIP 失败: ${finData.error || '未知错误'}`);
          }

          const zipParts = Array.isArray(finData.data.zipParts) && finData.data.zipParts.length ? finData.data.zipParts : null;
          const zipPartList = zipParts || [{
            filePath: finData.data.zipFilePath,
            fileName: finData.data.zipFileName || `${albumData.artistName} - ${albumData.name}.zip`,
            fileSize: finData.data.fileSize || 0,
            totalFiles: finData.data.totalFiles || allDownloadedFiles.length
          }];
          const totalZipMb = Number((zipPartList.reduce((s, p) => s + (p.fileSize || 0), 0) / (1024 * 1024)).toFixed(1));

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: isEn
              ? `${progressPrefix}🚀 <b>${typeLabel} ZIP ready (${totalZipMb} MB, ${zipPartList.length} ${zipPartList.length > 1 ? 'parts' : 'part'}), archiving via official Local Bot API...</b>`
              : `${progressPrefix}🚀 <b>全辑 ZIP 封装就绪 (${totalZipMb} MB，${zipPartList.length} 卷${zipPartList.length > 1 ? '分卷' : ''})，正在通过官方 Local Bot API 专线归档并推送...</b>`,
            parse_mode: 'HTML'
          });

          const baseCaption = safeCaption(
`📦 <b>${escapeHtml(albumData.name)} [${typeLabel}ZIP]</b>
👤 ${isEn ? 'Artist: ' : '艺人：'}${escapeHtml(albumData.artistName)}
🎵 ${isEn ? `Tracks: ${allDownloadedFiles.length}${skippedTracks.length ? ` (${skippedTracks.length} unavailable skipped)` : ''}` : `曲目数：共 ${allDownloadedFiles.length} 首${skippedTracks.length ? ` (已跳过 ${skippedTracks.length} 首无版权歌曲)` : ''}`}
🎧 ${isEn ? 'Format: ' : '规格：'}${escapeHtml(quality)}

${artistTag} ${albumTag} #${typeLabel}ZIP`);

          const allZipMsgIds = [];
          let lastSendResult = null;
          let uploadDurationTotalSec = 0; // 累计所有分卷的纯上传耗时（不含卷间冷却），避免完成消息只显示最后一卷
          for (let zi = 0; zi < zipPartList.length; zi++) {
            const part = zipPartList[zi];
            const partPath = part.filePath;
            const partName = part.fileName;
            const partTrackCount = part.trackFiles || part.totalFiles || allDownloadedFiles.length;
            const partCaption = zipPartList.length > 1
              ? safeCaption(
`📦 <b>${escapeHtml(albumData.name)} [${typeLabel}ZIP ${zi + 1}/${zipPartList.length}]</b>
👤 ${isEn ? 'Artist: ' : '艺人：'}${escapeHtml(albumData.artistName)}
🎵 ${isEn ? `Tracks: ${partTrackCount} in part / ${allDownloadedFiles.length} total${skippedTracks.length ? ` (${skippedTracks.length} unavailable skipped)` : ''}` : `曲目数：本卷 ${partTrackCount} 首 / 共 ${allDownloadedFiles.length} 首${skippedTracks.length ? ` (已跳过 ${skippedTracks.length} 首无版权歌曲)` : ''}`}
🎧 ${isEn ? 'Format: ' : '规格：'}${escapeHtml(quality)}

${artistTag} ${albumTag} #${typeLabel}ZIP`)
              : baseCaption;

            const sendResult = await unifiedSendMedia({
              chatId,
              filePath: partPath,
              fileName: partName,
              caption: partCaption,
              isZip: true,
              isAudio: false,
              privateCopy: false
            });

            if (!sendResult.groupMsgId) {
              throw new Error(isEn ? 'Failed to archive ZIP to channel' : '全辑 ZIP 归档上传失败，未能获取群消息 ID');
            }
            allZipMsgIds.push(sendResult.groupMsgId);
            lastSendResult = sendResult;
            uploadDurationTotalSec += Number(sendResult.durationSec || 0);

            if (zi + 1 < zipPartList.length) {
              console.log(`[TG-Bot] 分卷 ${zi + 1}/${zipPartList.length} 已归档频道，冷却 3s 后继续下一卷...`);
              await new Promise(r => setTimeout(r, 3000));
            }
          }

          // 单卷兼容保留 groupMsgId；多卷存数组以支持批量 copyMessages 与秒传
          db.set(cacheKey, {
            albumId,
            albumName: albumData.name,
            artistName: albumData.artistName,
            quality,
            groupMsgId: allZipMsgIds.length === 1 ? allZipMsgIds[0] : undefined,
            groupMsgIds: allZipMsgIds.length > 1 ? allZipMsgIds : undefined,
            zipFileId: lastSendResult.fileId || null,
            totalTracks: allDownloadedFiles.length,
            createdAt: Date.now()
          });

          // 额度已在开跑前整单预留（handleAlbumDownload 等入口），这里只按实际下载数对账；
          // 若走的是未预留的旧路径，则按实际下载曲目数补扣。
          if (hasPendingReservation(chatId)) settleQuotaReservation(chatId, allDownloadedFiles.length);
          else quotaManager.incrementQuota(chatId, allDownloadedFiles.length);

          const totalDurationSec = ((performance.now() - albumStartTime) / 1000).toFixed(1);

          return {
            ok: true,
            allGroupMsgIds: allZipMsgIds,
            zipGroupMsgId: allZipMsgIds[0] || null,
            zipFileId: lastSendResult.fileId || null,
            albumName: albumData.name,
            artistName: albumData.artistName,
            downloadedCount: allDownloadedFiles.length,
            skippedTracks,
            totalDurationSec,
            zipSizeMb: totalZipMb,
            zipPartCount: zipPartList.length,
            uploadDurationSec: uploadDurationTotalSec, // 全卷累计上传耗时（秒）
            sendResult: lastSendResult
          };
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
          await pMap(group.tracks, TG_TRACK_CONCURRENCY, async (track, relIdx) => {
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
              saveLrc: saveLyricsFormats.length > 0,
              embedLyrics: embedLyricsMode !== 'off',
              lyricsFormat: embedLyricsMode === 'ttml' ? 'ttml' : 'lrc',
              saveLyricsFormats,
              translateLyrics: needTranslate || false,
              ruby: needRuby || false,
              rubyMode: rubyMode || 'roman',
              lang: userLang,
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
                  throw new Error(data.error || (isEn ? 'Transfer service error' : '解析异常'));
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
              : `${progressPrefix}⏳ <b>正在高速转存全辑 [第 ${chunkIdx + 1}/${chunkTrackGroups.length} 组卡片] (${group.startNum}-${group.endNum}/${totalTracks})</b>\n💿 ${escapeHtml(albumData.name)} [${quality}]`,
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
          throw new Error(isEn
            ? `All tracks in this ${typeLabel.toLowerCase()} are unavailable in the resolving region or failed to download.`
            : `整张专辑的所有曲目均在当前地区无版权或下载失败，无法转存。`);
        }

        // 频道归档全部完成（私聊推送由调用方统一执行，保证批量场景最后一起发送）
        if (allGroupMsgIds.length === 0) {
          throw new Error(isEn
            ? `All tracks in this ${typeLabel.toLowerCase()} are unavailable in the resolving region or failed to download.`
            : `整张专辑的所有曲目均在当前地区无版权或下载失败，无法转存。`);
        }

        db.set(cacheKey, {
          albumId,
          albumName: albumData.name,
          artistName: albumData.artistName,
          quality,
          groupMsgIds: allGroupMsgIds,
          totalTracks: allDownloadedFiles.length,
          createdAt: Date.now()
        });

        // 额度已在开跑前整单预留，这里按实际下载数对账（未预留则按实际下载数补扣）
        if (hasPendingReservation(chatId)) settleQuotaReservation(chatId, allDownloadedFiles.length);
        else quotaManager.incrementQuota(chatId, allDownloadedFiles.length);

        const totalDurationSec = ((performance.now() - albumStartTime) / 1000).toFixed(1);
        return {
          ok: true,
          allGroupMsgIds,
          zipFileId: null,
          albumName: albumData.name,
          artistName: albumData.artistName,
          downloadedCount: allDownloadedFiles.length,
          skippedTracks,
          totalDurationSec,
          sendResult: null
        };
      } catch (err) {
        console.error('[TG-Bot] 全辑下载处理异常:', err);
        throw err;
      } finally {
        try {
          const sessionDir = `/tmp/am_sessions/${batchId}`;
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
        try {
          fs.rmSync(`/tmp/${batchId}.zip`, { force: true });
        } catch {}
        try {
          const tmpEntries = fs.readdirSync('/tmp');
          for (const entry of tmpEntries) {
            if (entry.startsWith(`${batchId}.part`)) {
              fs.rmSync(path.join('/tmp', entry), { force: true });
            }
          }
        } catch {}
        for (const f of allDownloadedFiles) {
          try {
            if (f.audioFilePath) fs.rmSync(path.dirname(f.audioFilePath), { recursive: true, force: true });
          } catch {}
        }
      }
}

// 记录用户在每个专辑/歌单曲目列表当前所处的页码: key=`${chatId}:${albumId}` -> pageIndex
const albumTrackPageMap = new Map();

// 展开单曲列表 (支持分页 + 多选勾选模式：⬜/✅ 勾选、点歌名进单曲卡、一键下载所选、支持返回上级)
async function showAlbumTracks(chatId, albumData, lang = 'zh', messageId = null, page = null) {
  const isEn = lang === 'en';
  const tracks = albumData.tracks || [];
  const selection = getSelection(chatId, 'trk', albumData.albumId);
  const pageKey = `${chatId}:${albumData.albumId}`;
  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  let curPage = page !== null && page !== undefined ? Number(page) : (albumTrackPageMap.get(pageKey) || 0);
  if (Number.isNaN(curPage) || curPage < 0) curPage = 0;
  if (curPage >= totalPages) curPage = totalPages - 1;
  albumTrackPageMap.set(pageKey, curPage);

  const inlineKeyboard = [];

  // 顶部：全选 / 全不选
  inlineKeyboard.push([
    {
      text: isEn ? `✅ Select All (${tracks.length})` : `✅ 勾选全部 (${tracks.length}首)`,
      callback_data: `tsel_all:${albumData.albumId}`
    },
    {
      text: isEn ? '⬜ Unselect All' : '⬜ 取消全部',
      callback_data: `tsel_none:${albumData.albumId}`
    }
  ]);

  // 曲目行: [勾选] + [序号. 歌名 -> 单曲卡]（每页 20 首，完全避开 Telegram 100 按钮上限）
  const startIdx = curPage * PAGE_SIZE;
  const visibleTracks = tracks.slice(startIdx, startIdx + PAGE_SIZE);
  for (let i = 0; i < visibleTracks.length; i++) {
    const t = visibleTracks[i];
    const num = t.trackNumber || (startIdx + i + 1);
    const checked = selection.has(String(t.id));
    const title = `${num}. ${t.name || 'Track'}`;
    inlineKeyboard.push([
      { text: checked ? '✅' : '⬜', callback_data: `tsel:${albumData.albumId}:${t.id}` },
      { text: title.length > 26 ? title.slice(0, 24) + '..' : title, callback_data: `pick:${t.id}:${albumData.albumId}` }
    ]);
  }

  // 分页导航栏（当总页数 > 1 时展示）
  if (totalPages > 1) {
    const navRow = [];
    if (curPage > 0) {
      navRow.push({
        text: isEn ? '⬅️ Prev' : '⬅️ 上一页',
        callback_data: `tsel_page:${albumData.albumId}:${curPage - 1}`
      });
    }
    navRow.push({
      text: `📄 ${curPage + 1} / ${totalPages}`,
      callback_data: `tsel_noop:${albumData.albumId}`
    });
    if (curPage + 1 < totalPages) {
      navRow.push({
        text: isEn ? '➡️ Next' : '➡️ 下一页',
        callback_data: `tsel_page:${albumData.albumId}:${curPage + 1}`
      });
    }
    inlineKeyboard.push(navRow);
  }

  // 底部：下载所选 + 返回专辑主菜单
  inlineKeyboard.push([
    {
      text: selection.size > 0
        ? (isEn ? `🚀 Download Selected (${selection.size})` : `🚀 下载所选单曲 (${selection.size} 首)`)
        : (isEn ? '🚀 Download Selected' : '🚀 下载所选单曲'),
      callback_data: `tsel_dl:${albumData.albumId}`
    }
  ]);
  inlineKeyboard.push([
    {
      text: isEn ? '🔙 Back to Menu' : '🔙 返回主菜单',
      callback_data: `aback:${albumData.albumId}`
    }
  ]);

  const text = isEn
    ? `📜 <b>Tracklist: ${escapeHtml(albumData.name)} (Page ${curPage + 1}/${totalPages})</b>\nTotal <code>${tracks.length}</code> tracks, selected: <code>${selection.size}</code>. Tick tracks across pages then tap [Download Selected], or tap a track title to open it:`
    : `📜 <b>曲目列表：${escapeHtml(albumData.name)} (第 ${curPage + 1}/${totalPages} 页)</b>\n共 <code>${tracks.length}</code> 首，已勾选 <code>${selection.size}</code> 首。支持跨页勾选后点击【下载所选单曲】批量下载；点击歌名可单独进入点歌：`;

  if (messageId) {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  } else {
    await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
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
        const grpLang = getUserLang(msg.from?.id || chatId, msg.from?.language_code);
        const gt = I18N[grpLang] || I18N.zh;
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: gt.groupTip,
          parse_mode: 'HTML'
        });
      }
      return;
    }

    if (chatType !== 'private') {
      return;
    }

    /* ---------- 音乐标签语言：等待用户直接输入 BCP-47 ---------- */
    const tagLangWait = userSessions.get(`${chatId}_taglang_wait`);
    if (tagLangWait && tagLangWait.awaitingTagLang) {
      // 用户中途发 /lang 之类命令则视为取消
      if (text.startsWith('/')) {
        userSessions.delete(`${chatId}_taglang_wait`);
      } else {
        const rawTag = text.trim();
        const userLangW = getUserLang(chatId, msg.from?.language_code);
        const isEnW = userLangW === 'en';
        // 规范的 BCP-47（允许用户大小写随意，例如 ar-eg / JA-jp）
        const normalized = rawTag.split('-').map((seg, i) => (i === 0 ? seg.toLowerCase() : (seg.length === 2 ? seg.toUpperCase() : seg))).join('-');
        if (!isValidBcp47(normalized)) {
          await tgCall('sendMessage', {
            chat_id: chatId,
            text: isEnW
              ? `❌ <b>Invalid BCP-47 language code:</b> <code>${escapeHtml(rawTag)}</code>\n\nExpected something like <code>ar-EG</code>, <code>ja-JP</code>, <code>zh-Hant-HK</code>.\nTry again, or send /lang to cancel.`
              : `❌ <b>语言代码格式不正确：</b><code>${escapeHtml(rawTag)}</code>\n\n应形如 <code>ar-EG</code>、<code>ja-JP</code>、<code>zh-Hant-HK</code>。\n请重新输入，或发送 /lang 取消。`,
            parse_mode: 'HTML'
          });
          return;
        }
        db.set(`taglang_${chatId}`, normalized);
        userSessions.delete(`${chatId}_taglang_wait`);
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: isEnW
            ? `✅ <b>Audio tag language set to</b> <code>${escapeHtml(normalized)}</code>\n\nFrom now on, downloaded <code>.m4a</code> tags and filenames will use Apple Music's official <b>${escapeHtml(normalized)}</b> names.\n\n<i>Note: Apple Music only has localized names for some combinations; for rare codes it may fall back to the catalog's default language.</i>\nSend /lang to change or reset.`
            : `✅ <b>音乐标签语言已设置为</b> <code>${escapeHtml(normalized)}</code>\n\n今后下载的 <code>.m4a</code> 标签与文件名将使用 Apple Music 官方的 <b>${escapeHtml(normalized)}</b> 名称。\n\n<i>说明：Apple Music 并非所有语言组合都有本地化名称，生僻代码可能回退到曲库默认语言。</i>\n发送 /lang 可修改或恢复。`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: isEnW ? '🏷 Tag language settings' : '🏷 标签语言设置', callback_data: 'taglang:menu' }
            ]]
          }
        });
        return;
      }
    }

    /* ---------- 语言命令 ---------- */
    if (text === '/lang' || text === '/language') {
      const userLang = getUserLang(chatId, msg.from?.language_code);
      const t = I18N[userLang] || I18N.zh;
      const isEnL = userLang === 'en';
      const curTag = getUserTagLang(chatId);
      const resolvedTag = resolveTagLang(chatId, userLang);
      const tagLine = isEnL
        ? `\n\n🏷 <b>Audio tags:</b> <code>${escapeHtml(curTag === 'auto' ? `Auto → ${resolvedTag}` : curTag)}</code>`
        : `\n\n🏷 <b>音乐标签语言：</b><code>${escapeHtml(curTag === 'auto' ? `自动 → ${resolvedTag}` : curTag)}</code>`;
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: (t.chooseLang || '🌐 <b>请选择您的显示语言 / Please choose your display language:</b>') + tagLine,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🇨🇳 简体中文', callback_data: 'set_lang:zh' },
              { text: '🇬🇧 English', callback_data: 'set_lang:en' }
            ],
            [
              { text: isEnL ? '🏷 Audio Tag Language (BCP-47)' : '🏷 音乐标签语言 (BCP-47)', callback_data: 'taglang:menu' }
            ]
          ]
        }
      });
      return;
    }

    // 独立命令：/tags /taglang /metadata —— 直接展示标签语言设置面板
    if (text === '/tags' || text === '/taglang' || text === '/metadata') {
      const userLang = getUserLang(chatId, msg.from?.language_code);
      const isEnT0 = userLang === 'en';
      await sendTagLangPanel(chatId, userLang);
      return;
    }

    if (text === '/start' || text === '/help') {
      const savedLang = db.get(`lang_${chatId}`);
      const userLang = getUserLang(chatId, msg.from?.language_code);
      const t = I18N[userLang] || I18N.zh;
      const isEnHelp = userLang === 'en';

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

      // /help 额外附上指令速查（很多人不知道 /changelog、/stats、/lang 的存在）
      const commandCheatSheet = isEnHelp
        ? `\n\n⌨️ <b>Available Commands:</b>
• <code>/changelog</code> — What's New & full release history
• <code>/stats</code> — Your daily quota & server bandwidth
• <code>/lang</code> — Switch between English / 中文`
        : `\n\n⌨️ <b>可用指令：</b>
• <code>/changelog</code> — 最新更新说明与历史版本记录
• <code>/stats</code> — 查询今日剩余配额与服务器带宽
• <code>/lang</code> — 切换中文 / English`;

      const clVer = loadChangelog().latestVersion || '2.6';
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: t.welcome + commandCheatSheet,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: userLang === 'zh' ? `✨ 最新更新 (v${clVer})` : `✨ What's New (v${clVer})`,
                callback_data: `show_changelog:${userLang}`
              },
              {
                text: userLang === 'zh' ? '🌐 切换为 English' : '🌐 Switch to 中文',
                callback_data: userLang === 'zh' ? 'set_lang:en' : 'set_lang:zh'
              }
            ],
            [
              {
                text: userLang === 'zh' ? '📜 历史更新记录' : '📜 Release History',
                callback_data: `show_changelog:${userLang}:history`
              }
            ]
          ]
        }
      });
      return;
    }

    if (text === '/changelog' || text === '/whatsnew' || text === '/updates') {
      const userLang = getUserLang(chatId, msg.from?.language_code);
      const cl = loadChangelog();
      if (cl.latestVersion) db.set(`seen_ver_${chatId}`, String(cl.latestVersion));
      const card = buildChangelogCard(userLang);
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      return;
    }

    if (text === '/stats' || text === '/traffic' || text === '/quota') {
      const stats = getTrafficStats();
      const isOwner = String(chatId) === String(OWNER_USER_ID);
      const userQuota = quotaManager.checkQuota(chatId);
      const isEnStats = getUserLang(chatId, msg.from?.language_code) === 'en';

      if (isEnStats) {
        const roleText = isOwner ? '👑 <b>Admin (100% Unlimited)</b>' : '👤 <b>Standard Member</b>';
        const quotaText = isOwner
          ? '• Download Quota: <code>Unlimited (100% Exempt)</code>\n• Artist Discography: <code>✅ Available</code>\n• Cooldown: <code>0s</code>'
          : `• Today's Usage: <code>${userQuota.current} / ${userQuota.max} tracks</code> (<code>${userQuota.remaining}</code> left)\n• Scope: <code>Shared across Single Tracks / Albums / Playlists</code>\n• Artist Discography: <code>✅ Available</code>\n• Cooldown: <code>5s between requests</code>`;

        const msgText =
`📊 <b>VPS Bandwidth & Quota Monitor</b>

📡 <b>Oracle Cloud (OCI) Monthly Bandwidth:</b>
• Progress: [<code>${stats.progressBar}</code>] <code>${stats.usagePercent}%</code>
• Outbound (TX): <code>${stats.txGB} GB</code> / <code>${stats.maxQuotaGB} GB (10TB)</code>
• Remaining Quota: <code>${stats.remainingGB} GB</code>
• Inbound (RX): <code>${stats.rxGB} GB</code> (✨ Free & unlimited on OCI)

👤 <b>Your Account & Daily Quota:</b>
• Role: ${roleText}
${quotaText}

💡 <b>Bandwidth Notes:</b>
1. <b>Inbound (Apple Music -> VPS)</b>: 100% free and does not count toward the 10TB outbound cap.
2. <b>Instant Delivery</b>: Cached tracks/albums are forwarded directly inside Telegram with <b>0 bytes of VPS upload</b> and <b>0 quota cost</b>.`;

        await tgCall('sendMessage', {
          chat_id: chatId,
          text: msgText,
          parse_mode: 'HTML'
        });
        return;
      }

      const roleText = isOwner ? '👑 <b>站长/管理员 (拥有 100% 全面豁免权)</b>' : '👤 <b>讨论组成员</b>';
      const quotaText = isOwner
        ? '• 下载权限：<code>无限制 (100% 全面豁免)</code>\n• 歌手全辑：<code>✅ 可用</code>\n• 冷却限制：<code>无限制 (0秒间隔)</code>'
        : `• 今日已用：<code>${userQuota.current} / ${userQuota.max} 首</code> (剩余 <code>${userQuota.remaining}</code> 首)\n• 计算口径：<code>单曲 / 专辑 / 歌单 / 歌手全辑 共用同一份额度</code>\n• 歌手全辑：<code>✅ 可用</code>\n• 冷却间隔：<code>5 秒/次</code>`;

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
    const adminCmdMatch = text.match(/^\/(admin|cmd|status|sys|clean|cleansessions|cleansession|check|restart|history|logs)(?:\s+(.*))?$/i);
    if (adminCmdMatch) {
      if (!isOwner) {
        const isEnCmd = getUserLang(chatId, msg.from?.language_code) === 'en';
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: isEnCmd
            ? `⚠️ <b>Access Denied:</b> This command is reserved for the bot administrator (Your ID: <code>${chatId}</code>).`
            : `⚠️ <b>无权访问：</b> 此指令为站长专属运维命令 (您的 ID: <code>${chatId}</code> 未授权)。`,
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
• <code>/clean</code>：一键清理 VPS 临时垃圾文件 (扫描 <code>/tmp</code> 遗留音频与 &gt;10m 会话目录；支持 <code>/clean force</code> 强清)。
• <code>/cleansessions</code>：强力清空 <code>/tmp/am_sessions/*</code> (无视时间限制，即时抹除所有中断残留批次)。
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
          text: '📊 <b>正在汇总最近 24 小时任务...</b>',
          parse_mode: 'HTML'
        });

        try {
          // 只认「结果型」日志：入队 / 完成 / 打包 / 归档 / 跳过 / 失败。
          // 每首歌都会打一遍的"标签注入""剥除 btrt""解碎片"属于过程噪声，一律不收。
          // 时间同时支持两种 journalctl 格式：传统 "Nov 05 14:29:02 host ..." 与 ISO "2026-11-05T14:29:02+0800 host ..."
          const rawLogs = execSync(
            'journalctl -u am-cloud.service -u am-tgbot.service --since "24 hours ago" --no-pager',
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
          );

          const RE_LINE = /^(\S+\s+\d+\s+)(\d{2}):(\d{2}):(\d{2})\s+\S+\s+\S+?:\s?(.*)$/;
          const RE_LINE_ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\S*\s+\S+\s+\S+?:\s?(.*)$/;

          const A = {
            enqueued: 0,
            completed: 0,
            zipBatches: 0,
            zipBytes: 0,
            zipFiles: 0,
            archived: 0,
            regionSkip: 0,
            lyricTimeout: 0,
            durations: [],
            qualities: new Map(),
            errors: [],
            hours: new Map(),
            recent: [],
            users: new Map(),
            restarts: 0,
            autosleep: 0,
          };

          // 打包链路的上下文（跨行累积）：日志里打包请求 / 封装完成 / 转存完成是分开的三行
          const packCtx = { sid: '', appleId: '', files: 0, type: '专辑', artist: '', firstTrack: '', sizeMb: null };

          for (const line of rawLogs.split('\n')) {
            const m = line.match(RE_LINE_ISO) || line.match(RE_LINE);
            if (!m) continue;
            const hh = m[2];
            const mm = m[3];
            const msg = m[5];

            // ── 打包链路的上下文：最近的曲目名 / 艺人 / 会话ID / 体积 ──
            // 日志顺序：…✔ 批处理就绪: 艺人 - 歌名.m4a … → 打包请求(会话ID) → 封装完成(体积) → 转存完成(链接)
            const tDone = msg.match(/✔ 批处理就绪:\s*(.+?)\.m4a/);
            if (tDone) {
              packCtx.lastTrack = tDone[1].trim();
              const dash = packCtx.lastTrack.indexOf(' - ');
              if (dash > 0) packCtx.artist = packCtx.lastTrack.slice(0, dash).trim();
            }
            const packReq = msg.match(/打包请求.*?会话\s+(album_\d+_(\d+)|playlist_\d+_(\d+))\s*\((\d+)\s*个文件\)/);
            if (packReq) {
              packCtx.sid = packReq[1];
              packCtx.appleId = packReq[2] || packReq[3] || '';
              packCtx.files = Number(packReq[4]);
              packCtx.type = packReq[1].startsWith('playlist_') ? '歌单' : '专辑';
              packCtx.firstTrack = packCtx.lastTrack || '';
            }
            const packSize = msg.match(/全辑 ZIP 封装完成\s*\(([\d.]+)\s*(GB|MB),\s*共\s*(\d+)\s*个文件/);
            let lastSizeMb = null;
            if (packSize) {
              lastSizeMb = packSize[2] === 'GB' ? parseFloat(packSize[1]) * 1024 : parseFloat(packSize[1]);
            }

            if (msg.includes('[Queue] 任务入队')) {
              A.enqueued++;
              A.hours.set(hh, (A.hours.get(hh) || 0) + 1);
              const q = msg.match(/\(([^()]+)\)\s*\(等待排队中/);
              if (q) {
                const name = q[1].trim();
                A.qualities.set(name, (A.qualities.get(name) || 0) + 1);
              }
            } else if (msg.includes('✔ 批处理就绪')) {
              A.completed++;
              const t = msg.match(/耗时:\s*([\d.]+)\s*s/);
              if (t) A.durations.push(parseFloat(t[1]));
            } else if (msg.includes('全辑 ZIP 封装完成')) {
              A.zipBatches++;
              if (lastSizeMb !== null) {
                A.zipBytes += lastSizeMb;
                const f = msg.match(/共\s*(\d+)\s*个文件/);
                if (f) A.zipFiles += Number(f[1]);
              }
              packCtx.sizeMb = lastSizeMb;
            } else if (msg.includes('全辑 ZIP 并发转存完成') || msg.includes('转存完成!')) {
              const k = msg.match(/总耗时:\s*([\d.]+)\s*s/);
              const link = msg.match(/(https:\/\/gofile\.io\/d\/\S+)/);
              const sample = packCtx.firstTrack || '';
              const dash = sample.indexOf(' - ');
              A.recent.push({
                hh, mm,
                sec: k ? k[1] : '?',
                link: link ? link[1] : '',
                artist: packCtx.artist || '',
                sample: dash > 0 ? sample.slice(dash + 3) : sample,
                files: packCtx.files || 0,
                sizeMb: packCtx.sizeMb || null,
                appleId: packCtx.appleId || '',
                type: packCtx.type || '专辑',
              });
            } else if (msg.includes('已归档频道')) {
              A.archived++;
            } else if (msg.includes('无资源或未上架') || msg.includes('当前歌曲在解析账号所属地区')) {
              A.regionSkip++;
            } else if (msg.includes('歌词抓取失败')) {
              A.lyricTimeout++;
            } else if (msg.includes('自适应等待')) {
              A.autosleep++;
            } else if (msg.includes('正在启动') || msg.includes('已就绪: http')) {
              A.restarts++;
            }

            if (/❌|失败|Error:|error:|Unhandled|崩溃/.test(msg)) {
              const noise = /Failed to fetch|重试|EAGAIN|歌词抓取失败/;
              if (!noise.test(msg)) {
                A.errors.push({ hh, mm, msg: msg.replace(/\s+/g, ' ').slice(0, 110) });
              }
            }

            const u = msg.match(/chat_?id[=: ]+(\d{6,})/i) || msg.match(/用户\s+(\d{9,})/);
            if (u) A.users.set(u[1], (A.users.get(u[1]) || 0) + 1);
          }

          let queueBusy = 0, queueWait = 0;
          try {
            const q = JSON.parse(execSync('curl -s --max-time 3 http://127.0.0.1:31409/queue', { encoding: 'utf8' }));
            const d = q.data || {};
            queueBusy = (d.running || []).length;
            queueWait = d.waiting || 0;
          } catch {}

          let sessions = 0;
          try {
            if (fs.existsSync('/tmp/am_sessions')) {
              for (const e of fs.readdirSync('/tmp/am_sessions')) {
                try {
                  const st = fs.statSync(path.join('/tmp/am_sessions', e));
                  if (st.isDirectory() && (Date.now() - st.mtimeMs) < 15 * 60 * 1000) sessions++;
                } catch {}
              }
            }
          } catch {}

          let disk = '';
          try {
            disk = execSync("df -h / | tail -n 1 | awk '{print $4 \" / \" $2 \" (\" $5 \") \"}'", { encoding: 'utf8' }).trim();
          } catch {}

          let loadLine = '';
          try {
            const cores = os.cpus().length;
            const la = os.loadavg().map((n) => Math.round((n / cores) * 100) + '%').join(' / ');
            const memUsed = ((os.totalmem() - os.freemem()) / 1024 ** 3).toFixed(1);
            const memTotal = (os.totalmem() / 1024 ** 3).toFixed(1);
            loadLine = 'CPU ' + la + ' · 内存 ' + memUsed + '/' + memTotal + 'G';
          } catch {}

          const dur = A.durations.slice().sort((a, b) => a - b);
          const avgDur = dur.length ? (dur.reduce((s, n) => s + n, 0) / dur.length).toFixed(2) : '—';
          const p95 = dur.length ? dur[Math.min(dur.length - 1, Math.floor(dur.length * 0.95))].toFixed(2) : '—';
          const zipGb = (A.zipBytes / 1024).toFixed(1);
          const avgZipMb = A.zipBatches ? (A.zipBytes / A.zipBatches).toFixed(0) : '—';
          const failPct = (A.completed + A.errors.length) > 0
            ? ((A.errors.length / (A.completed + A.errors.length)) * 100).toFixed(1)
            : '0.0';

          const qualEntries = [...A.qualities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
          const hourEntries = [...A.hours.entries()].sort((a, b) => a[0].localeCompare(b[0]));
          const maxHour = Math.max(1, ...hourEntries.map(([, n]) => n));

          const out = [];
          out.push('📊 <b>近 24 小时运行报告</b>');
          out.push('');

          out.push('▎<b>一、总览</b>');
          out.push('  入队 <b>' + A.enqueued + '</b> · 完成 <b>' + A.completed + '</b> 首 · 打包 <b>' + A.zipBatches + '</b> 次 · 归档 <b>' + A.archived + '</b>');
          out.push('  成功率 <b>' + (100 - Number(failPct)).toFixed(1) + '%</b> · 失败 <b>' + A.errors.length + '</b> 条');
          if (A.completed) {
            out.push('  单曲耗时 均值 <code>' + avgDur + 's</code> · P95 <code>' + p95 + 's</code>');
          }
          if (A.zipBatches) {
            out.push('  打包体积 共 <b>' + zipGb + ' GB</b> · 平均 <code>' + avgZipMb + ' MB</code>/包 · 合计 <b>' + A.zipFiles + '</b> 个文件');
          }

          if (qualEntries.length) {
            out.push('');
            out.push('▎<b>二、音质分布</b>');
            for (const [q, n] of qualEntries) {
              const pct = A.enqueued ? ((n / A.enqueued) * 100).toFixed(0) : '0';
              out.push('  ' + escapeHtml(q) + ' — <b>' + n + '</b> (' + pct + '%)');
            }
          }

          if (hourEntries.length) {
            out.push('');
            out.push('▎<b>三、时段分布</b>');
            for (const [h, n] of hourEntries.slice(-10)) {
              const bars = '█'.repeat(Math.max(1, Math.round((n / maxHour) * 12)));
              out.push('  <code>' + h + ':00</code> ' + bars + ' <b>' + n + '</b>');
            }
          }

          out.push('');
          out.push('▎<b>四、异常情况</b>');
          if (A.errors.length === 0) {
            out.push('  ✅ 无失败');
          } else {
            for (const e of A.errors.slice(-6)) {
              out.push('  · <code>' + e.hh + ':' + e.mm + '</code> ' + escapeHtml(e.msg));
            }
            if (A.errors.length > 6) out.push('  <i>… 更早 ' + (A.errors.length - 6) + ' 条省略</i>');
          }
          if (A.regionSkip > 0) out.push('  ◇ 版权跳过 <b>' + A.regionSkip + '</b> 首（所在区无资源，已自动略过）');
          if (A.lyricTimeout > 0) out.push('  ◇ 歌词超时 <b>' + A.lyricTimeout + '</b> 次（不影响音频）');
          if (A.autosleep > 0) out.push('  ◇ 频道限流自适应 <b>' + A.autosleep + '</b> 次');

          if (A.recent.length) {
            out.push('');
            out.push('▎<b>五、最近完成的下载</b>');
            for (const r of A.recent.slice(-6).reverse()) {
              const who = r.artist ? escapeHtml(r.artist) : '未知艺人';
              const meta = [];
              if (r.files) meta.push(r.files + ' 首');
              if (r.sizeMb) meta.push((r.sizeMb / 1024 >= 1 ? (r.sizeMb / 1024).toFixed(1) + ' GB' : Math.round(r.sizeMb) + ' MB'));
              meta.push(r.sec + 's');
              out.push('  · <code>' + r.hh + ':' + r.mm + '</code> <b>' + who + '</b> · ' + escapeHtml(r.type || '专辑'));
              if (r.sample) out.push('     └ 含《' + escapeHtml(r.sample) + '》等 ' + (r.files || '?') + ' 首 · ' + meta.slice(1).join(' · '));
              else if (meta.length) out.push('     └ ' + meta.join(' · '));
              if (r.link) out.push('     └ <a href="' + escapeHtml(r.link) + '">' + escapeHtml(r.link.replace('https://', '')) + '</a>');
            }
          }

          if (A.users.size) {
            out.push('');
            out.push('▎<b>六、活跃用户</b>（' + A.users.size + ' 人）');
            for (const [id, n] of [...A.users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
              let name = '';
              try { name = db.get('name_' + id) || ''; } catch {}
              out.push('  · ' + (name ? escapeHtml(name) + ' ' : '') + '<code>' + id + '</code> — ' + n + ' 次');
            }
          }

          out.push('');
          out.push('▎<b>七、此刻状态</b>');
          out.push('  队列 ' + (queueBusy ? '跑 <b>' + queueBusy + '</b>' : '空闲') + (queueWait ? ' · 排队 <b>' + queueWait + '</b>' : '') + ' · 活跃会话 <b>' + sessions + '</b>');
          if (disk) out.push('  磁盘 <code>' + escapeHtml(disk) + '</code>');
          if (loadLine) out.push('  ' + escapeHtml(loadLine));
          if (A.restarts > 3) out.push('  ⚠️ 24h 内服务重启 <b>' + A.restarts + '</b> 次');

          if (A.enqueued === 0 && A.errors.length === 0) {
            out.push('');
            out.push('🍃 <i>近 24 小时没有下载任务，系统完全空闲。</i>');
          }

          let text = out.join('\n');
          if (text.length > 3900) text = text.slice(0, 3850) + '\n…<i>内容过长已截断</i>';

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        } catch (err) {
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: '❌ 汇总失败: ' + escapeHtml(err.message),
            parse_mode: 'HTML'
          });
        }
        return;
      }

      // 2. 查看 VPS 状态与服务健康度
      if (cmd === 'status' || cmd === 'sys') {
        let loadStr = '未知';
        try {
          // loadavg 是 1/5/15 分钟平均"排队进程数"，除以 vCPU 数换算成直观的百分比占用
          const cores = os.cpus().length;
          loadStr = os.loadavg().map(n => `${Math.min(100, Math.round((n / cores) * 100))}%`).join(' / ');
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
• CPU 占用：<code>${loadStr}</code> (1/5/15 分钟均值 · ${os.cpus().length} vCPU)
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

      // 3. 强力清空批量会话目录 (对应 rm -rf /tmp/am_sessions/*)
      if (cmd === 'cleansessions' || cmd === 'cleansession') {
        const waitMsg = await tgCall('sendMessage', {
          chat_id: chatId,
          text: '🧹 <b>正在强力清空 /tmp/am_sessions 批量转存会话缓存...</b>',
          parse_mode: 'HTML'
        });
        try {
          const beforeDisk = execSync("df -h / | tail -n 1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
          const sessionsRoot = '/tmp/am_sessions';
          let cleanedCount = 0;
          const cleanedNames = [];
          if (fs.existsSync(sessionsRoot)) {
            const entries = fs.readdirSync(sessionsRoot);
            for (const entry of entries) {
              const p = path.join(sessionsRoot, entry);
              try {
                fs.rmSync(p, { recursive: true, force: true });
                cleanedCount++;
                cleanedNames.push(entry);
              } catch (err) {
                console.error(`[TG-Bot] 删除会话目录失败: ${p}`, err);
              }
            }
          }
          const afterDisk = execSync("df -h / | tail -n 1 | awk '{print $4}'", { encoding: 'utf8' }).trim();

          if (cleanedCount === 0) {
            await tgCall('editMessageText', {
              chat_id: chatId,
              message_id: waitMsg.message_id,
              text: `🍃 <b>/tmp/am_sessions 目录目前为空</b>\n暂无残留的专辑/歌单批量转存会话，无需清理。\n• 当前可用磁盘：<code>${afterDisk}</code>`,
              parse_mode: 'HTML'
            });
            return;
          }

          let listStr = '';
          const displayList = cleanedNames.slice(0, 6).map(n => `• <code>${escapeHtml(n)}</code>`).join('\n');
          const moreStr = cleanedNames.length > 6 ? `\n<i>... 另有 ${cleanedNames.length - 6} 个目录已清除</i>` : '';
          listStr = `\n\n🗑️ <b>已清除会话项：</b>\n${displayList}${moreStr}`;

          const runningNote = botTaskQueue.runningCount > 0 
            ? `\n\n⚠️ <i>注意：当前队列中有 ${botTaskQueue.runningCount} 个任务执行中，进行中的转存可能受影响。</i>` 
            : '';

          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `✨ <b>/tmp/am_sessions 会话缓存已强力清空！</b>\n• 清理会话目录：<code>${cleanedCount} 个</code>\n• 清理前可用：<code>${beforeDisk}</code>\n• 清理后可用：<code>${afterDisk}</code>${listStr}${runningNote}`,
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

      // 3.5 一键磁盘清理 (支持 /clean force 强制包含所有会话)
      if (cmd === 'clean') {
        const isForce = arg === 'force' || arg === 'all' || arg === 'sessions';
        const waitMsg = await tgCall('sendMessage', {
          chat_id: chatId,
          text: isForce 
            ? '🧹 <b>正在强制扫描并深度清理 VPS 临时缓存与所有会话目录...</b>' 
            : '🧹 <b>正在扫描并清理 VPS 临时缓存与孤立文件...</b>',
          parse_mode: 'HTML'
        });
        try {
          const beforeDisk = execSync("df -h / | tail -n 1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
          let cleanedCount = 0;
          const tmpDir = '/tmp';
          if (fs.existsSync(tmpDir)) {
            const entries = fs.readdirSync(tmpDir);
            for (const entry of entries) {
              if (
                entry.startsWith('am_tg_') ||
                entry.startsWith('album_') ||
                entry.startsWith('playlist_') ||
                entry.startsWith('am_defrag_') ||
                entry.startsWith('am_wp_') ||
                entry.startsWith('am_single_')
              ) {
                try {
                  fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
                  cleanedCount++;
                } catch {}
              }
            }
            // 扫描 /tmp/am_sessions 子目录
            // 常规模式：mtime 超过 10 分钟才删，避免误删正在进行的转存
            // 强制模式 (/clean force)：无视时间限制，全部清除
            const sessionsRoot = path.join(tmpDir, 'am_sessions');
            if (fs.existsSync(sessionsRoot)) {
              const now = Date.now();
              for (const sess of fs.readdirSync(sessionsRoot)) {
                const sessPath = path.join(sessionsRoot, sess);
                try {
                  const st = fs.statSync(sessPath);
                  if (isForce || (now - st.mtimeMs > 10 * 60 * 1000)) {
                    fs.rmSync(sessPath, { recursive: true, force: true });
                    cleanedCount++;
                  }
                } catch {}
              }
            }
          }
          const afterDisk = execSync("df -h / | tail -n 1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
          const modeNote = isForce ? ' (强制深度模式)' : '';
          const tipNote = (!isForce) ? '\n\n💡 <i>提示：刚中断的会话处于 10 分钟保护期；若需强制清空所有残留批次，请使用 <code>/cleansessions</code> 或 <code>/clean force</code></i>' : '';
          await tgCall('editMessageText', {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `✨ <b>VPS 磁盘清理完成！${modeNote}</b>\n• 清理遗留目录项：<code>${cleanedCount} 个</code>\n• 清理前可用：<code>${beforeDisk}</code>\n• 清理后可用：<code>${afterDisk}</code>${tipNote}`,
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
      // 支持直接在 TG 机器人中输入关键词搜索歌曲/专辑/艺人（复用 pick: / art_album: / art_back: 回调）
      if (!text.startsWith('/') && !/^https?:\/\//i.test(text) && text.length >= 2 && text.length <= 80) {
        const searchMsg = await tgCall('sendMessage', {
          chat_id: chatId,
          text: isEn ? `🔍 <b>Searching Apple Music for "${escapeHtml(text)}"...</b>` : `🔍 <b>正在 Apple Music 搜索「${escapeHtml(text)}」...</b>`,
          parse_mode: 'HTML'
        });
        try {
          // 优先在土区目录搜索（确保返回的曲目/专辑 ID 100% 兼容土区解密账号）
          const searchRes = await fetch(`${HOOK_BASE}/amp/v1/catalog/tr/search?term=${encodeURIComponent(text)}&types=songs,albums,artists&limit=5&l=en-GB`, {
            signal: AbortSignal.timeout(6000)
          });
          const searchJson = searchRes.ok ? await searchRes.json() : {};
          const songs = searchJson.results?.songs?.data || [];
          const albums = searchJson.results?.albums?.data || [];
          const artists = searchJson.results?.artists?.data || [];

          if (songs.length || albums.length || artists.length) {
            const kb = [];
            for (const s of songs.slice(0, 5)) {
              const sName = isEn ? (s.attributes?.name || 'Track') : toSimplifiedChinese(s.attributes?.name || 'Track');
              const sArt = normalizeArtistName(s.attributes?.artistName || '', isEn);
              const label = `🎵 ${sName} - ${sArt}`;
              kb.push([{ text: label.length > 42 ? label.slice(0, 40) + '..' : label, callback_data: `pick:${s.id}` }]);
            }
            for (const al of albums.slice(0, 3)) {
              const aName = isEn ? (al.attributes?.name || 'Album') : toSimplifiedChinese(al.attributes?.name || 'Album');
              const aArt = normalizeArtistName(al.attributes?.artistName || '', isEn);
              const label = `💿 ${aName} - ${aArt}`;
              kb.push([{ text: label.length > 42 ? label.slice(0, 40) + '..' : label, callback_data: `art_album:${al.id}` }]);
            }
            for (const ar of artists.slice(0, 2)) {
              const arName = normalizeArtistName(ar.attributes?.name || 'Artist', isEn);
              kb.push([{ text: `👤 ${isEn ? 'Artist' : '歌手'}: ${arName}`, callback_data: `art_back:${ar.id}` }]);
            }
            await tgCall('editMessageText', {
              chat_id: chatId,
              message_id: searchMsg.message_id,
              text: isEn
                ? `🔎 <b>Search Results for "${escapeHtml(text)}":</b>\nTap a track, album, or artist below to open:`
                : `🔎 <b>「${escapeHtml(text)}」搜索结果：</b>\n点击下方单曲、专辑或歌手即可直接打开下载面板：`,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: kb }
            });
            return;
          }
        } catch (sErr) {
          console.warn('[TG-Bot] 关键词搜索异常:', sErr.message);
        }
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: searchMsg.message_id,
          text: isEn
            ? `😕 No matching tracks or albums found for "<b>${escapeHtml(text)}</b>". Try sending an Apple Music link directly.`
            : `😕 未找到与「<b>${escapeHtml(text)}</b>」相关的歌曲或专辑，请尝试更换关键词或直接发送 Apple Music 链接。`,
          parse_mode: 'HTML'
        });
        return;
      }

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
        const artistData = await getArtistData(parsed.artistId, parsed.storefront, userLang, getUserTagLang(chatId));
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
          ? await fetchPlaylistDetails(parsed.playlistId, parsed.storefront, userLang, getUserTagLang(chatId))
          : await fetchAlbumDetails(parsed.albumId, parsed.storefront, userLang, getUserTagLang(chatId));

        const card = buildAlbumCard(albumData, 'Lossless', true, 'zip', userLang, isOwnerUser);
        userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
          isAlbum: true,
          albumData,
          quality: 'Lossless',
          needLrc: true,
          embedLyricsMode: 'lrc',
          saveLyricsFormats: [],
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
      const details = await fetchSongDetails(parsed.songId, parsed.storefront, userLang, getUserTagLang(chatId));
      const card = buildSongCard(details, 'Lossless', true, false, userLang, parsed.albumId || null);

      userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
        isAlbum: false,
        details,
        quality: 'Lossless',
        needLrc: true,
        embedLyricsMode: 'lrc',
        saveLyricsFormats: [],
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
    // D: 用户语言 / 是否站长 / 会话，必须在所有回调分支之前就绪（审批与申请分支都要用到）
    const userLang = getUserLang(chatId, cb.from?.language_code);
    const isEn = userLang === 'en';
    const isOwner = String(chatId) === String(OWNER_USER_ID);
    const session = userSessions.get(sessionKey);

    // 处理更新日志查看回调 (支持 latest 与 history 两种模式)
    if (data.startsWith('show_changelog')) {
      const parts = data.split(':');
      const targetLang = parts[1] || getUserLang(chatId, cb.from?.language_code);
      const mode = parts[2] === 'history' ? 'history' : 'latest';
      const cl = loadChangelog();
      if (cl.latestVersion) db.set(`seen_ver_${chatId}`, String(cl.latestVersion));
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      const card = buildChangelogCard(targetLang, mode);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      return;
    }

    // 处理中英双语切换按钮回调
    if (data.startsWith('set_lang:')) {
      const selectedLang = data.split(':')[1];
      db.set(`lang_${chatId}`, selectedLang);
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: selectedLang === 'en' ? 'Language switched to English! 🇬🇧' : '已切换为简体中文！🇨🇳'
      });
      const t = I18N[selectedLang] || I18N.zh;
      const clVer = loadChangelog().latestVersion || '2.6';
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${t.langSwitched}\n\n${t.welcome}`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: selectedLang === 'zh' ? `✨ 最新更新 (v${clVer})` : `✨ What's New (v${clVer})`,
                callback_data: `show_changelog:${selectedLang}`
              },
              {
                text: selectedLang === 'zh' ? '🌐 切换为 English' : '🌐 Switch to 中文',
                callback_data: selectedLang === 'zh' ? 'set_lang:en' : 'set_lang:zh'
              }
            ],
            [
              {
                text: selectedLang === 'zh' ? '🏷 设置音乐标签语言' : '🏷 Set Audio Tag Language',
                callback_data: 'taglang:menu'
              }
            ]
          ]
        }
      });
      return;
    }

    /* ==================== 音乐标签语言 (BCP-47) 回调 ====================
     * 前缀 taglang: 全部在这里处理，不走 session：
     *   taglang:menu          打开设置面板
     *   taglang:pick:<tag>    选中预设标签
     *   taglang:more          展开冷门语言
     *   taglang:custom        提示用户手动输入
     *   taglang:auto          恢复跟随界面语言
     */
    if (data.startsWith('taglang:')) {
      const uiLang = getUserLang(chatId, cb.from?.language_code);
      const isEnT = uiLang === 'en';
      const action = data.split(':')[1] || 'menu';
      const renderTagLangMenu = (expanded) => buildTagLangPanel(chatId, uiLang, expanded);

      if (action === 'custom') {
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        userSessions.set(`${chatId}_taglang_wait`, {
          awaitingTagLang: true,
          createdAt: Date.now(),
          messageId
        });
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: isEnT
            ? '⌨️ <b>Send me a BCP-47 language code</b>\n\nExamples:\n• <code>ar-EG</code> — Arabic (Egypt)\n• <code>ja-JP</code> — Japanese\n• <code>zh-Hant-HK</code> — Traditional Chinese (HK)\n• <code>es-MX</code> — Spanish (Mexico)\n\nSend /lang to cancel.'
            : '⌨️ <b>请直接发送 BCP-47 语言代码</b>\n\n示例：\n• <code>ar-EG</code> — 阿拉伯语（埃及）\n• <code>ja-JP</code> — 日语\n• <code>zh-Hant-HK</code> — 繁体中文（香港）\n• <code>es-MX</code> — 西班牙语（墨西哥）\n\n发送 /lang 可取消。',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: isEnT ? '🔙 Back' : '🔙 返回', callback_data: 'taglang:menu' }
            ]]
          }
        });
        return;
      }

      if (action === 'auto') {
        db.delete(`taglang_${chatId}`);
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: isEnT ? 'Tags now follow UI language' : '标签语言已恢复跟随界面'
        });
      } else if (action === 'pick') {
        const tag = data.split(':').slice(2).join(':');
        if (!isValidBcp47(tag)) {
          await tgCall('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: isEnT ? 'Invalid language code' : '无效的语言代码',
            show_alert: true
          });
          return;
        }
        db.set(`taglang_${chatId}`, tag);
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `${isEnT ? 'Tag language' : '标签语言'}: ${tag}`
        });
      } else if (action === 'more') {
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        const card = renderTagLangMenu(true);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        return;
      } else {
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      }

      const card = renderTagLangMenu(false);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      return;
    }

    /* ==================== 用户提交申请回调 (req:sub / req:disc) ==================== */
    if (data.startsWith('req:')) {
      const [, kind, targetId, optStr] = data.split(':');

      /** 解析编码进回调的选项；缺失时返回 null，交给会话兜底
       *  紧凑格式：q=L|H|A|C,t=0|1,e=l|t|o,s=lt,r=0|1,m=r|k */
      const SHORT_QUAL = { L: 'Lossless', H: 'Hi-Res', A: 'Atmos', C: 'AAC' };
      const SHORT_EMBED = { l: 'lrc', t: 'ttml', o: 'off' };
      const parseOpt = (raw) => {
        if (!raw || !raw.includes('=')) return null;
        const o = {};
        for (const part of raw.split(',')) {
          const i = part.indexOf('=');
          if (i < 0) continue;
          const k = part.slice(0, i);
          const v = part.slice(i + 1);
          if (k === 'q') o.quality = SHORT_QUAL[v] || 'Lossless';
          else if (k === 't') o.needTranslate = v === '1';
          else if (k === 'e') o.embedLyricsMode = SHORT_EMBED[v] || 'lrc';
          else if (k === 's') o.saveLyricsFormats = v ? [...v].map((c) => (c === 't' ? 'ttml' : 'lrc')) : [];
          else if (k === 'r') o.needRuby = v === '1';
          else if (k === 'm') o.rubyMode = v === 'k' ? 'kana' : 'roman';
        }
        return Object.keys(o).length ? o : null;
      };
      const cbOptions = parseOpt(optStr);
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      const applicant = { name: cb.from?.first_name || '', username: cb.from?.username || '' };
      try { db.set(`name_${chatId}`, applicant.name); } catch {}

      if (kind === 'disc') {
        // 歌手全专辑申请
        // 旧 bug：locked 按钮不带 artistId，导致 targetId=undefined → 这里必然「加载艺人失败」。
        // 现在先用回调里的 ID，取不到就回落到会话/勾选缓存里解析。
        const discArtistId = resolveArtistId(chatId, targetId);
        if (!discArtistId) {
          await tgCall('sendMessage', {
            chat_id: chatId,
            text: isEn
              ? '❌ Artist info expired. Please open the artist again and submit the request.'
              : '❌ 艺人信息已过期，请重新打开该歌手页面后再提交申请。'
          });
          return;
        }
        const artistData = await getArtistData(discArtistId, 'hk', userLang, getUserTagLang(chatId)).catch(() => null);
        if (!artistData || !(artistData.albums || []).length) {
          await tgCall('sendMessage', { chat_id: chatId, text: isEn ? '❌ Failed to load artist.' : '❌ 加载艺人失败。' });
          return;
        }
        const selected = (artistData.albums || []).filter((al) => getSelection(chatId, 'art', discArtistId).has(String(al.id)));
        const albumList = selected.length ? selected : artistData.albums;
        const tracks = albumList.reduce((s, al) => s + (al.trackCount || 0), 0);
        const scale = estimateScale(tracks);

        const res = await createRequest({
          chatId,
          userInfo: {
            name: applicant.name || (() => { try { return db.get(`name_${chatId}`) || ''; } catch { return ''; } })(),
            username: applicant.username || cb.from?.username || '',
          },
          type: 'discography',
          typeLabelZh: '歌手全专辑',
          typeLabelEn: 'Artist Discography',
          titleZh: `${artistData.name} — ${albumList.length} 张 / 约 ${scale.tracks} 首`,
          titleEn: `${artistData.name} — ${albumList.length} releases / ~${scale.tracks} tracks`,
          tracks,
          noteZh: `已勾选 ${albumList.length} 张专辑`,
          noteEn: `${albumList.length} releases selected`,
          botUsername: await getBotUsername(),
          // 勾选的专辑 ID 与用户选项必须随申请一起存盘，重启后仍能精确复原
          payload: {
            artistId: discArtistId,
            selectionIds: albumList.map((a) => String(a.id)),
            options: cbOptions || {
              quality: session?.quality || 'Lossless',
              needTranslate: session?.needTranslate || false,
              embedLyricsMode: session?.embedLyricsMode || 'lrc',
              saveLyricsFormats: session?.saveLyricsFormats || [],
              needRuby: session?.needRuby || false,
              rubyMode: session?.rubyMode || 'roman',
            },
          },
        }).catch((e) => ({ ok: false, error: e.message }));

        await replyRequestResult(chatId, isEn, res, scale);
        return;
      }

      if (kind === 'sub') {
        // 专辑/歌单超量申请：从 session 取 albumData
        const sess = session || {};
        const albumData = sess.albumData;        if (!albumData) {
          await tgCall('sendMessage', { chat_id: chatId, text: isEn ? '❌ Session expired, please send the link again.' : '❌ 会话已过期，请重新发送链接。' });
          return;
        }
        // 优先用回调里编码的选项（申请卡是独立消息，原会话早已对不上），其次才是会话
        const eff = cbOptions || {
          quality: sess.quality || 'Lossless',
          needTranslate: sess.needTranslate || false,
          embedLyricsMode: sess.embedLyricsMode || 'lrc',
          saveLyricsFormats: sess.saveLyricsFormats || [],
          needRuby: sess.needRuby || false,
          rubyMode: sess.rubyMode || 'roman',
        };
        const res = await submitAlbumRequest({
          chatId, userInfo: applicant, albumData,
          quality: eff.quality || 'Lossless',
          isPl: albumData.isPlaylist === true,
          isEn,
          options: eff,
        });
        await replyRequestResult(chatId, isEn, res, estimateScale((albumData.tracks || []).length));
        return;
      }
      return;
    }

    /* ==================== 站长审批回调 (只在站长私聊里可点) ==================== */
    if (data.startsWith('apr:')) {
      if (!isOwner) {
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: isEn ? 'Admin only.' : '仅站长可操作。',
          show_alert: true
        });
        return;
      }
      const parts = data.split(':');
      const act = parts[1];           // ok | no
      const reqId = parts[2];
      const req = requestStore.get(reqId);
      if (!req) {
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '申请不存在或已过期',
          show_alert: true
        });
        return;
      }
      if (req.status !== 'pending') {
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: req.status === 'approved' ? '该申请已批准过' : '该申请已拒绝过',
          show_alert: true
        });
        return;
      }

      req.status = act === 'ok' ? 'approved' : 'rejected';
      req.decidedAt = Date.now();
      requestStore.put(req);
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: act === 'ok' ? '✅ 已批准' : '❌ 已拒绝'
      });

      // 更新审批卡片：去掉按钮，标明结果
      try {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: `${act === 'ok' ? '✅ <b>已批准</b>' : '❌ <b>已拒绝</b>'} — 申请 #${req.id}\n👤 ${escapeHtml(req.userName)}（<code>${req.chatId}</code>）\n🎵 ${escapeHtml(req.titleZh)}`,
          parse_mode: 'HTML'
        });
      } catch {}

      const applicantLang = getUserLang(req.chatId);
      const applicantEn = applicantLang === 'en';

      if (act === 'no') {
        await tgCall('sendMessage', {
          chat_id: req.chatId,
          text: applicantEn
            ? `❌ <b>Request #${req.id} was not approved.</b>\n\nYou can still download individual albums or stay within your daily quota. You may apply again after the cooldown.`
            : `❌ <b>申请 #${req.id} 未通过。</b>\n\n你仍然可以单独下载专辑，或在每日额度内正常下载。冷却期过后可以再次申请。`,
          parse_mode: 'HTML'
        }).catch(() => {});
        return;
      }

      // 批准：立刻开始执行
      await tgCall('sendMessage', {
        chat_id: req.chatId,
        text: applicantEn
          ? `✅ <b>Request #${req.id} approved!</b>\n\nDownloading now — you'll get a <b>Gofile link</b> when it's done. Please download it early, the link expires after inactivity.`
          : `✅ <b>申请 #${req.id} 已通过！</b>\n\n现在开始下载，完成后会把 <b>Gofile 链接</b>发给你。请尽快下载，链接长期无访问会过期。`,
        parse_mode: 'HTML'
      }).catch(() => {});

      // 执行：专辑/歌单类走 handleAlbumDownload，艺人全辑走 handleArtistAlbumsDownload
      // messageId 是站长那条审批消息，不能拿来当申请人的进度消息（会更新错人的界面），
      // 所以这里先给申请人发一条进度消息，用它的 message_id 跑任务。
      try {
        const applicantLang = getUserLang(req.chatId);
        const aEn = applicantLang === 'en';

        /** 批准了却跑不起来时：用户和站长都要收到明确失败原因，不能静默挂起 */
        const failApproved = async (en, reason) => {
          await tgCall('sendMessage', {
            chat_id: req.chatId,
            text: en
              ? `❌ <b>Request #${req.id} could not start</b>\n${reason}\n\nPlease submit the request again.`
              : `❌ <b>申请 #${req.id} 未能开始</b>\n${reason}\n\n请重新提交一次申请。`,
            parse_mode: 'HTML'
          }).catch(() => {});
          await tgCall('sendMessage', {
            chat_id: OWNER_USER_ID,
            text: `⚠️ 申请 #${req.id}（${escapeHtml(req.userName)}）批准后无法执行：${escapeHtml(reason)}`,
            parse_mode: 'HTML'
          }).catch(() => {});
        };

        let progressMsg = null;
        try {
          progressMsg = await tgCall('sendMessage', {
            chat_id: req.chatId,
            text: aEn ? '⏳ <b>Approved — starting download…</b>' : '⏳ <b>已获批准，开始下载…</b>',
            parse_mode: 'HTML'
          });
        } catch {}
        const runMsgId = progressMsg?.message_id;

        if (req.type === 'album' || req.type === 'playlist') {
          const albumData = req.payload?.albumData;
          const o = req.payload?.options || {};
          if (albumData && runMsgId) {
            // 用申请人提交时选好的选项执行（音质、歌词、翻译、注音），不再一律写死
            await handleAlbumDownload(
              req.chatId, runMsgId, albumData,
              o.quality || req.payload.quality || 'Lossless',
              o.embedLyricsMode !== 'off' || (o.saveLyricsFormats || []).length > 0,
              'gofile',
              o.needTranslate || false,
              o.embedLyricsMode || 'lrc',
              o.saveLyricsFormats || [],
              o.needRuby || false,
              o.rubyMode || 'roman',
              true
            );
          } else {
            await failApproved(aEn, '申请数据缺失（可能提交时版本较旧），请重新提交一次申请');
          }
        } else if (req.type === 'discography') {
          if (!req.payload?.artistId || !(req.payload.selectionIds || []).length) {
            await failApproved(aEn, '申请数据缺失（可能提交时版本较旧），请重新提交一次申请');
          } else {
            // 恢复勾选：用请求里记录的专辑列表（与进程内存状态无关，重启也能复原）
            const sel = getSelection(req.chatId, 'art', req.payload.artistId);
            (req.payload.selectionIds || []).forEach((id) => sel.add(String(id)));
            const o = req.payload.options || {};
            if (runMsgId) {
              await handleArtistAlbumsDownload(
                req.chatId, runMsgId, req.payload.artistId,
                o.quality || 'Lossless',
                o.embedLyricsMode !== 'off' || (o.saveLyricsFormats || []).length > 0,
                'gofile',
                o.needTranslate || false,
                o.embedLyricsMode || 'lrc',
                o.saveLyricsFormats || [],
                o.needRuby || false,
                o.rubyMode || 'roman',
                true
              );
            } else {
              await failApproved(aEn, '无法向申请人发送进度消息');
            }
          }
        }
      } catch (e) {
        console.error('[Request] 批准后执行失败:', e.message);
        await tgCall('sendMessage', {
          chat_id: OWNER_USER_ID,
          text: `❌ 申请 #${req.id} 执行失败：${escapeHtml(e.message)}`,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
      return;
    }

    // ==================== 艺人浏览回调区 (无需 session，直接按 artistId 缓存/拉取) ====================
    if (data.startsWith('art_songs:') || data.startsWith('art_albums:') || data.startsWith('art_back:')) {
      const artistId = data.split(':')[1];
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      try {
        const artistData = await getArtistData(artistId, 'hk', userLang, getUserTagLang(chatId));
        if (data.startsWith('art_songs:')) {
          await showArtistSongs(chatId, artistData, userLang, messageId);
        } else if (data.startsWith('art_albums:')) {
          // 记住当前在看的艺人，供「申请批量下载」这类不带参数的回调按钮解析
          const curSess = userSessions.get(sessionKey) || { createdAt: Date.now() };
          curSess.artistId = String(artistId);
          userSessions.set(sessionKey, curSess);
          await showArtistAlbums(chatId, artistData, userLang, messageId, isOwner);
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

    // ==================== 艺人专辑勾选回调 (无需 session) ====================
    if (data.startsWith('atsel_art_')) {
      const parts = data.split(':');
      const artistId = parts[1] || null;

      // 艺人全专辑页的选项回调（音质 / 歌词 / 翻译 / 注音）
      if (data.startsWith('aao:')) {
        const p = data.split(':');
        const field = p[1];
        const o = getArtistOpts(chatId);
        if (field === 'q') {
          o.quality = ['Lossless', 'Hi-Res', 'Atmos', 'AAC'].includes(p[2]) ? p[2] : 'Lossless';
        } else if (field === 'e') {
          o.embedLyricsMode = ['lrc', 'ttml', 'off'].includes(p[2]) ? p[2] : 'lrc';
        } else if (field === 's') {
          const f = p[2];
          if (f === 'lrc' || f === 'ttml') {
            o.saveLyricsFormats = o.saveLyricsFormats.includes(f)
              ? o.saveLyricsFormats.filter((x) => x !== f)
              : [...o.saveLyricsFormats, f];
          }
        } else if (field === 't') {
          o.needTranslate = !o.needTranslate;
        } else if (field === 'r') {
          o.needRuby = !o.needRuby;
        } else if (field === 'm') {
          o.rubyMode = o.rubyMode === 'kana' ? 'roman' : 'kana';
        }
        o.updatedAt = Date.now();

        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        // 重绘这一页，让 ✅ 标记跟上。artistId 位置随字段不同：q/e/s 是 p[3]，其余是 p[2]
        const adId = ['q', 'e', 's'].includes(field) ? p[3] : p[2];
        const ad = await getArtistData(adId, 'hk', userLang, getUserTagLang(chatId));
        await showArtistAlbums(chatId, ad, userLang, messageId, isOwner);
        return;
      }

      // 分页按钮（atsel_art_more）只做界面刷新，不需要额外应答动作
      if (data.startsWith('atsel_art_more')) {
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          show_alert: false
        });
        return;
      }

      if (data.startsWith('atsel_art_dl:')) {
        const selection = getSelection(chatId, 'art', artistId);
        if (selection.size === 0) {
          await tgCall('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: isEn ? 'Please tick at least one album first!' : '请先勾选至少一张专辑！',
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
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        // 额度内直接下载；超额时由 handleArtistAlbumsDownload 内部转为「申请站长授权」
        // 选项来自本页自己的 artistOpts（这个页面不是会话式消息，session 不存在）
        const ao = getArtistOpts(chatId);
        handleArtistAlbumsDownload(
          chatId, messageId, artistId,
          ao.quality || 'Lossless',
          ao.embedLyricsMode !== 'off' || ao.saveLyricsFormats.length > 0,
          'zip',
          ao.needTranslate || false,
          ao.embedLyricsMode || 'lrc',
          ao.saveLyricsFormats || [],
          ao.needRuby || false,
          ao.rubyMode || 'roman',
          false
        )
          .catch(e => console.error('[TG-Bot] 全专辑批量转存任务出错:', e.message))
          .finally(() => {
            selection.clear();
            userSessions.delete(sessionKey);
          });
        return;
      }

      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      try {
        const artistData = await getArtistData(artistId, 'hk', userLang, getUserTagLang(chatId));
        const selection = getSelection(chatId, 'art', artistId);
        let targetPage = null;
        if (data.startsWith('atsel_art_page:')) {
          targetPage = parseInt(parts[2], 10) || 0;
        } else if (data.startsWith('atsel_art_toggle:')) {
          const albumId = parts[2];
          if (selection.has(String(albumId))) selection.delete(String(albumId));
          else selection.add(String(albumId));
        } else if (data.startsWith('atsel_art_all:')) {
          artistData.albums.forEach(al => selection.add(String(al.id)));
        } else if (data.startsWith('atsel_art_studio:')) {
          selection.clear();
          artistData.albums.filter(al => al.kind === 'full' || !al.kind).forEach(al => selection.add(String(al.id)));
        } else if (data.startsWith('atsel_art_none:')) {
          selection.clear();
        }
        await showArtistAlbums(chatId, artistData, userLang, messageId, isOwner, targetPage);
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
        const albumData = await fetchAlbumDetails(albumId, 'hk', userLang, getUserTagLang(chatId));
        const defaultMode = 'zip';
        const card = buildAlbumCard(albumData, 'Lossless', true, defaultMode, userLang, isOwner, artistId);
        userSessions.set(sessionKey, {
          isAlbum: true,
          albumData,
          quality: 'Lossless',
          needLrc: true,
          embedLyricsMode: 'lrc',
          saveLyricsFormats: [],
          deliveryMode: defaultMode,
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
        const details = await fetchSongDetails(songId, 'hk', userLang, getUserTagLang(chatId));
        const card = buildSongCard(details, 'Lossless', true, false, userLang, backAlbumId);
        userSessions.set(`${chatId}_${loadingMsg.message_id}`, {
          isAlbum: false,
          details,
          quality: 'Lossless',
          needLrc: true,
          embedLyricsMode: 'lrc',
          saveLyricsFormats: [],
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
        try {
          albumData = String(albumId).startsWith('pl.')
            ? await fetchPlaylistDetails(albumId, 'hk', userLang, getUserTagLang(chatId))
            : await fetchAlbumDetails(albumId, 'hk', userLang, getUserTagLang(chatId));
        } catch {}
      }
      if (albumData) {
        await showAlbumTracks(chatId, albumData, userLang, messageId);
      }
      return;
    }

    // ==================== 专辑曲目多选勾选回调 (无需 session) ====================
    if (data.startsWith('tsel:') || data.startsWith('tsel_page:') || data.startsWith('tsel_all:') || data.startsWith('tsel_none:') || data.startsWith('tsel_noop:') || data.startsWith('tsel_dl:')) {
      const parts = data.split(':');
      const albumId = parts[1];
      if (data.startsWith('tsel_noop:')) {
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        return;
      }

      const selection = getSelection(chatId, 'trk', albumId);
      let albumData = session?.albumData;
      if (!albumData) {
        try {
          albumData = String(albumId).startsWith('pl.')
            ? await fetchPlaylistDetails(albumId, 'hk', userLang, getUserTagLang(chatId))
            : await fetchAlbumDetails(albumId, 'hk', userLang, getUserTagLang(chatId));
        } catch {}
      }

      if (data.startsWith('tsel_dl:')) {
        if (selection.size === 0) {
          await tgCall('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: isEn ? 'Please tick at least one track first!' : '请先勾选至少一首单曲！',
            show_alert: true
          });
          return;
        }
        if (!albumData) {
          await tgCall('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: isEn ? 'Failed to load album data, please retry!' : '专辑数据加载失败，请重试！',
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
        await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
        handleMultiTrackDownload(chatId, messageId, albumData, selection, session?.quality || 'Lossless', session?.needLrc ?? true, false, session?.needTranslate || false, session?.embedLyricsMode || 'lrc', session?.saveLyricsFormats || [], session?.needRuby || false, session?.rubyMode || 'roman')
          .catch(e => console.error('[TG-Bot] 多选单曲批量转存任务出错:', e.message))
          .finally(() => userSessions.delete(sessionKey));
        return;
      }

      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      let targetPage = null;
      if (data.startsWith('tsel_page:')) {
        targetPage = parseInt(parts[2], 10) || 0;
      } else if (data.startsWith('tsel:')) {
        const trackId = parts[2];
        if (selection.has(String(trackId))) selection.delete(String(trackId));
        else selection.add(String(trackId));
      } else if (data.startsWith('tsel_all:')) {
        if (albumData) {
          albumData.tracks.forEach(t => selection.add(String(t.id)));
        }
      } else if (data.startsWith('tsel_none:')) {
        selection.clear();
      }

      if (albumData) {
        await showAlbumTracks(chatId, albumData, userLang, messageId, targetPage);
      } else {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: `❌ ${isEn ? 'Failed to load album tracks' : '加载专辑曲目失败'}`
        });
      }
      return;
    }

    // 返回专辑主菜单
    if (data.startsWith('aback:')) {
      const albumId = data.split(':')[1];
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      let albumData = session?.albumData;
      if (!albumData) {
        try {
          albumData = String(albumId).startsWith('pl.')
            ? await fetchPlaylistDetails(albumId, 'hk', userLang, getUserTagLang(chatId))
            : await fetchAlbumDetails(albumId, 'hk', userLang, getUserTagLang(chatId));
        } catch {}
      }
      if (albumData) {
        const card = buildAlbumCard(albumData, session?.quality || 'Lossless', session?.needLrc ?? true, session?.deliveryMode || 'zip', userLang, isOwner, session?.backArtistId || null, session?.needTranslate || false, session?.embedLyricsMode || 'lrc', session?.saveLyricsFormats || [], session?.needRuby || false, session?.rubyMode || 'roman');
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

    // 非站长点击歌单整辑下载按钮 → 引导提交申请
    if (data.startsWith('anotowner:')) {
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
      if (!session?.albumData) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: isEn ? 'Session expired. Please send the link again.' : '会话已过期，请重新发送链接。'
        });
        return;
      }
      await offerApprovalRequest({
        chatId, messageId, userInfo: cb.from,
        quality: session.quality || 'Lossless',
        albumData: session.albumData,
        isPl: session.albumData.isPlaylist === true,
        typeLabel: session.albumData.isPlaylist ? (isEn ? 'playlist' : '歌单') : (isEn ? 'album' : '专辑'),
        isEn,
        tracks: (session.albumData.tracks || []).length,
        options: {
          quality: session.quality || 'Lossless',
          needTranslate: session.needTranslate || false,
          embedLyricsMode: session.embedLyricsMode || 'lrc',
          needRuby: session.needRuby || false,
          rubyMode: session.rubyMode || 'roman',
        },
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
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: session.deliveryMode === 'gofile'
            ? (isEn ? '☁️ Gofile mode: faster, no 2GB limit' : '☁️ Gofile 模式：更快、无 2GB 限制')
            : session.deliveryMode === 'zip'
              ? (isEn ? '📦 Single ZIP archive' : '📦 全辑单 ZIP')
              : (isEn ? '🎵 Native playlist bubbles' : '🎵 原生音频合辑')
        });
        return;
      }

      if (data.startsWith('aefmt:')) {
        const parts = data.split(':');
        session.embedLyricsMode = ['lrc', 'ttml', 'off'].includes(parts[1]) ? parts[1] : 'lrc';
        session.needLrc = session.embedLyricsMode !== 'off' || (session.saveLyricsFormats?.length > 0);
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        // 明确告知切换结果，避免"点了没反应"的错觉
        const fmtZh = session.embedLyricsMode === 'lrc' ? '内嵌 LRC' : session.embedLyricsMode === 'ttml' ? '内嵌 TTML' : '不内嵌歌词';
        const fmtEn = session.embedLyricsMode === 'lrc' ? 'Embed LRC' : session.embedLyricsMode === 'ttml' ? 'Embed TTML' : 'No embedded lyrics';
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: isEn ? `✅ Lyrics: ${fmtEn}` : `✅ 歌词：${fmtZh}`
        });
        return;
      }

      if (data.startsWith('aesave:')) {
        const parts = data.split(':');
        const fmt = parts[1];
        const cur = session.saveLyricsFormats || [];
        session.saveLyricsFormats = cur.includes(fmt) ? cur.filter((f) => f !== fmt) : [...cur, fmt];
        session.needLrc = session.embedLyricsMode !== 'off' || (session.saveLyricsFormats.length > 0);
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        const on = session.saveLyricsFormats.includes(fmt);
        const extNote = session.deliveryMode === 'media'
          ? (isEn ? ' (MediaGroup mode cannot attach external files)' : '（原生音频合辑模式无法附带外置文件）')
          : '';
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: isEn
            ? `${on ? '✅ External' : '❌ External'} .${fmt.toUpperCase()} ${on ? 'enabled' : 'disabled'}${extNote}`
            : `${on ? '✅ 已生成外置' : '❌ 已关闭外置'} .${fmt.toUpperCase()}${extNote}`
        });
        return;
      }

      if (data.startsWith('alyronly:')) {
        const parts = data.split(':');
        const want = parts[1]; // 'lrc' | 'ttml' | 'both'
        await handleAlbumLyricsOnlyDownload(chatId, messageId, session.albumData, want, session.needTranslate, session.needRuby, session.rubyMode);
        return;
      }

      if (data.startsWith('atlrc:')) {
        session.needTranslate = data.split(':')[1] === '1';
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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

      if (data.startsWith('aruby:')) {
        session.needRuby = data.split(':')[1] === '1';
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: session.needRuby
            ? (isEn ? '✅ Ruby phonetic enabled (Japanese tracks)' : '✅ 已开启注音（仅日文歌曲生效）')
            : (isEn ? 'Ruby phonetic disabled' : '已关闭注音')
        });
        return;
      }

      if (data.startsWith('arubym:')) {
        session.rubyMode = data.split(':')[1] === 'kana' ? 'kana' : 'roman';
        const card = buildAlbumCard(session.albumData, session.quality, session.needLrc, session.deliveryMode, userLang, isOwner, session.backArtistId || null, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: card.text,
          parse_mode: 'HTML',
          reply_markup: card.reply_markup
        });
        await tgCall('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: session.rubyMode === 'kana'
            ? (isEn ? 'Ruby mode: Hiragana' : '注音模式：平假名')
            : (isEn ? 'Ruby mode: Romaji' : '注音模式：罗马音')
        });
        return;
      }

      if (data.startsWith('adl:')) {
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
        handleAlbumDownload(chatId, messageId, session.albumData, session.quality, session.needLrc, session.deliveryMode, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode)
          .catch(e => console.error('[TG-Bot] 专辑转存任务出错:', e.message))
          .finally(() => userSessions.delete(sessionKey));
        return;
      }
    }

    // 单曲相关回调
    if (data.startsWith('q:')) {
      session.quality = data.split(':')[1];
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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

    if (data.startsWith('efmt:')) {
      const parts = data.split(':');
      session.embedLyricsMode = ['lrc', 'ttml', 'off'].includes(parts[1]) ? parts[1] : 'lrc';
      session.needLrc = session.embedLyricsMode !== 'off' || (session.saveLyricsFormats?.length > 0);
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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

    if (data.startsWith('esave:')) {
      const parts = data.split(':');
      const fmt = parts[1];
      const cur = session.saveLyricsFormats || [];
      session.saveLyricsFormats = cur.includes(fmt) ? cur.filter((f) => f !== fmt) : [...cur, fmt];
      session.needLrc = session.embedLyricsMode !== 'off' || (session.saveLyricsFormats.length > 0);
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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

    if (data.startsWith('lyronly:')) {
      const parts = data.split(':');
      const want = parts[1]; // 'lrc' | 'ttml' | 'both'
      await handleLyricsOnlyDownload(chatId, messageId, session.details, want, session.needTranslate, session.needRuby, session.rubyMode);
      return;
    }

    if (data.startsWith('tlrc:')) {
      session.needTranslate = data.split(':')[1] === '1';
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
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

    if (data.startsWith('ruby:')) {
      session.needRuby = data.split(':')[1] === '1';
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: session.needRuby
          ? (isEn ? '✅ Ruby phonetic enabled (Japanese tracks)' : '✅ 已开启注音（仅日文歌曲生效）')
          : (isEn ? 'Ruby phonetic disabled' : '已关闭注音')
      });
      return;
    }

    if (data.startsWith('rubym:')) {
      session.rubyMode = data.split(':')[1] === 'kana' ? 'kana' : 'roman';
      const card = buildSongCard(session.details, session.quality, session.needLrc, session.isZip, userLang, session.backAlbumId, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup
      });
      await tgCall('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: session.rubyMode === 'kana'
          ? (isEn ? 'Ruby mode: Hiragana' : '注音模式：平假名')
          : (isEn ? 'Ruby mode: Romaji' : '注音模式：罗马音')
      });
      return;
    }

    if (data.startsWith('dl:')) {
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
      handleDownload(chatId, messageId, session.details, session.quality, session.needLrc, session.isZip, session.needTranslate, session.embedLyricsMode, session.saveLyricsFormats, session.needRuby, session.rubyMode)
        .catch(e => console.error('[TG-Bot] 单曲转存任务出错:', e.message))
        .finally(() => userSessions.delete(sessionKey));
      return;
    }
  }
}

// 清理异常终止遗留的临时目录与临时歌词文件 (兜底防护)
function cleanupStaleTgTempDirs() {
  try {
    const tmpDir = '/tmp';
    const now = Date.now();
    const maxAge = 15 * 60 * 1000; // 15分钟
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      // am_tg_* 为下载临时目录；am_lyr_only_* / am_lyr_fix_* 为仅歌词/补歌词场景写出的临时文件。
      // 后者原先没有任何清理逻辑，会长期堆积在 /tmp。
      const isTgTempDir = entry.startsWith('am_tg_');
      const isLyricsTemp = entry.startsWith('am_lyr_only_') || entry.startsWith('am_lyr_fix_');
      if (isTgTempDir || isLyricsTemp) {
        const p = path.join(tmpDir, entry);
        try {
          const stat = fs.statSync(p);
          if (now - stat.mtimeMs > maxAge) {
            fs.rmSync(p, { recursive: true, force: true });
            console.log(`[TG-Bot] 自动清理遗留临时${isTgTempDir ? '目录' : '歌词文件'}: ${entry}`);
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

    // 注册 Telegram 原生指令菜单（普通用户 5 个常用指令；站长专属叠加全套运维指令）
    try {
      const userCommands = [
        { command: 'start', description: '启动与语言切换 / Start & Language' },
        { command: 'tags', description: '音乐标签语言 BCP-47 / Audio Tag Language' },
        { command: 'changelog', description: '最新更新说明与版本历史 / What\'s New' },
        { command: 'help', description: '使用帮助与格式说明 / Usage & Tips' },
        { command: 'stats', description: '带宽流量与配额 / Bandwidth & Quota' },
        { command: 'lang', description: '切换中英语言 / Switch Language' }
      ];
      const ownerCommands = [
        { command: 'start', description: '启动与语言切换 / Start & Language' },
        { command: 'tags', description: '音乐标签语言 BCP-47 / Audio Tag Language' },
        { command: 'changelog', description: '最新更新说明与版本历史 / What\'s New' },
        { command: 'help', description: '使用帮助与格式说明 / Usage & Tips' },
        { command: 'stats', description: '带宽流量与配额 / Bandwidth & Quota' },
        { command: 'lang', description: '切换中英语言 / Switch Language' },
        { command: 'history', description: '最近1小时全平台任务流水 (Web+TG)' },
        { command: 'status', description: 'VPS 系统资源与服务监控仪表盘' },
        { command: 'check', description: '全链路服务与 Apple Music 账号探活' },
        { command: 'clean', description: '一键扫描清理 VPS 临时垃圾与残留会话' },
        { command: 'restart', description: '远程重启指定服务 (bot/cloud/hook/api/all)' }
      ];

      // 全局默认（含私聊、群组、频道三个作用域，避免某些客户端按作用域取到旧菜单）
      for (const scope of [
        { type: 'default' },
        { type: 'all_private_chats' },
        { type: 'all_group_chats' },
        { type: 'all_chat_administrators' }
      ]) {
        await tgCall('setMyCommands', { commands: userCommands, scope });
      }

      // 站长私聊专属：普通指令 + 运维指令（Telegram 上限 100 条，此处 10 条）
      if (OWNER_USER_ID) {
        await tgCall('setMyCommands', {
          commands: ownerCommands,
          scope: { type: 'chat', chat_id: Number(OWNER_USER_ID) }
        });
      }
      console.log('[TG-Bot] ✔ Telegram 指令菜单已同步注册 (全局 6 条 + 站长专属 11 条)');
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
