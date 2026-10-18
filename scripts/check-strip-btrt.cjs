#!/usr/bin/env node
/**
 * stripBitrateBox 回归校验。
 *
 * 背景：第一版实现把祖先链里被删除的 `btrt` 自身也写回了一次 size（20-20=0），
 * 结果覆盖掉刚搬过来的 `stts` 的 size 字段，`stbl` 样本表整段损坏——
 * 严格解析器直接拒绝，连 MT 管理器都播不了。
 *
 * 用法：node scripts/check-strip-btrt.cjs <带 btrt 的 m4a>
 * 校验点：
 *   1. btrt 归零
 *   2. stbl 五个子盒（stsd/stts/stsc/stsz/stco）齐全且 size 合法
 *   3. stsd=67、ec-3=51、dec3 保留
 *   4. 所有 stco 偏移落在 mdat 负载区间内
 *   5. 幂等
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'cloud-service.mjs'), 'utf8');
const m = src.match(/^function stripBitrateBox\([\s\S]*?^}/m);
if (!m) { console.error('在 cloud-service.mjs 中找不到 stripBitrateBox'); process.exit(1); }
eval(m[0]);

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/check-strip-btrt.cjs <file.m4a>'); process.exit(1); }

const orig = fs.readFileSync(file);
const out = stripBitrateBox(orig);
const text = (b, a, n) => b.toString('latin1', a, a + n);

const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };

check(out.length === orig.length - 20, `长度减 20（${orig.length} -> ${out.length}）`);
check(!out.includes(Buffer.from('btrt', 'latin1')), 'btrt 已移除');

const stblAt = out.indexOf(Buffer.from('stbl', 'latin1')) - 4;
check(stblAt >= 0, 'stbl 存在');
const stblSize = out.readUInt32BE(stblAt);
const kids = {};
let p = stblAt + 8;
while (p + 8 <= stblAt + stblSize) {
  const s = out.readUInt32BE(p);
  const k = text(out, p + 4, 4);
  if (s < 8) { fail.push(`stbl 子盒 ${k} size 非法 (${s})`); break; }
  kids[k] = { p, size: s };
  p += s;
}
for (const k of ['stsd', 'stts', 'stsc', 'stsz', 'stco']) {
  check(Boolean(kids[k]), `stbl 含 ${k}`);
}
check(kids.stsd && kids.stsd.size === 67, `stsd = 67（实际 ${kids.stsd && kids.stsd.size}）`);
const ecAt = out.indexOf(Buffer.from('ec-3', 'latin1')) - 4;
check(ecAt >= 0 && out.readUInt32BE(ecAt) === 51, `ec-3 = 51（实际 ${ecAt >= 0 && out.readUInt32BE(ecAt)}）`);
check(out.includes(Buffer.from('dec3', 'latin1')), 'dec3 保留');

const stco = kids.stco;
if (stco) {
  const n = out.readUInt32BE(stco.p + 12);
  const mdatAt = out.indexOf(Buffer.from('mdat', 'latin1')) - 4;
  const lo = mdatAt + 8;
  const hi = mdatAt + out.readUInt32BE(mdatAt);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const o = out.readUInt32BE(stco.p + 16 + i * 4);
    if (o < lo || o >= hi) bad++;
  }
  check(bad === 0 && n > 0, `stco 的 ${n} 个偏移全部落在 mdat 内（越界 ${bad}）`);
}

check(stripBitrateBox(out).equals(out), '幂等');

if (fail.length) {
  console.error(`\n${fail.length} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
