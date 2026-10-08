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
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 31409;
const HOST = '127.0.0.1';
const HOOK_BASE = 'http://127.0.0.1:31408';

// 繁简字转换字典 (OpenCC 词表)
let t2sMap = {};
try {
  const t2sPath = path.join(__dirname, 't2s.json');
  if (fs.existsSync(t2sPath)) {
    t2sMap = JSON.parse(fs.readFileSync(t2sPath, 'utf8'));
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
  '儘': '尽'
};
Object.assign(t2sMap, EXTRA_T2S);

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

/**
 * 封装 ZIP 归档文件
 * 使用 python3 zipfile 进行封装：
 * 1. 强制写入 PKZIP Bit 11 (0x800) UTF-8 标识位，彻底解决 Windows 资源管理器打开含中日韩字符 ZIP 乱码、报损坏或空白的问题
 * 2. 采用 ZIP_STORED (Store 0，无额外压缩计算)，直接流式打包，速度极快
 */
async function packZipFolder(sourceDir, outputZipPath) {
  const zipScript = path.join(__dirname, 'zip_pack.py');
  await execFileAsync('python3', [zipScript, outputZipPath, sourceDir]);
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

function sanitizeFilename(name) {
  if (!name) return 'track';
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
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
    finalizeBatch = false
  } = body;

  // 0. 如果是批处理全辑最终打包请求 (3 线程并发转存全部就绪后统一打包上传)
  if (finalizeBatch && batchId) {
    const sessionDir = `/tmp/am_sessions/${batchId}`;
    if (!fs.existsSync(sessionDir)) {
      throw new Error(`批处理会话不存在或已过期: ${batchId}`);
    }
    const finalZipName = sanitizeFilename(zipFilename || (meta.album ? `${meta.album} [${quality}].zip` : 'Album.zip'));
    const zipFilePath = `/tmp/${batchId}.zip`;
    const files = fs.readdirSync(sessionDir);
    console.log(`[Cloud-Transfer] 收到全辑并发转存打包请求，正在将会话 ${batchId} (${files.length} 个文件) 打包为 .zip...`);
    await packZipFolder(sessionDir, zipFilePath);

    const zipBuf = fs.readFileSync(zipFilePath);
    console.log(`[Cloud-Transfer] 全辑 ZIP 封装完成 (${(zipBuf.length / (1024 * 1024)).toFixed(1)}MB, 共 ${files.length} 个文件)，正在直传 Gofile...`);

    const srv = await getGofileServer();
    const form = new FormData();
    form.append('file', new Blob([zipBuf], { type: 'application/zip' }), finalZipName);
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

    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(zipFilePath, { force: true });
    } catch {}

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
  }

  const shouldSaveLyricsFile = saveLyricsFile !== undefined 
    ? Boolean(saveLyricsFile) 
    : Boolean(saveLrc);
  const shouldEmbedLyrics = Boolean(embedLyrics);
  const chosenLyricsFormat = (lyricsFormat || 'lrc').toLowerCase() === 'ttml' ? 'ttml' : 'lrc';

  let audioHookUrl = directHookUrl;
  let chosenFormatName = '';

  // 1. 如果没有直接传 hookFileUrl，通过 127.0.0.1:31408/parse/song/{adamId} 获取
  if (!audioHookUrl) {
    if (!adamId) throw new Error('缺少 adamId 或 hookFileUrl');
    const parseRes = await fetch(`${HOOK_BASE}/parse/song/${adamId}`, { signal: AbortSignal.timeout(10000) });
    if (!parseRes.ok) throw new Error(`解析歌曲失败: HTTP ${parseRes.status}`);
    const parseData = await parseRes.json();
    const variants = parseData.variants || [];
    if (!variants.length) throw new Error('未找到可用的音频流');

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

  // 确保 audioHookUrl 指向本地 HOOK_BASE
  let targetAudioUrl = audioHookUrl;
  if (targetAudioUrl.startsWith('/')) {
    targetAudioUrl = `${HOOK_BASE}${targetAudioUrl}`;
  } else if (!targetAudioUrl.startsWith('http://127.0.0.1:31408') && !targetAudioUrl.startsWith('http://localhost:31408')) {
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
    const aRes = await fetch(targetAudioUrl, { signal: AbortSignal.timeout(60000) });
    if (!aRes.ok) throw new Error(`获取音频流失败: HTTP ${aRes.status}`);
    return new Uint8Array(await aRes.arrayBuffer());
  };
  tasks.push(fetchAudio());

  // 封面图抓取
  const fetchCover = async () => {
    if (!meta.coverUrl) return null;
    try {
      const cRes = await fetch(meta.coverUrl, { signal: AbortSignal.timeout(8000) });
      if (cRes.ok) return new Uint8Array(await cRes.arrayBuffer());
    } catch (e) {
      console.warn('[Cloud-Transfer] 封面抓取失败:', e.message);
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

  // 繁体中文转简体中文 (智能保护英文及日文假名)
  if (meta.title) meta.title = toSimplifiedChinese(meta.title);
  if (meta.artist) meta.artist = toSimplifiedChinese(meta.artist);
  if (meta.album) meta.album = toSimplifiedChinese(meta.album);
  if (meta.albumArtist) meta.albumArtist = toSimplifiedChinese(meta.albumArtist);
  if (meta.composer) meta.composer = toSimplifiedChinese(meta.composer);
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

    fs.writeFileSync(path.join(sessionDir, finalM4aName), taggedMp4Buf);

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

    const zipBuf = fs.readFileSync(zipFilePath);
    console.log(`[Cloud-Transfer] 全辑 ZIP 封装完成 (${(zipBuf.length / (1024 * 1024)).toFixed(1)}MB, 共 ${files.length} 个文件)，正在直传 Gofile...`);

    const srv = await getGofileServer();
    const form = new FormData();
    form.append('file', new Blob([zipBuf], { type: 'application/zip' }), finalZipName);
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

    // 清理临时会话目录与 zip 文件，VPS 零磁盘残留
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(zipFilePath, { force: true });
    } catch {}

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
  }

  // 4.2 单曲压缩模式 (可选将单曲与对应歌词打包为单个 .zip 上传)
  if (zip) {
    const singleDir = `/tmp/am_single_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    fs.mkdirSync(singleDir, { recursive: true });
    fs.writeFileSync(path.join(singleDir, standardM4aName), taggedMp4Buf);

    if (lyricsFilename && lyricsContent) {
      fs.writeFileSync(path.join(singleDir, lyricsFilename), lyricsContent, 'utf8');
    }

    const finalZipName = `${cleanArtist ? cleanArtist + ' - ' : ''}${cleanTitle}.zip`;
    const zipFilePath = `${singleDir}.zip`;
    const files = fs.readdirSync(singleDir);
    await packZipFolder(singleDir, zipFilePath);

    const zipBuf = fs.readFileSync(zipFilePath);
    const srv = await getGofileServer();
    const form = new FormData();
    form.append('file', new Blob([zipBuf], { type: 'application/zip' }), finalZipName);
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

    try {
      fs.rmSync(singleDir, { recursive: true, force: true });
      fs.rmSync(zipFilePath, { force: true });
    } catch {}

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
  }

  // 4.3 常规单文件上传至 Gofile (支持同一 folderId 归集)
  const srv = await getGofileServer();
  const upUrl = `https://${srv}.gofile.io/contents/uploadfile`;

  // 上传音频
  const form = new FormData();
  form.append('file', new Blob([taggedMp4Buf], { type: 'audio/mp4' }), standardM4aName);
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

/* ==================== HTTP 服务 ==================== */

const server = http.createServer(async (req, res) => {
  // CORS 响应头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

  if (req.method === 'POST' && (u.pathname === '/transfer' || u.pathname === '/api/cloud-transfer')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw);
        const result = await processTransfer(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', data: result }));
      } catch (err) {
        console.error('[Cloud-Transfer] 错误:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
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
    const maxAge = 2 * 60 * 60 * 1000;
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if ((entry.startsWith('album_') || entry.startsWith('playlist_') || entry.startsWith('am_single_')) && entry.endsWith('.zip')) {
        const p = path.join(tmpDir, entry);
        try {
          const stat = fs.statSync(p);
          if (now - stat.mtimeMs > maxAge) {
            fs.rmSync(p, { force: true });
            console.log(`[am-cloud] 自动清理过期临时 ZIP: ${entry}`);
          }
        } catch {}
      }
    }
  } catch {}
}

server.listen(PORT, HOST, () => {
  console.log(`[am-cloud] VPS 2000M 云端极速转存服务已就绪: http://${HOST}:${PORT}`);
  cleanupStaleSessions();
  setInterval(cleanupStaleSessions, 30 * 60 * 1000);
});

