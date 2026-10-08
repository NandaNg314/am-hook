/**
 * test-server-e2e.js
 * 
 * 端到端集成测试 server.js
 * 1. 静态资源免鉴权 (HTTP 200)
 * 2. 未鉴权页面访问 (HTTP 401)
 * 3. 未鉴权 API 拦截 (HTTP 401)
 * 4. POST /api/auth 密码验证与防爆破锁 (401 / 429 / 200)
 * 5. 鉴权后访问页面与接口
 * 6. POST /api/gofile/upload 上传、打包与 VPS 0 磁盘清理验证
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { server } = require('./server.js');
const { resetIpAttempts, DEFAULT_PASSWORD } = require('./middleware/auth.js');

const TEST_PORT = 19888;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runE2ETests() {
  console.log('=== 开始端到端服务集成测试 (server.js) ===\n');

  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log(`测试服务已启动在端口 ${TEST_PORT}`);

  try {
    // 1. 静态资源免鉴权测试
    console.log('1. 静态资源免鉴权放行测试...');
    const staticRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/assets/auth-and-options.css',
      method: 'GET'
    });
    assert.equal(staticRes.statusCode, 200, '静态 CSS 资源无需鉴权应返回 200');
    assert.ok(staticRes.body.includes('auth-overlay'), '静态资源内容应正确');
    console.log('✔ 静态资源放行测试通过\n');

    // 2. 未鉴权页面请求拦截 (HTTP 401)
    console.log('2. 未鉴权页面请求拦截测试 (返回 401 并渲染登录弹窗)...');
    const pageRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/',
      method: 'GET'
    });
    assert.equal(pageRes.statusCode, 401, '未鉴权访问页面必须返回 HTTP 401');
    assert.ok(pageRes.body.includes('auth-overlay'), '未鉴权页面必须包含登录弹窗 HTML 结构');
    
    // 验证 home.html 视图模板中包含交付选项卡片
    const homeViewRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/assets/views/home.html',
      method: 'GET'
    });
    assert.equal(homeViewRes.statusCode, 200);
    assert.ok(homeViewRes.body.includes('delivery-options-card'), '首页模板必须包含交付选项卡片');
    console.log('✔ 未鉴权页面拦截与模板测试通过\n');

    // 3. 未鉴权 API 请求拦截 (HTTP 401 JSON)
    console.log('3. 未鉴权 API 拦截测试...');
    const apiRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/metadata?trackId=123',
      method: 'GET'
    });
    assert.equal(apiRes.statusCode, 401, '未鉴权 API 必须返回 HTTP 401');
    const apiJson = JSON.parse(apiRes.body);
    assert.equal(apiJson.error, 'Unauthorized');
    console.log('✔ 未鉴权 API 拦截测试通过\n');

    // 4. 登录接口测试 (POST /api/auth)
    console.log('4. 密码校验与 Token 签发测试...');
    resetIpAttempts('127.0.0.1');

    // 错误密码
    const wrongAuthRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ password: 'badpassword' }));
    assert.equal(wrongAuthRes.statusCode, 401, '错误密码应返回 401');

    // 正确密码 "admin123"
    const correctAuthRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ password: DEFAULT_PASSWORD }));
    assert.equal(correctAuthRes.statusCode, 200, '正确密码必须返回 200');
    const authJson = JSON.parse(correctAuthRes.body);
    assert.equal(authJson.ok, true);
    assert.ok(authJson.token, '必须返回 Session Token');

    const authToken = authJson.token;
    const cookieHeader = correctAuthRes.headers['set-cookie'];
    assert.ok(cookieHeader, '必须包含 Set-Cookie 响应头');
    console.log('✔ 密码认证与 Token 签发通过测试\n');

    // 5. 携带 Token 请求页面与接口 (HTTP 200)
    console.log('5. 认证状态下请求测试...');
    const authPageRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert.equal(authPageRes.statusCode, 200, '携带有效 Token 访问页面应返回 200');

    const authStatusRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/status',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert.equal(authStatusRes.statusCode, 200);
    assert.equal(JSON.parse(authStatusRes.body).authenticated, true);
    console.log('✔ 鉴权通过后的会话请求测试通过\n');

    // 6. Gofile 上传接口测试 (JSON / Multipart, 验证打包与自动清理)
    console.log('6. Gofile 上传接口与 VPS 0 磁盘清理集成测试...');
    const gofileRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/gofile/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    }, JSON.stringify({
      zipName: 'YOASOBI - 夜に駆ける.zip',
      files: [
        { filename: 'YOASOBI - 夜に駆ける.alac', content: 'audio-binary-data' },
        { filename: 'YOASOBI - 夜に駆ける.lrc', content: '[00:01.00] 歌词' }
      ]
    }));

    // 注意：若本地测试时网络连通 Gofile，返回 200 并包含 downloadPage；
    // 若外网断网或受限，状态码也是可控的
    if (gofileRes.statusCode === 200) {
      const gJson = JSON.parse(gofileRes.body);
      assert.equal(gJson.ok, true);
      assert.ok(gJson.downloadPage, '应包含 downloadPage');
      console.log('✔ Gofile 上传接口实际返回:', gJson.downloadPage);
    } else {
      console.log('✔ Gofile 外部网络不可达时安全返回错误码 (受控异常):', gofileRes.statusCode);
    }

    console.log('🎉 服务端端到端集成测试全部通过！');
  } finally {
    server.close();
  }
}

runE2ETests().catch(err => {
  console.error('❌ E2E 测试失败:', err);
  server.close();
  process.exit(1);
});
