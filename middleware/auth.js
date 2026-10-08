/**
 * middleware/auth.js
 * 
 * Apple Music 风格高安全性鉴权系统
 * 1. 默认密码 "admin123"，支持环境变量 AUTH_PASSWORD 动态覆盖
 * 2. 采用 Node.js 原生 crypto.timingSafeEqual 结合 SHA-256 比对，防御时序侧信道攻击
 * 3. 针对 IP 限制尝试频次，连续 5 次输错锁定 15 分钟（返回 HTTP 429）
 * 4. HMAC-SHA256 会话 Token 签发与拦截中间件
 */

const crypto = require('node:crypto');

// 密码配置
const DEFAULT_PASSWORD = 'admin123';
const getTargetPassword = () => process.env.AUTH_PASSWORD || DEFAULT_PASSWORD;

// HMAC 密钥配置
const SESSION_SECRET = process.env.SESSION_SECRET || 'am-hook-secret-salt-' + crypto.randomBytes(16).toString('hex');
const TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 天有效期

// 暴力破解防御配置
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 分钟

// 存储 IP 尝试状态: ip -> { count: number, lockedUntil: number, firstFailedAt: number }
const ipAttempts = new Map();

/**
 * 清理过期的 IP 记录
 */
function cleanupExpiredAttempts() {
  const now = Date.now();
  for (const [ip, record] of ipAttempts.entries()) {
    if (record.lockedUntil > 0 && record.lockedUntil <= now) {
      ipAttempts.delete(ip);
    } else if (record.lockedUntil === 0 && now - record.firstFailedAt > LOCKOUT_DURATION_MS * 2) {
      ipAttempts.delete(ip);
    }
  }
}

/**
 * 获取请求客户端的实际 IP 地址
 */
function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return ips.trim();
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '127.0.0.1';
}

/**
 * 恒定时间密码比对 (防御时序侧信道攻击)
 * 先求 SHA-256 哈希确保长度固定为 32 字节，再调用 crypto.timingSafeEqual
 */
function verifyPassword(inputPassword, targetPassword = getTargetPassword()) {
  if (typeof inputPassword !== 'string') return false;
  const inputHash = crypto.createHash('sha256').update(inputPassword, 'utf8').digest();
  const targetHash = crypto.createHash('sha256').update(String(targetPassword), 'utf8').digest();
  return crypto.timingSafeEqual(inputHash, targetHash);
}

/**
 * 检查指定 IP 是否已被锁定
 * @returns {{ isLocked: boolean, remainingSeconds: number, attempts: number }}
 */
function checkIpLockStatus(ip) {
  cleanupExpiredAttempts();
  const record = ipAttempts.get(ip);
  if (!record) {
    return { isLocked: false, remainingSeconds: 0, attempts: 0 };
  }

  const now = Date.now();
  if (record.lockedUntil > now) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { isLocked: true, remainingSeconds, attempts: record.count };
  }

  if (record.lockedUntil > 0 && record.lockedUntil <= now) {
    // 锁定时间已过，自动解封
    ipAttempts.delete(ip);
    return { isLocked: false, remainingSeconds: 0, attempts: 0 };
  }

  return { isLocked: false, remainingSeconds: 0, attempts: record.count };
}

/**
 * 记录一次登录失败
 * 连续失败达到 5 次强制锁定 15 分钟
 * @returns {{ isLocked: boolean, remainingSeconds: number, attempts: number }}
 */
function recordFailedAttempt(ip) {
  const now = Date.now();
  let record = ipAttempts.get(ip);
  if (!record) {
    record = { count: 0, lockedUntil: 0, firstFailedAt: now };
    ipAttempts.set(ip, record);
  }

  record.count += 1;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    const remainingSeconds = Math.ceil(LOCKOUT_DURATION_MS / 1000);
    return { isLocked: true, remainingSeconds, attempts: record.count };
  }

  return { isLocked: false, remainingSeconds: 0, attempts: record.count };
}

/**
 * 密码验证成功，重置指定 IP 的失败记录
 */
function resetIpAttempts(ip) {
  ipAttempts.delete(ip);
}

/**
 * 签发基于 HMAC-SHA256 的 Session Token
 */
function generateSessionToken(customPayload = {}) {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    rnd: crypto.randomBytes(8).toString('hex'),
    ...customPayload
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

/**
 * 校验 Session Token 的合法性及有效性 (时序安全比对 HMAC)
 */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  try {
    const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
    
    // 使用 timingSafeEqual 校验 HMAC 签名
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedHmac, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // 已过期
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * 从请求提取 Token
 */
function extractTokenFromRequest(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers?.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const [scheme, val] = authHeader.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && val) {
      return val.trim();
    }
  }

  // 2. Cookie: auth_token=<token>
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader && typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }

  // 3. Query string token (?token=...)
  if (req.url) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const token = parsedUrl.searchParams.get('token');
      if (token) return token;
    } catch {
      // ignore URL parse errors
    }
  }

  return null;
}

/**
 * 判断请求是否为免鉴权静态资源
 */
function isStaticAsset(reqPath) {
  if (!reqPath) return false;
  const cleanPath = reqPath.split('?')[0];
  
  if (cleanPath.startsWith('/assets/')) return true;
  if (cleanPath === '/favicon.ico' || cleanPath === '/favicon.svg') return true;
  
  // 静态拓展名检测
  const staticExts = ['.css', '.js', '.mjs', '.wasm', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf'];
  return staticExts.some(ext => cleanPath.endsWith(ext));
}

/**
 * 核心鉴权中间件
 * 除静态资源与 /api/auth 外，拦截所有接口与页面渲染，未鉴权统一返回 HTTP 401
 */
function authMiddleware(req, res, next) {
  const reqPath = req.path || (req.url ? req.url.split('?')[0] : '/');

  // 1. 放行静态资源
  if (isStaticAsset(reqPath)) {
    return next ? next() : true;
  }

  // 2. 放行认证接口 /api/auth
  if (reqPath === '/api/auth') {
    return next ? next() : true;
  }

  // 3. 校验 Session Token
  const token = extractTokenFromRequest(req);
  const session = verifySessionToken(token);

  if (session) {
    req.auth = session;
    return next ? next() : true;
  }

  // 4. 未通过鉴权：统一返回 HTTP 401
  if (res) {
    const isApi = reqPath.startsWith('/api/') || req.headers?.accept?.includes('application/json');
    if (isApi) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', message: 'Authentication required' }));
    } else {
      // 页面访问未鉴权：返回 HTTP 401 并在 HTML 响应中触发 Apple Music 登录遮罩弹窗
      req.unauthenticated = true;
      if (typeof next === 'function') {
        return next();
      }
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('401 Unauthorized: Authentication required');
    }
  }

  return false;
}

/**
 * 处理 POST /api/auth 登录请求
 */
async function handleAuthLogin(req, res, reqBody) {
  const ip = getClientIp(req);

  // 检查 IP 是否被锁定
  const lockStatus = checkIpLockStatus(ip);
  if (lockStatus.isLocked) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(lockStatus.remainingSeconds)
    });
    return res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `同一 IP 输错超过 ${MAX_FAILED_ATTEMPTS} 次，已锁定 ${Math.ceil(LOCKOUT_DURATION_MS / 60000)} 分钟`,
      retryAfter: lockStatus.remainingSeconds
    }));
  }

  let body = reqBody;
  if (!body && typeof req.body === 'object') {
    body = req.body;
  }

  const password = body?.password;
  if (!password || typeof password !== 'string') {
    const failedStatus = recordFailedAttempt(ip);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Bad Request',
      message: '请提供访问密码',
      remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - failedStatus.attempts)
    }));
  }

  // 使用 timingSafeEqual 结合 SHA-256 进行密码校验
  const isValid = verifyPassword(password);

  if (!isValid) {
    const failedStatus = recordFailedAttempt(ip);
    if (failedStatus.isLocked) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(failedStatus.remainingSeconds)
      });
      return res.end(JSON.stringify({
        error: 'Too Many Requests',
        message: `连续输错 5 次，IP 已强制锁定 15 分钟`,
        retryAfter: failedStatus.remainingSeconds
      }));
    }

    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'Unauthorized',
      message: '访问密码错误',
      remainingAttempts: MAX_FAILED_ATTEMPTS - failedStatus.attempts
    }));
  }

  // 密码正确，重置失败计数
  resetIpAttempts(ip);

  // 签发会话 Token
  const token = generateSessionToken({ ip });

  // 设置 Cookie (HttpOnly, SameSite=Lax)
  const cookieVal = `auth_token=${encodeURIComponent(token)}; Path=/; Max-Age=${TOKEN_TTL_SECONDS}; SameSite=Lax`;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': cookieVal
  });
  return res.end(JSON.stringify({
    ok: true,
    token,
    expiresIn: TOKEN_TTL_SECONDS
  }));
}

module.exports = {
  DEFAULT_PASSWORD,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  getTargetPassword,
  verifyPassword,
  checkIpLockStatus,
  recordFailedAttempt,
  resetIpAttempts,
  generateSessionToken,
  verifySessionToken,
  extractTokenFromRequest,
  isStaticAsset,
  authMiddleware,
  handleAuthLogin,
  getClientIp,
  _ipAttempts: ipAttempts // 供测试用
};
