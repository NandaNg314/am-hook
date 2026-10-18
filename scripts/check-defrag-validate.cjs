/**
 * validateDefragged 回归测试
 *
 * 验证：
 *  - 正常解碎片产物 → 通过
 *  - 未解碎片（含 moof）→ 拦住
 *  - stbl 子盒被破坏（模拟 stripBitrateBox 早期把 stts size 清零的 bug）→ 拦住
 *
 * 用法：node scripts/check-defrag-validate.cjs [样本路径...]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'cloud-service.mjs'), 'utf8');

function grabFn(name) {
  const i = src.indexOf('function ' + name);
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

const code = grabFn('validateDefragged');
if (!code) {
  console.error('✗ 未能在 cloud-service.mjs 中找到 validateDefragged');
  process.exit(1);
}

const mod = { exports: {} };
new Function('module', 'exports', 'Buffer', code + '\nmodule.exports = { validateDefragged };')(mod, mod.exports, Buffer);
const { validateDefragged } = mod.exports;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// 收集候选样本：优先命令行参数，否则扫 sample/
let samples = process.argv.slice(2);
if (!samples.length) {
  const dir = path.join(ROOT, 'sample');
  if (fs.existsSync(dir)) {
    samples = fs.readdirSync(dir)
      .filter(f => f.endsWith('.m4a'))
      .map(f => path.join(dir, f));
  }
}

console.log('=== validateDefragged 回归测试 ===\n');

if (!samples.length) {
  console.log('  未找到样本，跳过文件用例（仅跑合成用例）\n');
}

for (const file of samples) {
  if (!fs.existsSync(file)) continue;
  const buf = fs.readFileSync(file);
  const name = path.basename(file);
  const hasMoof = buf.indexOf(Buffer.from('moof', 'latin1')) >= 0;
  // 已知坏样本：文件名含 "tgbot new" 是修复前的坏产物（stbl 子盒缺失）
  const knownBad = /\(tgbot new\)/i.test(name);
  const result = validateDefragged(buf);

  console.log(`${name}  (${buf.length} B, moof=${hasMoof}${knownBad ? ', 已知坏样本' : ''})`);
  if (hasMoof) {
    check('分片文件应被拒绝', result !== null, `实际返回 ${result}`);
  } else if (knownBad) {
    check('已知坏样本应被拒绝', result !== null, `实际返回 ${result}`);
  } else {
    check('干净文件应通过', result === null, `实际返回 ${result}`);
  }
  console.log('');
}

// ---- 合成用例：手工构造最小 moov ----
function box(kind, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(kind, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}

function makeMinimal(stblOverrides = {}) {
  const versionFlags = Buffer.alloc(4);
  const stsd = box('stsd', Buffer.concat([versionFlags, Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)]));
  const stts = stblOverrides.dropStts ? Buffer.alloc(0) : box('stts', Buffer.concat([versionFlags, Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)]));
  const stsc = box('stsc', Buffer.concat([versionFlags, Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)]));
  const sampleCount = stblOverrides.zeroSamples ? 0 : 100;
  const stszPayload = Buffer.alloc(8);
  stszPayload.writeUInt32BE(0, 0);      // sample_size
  stszPayload.writeUInt32BE(sampleCount, 4); // sample_count
  const stsz = box('stsz', Buffer.concat([versionFlags, stszPayload]));
  const stco = box('stco', Buffer.concat([versionFlags, Buffer.from([0, 0, 0, 1]), Buffer.alloc(4)]));

  const stbl = box('stbl', Buffer.concat([stsd, stts, stsc, stsz, stco]));
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', mdia);
  const moov = box('moov', trak);
  const mdat = box('mdat', Buffer.alloc(16));
  return Buffer.concat([moov, mdat]);
}

console.log('--- 合成用例 ---');

check('完整最小文件应通过', validateDefragged(makeMinimal()) === null, String(validateDefragged(makeMinimal())));

{
  const b = makeMinimal({ dropStts: true });
  const r = validateDefragged(b);
  check('缺少 stts 应被拒绝', r !== null && r.includes('stts'), String(r));
}

{
  const b = makeMinimal({ zeroSamples: true });
  const r = validateDefragged(b);
  check('sample_count=0 应被拒绝', r !== null && r.includes('sample_count'), String(r));
}

{
  const b = Buffer.concat([makeMinimal(), box('moof', Buffer.alloc(16))]);
  const r = validateDefragged(b);
  check('残留 moof 应被拒绝', r !== null && r.includes('moof'), String(r));
}

{
  const b = box('mdat', Buffer.alloc(16));
  const r = validateDefragged(b);
  check('缺少 moov 应被拒绝', r !== null && r.includes('moov'), String(r));
}

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
