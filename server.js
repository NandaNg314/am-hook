/**
 * server.js
 * 
 * am-hook 高安全性定制版 Web 主服务
 * - Apple Music 原生深色毛玻璃风格密码鉴权系统 (middleware/auth.js)
 * - 纯 Gofile 压缩转存与自动清理 (utils/gofileUploader.js)
 * - 原版元数据与纯净歌词抓取 (utils/metadataAndLyrics.js)
 * - 静态资源分发与单页应用 (SPA) 路由代理
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const {
  authMiddleware,
  handleAuthLogin,
  verifySessionToken,
  extractTokenFromRequest,
  isStaticAsset,
  resetIpAttempts
} = require('./middleware/auth.js');

const {
  processGofileDelivery,
  sanitizeFilename,
  formatSongFilename,
  formatLyricsFilename,
  formatZipFilename
} = require('./utils/gofileUploader.js');

const {
  fetchSongMetadata,
  fetchSongLyrics,
  detectLanguage,
  ttmlToLrc
} = require('./utils/metadataAndLyrics.js');

const {
  handleStatus,
  handleKey,
  handleParseSong,
  handleLyricsTtml
} = require('./middleware/wrapperProxy.js');

// 自动加载根目录下 .env 环境变量
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
} catch (e) {}

const PORT = parseInt(process.env.PORT || '8888', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UI_DIR = path.join(__dirname, 'src', 'ui');

// MIME 类型字典
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * 辅助函数：读取完整请求体 Buffer
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 原生简易 Multipart/form-data 解析器
 */
function parseMultipartFormData(bodyBuffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let start = 0;

  while (true) {
    const boundaryIndex = bodyBuffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    const nextStart = boundaryIndex + boundaryBuffer.length;
    // 检查是否结束 (--)
    if (bodyBuffer.slice(nextStart, nextStart + 2).toString() === '--') {
      break;
    }

    // 寻找 CRLF
    const crlfIndex = bodyBuffer.indexOf(Buffer.from('\r\n\r\n'), nextStart);
    if (crlfIndex === -1) break;

    const headersText = bodyBuffer.slice(nextStart + 2, crlfIndex).toString('utf8');
    const partDataStart = crlfIndex + 4;

    const nextBoundaryIndex = bodyBuffer.indexOf(boundaryBuffer, partDataStart);
    if (nextBoundaryIndex === -1) break;

    const partData = bodyBuffer.slice(partDataStart, nextBoundaryIndex - 2); // 去除末尾 \r\n

    // 解析 headersText 中的 name 和 filename
    const nameMatch = headersText.match(/name=["']([^"']+)["']/i);
    const filenameMatch = headersText.match(/filename=["']([^"']+)["']/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      data: partData,
      headers: headersText
    });

    start = nextBoundaryIndex;
  }

  return parts;
}

/**
 * 静态文件分发处理
 */
async function serveStaticFile(reqPath, res) {
  let relativePath = reqPath;
  if (relativePath.startsWith('/assets/')) {
    relativePath = relativePath.slice('/assets/'.length);
  } else if (relativePath.startsWith('/')) {
    relativePath = relativePath.slice(1);
  }

  const filePath = path.join(UI_DIR, relativePath);
  // 防止路径穿越
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    return res.end('403 Forbidden');
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = await fs.promises.readFile(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(content);
  } catch (err) {
    res.writeHead(404);
    res.end('404 Not Found');
  }
}

/**
 * 渲染 SPA 主页 (src/ui/app.html)
 */
async function serveAppHtml(res, statusCode = 200) {
  try {
    const htmlPath = path.join(UI_DIR, 'app.html');
    const html = await fs.promises.readFile(htmlPath, 'utf8');
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error: Failed to read app.html');
  }
}

/**
 * 主请求处理器
 */
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // 1. 静态资源免鉴权直接返回
  if (isStaticAsset(pathname)) {
    return serveStaticFile(pathname, res);
  }

  // 2. 身份认证接口：POST /api/auth
  if (pathname === '/api/auth' && method === 'POST') {
    const bodyBuf = await readRequestBody(req);
    let jsonBody = {};
    try {
      jsonBody = JSON.parse(bodyBuf.toString('utf8'));
    } catch {}
    return handleAuthLogin(req, res, jsonBody);
  }

  // 检查认证状态：GET /api/auth/status
  if (pathname === '/api/auth/status' && method === 'GET') {
    const token = extractTokenFromRequest(req);
    const session = verifySessionToken(token);
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, authenticated: true, user: session }));
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, authenticated: false }));
  }

  // 退出登录：POST /api/auth/logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; Max-Age=0; SameSite=Lax'
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 3. 执行全局鉴权检查
  const token = extractTokenFromRequest(req);
  const session = verifySessionToken(token);

  if (!session) {
    // 未通过鉴权：除静态资源与 /api/auth 外，拦截所有接口与页面渲染，未鉴权统一返回 HTTP 401
    const isApiRequest = pathname.startsWith('/api/') || pathname.startsWith('/amp/') || req.headers.accept?.includes('application/json');
    if (isApiRequest) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Unauthorized',
        message: '请先登录以访问 Apple Music 服务'
      }));
    } else {
      // 页面渲染请求返回 HTTP 401 并渲染包含登录弹窗的 HTML
      return serveAppHtml(res, 401);
    }
  }

  req.auth = session;

  // 4. Wrapper-Lite 代理路由 (/status, /key, /parse/song/:id, /lyrics/:id)
  if (pathname === '/status' && method === 'GET') {
    return handleStatus(req, res);
  }

  if (pathname === '/key' && method === 'GET') {
    return handleKey(req, res, parsedUrl);
  }

  if (pathname.startsWith('/parse/song/') && method === 'GET') {
    const adamId = pathname.slice('/parse/song/'.length);
    return handleParseSong(req, res, adamId);
  }

  if (pathname.startsWith('/lyrics/') && method === 'GET') {
    const adamId = pathname.slice('/lyrics/'.length);
    const lang = parsedUrl.searchParams.get('language') || '';
    return handleLyricsTtml(req, res, adamId, lang);
  }

  // 5. Gofile 转存接口：POST /api/gofile/upload
  if (pathname === '/api/gofile/upload' && method === 'POST') {
    try {
      const contentType = req.headers['content-type'] || '';
      const bodyBuf = await readRequestBody(req);
      const filesToDeliver = [];
      let customZipName = 'am-hook-download.zip';

      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
        if (!boundaryMatch) throw new Error('Missing boundary in multipart request');
        const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '');
        const parts = parseMultipartFormData(bodyBuf, boundary);

        for (const p of parts) {
          if (p.name === 'zipName') {
            customZipName = p.data.toString('utf8').trim();
          } else if (p.filename) {
            filesToDeliver.push({
              filename: p.filename,
              content: p.data
            });
          }
        }
      } else if (contentType.includes('application/json')) {
        const json = JSON.parse(bodyBuf.toString('utf8'));
        if (json.zipName) customZipName = json.zipName;
        if (Array.isArray(json.files)) {
          for (const f of json.files) {
            filesToDeliver.push({
              filename: f.filename,
              content: Buffer.from(f.content, f.encoding || 'utf8')
            });
          }
        }
      }

      if (filesToDeliver.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No files provided for Gofile delivery' }));
      }

      // 调用 Gofile 交付流程 (并在 finally 中全自动清理临时工作目录与 .zip)
      const delivery = await processGofileDelivery({
        files: filesToDeliver,
        zipFilename: customZipName
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        downloadPage: delivery.downloadPage,
        zipFilename: delivery.zipFilename,
        fileId: delivery.fileId
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Gofile delivery failed',
        message: err.message
      }));
    }
  }

  // 5. 元数据抓取接口：GET /api/metadata
  if (pathname === '/api/metadata' && method === 'GET') {
    const trackId = parsedUrl.searchParams.get('trackId') || parsedUrl.searchParams.get('id');
    const storefront = parsedUrl.searchParams.get('storefront') || 'us';
    const titleHint = parsedUrl.searchParams.get('titleHint') || '';

    if (!trackId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing trackId query param' }));
    }

    try {
      const meta = await fetchSongMetadata(trackId, { storefront, titleHint });
      if (!meta) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Song not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, metadata: meta }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to fetch metadata', message: err.message }));
    }
  }

  // 6. 歌词抓取接口：GET /api/lyrics
  if (pathname === '/api/lyrics' && method === 'GET') {
    const trackId = parsedUrl.searchParams.get('trackId') || parsedUrl.searchParams.get('id');
    const storefront = parsedUrl.searchParams.get('storefront') || 'us';

    if (!trackId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing trackId query param' }));
    }

    try {
      const lrc = await fetchSongLyrics(trackId, { storefront });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, lrc }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, lrc: null }));
    }
  }

  // 7. 单页应用 (SPA) 路由 fallback：所有站内页面地址（如 /、/new、/https://music.apple.com/...）返回 app.html
  return serveAppHtml(res, 200);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`=======================================================`);
    console.log(`🎵 am-hook Apple Music 定制服务已启动`);
    console.log(`🌐 访问地址: http://127.0.0.1:${PORT}`);
    console.log(`🔒 鉴权密码: ${process.env.AUTH_PASSWORD || 'admin123'}`);
    console.log(`📦 Gofile 交付模式: 已就绪 (VPS 0 磁盘占用保证)`);
    console.log(`=======================================================`);
  });
}

module.exports = {
  server,
  parseMultipartFormData,
  serveAppHtml,
  serveStaticFile
};
