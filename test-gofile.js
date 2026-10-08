/**
 * test-gofile.js
 * 
 * 验证：
 * 1. 命名规则与非法字符（/ \ : * ? " < > |）剔除
 * 2. 单曲/专辑/歌单最外层单个 .zip 打包（内部平铺）
 * 3. Gofile 上传逻辑
 * 4. 自动清理逻辑：无论成功或异常，finally 确保临时目录与本地 .zip 彻底删除，VPS 磁盘 0 占用
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const {
  sanitizeFilename,
  formatSongFilename,
  formatLyricsFilename,
  formatZipFilename,
  createZipArchive,
  processGofileDelivery
} = require('./utils/gofileUploader.js');

async function runTests() {
  console.log('=== 开始测试 Gofile 转存与打包系统 (utils/gofileUploader.js) ===\n');

  // 1. 验证命名规则与非法字符剔除
  console.log('1. 验证命名规则与非法字符过滤...');
  const dirtyArtist = 'YOASOBI / 幾田<りら>';
  const dirtyTitle = '夜に駆ける: "Special*Edition"?|Test\\';
  const cleanSong = formatSongFilename(dirtyArtist, dirtyTitle, 'alac');
  const cleanLrc = formatLyricsFilename(dirtyArtist, dirtyTitle);

  assert.equal(cleanSong, 'YOASOBI _ 幾田_りら_ - 夜に駆ける_ _Special_Edition_Test_.alac');
  assert.equal(cleanLrc, 'YOASOBI _ 幾田_りら_ - 夜に駆ける_ _Special_Edition_Test_.lrc');
  assert.ok(!/[\\/:*?"<>|]/.test(cleanSong), '文件名不得包含非法字符');
  assert.ok(!/[\\/:*?"<>|]/.test(cleanLrc), '歌词文件名不得包含非法字符');

  // 打包命名验证
  const songZip = formatZipFilename('song', { artist: 'YOASOBI', title: '夜に駆ける' });
  assert.equal(songZip, 'YOASOBI - 夜に駆ける.zip');

  const albumZip = formatZipFilename('album', { albumName: 'THE BOOK / 完全生産限定盤' });
  assert.equal(albumZip, 'THE BOOK _ 完全生産限定盤.zip');

  const playlistZip = formatZipFilename('playlist', { playlistName: 'Top 100: Global' });
  assert.equal(playlistZip, 'Top 100_ Global.zip');
  console.log('✔ 命名规范与非法字符过滤通过测试\n');

  // 2. 验证最外层 zip 打包与解压完整性 (内部直接平铺)
  console.log('2. 验证纯 Node.js ZIP 打包与平铺结构...');
  const testDir = path.join(os.tmpdir(), 'test_zip_temp_' + Date.now());
  const testZipPath = path.join(testDir, 'YOASOBI - 夜に駆ける.zip');

  const sampleFiles = [
    { name: 'YOASOBI - 夜に駆ける.alac', data: Buffer.from('MOCK_ALAC_AUDIO_BINARY_DATA_1234567890') },
    { name: 'YOASOBI - 夜に駆ける.lrc', data: Buffer.from('[00:01.20] 沈むように溶けてゆくように\n[00:04.50] 二人だけの空が広がる夜に') }
  ];

  await createZipArchive(sampleFiles, testZipPath);
  assert.ok(fs.existsSync(testZipPath), '打包后的 .zip 文件必须存在');

  // 读取并解析 ZIP 文件头以验证格式正确性
  const zipBuffer = fs.readFileSync(testZipPath);
  assert.ok(zipBuffer.length > 50, 'ZIP 文件体积必须大于基础文件头大小');
  assert.equal(zipBuffer.readUInt32LE(0), 0x04034b50, 'ZIP 首部必须为 Local File Header 标识');

  // 验证内部平铺文件名 (无任何多余嵌套前缀)
  const zipStr = zipBuffer.toString('utf8');
  assert.ok(zipStr.includes('YOASOBI - 夜に駆ける.alac'), 'ZIP 内必须直接平铺同名 .alac');
  assert.ok(zipStr.includes('YOASOBI - 夜に駆ける.lrc'), 'ZIP 内必须直接平铺同名 .lrc');
  assert.ok(!zipStr.includes('/YOASOBI - 夜に駆ける.alac'), 'ZIP 内不应包含多余子目录层级');

  // 清理测试 zip
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✔ ZIP 打包与平铺结构通过测试\n');

  // 3. 验证 processGofileDelivery 成功生命周期与 finally 自动清理
  console.log('3. 验证 Gofile 转存生命周期与自动清理 (成功场景)...');
  let capturedZipPath = null;
  const mockUploaderSuccess = async (zipPath) => {
    capturedZipPath = zipPath;
    assert.ok(fs.existsSync(zipPath), '上传前 zip 文件必须存在');
    return {
      downloadPage: 'https://gofile.io/d/abc123Test',
      fileId: 'mock-file-id-123'
    };
  };

  const deliveryResult = await processGofileDelivery({
    files: [
      { filename: 'YOASOBI - 夜に駆ける.alac', content: 'audio-data' },
      { filename: 'YOASOBI - 夜に駆ける.lrc', content: '[00:01.00] 歌词' }
    ],
    zipFilename: 'YOASOBI - 夜に駆ける.zip',
    customUploader: mockUploaderSuccess
  });

  assert.equal(deliveryResult.ok, true);
  assert.equal(deliveryResult.downloadPage, 'https://gofile.io/d/abc123Test');
  assert.equal(deliveryResult.zipFilename, 'YOASOBI - 夜に駆ける.zip');

  // 关键验证：finally 执行后本地 .zip 和工作目录必须已经被清理
  assert.ok(capturedZipPath, '捕获到临时 zip 路径');
  assert.equal(fs.existsSync(capturedZipPath), false, '上传完成后本地 .zip 必须已彻底删除');
  console.log('✔ 成功转存且本地临时文件与 zip 已自动清理 (VPS 0 磁盘占用)\n');

  // 4. 验证 processGofileDelivery 异常场景下的 finally 保证清理
  console.log('4. 验证 Gofile 转存失败/异常时的 finally 清理保底机制...');
  let failedZipPath = null;
  const mockUploaderFail = async (zipPath) => {
    failedZipPath = zipPath;
    assert.ok(fs.existsSync(zipPath), '发生异常前 zip 存在');
    throw new Error('模拟 Gofile 网络中断或 500 错误');
  };

  await assert.rejects(
    async () => {
      await processGofileDelivery({
        files: [{ filename: 'test.alac', content: 'data' }],
        zipFilename: 'test.zip',
        customUploader: mockUploaderFail
      });
    },
    /模拟 Gofile 网络中断/
  );

  // 关键验证：即便上传报错抛出异常，finally 依然把本地 zip 和目录彻底删除
  assert.ok(failedZipPath, '捕获到失败任务的 zip 路径');
  assert.equal(fs.existsSync(failedZipPath), false, '发生异常时本地 .zip 也必须彻底删除，零残留');
  console.log('✔ 异常场景下 finally 清理机制验证通过\n');

  console.log('🎉 所有 Gofile 打包与自动清理测试全部通过！');
}

runTests().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
