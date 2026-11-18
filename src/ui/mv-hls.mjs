// HLS parsing stays in the browser. Only PlayReady key declarations are used; some older MVs are unencrypted.
export function attributes(value) {
  const result = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
  for (const m of value.matchAll(re)) result[m[1]] = m[2] ?? m[3];
  return result;
}
export function mvLink(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'music.apple.com') return null;
    const m = u.pathname.match(/^\/([a-z]{2})\/music-video\/(?:[^/]+\/)?(\d+)\/?$/i);
    return m ? { id: m[2], country: m[1].toLowerCase() } : null;
  } catch { return null; }
}
function absolute(uri, base) {
  const baseUrl = new URL(base);
  const u = new URL(uri, baseUrl);
  if (u.protocol !== 'https:') throw new Error('Expected an HTTPS media URL');
  // Apple's mvod CDN signs media playlists with a directory-scoped ?accessKey=... token;
  // relative init/segment URIs omit the query string and fail with 403 unless inherited.
  if (u.origin === baseUrl.origin && !u.search && baseUrl.search) u.search = baseUrl.search;
  return u.href;
}
export function parseMaster(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS master playlist');
  const videos = [], audios = [], captions = []; let pending;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) audios.push({ ...a, url: absolute(a.URI, url) });
      if (a.TYPE === 'CLOSED-CAPTIONS') captions.push(a);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) pending = attributes(line.slice(18));
    else if (line && !line.startsWith('#') && pending) {
      if (pending.RESOLUTION) videos.push({ ...pending, url: absolute(line, url) });
      pending = null;
    }
  }
  videos.sort((a, b) => Number(b.BANDWIDTH) - Number(a.BANDWIDTH));
  for (const a of audios) {
    a.codec = videos.filter(v => v.AUDIO === a['GROUP-ID']).flatMap(v => (v.CODECS || '').split(','))
      .find(c => /^(mp4a|ac-3|ec-3|ac-4)/.test(c)) || '';
  }
  if (!videos.length || !audios.length) throw new Error('No separate video/audio tracks found');
  return { videos, audios, captions };
}
export function recommendedAudio(video, audios) {
  return audios.find(a => a['GROUP-ID'] === video.AUDIO && a.DEFAULT === 'YES')
    || audios.find(a => a['GROUP-ID'] === video.AUDIO) || audios[0];
}
export function parseMedia(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS media playlist');
  const segments = []; let init, key, encrypted = false, duration, range, time = 0, previous;
  function resource(uri, spec) {
    const r = { url: absolute(uri, url) };
    if (spec) {
      const m = /^(\d+)(?:@(\d+))?$/.exec(spec);
      if (!m) throw new Error('Invalid HLS byte range');
      const offset = m[2] === undefined ? (previous?.url === r.url ? previous.end : NaN) : Number(m[2]);
      const length = Number(m[1]);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid HLS byte range offset');
      r.range = { offset, length }; previous = { url: r.url, end: offset + length };
    } else previous = null;
    return r;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line.slice(11));
      encrypted = a.METHOD !== 'NONE';
      if (!encrypted) key = null;
      else if (a.KEYFORMAT === 'com.microsoft.playready') {
        if (!a.URI?.startsWith('data:') || !a.URI.includes(';base64,')) throw new Error('Unsupported PlayReady key URI');
        key = a.URI;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line.slice(11)); init = resource(a.URI, a.BYTERANGE);
    } else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line === '#EXT-X-DISCONTINUITY') throw new Error('Discontinuous MV playlists are not supported');
    else if (line && !line.startsWith('#')) {
      if (!init || !Number.isFinite(duration) || duration <= 0) throw new Error('Missing init or segment duration');
      if (encrypted && !key) throw new Error('No PlayReady key for encrypted MV media');
      segments.push({ ...resource(line, range), init, key, start: time, duration });
      time += duration; duration = undefined; range = undefined;
    }
  }
  if (!segments.length) throw new Error('No MV media segments found');
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('Only completed MV playlists are supported');
  return { segments, duration: time, init: segments[0].init };
}
export async function fetchResource(resource, signal) {
  const headers = {};
  if (resource.range) headers.Range = `bytes=${resource.range.offset}-${resource.range.offset + resource.range.length - 1}`;
  const res = await fetch(resource.url, { headers, signal });
  if (!res.ok) throw new Error(`Media HTTP ${res.status}`);
  // Never buffer a whole MV when a CDN ignores Range.
  if (resource.range && res.status !== 206) { await res.body?.cancel(); throw new Error('CDN did not honor the byte range'); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (resource.range && bytes.length !== resource.range.length) throw new Error('Truncated media range');
  return bytes;
}

const FORBIDDEN_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE_FILE_CHARS = /[\p{Cf}\ufdd0-\ufdef\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;
const RESERVED_FILE_NAME = /^((con|prn|aux|nul|clock\$|(com|lpt)[0-9\u00b9\u00b2\u00b3])(\..*)?|desktop\.ini|thumbs\.db)$/i;
const SHELL_EXT_DOT = /\.(?=(lnk|local|\{.*\})$)/i;
const UTF8_ENCODER = new TextEncoder();
const MV_MAX_CHARS = 180;
const MV_MAX_BYTES = 240;

function cleanFilePart(value) {
  return String(value ?? '')
    .replace(INVISIBLE_FILE_CHARS, '')
    .normalize('NFC')
    .replace(FORBIDDEN_FILE_CHARS, '_')
    .replace(INVISIBLE_FILE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function finalizeSegment(text) {
  let s = text.replace(/^[.\s]+|[.\s]+$/g, '').replace(/^~|~$/g, '～').replace(SHELL_EXT_DOT, '_');
  if (RESERVED_FILE_NAME.test(s)) s = `_${s}`;
  return s || '_';
}

function truncateSegment(text, maxBytes, maxChars) {
  let chars = [...text];
  if (chars.length > maxChars) chars = chars.slice(0, maxChars);
  while (chars.length && UTF8_ENCODER.encode(chars.join('')).length > maxBytes) chars.pop();
  return finalizeSegment(chars.join(''));
}

/** 清洗单个文件名（不含扩展名）：NFC 规范化、去除控制/不可见字符、非法字符转下划线、处理首尾点与 ~、Windows 保留名与 UTF-8 字节安全截断 */
export function sanitizeFileName(name, maxBytes = MV_MAX_BYTES, maxChars = MV_MAX_CHARS) {
  const cleaned = cleanFilePart(name).replace(/^[.\s]+|[.\s]+$/g, '');
  if (!cleaned) return '_';
  const s = finalizeSegment(cleaned);
  return (UTF8_ENCODER.encode(s).length > maxBytes || [...s].length > maxChars)
    ? truncateSegment(cleaned, maxBytes, maxChars)
    : s;
}

/** 安全解码 URL 路径里的 MV slug（`_` 或非法 percent-encoding 时返回空串） */
export function decodeMvSlug(slug) {
  if (!slug || slug === '_') return '';
  try {
    const decoded = decodeURIComponent(String(slug)).trim();
    return decoded === '_' ? '' : decoded;
  } catch {
    return '';
  }
}

/** 生成用于文件名后缀的规格标签（如 480p、1080p、4K Dolby Vision · Atmos） */
export function mvTrackSpec(video, audio, post = false) {
  if (!video) return '';
  if (post || video.direct) return video.height ? `${video.height}p` : 'SD';
  const height = Number(String(video.RESOLUTION || '').split('x')[1]) || 0;
  const res = height >= 2160 ? '4K' : height >= 1440 ? '2K' : height ? `${height}p` : '';
  const vc = String(video.CODECS || '');
  const range = /^dv(h1|he)/.test(vc) ? 'Dolby Vision' : ({ PQ: 'HDR10', HLG: 'HLG' }[video['VIDEO-RANGE']] || '');
  const videoPart = [res, range].filter(Boolean).join(' ');
  const [channels, joc] = String(audio?.CHANNELS || '').split('/');
  const audioPart = joc === 'JOC' ? 'Atmos' : (channels && channels !== '2' && channels !== '1') ? ({ 6: '5.1', 8: '7.1' }[channels] || `${channels}ch`) : '';
  return [videoPart, audioPart].filter(Boolean).join(' · ');
}

/** 生成规范的 MV 下载文件名：{artist} - {title} [{spec}].mp4（超长时优先截断标题/艺人，始终保留 [{spec}].mp4 后缀） */
export function buildMvFileName({ artist = '', title = '', spec = '', id = '', post = false, maxBytes = MV_MAX_BYTES, maxChars = MV_MAX_CHARS } = {}) {
  let cleanArtist = cleanFilePart(artist).replace(/^[.\s]+|[.\s]+$/g, '');
  let cleanTitle = cleanFilePart(title).replace(/^[.\s]+|[.\s]+$/g, '') || cleanFilePart(`${post ? 'Video' : 'MV'} ${id || ''}`.trim()) || 'MV';
  const cleanSpec = cleanFilePart(spec).replace(/^[.\s]+|[.\s]+$/g, '');
  const suffix = cleanSpec ? ` [${cleanSpec}]` : '';
  // 为 .mp4（4 字节）与可能的全角 ～ / _ 前缀留出字节余量，保证总文件名 <= 255 UTF-8 字节
  const stemMaxBytes = Math.max(16, maxBytes - 4);
  const stemMaxChars = Math.max(16, maxChars - 4);
  const compose = (a, t) => `${a ? `${a} - ` : ''}${t}${suffix}`;
  const fits = (s) => UTF8_ENCODER.encode(s).length <= stemMaxBytes && [...s].length <= stemMaxChars;

  let aChars = [...cleanArtist], tChars = [...cleanTitle];
  while (!fits(compose(aChars.join(''), tChars.join('')))) {
    if (tChars.length > 1 && (tChars.length >= aChars.length || aChars.length <= 1)) {
      tChars.pop();
    } else if (aChars.length > 0) {
      aChars.pop();
    } else {
      break;
    }
  }
  const stem = compose(aChars.join('').replace(/[.\s]+$/g, ''), tChars.join('').replace(/[.\s]+$/g, ''));
  return `${sanitizeFileName(stem, stemMaxBytes, stemMaxChars)}.mp4`;
}
