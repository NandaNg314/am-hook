import fs from 'node:fs';
import path from 'node:path';
const DIR = '/home/ubuntu/am-hook';
const env = Object.fromEntries(
  fs.readFileSync(path.join(DIR, '.env'), 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const cat = await (await fetch('http://127.0.0.1:31408/amp/v1/catalog/hk/albums/1440148289?l=zh-Hans-CN')).json();
const album = cat.data[0];
const track = album.relationships.tracks.data[0];
const res = await fetch('http://127.0.0.1:31409/api/cloud-transfer', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    adamId: track.id,
    quality: 'AAC',
    meta: {
      title: track.attributes.name,
      artist: album.attributes.artistName,
      album: album.attributes.name,
      albumArtist: album.attributes.artistName,
      trackNumber: 1,
      totalTracks: 12,
      coverUrl: album.attributes.artwork.url.replace('{w}x{h}', '1400x1400'),
    },
    batchId: `dbg_${Date.now()}`,
    isLastTrack: false,
    saveLrc: false,
    embedLyrics: true,
    lyricsFormat: 'lrc',
    saveLyricsFormats: [],
    translateLyrics: false,
    ruby: false,
    rubyMode: 'roman',
    lang: 'zh',
    noUpload: false,
  }),
  signal: AbortSignal.timeout(180000),
});
const data = await res.json();
console.log('status:', data.status);
console.log('data keys:', Object.keys(data.data || {}));
console.log('完整返回:');
console.log(JSON.stringify(data, null, 2).slice(0, 2000));
