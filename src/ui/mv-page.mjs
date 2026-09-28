import { parseMaster, recommendedAudio } from './hls.mjs';
import { fetchMaster, Playback, downloadMV, mime, collectGarbage } from './engine.mjs';
const $ = id => document.getElementById(id), { t } = AmI18n;
// 与 song 页一致：/https://music.apple.com/{cc}/music-video/{slug}/{id}
const [, country = 'us', id] = location.pathname.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/music-video\/[^/]+\/(\d+)\/?$/) || [];
let master, selectedVideo, selectedAudio, playback, downloadController, result, resultUrl;
let statusKey = 'mv.loading', statusVars, title = `MV ${id || ''}`, artist = '', busy = false;
const pageController = new AbortController();
// 状态点颜色：进行中闪烁，完成为绿色，失败为红色
const STATES = { 'mv.loading': 'loading', 'mv.license': 'busy', 'mv.buffering': 'busy', 'mv.downloading': 'busy', 'mv.defrag': 'busy',
  'mv.ready': 'idle', 'mv.playing': 'ok', 'mv.pressPlay': 'ok', 'mv.complete': 'ok', 'mv.failed': 'error' };
function status(key, vars) {
  statusKey = key; statusVars = vars; $('status').textContent = t(key, vars);
  $('feedback').dataset.state = STATES[key] || 'idle';
}
function error(e) { $('error').textContent = e.message; $('error').hidden = false; $('feedback').dataset.state = 'error'; }
function controls() {
  $('play').disabled = !master || busy;
  $('download').disabled = !master || busy;
  $('screen-play').disabled = !master || busy; $('screen-play').hidden = !!playback;
  $('video-tracks').disabled = busy; $('audio-tracks').disabled = busy;
  if (busy) setOpen(null, false);
  $('cancel').hidden = !busy;
}
function stopPlayback() { playback?.stop(); playback = null; $('screen-play').hidden = false; }
function badge(text, kind = '') {
  const node = document.createElement('span'); node.className = `badge ${kind}`; node.textContent = text; return node;
}
function videoTag(track) {
  const height = Number(track.RESOLUTION.split('x')[1]) || 0;
  return height >= 2160 ? '4K' : height >= 1440 ? '2K' : height ? `${height}p` : '—';
}
function videoRange(track) {
  if (/^dv(h1|he)/.test(track.CODECS)) return 'Dolby Vision';
  return { PQ: 'HDR10', HLG: 'HLG' }[track['VIDEO-RANGE']] || '';
}
function audioTag(track) {
  const [channels, joc] = String(track.CHANNELS || '').split('/');
  return joc === 'JOC' ? 'Atmos' : { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' }[channels] || channels || '—';
}
function audioCodec(codec) {
  return /^mp4a/.test(codec) ? 'AAC' : /^ec-3/.test(codec) ? 'E-AC-3' : /^ac-3/.test(codec) ? 'AC-3' : /^ac-4/.test(codec) ? 'AC-4' : codec || '—';
}
// 同名音轨（Apple 常见多条 "English"）用 GROUP-ID 末尾的码率区分
function audioName(track) {
  const name = track.NAME || track.LANGUAGE || 'Audio', kbps = track['GROUP-ID']?.match(/-(\d+)$/)?.[1];
  return kbps && master.audios.filter(a => (a.NAME || a.LANGUAGE || 'Audio') === name).length > 1 ? `${name} · ${kbps} kbps` : name;
}
// 一条轨道的展示内容：左侧规格标签 + 标题/参数/徽标；下拉触发按钮与选项共用
function describe(track, video) {
  const tag = document.createElement('span'); tag.className = 'mv-tag';
  const text = document.createElement('span'), heading = document.createElement('strong'), detail = document.createElement('small');
  text.className = 'mv-option-body';
  if (video) {
    tag.textContent = videoTag(track);
    heading.textContent = `${track.RESOLUTION.replace('x', '×')} · ${(Number(track.BANDWIDTH) / 1e6).toFixed(2)} Mbps`;
    const supported = globalThis.MediaSource?.isTypeSupported(mime(track, true));
    detail.textContent = `${track.CODECS.split(',')[0]} · ${track['FRAME-RATE'] ? `${Math.round(Number(track['FRAME-RATE']) * 100) / 100} fps` : '— fps'}`;
    const range = videoRange(track);
    if (range) text.append(badge(range, 'ok'));
    if (!supported) text.append(badge(t('mv.downloadOnly'), 'warn'));
  } else {
    tag.textContent = audioTag(track);
    heading.textContent = audioName(track);
    detail.textContent = `${audioCodec(track.codec)} · ${track.CHANNELS || '—'} ${t('mv.channels')} · ${track['GROUP-ID']}`;
    if (track === recommendedAudio(selectedVideo, master.audios)) text.append(badge(t('mv.recommended'), 'accent'));
  }
  text.prepend(heading, detail); return [tag, text];
}
function option(track, video) {
  const kind = video ? 'video' : 'audio';
  const label = document.createElement('label'); label.className = 'mv-option';
  const input = document.createElement('input'); input.type = 'radio'; input.name = kind;
  input.checked = track === (video ? selectedVideo : selectedAudio);
  // 鼠标/触摸点选后收起；方向键切换（detail 为 0）保持展开，便于连续浏览
  label.addEventListener('click', e => { if (e.detail > 0) setOpen(kind, false); });
  input.addEventListener('change', () => {
    stopPlayback();
    if (video) { selectedVideo = track; selectedAudio = recommendedAudio(track, master.audios); }
    else selectedAudio = track;
    renderTracks();
    if ($(`${kind}s`).hidden) $(`${kind}-trigger`).focus();
    else $(`${kind}s`).querySelector('input:checked')?.focus();
    status('mv.ready');
  });
  label.append(...describe(track, video), input); return label;
}
// 两个轨道下拉：同一时间只展开一个
function setOpen(kind, open) {
  for (const k of ['video', 'audio']) {
    const on = k === kind && open;
    $(`${k}-trigger`).setAttribute('aria-expanded', String(on)); $(`${k}s`).hidden = !on;
  }
  if (open) {
    const list = $(`${kind}s`), checked = list.querySelector('input:checked');
    checked?.focus({ preventScroll: true });
    list.scrollIntoView({ block: 'nearest' }); checked?.closest('.mv-option')?.scrollIntoView({ block: 'nearest' });
  }
}
for (const kind of ['video', 'audio']) {
  $(`${kind}-trigger`).addEventListener('click', () => setOpen(kind, $(`${kind}s`).hidden));
  $(`${kind}s`).addEventListener('keydown', e => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    e.preventDefault(); setOpen(kind, false); $(`${kind}-trigger`).focus();
  });
}
document.addEventListener('pointerdown', e => { if (!e.target.closest?.('.mv-select')) setOpen(null, false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(null, false); });
function renderTracks() {
  if (!master) return;
  $('videos').replaceChildren(...master.videos.map(v => option(v, true)));
  $('audios').replaceChildren(...master.audios.map(a => option(a, false)));
  $('video-value').replaceChildren(...describe(selectedVideo, true));
  $('audio-value').replaceChildren(...describe(selectedAudio, false));
  $('video-count').textContent = master.videos.length;
  $('audio-count').textContent = master.audios.length;
  $('selection').textContent = [selectedVideo.RESOLUTION, videoRange(selectedVideo) || 'SDR', audioName(selectedAudio) || selectedAudio.codec].filter(Boolean).join(' · ');
}
/** 艺人资源 → 本站艺人页链接 */
function artistLink(resource, label = resource.attributes.name) {
  const m = (resource.attributes.url || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/artist\/([^/?#]+)\/(\d+)/i);
  const a = document.createElement('a');
  a.href = m ? `/https://music.apple.com/${m[1].toLowerCase()}/artist/${m[2]}/${m[3]}` : `/https://music.apple.com/${country}/artist/_/${resource.id}`;
  a.textContent = label;
  return a;
}
/**
 * 艺人行（如「A, B & C」）中每位艺人的名字链接到其艺人页，分隔符保持原样（与 song 页相同）；
 * 名字对不上而只有一位艺人时，整行链接到该艺人。
 */
function artistNodes(text, artists) {
  const named = artists.slice().sort((a, b) => b.attributes.name.length - a.attributes.name.length);
  const word = /[\p{L}\p{N}]/u;
  const nodes = [];
  let plain = '', linked = false;
  for (let i = 0; i < text.length;) {
    // 名字前后不能紧挨字母或数字，避免把长名字里的一段当成另一位艺人
    const hit = (i === 0 || !word.test(text[i - 1])) && named.find(a => text.startsWith(a.attributes.name, i)
      && !word.test(text[i + a.attributes.name.length] || ''));
    if (hit) {
      if (plain) nodes.push(plain);
      plain = ''; nodes.push(artistLink(hit)); i += hit.attributes.name.length; linked = true;
    } else plain += text[i++];
  }
  if (plain) nodes.push(plain);
  if (!linked && named.length === 1) return [artistLink(named[0], text)];
  return nodes;
}
let metadataSeq = 0;
async function metadata() {
  // 快速切换语言时只采用最后一次请求的结果
  const seq = ++metadataSeq;
  try {
    // 经服务端 /amp 代理请求 amp-api 的 music-videos 资源，名称按界面语言返回（l 按地区支持的语言选择）
    const url = new URL(`/amp/v1/catalog/${country}/music-videos/${id}`, location.origin);
    url.searchParams.set('include', 'artists');
    const l = await AmI18n.catalogLang(country);
    if (l) url.searchParams.set('l', l);
    let res = await fetch(url, { signal: pageController.signal });
    // 语言参数被拒绝时去掉 l，改用地区默认语言
    if (res.status === 400 && url.searchParams.has('l')) { url.searchParams.delete('l'); res = await fetch(url, { signal: pageController.signal }); }
    if (!res.ok) return;
    const resource = (await res.json()).data?.[0];
    const item = resource?.attributes;
    if (!item || seq !== metadataSeq) return;
    title = item.name || title; artist = item.artistName || '';
    $('title').textContent = title; document.title = `${title} · am-hook MV`;
    $('artist').replaceChildren(...artistNodes(artist, (resource.relationships?.artists?.data || []).filter(r => r.attributes?.name)));
    const seconds = Math.floor(Number(item.durationInMillis) / 1000);
    $('meta').replaceChildren(...[item.releaseDate?.slice(0, 4), item.genreNames?.[0],
      seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '', `ID ${id}`].filter(Boolean).map(value => badge(value)));
    // artwork.url 是 {w}x{h}{c}.{f} 模板
    const artUrl = size => item.artwork?.url?.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') || '';
    const art = artUrl(600);
    if (art) {
      $('artwork').src = art; $('artwork').hidden = false; $('video').poster = art;
      $('artwork').onload = () => { $('ambient').style.setProperty('--art', `url("${art}")`); $('ambient').classList.add('on'); };
      $('artwork').onerror = () => { $('artwork').hidden = true; };
    }
    try {
      const old = JSON.parse(localStorage.getItem('am-hook:recent') || '[]');
      const recent = { id, title, artist, artwork: artUrl(100), link: `https://music.apple.com/${country}/music-video/_/${id}` };
      localStorage.setItem('am-hook:recent', JSON.stringify([recent, ...(Array.isArray(old) ? old.filter(r => r.id !== id) : [])].slice(0, 12)));
    } catch {}
  } catch (e) { if (e.name !== 'AbortError') console.info('MV metadata unavailable'); }
}
$('play').onclick = async () => {
  stopPlayback(); $('error').hidden = true; busy = true; controls(); status('mv.license');
  const session = new Playback($('video'), key => { if (!downloadController) status(`mv.${key}`); }, error);
  playback = session;
  try { await session.start(id, selectedVideo, selectedAudio, master.captions); }
  catch (e) { session.stop(); if (playback === session) playback = null; if (e.name !== 'AbortError') error(e); }
  finally { busy = false; controls(); }
};
$('download').onclick = async () => {
  stopPlayback(); $('error').hidden = true; busy = true; controls(); status('mv.license');
  downloadController = new AbortController();
  if (resultUrl) URL.revokeObjectURL(resultUrl); await result?.dispose(); result = null; $('save').hidden = true;
  $('progress').value = 0; $('progress').hidden = false;
  try {
    result = await downloadMV(id, selectedVideo, selectedAudio, { signal: downloadController.signal, onProgress: (value, bytes) => {
      $('progress').value = value; status('mv.downloading', { percent: Math.round(value * 100), size: (bytes / 1048576).toFixed(1) });
    }, onDefrag: () => { $('progress').removeAttribute('value'); status('mv.defrag'); } });
    resultUrl = URL.createObjectURL(result.file); $('save').href = resultUrl;
    $('save').download = `${title} (${id}).mp4`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    $('save').hidden = false; $('save').click(); status('mv.complete');
  } catch (e) { if (e.name === 'AbortError') status('mv.cancelled'); else error(e); }
  finally { downloadController = null; busy = false; $('progress').hidden = true; controls(); }
};
// 在外壳中打开时：MV 与常驻播放条上的音乐同时只播放一个
let music = null;
try { if (parent !== window && parent.AmShell) music = parent.AmShell.attach(window); } catch {}
if (music) {
  $('video').addEventListener('play', () => music.pause());
  music.onChange((current, playing) => { if (playing) $('video').pause(); });
}
$('screen-play').onclick = () => $('play').click();
$('cancel').onclick =() => { downloadController?.abort(); stopPlayback(); status('mv.cancelled'); };
window.addEventListener('pagehide', () => { pageController.abort(); downloadController?.abort(); stopPlayback(); if (resultUrl) URL.revokeObjectURL(resultUrl); result?.dispose(); });
// 切换语言：标题等由 amp-api 按语言返回，重新获取
AmI18n.onChange(() => { renderTracks(); status(statusKey, statusVars); if (id) void metadata(); });
AmI18n.apply(); status(statusKey);
async function load() {
  void collectGarbage();
  if (!id) throw new Error('Invalid music video ID');
  $('title').textContent = title; void metadata();
  $('meta').replaceChildren(badge(`ID ${id}`));
  $('apple-link').href = `https://music.apple.com/${country}/music-video/_/${id}`;
  $('apple-link').hidden = false;
  const { masterUrl, masterBody } = await fetchMaster(id, pageController.signal);
  master = parseMaster(masterBody, masterUrl); selectedVideo = master.videos[0]; selectedAudio = recommendedAudio(selectedVideo, master.audios);
  renderTracks(); controls(); status('mv.ready');
}
load().catch(e => {
  error(e); status('mv.failed');
  for (const name of ['videos', 'audios']) {
    const message = document.createElement('p'); message.className = 'mv-empty';
    message.dataset.i18n = 'mv.unavailable'; message.textContent = t('mv.unavailable');
    $(name).replaceChildren(message);
    const empty = document.createElement('span'); empty.className = 'mv-trigger-empty';
    empty.dataset.i18n = 'mv.unavailable'; empty.textContent = t('mv.unavailable');
    $(`${name.slice(0, -1)}-value`).replaceChildren(empty);
  }
});
