/**
 * Gofile 交付端到端验证（模拟 tg-bot 的完整逻辑）
 * 1. 逐曲缓存（isLastTrack: false）
 * 2. 全部完成后触发一次打包上传（isLastTrack: true）
 * 3. 取 downloadPage 并发到 TG
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/home/ubuntu/am-hook';
const env = Object.fromEntries(
  fs.readFileSync(path.join(DIR, '.env'), 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = env.BOT_TOKEN;
const API = 'http://127.0.0.1:8081';
const CLOUD = 'http://127.0.0.1:31409/api/cloud-transfer';
const CATALOG = 'http://127.0.0.1:31408/amp/v1/catalog';

const albumId = process.argv[2];
const chatId = process.argv[3];
const storefront = process.argv[4] || 'hk';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const tg = async (method, params = {}) => {
  const r = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  return r.json();
};

log(`获取专辑 ${albumId}`);
const cat = await (await fetch(`${CATALOG}/${storefront}/albums/${albumId}?l=zh-Hans-CN`, { signal: AbortSignal.timeout(20000) })).json();
if (!cat.data?.length) { console.error('专辑获取失败'); process.exit(1); }
const album = cat.data[0];
const tracks = album.relationships.tracks.data.map((t) => ({ id: t.id, name: t.attributes.name }));
log(`专辑: ${album.attributes.artistName} - ${album.attributes.name} (${tracks.length} 首)`);

const batchId = `verify_${Date.now()}`;
const meta = (t, idx) => ({
  title: t.name,
  artist: album.attributes.artistName,
  album: album.attributes.name,
  albumArtist: album.attributes.artistName,
  trackNumber: idx + 1,
  totalTracks: tracks.length,
  coverUrl: album.attributes.artwork.url.replace('{w}x{h}', '1400x1400'),
});

const baseBody = (t, idx, isLast) => ({
  adamId: t.id,
  quality: 'AAC',
  meta: meta(t, idx),
  batchId,
  isLastTrack: isLast,
  saveLrc: false,
  embedLyrics: true,
  lyricsFormat: 'lrc',
  saveLyricsFormats: [],
  translateLyrics: false,
  ruby: false,
  rubyMode: 'roman',
  lang: 'zh',
  noUpload: false,
});

// 阶段 1：并发缓存
let ok = 0, skip = 0;
const CONC = 3;
let next = 0;
async function worker() {
  while (next < tracks.length) {
    const i = next++;
    try {
      const res = await fetch(CLOUD, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseBody(tracks[i], i, false)),
        signal: AbortSignal.timeout(180000),
      });
      const d = await res.json();
      if (d.status === 'ok') { ok++; log(`[${i + 1}/${tracks.length}] ✓ ${tracks[i].name}`); }
      else { skip++; log(`[${i + 1}/${tracks.length}] ✗ ${tracks[i].name}: ${d.error}`); }
    } catch (e) { skip++; log(`[${i + 1}/${tracks.length}] ✗ ${tracks[i].name}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// 阶段 2：触发打包
log(`缓存完成: 成功 ${ok} / 跳过 ${skip}，触发打包上传...`);
let downloadPage = '';
try {
  const res = await fetch(CLOUD, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseBody(tracks[0], 0, true)),
    signal: AbortSignal.timeout(300000),
  });
  const d = await res.json();
  log('打包返回:', JSON.stringify(d).slice(0, 300));
  downloadPage = d.data?.downloadPage || (d.data?.folderId ? `https://gofile.io/d/${d.data.folderId}` : '');
} catch (e) {
  log('打包异常:', e.message);
}

log('最终链接:', downloadPage || '(空)');

if (downloadPage) {
  const sent = await tg('sendMessage', {
    chat_id: chatId,
    text: `【自动化验证】${album.attributes.artistName} - ${album.attributes.name}\n成功 ${ok} 首 / 跳过 ${skip} 首\n${downloadPage}`,
    disable_web_page_preview: true,
  });
  log('链接已发送:', sent.ok ? 'ok' : 'fail');
}

console.log('\n=== 结论 ===');
console.log(downloadPage ? 'PASS: 链接已生成并送达' : 'FAIL: 未生成链接');
