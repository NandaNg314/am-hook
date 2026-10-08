/**
 * test-auth.js
 * 
 * 验证 timingSafeEqual 密码比对与 IP 防暴力破解逻辑
 */

const assert = require('node:assert/strict');
const {
  verifyPassword,
  checkIpLockStatus,
  recordFailedAttempt,
  resetIpAttempts,
  generateSessionToken,
  verifySessionToken,
  handleAuthLogin,
  DEFAULT_PASSWORD,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS
} = require('./middleware/auth.js');

async function runTests() {
  console.log('=== 开始测试 Apple Music 鉴权系统 (middleware/auth.js) ===\n');

  // 1. 验证密码校验与 timingSafeEqual 逻辑
  console.log('1. 验证 timingSafeEqual 与 SHA-256 密码比对...');
  assert.equal(verifyPassword(DEFAULT_PASSWORD), true, '默认密码 admin123 应该校验通过');
  assert.equal(verifyPassword('wrongpassword'), false, '错误密码应该返回 false');
  assert.equal(verifyPassword(''), false, '空字符串密码应该返回 false');
  assert.equal(verifyPassword(null), false, '非字符串参数应该返回 false');

  // 环境变量覆盖测试
  process.env.AUTH_PASSWORD = 'custom_secret_pass_2026';
  assert.equal(verifyPassword('custom_secret_pass_2026'), true, '环境变量 AUTH_PASSWORD 动态覆盖有效');
  assert.equal(verifyPassword(DEFAULT_PASSWORD), false, '覆盖后原默认密码失效');
  delete process.env.AUTH_PASSWORD;
  assert.equal(verifyPassword(DEFAULT_PASSWORD), true, '恢复后默认密码重新生效');
  console.log('✔ 密码比对逻辑通过测试\n');

  // 2. 验证暴力破解防御机制 (连续 5 次输错锁定 15 分钟)
  console.log('2. 验证防暴力破解机制 (同一 IP 限制 5 次，锁定 15 分钟)...');
  const testIp = '192.168.1.100';
  resetIpAttempts(testIp);

  let initialStatus = checkIpLockStatus(testIp);
  assert.equal(initialStatus.isLocked, false);
  assert.equal(initialStatus.attempts, 0);

  // 连续输错 1 ~ 4 次
  for (let i = 1; i <= 4; i++) {
    const res = recordFailedAttempt(testIp);
    assert.equal(res.isLocked, false, `输错 ${i} 次时不应该锁定`);
    assert.equal(res.attempts, i, `尝试计数应为 ${i}`);
  }

  // 第 5 次输错：触发强制锁定 15 分钟
  const lockRes = recordFailedAttempt(testIp);
  assert.equal(lockRes.isLocked, true, '输错第 5 次时必须锁定');
  assert.equal(lockRes.attempts, 5);
  assert.ok(lockRes.remainingSeconds > 0 && lockRes.remainingSeconds <= 15 * 60, '剩余锁定时间应在 15 分钟内');

  // 第 6 次检查：已被锁定
  const checkAgain = checkIpLockStatus(testIp);
  assert.equal(checkAgain.isLocked, true, '被锁定 IP 再次检查依然锁定');

  // 测试成功登录重置计数
  resetIpAttempts(testIp);
  const resetStatus = checkIpLockStatus(testIp);
  assert.equal(resetStatus.isLocked, false, '重置后状态应该恢复正常');
  assert.equal(resetStatus.attempts, 0);
  console.log('✔ 防暴力破解逻辑通过测试\n');

  // 3. 验证 HMAC-SHA256 Session Token 签发与时序安全校验
  console.log('3. 验证基于 HMAC-SHA256 的 Session Token 签发与校验...');
  const token = generateSessionToken({ uid: 'tester-1' });
  assert.ok(typeof token === 'string' && token.includes('.'), '签发 Token 应包含 payload 与 HMAC 签名两部分');

  const payload = verifySessionToken(token);
  assert.ok(payload !== null, '合法 Token 应能成功通过校验');
  assert.equal(payload.uid, 'tester-1');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'Token 有效期必须在未来');

  // 篡改签名或 Payload 测试
  const [pB64, sig] = token.split('.');
  const tamperedSig = sig.slice(0, -2) + 'aa';
  assert.equal(verifySessionToken(`${pB64}.${tamperedSig}`), null, '篡改签名的 Token 校验必须失败');

  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, uid: 'hacker' })).toString('base64url');
  assert.equal(verifySessionToken(`${tamperedPayload}.${sig}`), null, '篡改 Payload 的 Token 校验必须失败');
  console.log('✔ Session Token 签发与校验通过测试\n');

  // 4. 模拟测试 handleAuthLogin HTTP 接口响应 (401, 429, 200)
  console.log('4. 模拟测试 POST /api/auth 接口处理...');
  const ipSim = '10.0.0.88';
  resetIpAttempts(ipSim);

  // 辅助 Mock Response 对象
  function createMockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(data) {
        this.body = data;
      }
    };
  }

  // 输错密码 -> 401
  const mockReqWrong = { socket: { remoteAddress: ipSim }, headers: {} };
  const mockResWrong = createMockRes();
  await handleAuthLogin(mockReqWrong, mockResWrong, { password: 'bad' });
  assert.equal(mockResWrong.statusCode, 401, '密码错误应返回 HTTP 401');

  // 再错 4 次 -> 触发第 5 次输错锁定
  for (let i = 0; i < 3; i++) {
    const res = createMockRes();
    await handleAuthLogin(mockReqWrong, res, { password: 'bad' });
    assert.equal(res.statusCode, 401);
  }
  const mockResLock = createMockRes();
  await handleAuthLogin(mockReqWrong, mockResLock, { password: 'bad' });
  assert.equal(mockResLock.statusCode, 429, '输错 5 次必须返回 HTTP 429');

  // 已锁定状态下继续请求 -> 直接 429
  const mockResLockedCheck = createMockRes();
  await handleAuthLogin(mockReqWrong, mockResLockedCheck, { password: DEFAULT_PASSWORD });
  assert.equal(mockResLockedCheck.statusCode, 429, '被锁定时即便密码正确也必须返回 HTTP 429');

  // 重置解封后，输入正确密码 -> 200 并返回 Token
  resetIpAttempts(ipSim);
  const mockResSuccess = createMockRes();
  await handleAuthLogin(mockReqWrong, mockResSuccess, { password: DEFAULT_PASSWORD });
  assert.equal(mockResSuccess.statusCode, 200, '密码正确应返回 HTTP 200');
  const resJson = JSON.parse(mockResSuccess.body);
  assert.equal(resJson.ok, true);
  assert.ok(resJson.token, '返回体内必须包含 Token');
  assert.ok(mockResSuccess.headers['Set-Cookie'].includes('auth_token='), '响应头中必须包含 Set-Cookie');

  console.log('✔ handleAuthLogin HTTP 接口模拟测试通过\n');

  console.log('🎉 所有鉴权测试全部通过！');
}

runTests().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
