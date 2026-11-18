#!/usr/bin/env node
/**
 * 发布前/部署后冒烟测试（跑在 am-hook 所在 VPS 上）
 *
 * 覆盖：Hi-Res / Lossless / AAC / Atmos / M4P 单文件回退 / 日文，检查 0–30s 与 12–18s 解码、
 *       网页公告与 changelog API。默认不真实上传 Gofile（UPLOAD=1 时开启）。
 *
 * 用法：
 *   node tests/smoke_download.mjs
 *   UPLOAD=1 node tests/smoke_download.mjs
 *
 * 退出码：0 = 全部通过；1 = 有问题。
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const HOOK = process.env.HOOK_BASE || 'http://127.0.0.1:31408';
const CLOUD = process.env.CLOUD_API || 'http://127.0.0.1:31409/api/cloud-transfer';
const DO_UPLOAD = process.env.UPLOAD === '1';

const CASES = [
  { id: '1720919502', q: 'Hi-Res', name: '罗大佑 Hi-Res', expectParse: 200 },
  { id: '1566386329', q: 'Lossless', name: 'Tom Odell Lossless', expectParse: 200 },
  { id: '1071079652', q: 'AAC', name: 'Sonu Nigam AAC', expectParse: 200 },
  { id: '1041896939', q: 'Hi-Res', name: 'M4P 单文件（回退）', allowFallback: true },
  { id: '860230557', q: 'Hi-Res', name: 'M4P 单文件 B（回退）', allowFallback: true },
  { id: '1493425224', q: 'Hi-Res', name: 'M4P 单文件 C（回退）', allowFallback: true },
  { id: '1530202477', q: 'Atmos', name: 'UNSELF Atmos', expectParse: 200 },
  { id: '1474062334', q: 'Lossless', name: '神様のダンス 日文', expectParse: 200 },
];

const TMP = '/tmp/am_smoke';

function sh(cmd) {
  try {
    return { out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status || 1 };
  }
}

function errLines(s) {
  const t = s.trim();
  return t ? t.split('\n').length : 0;
}

async function parseSong(id) {
  const r = await fetch(`${HOOK}/parse/song/${id}`, { signal: AbortSignal.timeout(25000) });
  const body = await r.text();
  let msg = '';
  try { msg = JSON.parse(body).msg || ''; } catch {}
  return { code: r.status, msg };
}

async function transfer(c) {
  const batchId = `smoke_${c.id}_${Date.now()}`;
  const r = await fetch(CLOUD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adamId: c.id,
      quality: c.q,
      batchId,
      isLastTrack: true,
      noUpload: true,
      saveLrc: false,
      embedLyrics: true,
      lyricsFormat: 'lrc',
      saveLyricsFormats: [],
      translateLyrics: false,
      ruby: false,
      lang: 'zh',
      meta: { title: c.name, artist: c.name, album: c.name, albumArtist: c.name, trackNumber: 1, totalTracks: 1 },
    }),
    signal: AbortSignal.timeout(600000),
  });
  const j = await r.json();
  if (j.status !== 'ok') throw new Error((j.error || 'transfer failed').slice(0, 160));
  const zip = j.data.zipFilePath;
  if (!zip || !fs.existsSync(zip)) throw new Error('no zip output');

  const dir = `${TMP}/${c.id}`;
  sh(`rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && unzip -o -q "${zip}"`);
  const file = sh(`find "${dir}" -type f \\( -iname "*.m4a" -o -iname "*.mp4" \\) | head -1`).out.trim();
  if (!file || !fs.existsSync(file)) throw new Error('no audio in zip');

  const e30 = errLines(sh(`ffmpeg -v error -ss 0 -t 30 -i "${file}" -f null - 2>&1`).out);
  const e15 = errLines(sh(`ffmpeg -v error -ss 12 -t 6 -i "${file}" -f null - 2>&1`).out);
  const size = fs.statSync(file).size;

  sh(`rm -rf "${dir}" "${zip}"`);
  if (j.data.sessionDir) sh(`rm -rf "${j.data.sessionDir}"`);
  return { qualityName: j.data.qualityName || '', fallback: j.data.qualityFallback || '', size, e30, e15 };
}

async function main() {
  sh(`rm -rf ${TMP} && mkdir -p ${TMP}`);
  const results = [];

  for (const c of CASES) {
    const ps = await parseSong(c.id);
    try {
      const t = await transfer(c);
      const fallbackOk = t.fallback || /webplayback/i.test(t.qualityName);
      const parseOk = !c.expectParse || ps.code === c.expectParse || (c.allowFallback && fallbackOk);
      const ok = parseOk && t.e30 === 0 && t.e15 === 0;
      results.push({ ...c, ok, parse: ps.code, ...t, err: ok ? '' : `parse=${ps.code} e30=${t.e30} e15=${t.e15}` });
      console.log(`[${ok ? 'OK' : 'FAIL'}] ${c.name} parse=${ps.code} q=${t.qualityName} ${(t.size / 1048576).toFixed(1)}MB e30=${t.e30} e15=${t.e15}${t.fallback ? ' fallback' : ''}`);
    } catch (e) {
      results.push({ ...c, ok: false, parse: ps.code, err: e.message });
      console.log(`[FAIL] ${c.name} parse=${ps.code} ${e.message}`);
    }
  }

  const home = await (await fetch(`${HOOK}/`, { signal: AbortSignal.timeout(10000) })).text();
  const hasAnnounce = home.includes('announce-card');
  const clApi = await fetch(`${CLOUD.replace('/api/cloud-transfer', '')}/api/quota/changelog`, { signal: AbortSignal.timeout(10000) });
  const webOk = hasAnnounce && clApi.ok;
  console.log(`[WEB] announce=${hasAnnounce} changelog_api=${clApi.status} ${webOk ? 'OK' : 'FAIL'}`);

  if (DO_UPLOAD) {
    console.log('[UPLOAD] 真实 Gofile 上传测试 ...');
    try {
      const r = await fetch(CLOUD, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adamId: '1566386329', quality: 'Lossless', batchId: `smoke_up_${Date.now()}`, isLastTrack: true,
          noUpload: false, saveLrc: false, embedLyrics: true, lyricsFormat: 'lrc', saveLyricsFormats: [],
          translateLyrics: false, ruby: false, lang: 'zh',
          meta: { title: 'smoke-upload', artist: 'smoke-upload', album: 'smoke-upload', albumArtist: 'smoke-upload', trackNumber: 1, totalTracks: 1 },
        }),
        signal: AbortSignal.timeout(600000),
      });
      const j = await r.json();
      const ok = j.status === 'ok' && !!j.data?.downloadPage;
      console.log(`[UPLOAD] ${ok ? 'OK' : 'FAIL'} ${j.data?.downloadPage || JSON.stringify(j).slice(0, 160)}`);
      results.push({ name: 'Gofile upload', ok });
    } catch (e) {
      console.log(`[UPLOAD] FAIL ${e.message}`);
      results.push({ name: 'Gofile upload', ok: false });
    }
  }

  sh(`rm -rf ${TMP}`);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== TOTAL ${results.length}, BAD ${bad.length} ===`);
  if (bad.length) {
    for (const b of bad) console.log('BAD:', JSON.stringify(b).slice(0, 240));
    console.log('HAS_PROBLEM');
    process.exit(1);
  }
  if (!webOk) {
    console.log('HAS_PROBLEM (web)');
    process.exit(1);
  }
  console.log('ALL_OK');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
