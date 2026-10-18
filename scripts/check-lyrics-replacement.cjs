// 真实样本回归：直接从 cloud-service.mjs 抽出 collapseCjkSpaces + buildBilingualLrc 的行为验证
const fs = require('fs');

const src = fs.readFileSync('cloud-service.mjs', 'utf8').replace(/\r\n/g, '\n');

// 抽取 collapseCjkSpaces
const cjkSrc = src.match(/const CJK_RE = [\s\S]*?\n}\n/)[0];
const collapseCjkSpaces = new Function(`${cjkSrc}\nreturn collapseCjkSpaces;`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        期望: ${want}\n        实际: ${got}`); }
};

console.log('=== collapseCjkSpaces ===');
eq('中文词间空格', collapseCjkSpaces('徘徊过 多少 橱窗 住 过 多少 旅 馆'), '徘徊过多少橱窗住过多少旅馆');
eq('中文无空格', collapseCjkSpaces('忘掉种过的花'), '忘掉种过的花');
eq('全角标点旁空格', collapseCjkSpaces('你好 ， 世界'), '你好，世界');
eq('英文保留空格', collapseCjkSpaces('I love you so much'), 'I love you so much');
eq('中英混排保留', collapseCjkSpaces('我 love 你'), '我 love 你');
eq('连续空格折叠', collapseCjkSpaces('徘徊过   多少'), '徘徊过多少');
eq('首尾空白', collapseCjkSpaces('  你好 世界  '), '你好世界');
eq('空串', collapseCjkSpaces(''), '');
eq('日语假名', collapseCjkSpaces('君 の 名前'), '君の名前');

console.log();
console.log('=== 语言门槛 ===');
const gateSrc = src.match(/const rootLang = [\s\S]*?if \(rootLang\.startsWith\('zh'\)[^\n]*\n/)[0];
// 行为表：逻辑直接从 cloud-service.mjs 源码抽取执行，杜绝测试与实现漂移
const gateBody = src.match(/  const rootLang = [\s\S]*?if \(rootLang\.startsWith\('zh'\) && !target\.startsWith\('zh'\)\) return null;\n/)[0];
const gate = new Function('ttmlContent', 'targetLang', `
  ${gateBody}
  return true;
`);
const gateOf = (root, tgt) => gate(`<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="${root}">`, tgt);
console.log('  抽取自源码，共', gateBody.trim().split('\n').length, '行');
// gate 返回 true = 处理翻译，null = 跳过（源码里 return null 表示降级单语）
const cases = [
  ['zh-Hant', 'zh-Hans-CN', true,  '粤语歌 → 简体（本次修复的场景）'],
  ['zh-Hant', 'zh-Hant',    false, '原文即目标，跳过'],
  ['zh-Hans', 'zh-Hans-CN', false, '简体歌 → 简体，跳过'],
  ['en',      'zh-Hans-CN', true,  '英文歌 → 中文'],
  ['ja',      'zh-Hans-CN', true,  '日文歌 → 中文'],
  ['zh-Hans', 'en',         false, '中文歌不翻成英文'],
];
for (const [root, tgt, want, desc] of cases) {
  eq(`${desc} (${root} → ${tgt})`, gateOf(root, tgt) !== null, want);
}

console.log();
console.log(`结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
