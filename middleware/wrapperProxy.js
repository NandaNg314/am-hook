/**
 * middleware/wrapperProxy.js
 * 
 * 桥接 wrapper-lite 密钥服务与 am-hook 前端：
 * - /status: wrapper 状态与地区
 * - /parse/song/:id: 解析 master m3u8 与轨道变体
 * - /key: 提取解密模板下发给浏览器 WASM
 * - /lyrics/:id: 获取 TTML 歌词
 */

const WRAPPER_URL = process.env.WRAPPER_URL || 'http://127.0.0.1:12340';

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,\r\n]+)/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    let val = match[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    attrs[match[1]] = val;
  }
  return attrs;
}

function parseMasterVariants(content) {
  const audioGroups = new Map();
  let currentStream = null;
  const variants = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO' && attrs['GROUP-ID']) {
        audioGroups.set(attrs['GROUP-ID'], {
          name: attrs.NAME || '',
          channels: attrs.CHANNELS || null,
          sample_rate: attrs['SAMPLE-RATE'] ? parseInt(attrs['SAMPLE-RATE'], 10) : null,
          bit_depth: attrs['BIT-DEPTH'] ? parseInt(attrs['BIT-DEPTH'], 10) : null,
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      currentStream = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line && !line.startsWith('#') && line.endsWith('.m3u8')) {
      const attrs = currentStream || {};
      currentStream = null;
      const groupId = attrs.AUDIO || '';
      const group = audioGroups.get(groupId) || {};
      const stem = line.endsWith('.m3u8') ? line.slice(0, -5) : line;
      variants.push({
        uri: line,
        file_uri: `${stem}_m.mp4`,
        audio: group.name || '',
        channels: group.channels || null,
        sample_rate: group.sample_rate || null,
        bit_depth: group.bit_depth || null,
        group_id: groupId,
        codecs: attrs.CODECS || null,
        bandwidth: attrs['AVERAGE-BANDWIDTH'] ? parseInt(attrs['AVERAGE-BANDWIDTH'], 10) : (attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : null)
      });
    }
  }
  return variants;
}

async function handleStatus(req, res) {
  try {
    const fetchRes = await fetch(`${WRAPPER_URL}/status`);
    const json = await fetchRes.json();
    if (json.code === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        msg: json.msg || 'SUCCESS',
        regions: json.data?.regions || [],
        wrapperUrl: WRAPPER_URL,
        hook: false
      }));
    }
  } catch (err) {}

  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    code: 1,
    msg: 'wrapper-lite unavailable',
    regions: [],
    wrapperUrl: WRAPPER_URL,
    hook: false
  }));
}

async function handleKey(req, res, parsedUrl) {
  const adamId = parsedUrl.searchParams.get('adamId');
  const uri = parsedUrl.searchParams.get('uri');

  if (!adamId || !uri) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing adamId or uri' }));
  }

  try {
    const keyUrl = `${WRAPPER_URL}/key?adamId=${encodeURIComponent(adamId)}&uri=${encodeURIComponent(uri)}`;
    const fetchRes = await fetch(keyUrl);
    const json = await fetchRes.json();

    if (json.code === 0 && json.data) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=3600'
      });
      return res.end(JSON.stringify(json.data));
    }
    res.writeHead(fetchRes.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: json.msg || 'Failed to fetch key from wrapper-lite' }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleParseSong(req, res, adamId) {
  const cleanId = String(adamId).replace(/[^0-9]/g, '');
  if (!cleanId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid adamId' }));
  }

  try {
    const m3u8Res = await fetch(`${WRAPPER_URL}/m3u8?adamId=${cleanId}`);
    const m3u8Json = await m3u8Res.json();

    if (m3u8Json.code !== 0 || !m3u8Json.data?.m3u8) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: m3u8Json.msg || 'Failed to get m3u8 from wrapper-lite' }));
    }

    const masterUrl = m3u8Json.data.m3u8;
    const appleRes = await fetch(masterUrl);
    if (!appleRes.ok) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to fetch master m3u8 from Apple CDN' }));
    }

    const masterBody = await appleRes.text();
    const variants = parseMasterVariants(masterBody);

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=3600'
    });
    res.end(JSON.stringify({
      adamId: cleanId,
      masterUrl,
      variants,
      hook: false
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleLyricsTtml(req, res, adamId, language) {
  const cleanId = String(adamId).replace(/[^0-9]/g, '');
  if (!cleanId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid adamId' }));
  }

  try {
    const fetchRes = await fetch(`${WRAPPER_URL}/lyrics?adamId=${cleanId}&language=${encodeURIComponent(language || '')}`);
    if (fetchRes.status === 200) {
      const xml = await fetchRes.text();
      res.writeHead(200, {
        'Content-Type': 'application/ttml+xml; charset=utf-8',
        'Cache-Control': 'private, max-age=3600'
      });
      return res.end(xml);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 1, msg: 'lyrics not found' }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = {
  handleStatus,
  handleKey,
  handleParseSong,
  handleLyricsTtml,
  parseMasterVariants
};
