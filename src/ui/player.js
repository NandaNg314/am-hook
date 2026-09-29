/*
 * am-hook 简易在线播放器
 *
 * 播放方式按优先级：
 *   1. MSE：浏览器直接从 Apple CDN 获取 media m3u8 与分段，在 Worker 中用 wasm 解密（decrypt.js）
 *      后逐段喂给 SourceBuffer。只缓冲当前位置之后 ~45s，拖动时直接定位到对应 segment。
 *   2. EC-3 回退：原生 MSE 不可用时，按需加载 ec3.wasm，解码为 5.1/7.1 PCM。
 *   3. 原生 HLS：把服务端解密的 media m3u8 交给 <audio>（其他编码的可选路径）。
 *   4. 直连：<audio src=服务端解密的 media file>，依赖浏览器对 fMP4 的渐进式播放。
 *   3、4 需要服务端以 --hook 启动（item 带 hookM3u8Url / hookFileUrl）。
 */
(function (global) {
  'use strict';

  const AHEAD_SECONDS = 45;
  const BEHIND_SECONDS = 30;

  /** 服务端默认 media m3u8 是每段独立 URL 的通用写法；Safari 原生 HLS 用原始 EXT-X-MAP + BYTERANGE 写法 */
  function byterangeUrl(m3u8Url) {
    return m3u8Url + (m3u8Url.includes('?') ? '&' : '?') + 'hook=byterange';
  }

  /** time 所在 segment 下标 */
  function segmentAt(segments, time) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function mimeFor(codecs) {
    return `audio/mp4; codecs="${codecs || 'mp4a.40.2'}"`;
  }

  // 运行时确认播放失败的编码（检测结果不可靠时以实际结果为准）
  const failedCodecs = new Set();

  /**
   * 该编码在当前浏览器中可尝试的播放方式（按优先级），空数组表示不支持。
   * 注意：canPlayType('application/vnd.apple.mpegurl') 只说明浏览器能播 HLS，
   * 不代表能解码其中的编码（新版 Chrome/Edge 原生支持 HLS 但不支持 ALAC），
   * 所以 HLS / 直连都必须同时通过编码检测。EC-3 单独按 MSE -> PCM 检测，
   * 两种方式都由浏览器端解密，不依赖 --hook。
   */
  function detectModes(codecs, audio, hook) {
    if (failedCodecs.has(codecs)) return [];
    const mime = mimeFor(codecs);
    const modes = [];
    const decrypt = global.AmDecrypt && global.AmDecrypt.supported();
    const MS = global.ManagedMediaSource || global.MediaSource;
    if (MS && MS.isTypeSupported && MS.isTypeSupported(mime) && decrypt) modes.push('mse');
    if (/^(ec-3|ec3)$/i.test(String(codecs))) {
      if (decrypt && global.Worker && global.WebAssembly &&
          (global.AudioContext || global.webkitAudioContext)) modes.push('ec3');
      return modes;
    }
    if (hook && audio && audio.canPlayType(mime) !== '') {
      if (audio.canPlayType('application/vnd.apple.mpegurl') !== '') modes.push('hls');
      modes.push('direct');
    }
    if (String(codecs).toLowerCase() === 'alac' && MS && MS.isTypeSupported &&
        MS.isTypeSupported(mimeFor('flac')) && global.Worker && decrypt) modes.push('flac');
    return modes;
  }

  /** hook：服务端是否以 --hook 启动（决定能否使用原生 HLS / 直连） */
  function detectMode(codecs, audio, hook) {
    return detectModes(codecs, audio, hook)[0] || null;
  }

  /** 界面文案（i18n.js）；未加载时直接返回 key */
  function t(key, vars) {
    return global.AmI18n ? global.AmI18n.t(key, vars) : key;
  }

  /** 不能在浏览器内播放时给用户的建议 */
  function fallbackHint(item) {
    return t(item && item.hookM3u8Url ? 'player.hintExternal' : 'player.hintDownload');
  }

  function modeLabel(mode) {
    return mode === 'direct' ? t('player.direct') : mode === 'ec3' ? t('player.pcmMode') : mode.toUpperCase();
  }

  /* ---------- 播放队列的曲目：逐首解析 master，选浏览器能播放的最高音质 ---------- */
  function rankVariant(v) {
    const g = v.group_id.toLowerCase();
    return g.includes('alac') ? 0 : g.includes('atmos') ? 1 : g.includes('he-') ? 3 : 2;
  }

  function variantLabel(v) {
    const g = v.group_id.toLowerCase();
    if (g.includes('alac')) {
      const spec = [v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ');
      return `ALAC${spec ? ' · ' + spec : ''}`;
    }
    if (g.includes('atmos')) return 'Dolby Atmos';
    const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
    return `${g.includes('he-') ? 'HE-AAC' : 'AAC'}${kbps ? ' · ' + kbps + ' kbps' : ''}`;
  }

  let probe = null;

  /** entry: { track, name, artist, album, artwork } → play() 使用的 item */
  /** 就地打乱 list[start..]（Fisher-Yates） */
  function shuffleFrom(list, start) {
    for (let i = list.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  async function resolveEntry(entry) {
    const res = await fetch(`/parse/song/${entry.track}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.masterUrl || !Array.isArray(data.variants)) throw new Error(data.msg || `HTTP ${res.status}`);
    const hook = !!data.hook;
    const base = data.masterUrl.slice(0, data.masterUrl.lastIndexOf('/') + 1);
    probe = probe || document.createElement('audio');
    const best = data.variants
      .map((v) => ({ ...v, mode: detectMode(v.codecs, probe, hook) }))
      .filter((v) => v.mode)
      .sort((a, b) => rankVariant(a) - rankVariant(b) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (!best) throw Object.assign(new Error(t('album.noPlayable', { name: entry.name })), { noPlayable: true });
    return {
      id: `${entry.track}:${best.group_id}`,
      track: entry.track,
      codecs: best.codecs,
      m3u8Url: base + best.uri,
      hookM3u8Url: hook ? `${location.origin}/${base + best.uri}` : null,
      hookFileUrl: hook ? `${location.origin}/${base + best.file_uri}` : null,
      label: variantLabel(best),
      title: entry.name,
      artist: entry.artist,
      album: entry.album,
      artwork: entry.artwork,
    };
  }

  class FlacTranscoder {
    constructor() {
      this.worker = new Worker('/assets/flac-transcode-worker.js');
      this.pending = new Map();
      this.seq = 0;
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'FLAC Worker failed'));
        this.pending.clear();
      };
    }

    run(op, buf) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op, buf }, [buf]);
      });
    }

    destroy() {
      this.worker.terminate();
      for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
      this.pending.clear();
    }
  }

  class Ec3Decoder {
    constructor() {
      this.worker = new Worker('/assets/ec3-decode-worker.js');
      this.pending = new Map();
      this.seq = 0;
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'EC-3 Worker failed'));
        this.pending.clear();
      };
    }

    decode(buf) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op: 'decode', buf }, [buf]);
      });
    }

    flush() {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op: 'flush' });
      });
    }

    destroy() {
      this.worker.terminate();
      for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
      this.pending.clear();
    }
  }

  /** Bounded, on-demand multichannel PCM playback for EC-3. */
  class PcmEngine {
    constructor(onUpdate, onError, onEnded) {
      this.onUpdate = onUpdate;
      this.onError = onError;
      this.onEnded = onEnded;
      this.context = new (global.AudioContext || global.webkitAudioContext)();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.nodes = new Set();
      this.paused = true;
      this.anchorTime = 0;
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = 0;
      this.generation = 0;
      this.timer = setInterval(() => {
        if (!this.paused && this.duration && this.currentTime >= this.duration) {
          this.pause();
          if (this.onEnded) this.onEnded();
        }
        if (!this.paused) this.pump();
        this.onUpdate();
      }, 200);
      // Resume during the click gesture, before the asynchronous playlist request.
      this.started = this.context.resume().then(() => this.context.suspend());
    }

    get currentTime() {
      const time = this.paused ? this.anchorTime
        : this.anchorTime + Math.max(0, this.context.currentTime - this.anchorContextTime);
      return Math.min(this.duration || Infinity, time);
    }

    set currentTime(value) { const pending = this.seek(value); if (pending) pending.catch(() => {}); }

    async load(url) {
      const gen = this.generation;
      await this.started;
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.controller = new AbortController();
      this.playlist = await global.AmDecrypt.openTrack(url, this.controller.signal);
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.duration = this.playlist.duration;
      this.decoder = new Ec3Decoder();
      this.nextIndex = 0;
      await this.pump(true);
    }

    async pump(first = false) {
      if (this.busy || this.failed || !this.playlist || !this.decoder) return;
      this.busy = true;
      const gen = this.generation;
      const required = first;
      try {
        const { segments } = this.playlist;
        while (this.nextIndex < segments.length && (first || segments[this.nextIndex].time < this.currentTime + 12)) {
          const seg = segments[this.nextIndex];
          const encrypted = await this.playlist.load(seg, this.controller.signal);
          if (gen !== this.generation) return;
          const decoded = await this.decoder.decode(encrypted);
          if (gen !== this.generation) return;
          const { channels, rate, samples, chunks } = decoded;
          if (this.channels && (this.channels !== channels || this.rate !== rate)) {
            throw new Error('EC-3 channel layout changed during playback');
          }
          this.channels = channels;
          this.rate = rate;
          let sampleOffset = 0;
          for (const chunk of chunks) {
            const chunkTime = seg.time + sampleOffset / rate;
            const offset = Math.max(0, this.currentTime - chunkTime);
            sampleOffset += chunk.samples;
            if (offset >= chunk.samples / rate) {
              chunk.pcm = null;
              continue;
            }
            const data = new Float32Array(chunk.pcm);
            const buffer = this.context.createBuffer(channels, chunk.samples, rate);
            for (let ch = 0; ch < channels; ch++) {
              // FFmpeg's 7.1 order puts back channels before side channels;
              // Web Audio uses side channels before back channels.
              const sourceCh = channels === 8 ? [0, 1, 2, 3, 6, 7, 4, 5][ch] : ch;
              buffer.copyToChannel(data.subarray(sourceCh * chunk.capacity, sourceCh * chunk.capacity + chunk.samples), ch);
            }
            chunk.pcm = null;
            const node = this.context.createBufferSource();
            node.buffer = buffer;
            node.connect(this.gain);
            node.onended = () => { this.nodes.delete(node); node.disconnect(); };
            this.nodes.add(node);
            const when = Math.max(this.context.currentTime + 0.01,
              this.anchorContextTime + chunkTime - this.anchorTime);
            node.start(when, offset);
          }
          this.loadedUntil = Math.max(this.loadedUntil, seg.time + samples / rate);
          this.nextIndex++;
          first = false;
          this.onUpdate();
          if (required) break;
        }
      } catch (error) {
        if (required && gen === this.generation) throw error;
        if (error.name !== 'AbortError' && gen === this.generation) {
          this.failed = true;
          this.pause();
          this.onError(error);
        }
      } finally {
        this.busy = false;
      }
    }

    async play() {
      if (this.seeking) { this.resumeAfterSeek = true; return this.seekTask; }
      this.failed = false;
      await this.context.resume();
      this.paused = false;
      this.onUpdate();
      this.pump();
    }

    pause() {
      if (this.seeking) { this.resumeAfterSeek = false; return; }
      if (this.paused) return;
      this.anchorTime = this.currentTime;
      this.anchorContextTime = this.context.currentTime;
      this.paused = true;
      this.context.suspend();
      this.onUpdate();
    }

    seek(time) {
      if (!this.playlist) return;
      this.generation++;
      const gen = this.generation;
      this.failed = false;
      this.resumeAfterSeek = !this.paused || (this.seeking && this.resumeAfterSeek);
      this.seeking = true;
      this.paused = true;
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.anchorTime = Math.max(0, Math.min(time, this.duration));
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = this.anchorTime;
      this.nextIndex = segmentAt(this.playlist.segments, this.anchorTime);
      this.onUpdate();
      const task = (async () => {
        await this.context.suspend();
        while (this.busy && gen === this.generation) await new Promise((resolve) => setTimeout(resolve, 10));
        if (gen !== this.generation) return;
        await this.decoder.flush();
        if (gen !== this.generation) return;
        this.anchorContextTime = this.context.currentTime + 0.03;
        await this.pump(true);
        if (gen === this.generation && this.resumeAfterSeek) {
          await this.context.resume();
          this.paused = false;
          this.onUpdate();
          this.pump();
        }
      })().catch((error) => {
        if (gen === this.generation && error.name !== 'AbortError') {
          this.failed = true;
          this.onError(error);
        }
        throw error;
      })
        .finally(() => { if (gen === this.generation) { this.seeking = false; this.seekTask = null; } });
      this.seekTask = task;
      return task;
    }

    destroy() {
      this.generation++;
      clearInterval(this.timer);
      if (this.controller) this.controller.abort();
      if (this.decoder) this.decoder.destroy();
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.context.close();
    }
  }

  class MseEngine {
    constructor(audio) {
      this.audio = audio;
      this.generation = 0;
    }

    /** m3u8Url：Apple CDN 上的原始 media m3u8 */
    async load(m3u8Url, codecs, onError, transcode = false) {
      const gen = ++this.generation;
      this.destroy(false);
      this.onError = onError;
      this.controller = new AbortController();
      const playlist = await global.AmDecrypt.openTrack(m3u8Url, this.controller.signal);
      if (gen !== this.generation) return;
      this.playlist = playlist;
      if (transcode) this.transcoder = new FlacTranscoder();

      const MS = global.ManagedMediaSource || global.MediaSource;
      const ms = new MS();
      this.ms = ms;
      this.objectUrl = URL.createObjectURL(ms);
      if (global.ManagedMediaSource && MS === global.ManagedMediaSource) this.audio.disableRemotePlayback = true;
      this.audio.src = this.objectUrl;
      await new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));
      if (gen !== this.generation) return;

      ms.duration = playlist.duration;
      this.sb = ms.addSourceBuffer(mimeFor(transcode ? 'flac' : codecs));
      await this.append(await this.fetchRange(playlist.init, gen), gen);

      // 只记录成功追加的分段；时间戳与 EXTINF 有偏差时避免反复拉取。
      this.appendedSegments = new Set();
      this.pendingSegments = new Map();
      this.segmentController = new AbortController();
      this.seekSerial = 0;
      this.pumpSerial = 0;
      this.onTick = () => this.pump(gen);
      this.onSeeking = () => {
        this.seekSerial++;
        const seekSerial = this.seekSerial;
        this.pumpSerial++;
        this.segmentController.abort();
        this.segmentController = new AbortController();
        this.appendedSegments.clear();
        this.pendingSegments.clear();
        if (this.sb.updating) {
          this.sb.addEventListener('updateend', () => {
            if (gen !== this.generation || seekSerial !== this.seekSerial) return;
            this.busy = false;
            this.pump(gen);
          }, { once: true });
        } else {
          this.busy = false;
          this.pump(gen);
        }
      };
      this.audio.addEventListener('timeupdate', this.onTick);
      this.audio.addEventListener('seeking', this.onSeeking);
      this.pump(gen);
    }

    /** 获取并解密一个分段 */
    async fetchRange(range, gen, signal = this.controller.signal) {
      let buf = await this.playlist.load(range, signal);
      signal.throwIfAborted();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      if (this.transcoder) buf = await this.transcoder.run(range.init ? 'open' : 'transcode', buf);
      signal.throwIfAborted();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      return buf;
    }

    append(buf, gen) {
      return new Promise((resolve, reject) => {
        if (gen !== this.generation || !this.sb) return reject(new DOMException('stale', 'AbortError'));
        const done = () => { this.sb.removeEventListener('error', fail); resolve(); };
        const fail = () => { this.sb.removeEventListener('updateend', done); reject(new Error(t('player.errorAppend'))); };
        this.sb.addEventListener('updateend', done, { once: true });
        this.sb.addEventListener('error', fail, { once: true });
        try {
          this.sb.appendBuffer(buf); // readyState 为 ended 时追加会自动重新打开
        } catch (err) {
          this.sb.removeEventListener('updateend', done);
          this.sb.removeEventListener('error', fail);
          reject(err);
        }
      });
    }

    isBuffered(seg) {
      const b = this.sb.buffered;
      const from = seg.time + 0.25;
      const to = seg.time + Math.max(seg.duration - 0.25, 0.3);
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= from && b.end(i) >= to) return true;
      }
      return false;
    }

    async evict(gen) {
      const cut = this.audio.currentTime - (this.transcoder ? 2 : BEHIND_SECONDS);
      if (cut <= 1 || this.sb.updating) return;
      await new Promise((resolve) => {
        this.sb.addEventListener('updateend', resolve, { once: true });
        this.sb.remove(0, cut);
      });
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
    }

    ready(i) {
      // A nearly complete buffered range can still have queued FLAC fragments.
      // Finish those before starting the next segment: backfilling them later
      // changes MSE's append position and lets quota eviction remove future audio.
      if (this.pendingSegments.has(i)) return false;
      return this.isBuffered(this.playlist.segments[i]) || this.appendedSegments.has(i);
    }

    async pump(gen) {
      if (this.busy || gen !== this.generation || !this.sb) return;
      const { segments } = this.playlist;
      const now = this.audio.currentTime;
      const startIndex = segmentAt(segments, now);
      let target = -1;
      const ahead = this.transcoder ? 14 : AHEAD_SECONDS;
      for (let i = startIndex; i < segments.length; i++) {
        if (segments[i].time > now + ahead) break;
        if (!this.ready(i)) { target = i; break; }
      }
      if (target < 0) {
        // After seeking, earlier segments may never have been loaded. Signal
        // EOF once the remaining audio is appended so the decoder can flush
        // its final samples. A later seek/append reopens the MediaSource.
        const tailDone = segments.every((_, i) => i < startIndex || this.ready(i));
        if (tailDone && this.ms.readyState === 'open' && !this.sb.updating) {
          try { this.ms.endOfStream(); } catch {}
        }
        return;
      }

      this.busy = true;
      const pumpSerial = ++this.pumpSerial;
      const seekSerial = this.seekSerial;
      const signal = this.segmentController.signal;
      let waitForPlayback = false;
      try {
        if (this.transcoder) {
          let queue = this.pendingSegments.get(target);
          if (!queue) {
            queue = await this.fetchRange(segments[target], gen, signal);
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            this.pendingSegments.set(target, queue);
          }
          while (queue.length) {
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            try {
              await this.append(queue[0], gen);
            } catch (err) {
              if (!err || err.name !== 'QuotaExceededError') throw err;
              await this.evict(gen);
              try {
                await this.append(queue[0], gen);
              } catch (retryError) {
                if (!retryError || retryError.name !== 'QuotaExceededError') throw retryError;
                waitForPlayback = true;
                break;
              }
            }
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            queue.shift();
          }
          if (!queue.length) {
            this.pendingSegments.delete(target);
            this.appendedSegments.add(target);
          }
        } else {
          const buf = await this.fetchRange(segments[target], gen, signal);
          if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
          try {
            await this.append(buf, gen);
          } catch (err) {
            if (err && err.name === 'QuotaExceededError') {
              await this.evict(gen);
              await this.append(buf, gen);
            } else {
              throw err;
            }
          }
          if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
          this.appendedSegments.add(target);
        }
      } catch (err) {
        if (pumpSerial === this.pumpSerial && (!err || err.name !== 'AbortError')) {
          this.busy = false;
          if (this.onError) this.onError(err);
          return;
        }
      }
      if (pumpSerial === this.pumpSerial) {
        this.busy = false;
        if (!waitForPlayback && gen === this.generation) this.pump(gen);
      }
    }

    destroy(bump = true) {
      if (bump) this.generation++;
      if (this.controller) this.controller.abort();
      if (this.segmentController) this.segmentController.abort();
      if (this.transcoder) this.transcoder.destroy();
      if (this.onTick) {
        this.audio.removeEventListener('timeupdate', this.onTick);
        this.audio.removeEventListener('seeking', this.onSeeking);
      }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.onTick = this.onSeeking = this.controller = this.segmentController = this.objectUrl = this.sb = this.ms = this.playlist = this.transcoder = this.pendingSegments = this.appendedSegments = null;
      this.busy = false;
    }
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const ICON_LOADING = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
  const ICON_QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 14.5v5.5"/><circle cx="14" cy="20" r="2"/><path d="M16 14.5 20 13"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
  const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 12h10"/></svg>';
  const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3c2.2 0 3.4 1 4.5 2.8l3 4.4C14.6 16 15.8 17 18 17h2.5"/><path d="M3 17h3c1.6 0 2.7-.6 3.6-1.6M14.4 8.6C15.3 7.6 16.4 7 18 7h2.5"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/></svg>';
  const ICON_REPEAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/></svg>';
  const ICON_REPEAT_ONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/><path d="M11 10.5 12.5 9.5v5" stroke-width="1.8"/></svg>';

  /**
   * 页面底部播放条。
   * 外壳页（shell.html）中只有一个实例，站内页面在 iframe 中经 connect() 共用它，跳转页面时播放不中断；
   * 直接打开页面（浏览器不发送 Sec-Fetch-Dest）时每个页面各自创建。
   */
  class AmPlayer {
    constructor(root) {
      this.root = root;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.mse = new MseEngine(this.audio);
      this.pcm = null;
      this.$ = (sel) => root.querySelector(sel);
      this.listeners = new Set();
      this.unsupportedListeners = new Set();
      this.playToken = 0;
      /** 播放队列：{ entries, pos }，entries 见 resolveEntry；pendingTrack 为正在解析的曲目 */
      this.queue = null;
      this.queueSerial = 0;
      this.pendingTrack = null;
      /** 需要为播放条留出底部空间的文档（自身与 iframe 中的页面） */
      this.docs = new Set([root.ownerDocument]);
      /** 随机播放（true / false）与重复播放（off / all / one），与 Apple Music 相同，下次打开时保留 */
      this.shuffle = false;
      this.repeat = 'off';
      try {
        this.shuffle = localStorage.getItem('am-hook:shuffle') === '1';
        const repeat = localStorage.getItem('am-hook:repeat');
        if (repeat === 'all' || repeat === 'one') this.repeat = repeat;
      } catch {}
      new ResizeObserver(() => this.layout()).observe(root);
      this.bindUi();
      this.bindQueueUi();
      this.bindKeys(root.ownerDocument);
      try {
        const v = parseFloat(localStorage.getItem('am-hook:volume'));
        if (v >= 0 && v <= 1) this.audio.volume = v;
      } catch {}
      this.$('.volume').value = this.audio.volume;
      if (global.AmI18n) global.AmI18n.onChange(() => this.renderLang());
    }

    /** 切换界面语言后重绘播放条上的文字 */
    renderLang() {
      this.renderToggle();
      if (this.current) {
        this.renderMode();
        this.$('.player-title').textContent = this.current.title || t('player.unknownTitle');
      }
      this.renderError();
      this.renderQueueLang();
    }

    renderMode() {
      if (!this.current) return;
      const ec3 = this.current.mode === 'ec3';
      const channels = this.pcm && this.pcm.channels;
      this.$('.player-mode').textContent = ec3 && channels
        ? t('player.pcmChannels', { n: channels - 1 }) : modeLabel(this.current.mode);
      const notice = this.$('.player-notice');
      const noticeKey = ec3 ? 'player.pcmNotice'
        : this.current.mode === 'flac' ? 'player.flacNotice' : null;
      notice.textContent = noticeKey ? t(noticeKey) : '';
      notice.hidden = !noticeKey;
    }

    transport() { return this.current && this.current.mode === 'ec3' && this.pcm ? this.pcm : this.audio; }

    updatePcm() {
      this.renderToggle();
      this.renderProgress();
      this.renderMode();
      this.emit();
    }

    onChange(fn) { this.listeners.add(fn); }
    emit() {
      this.listeners.forEach((fn) => fn(this.current, !this.transport().paused));
      this.renderModes();
      this.renderQueue();
    }

    bindUi() {
      const a = this.audio;
      this.$('.player-toggle').addEventListener('click', () => this.toggle());
      this.$('.skip-prev').addEventListener('click', () => this.previous());
      this.$('.skip-next').addEventListener('click', () => this.next());
      this.$('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      this.$('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      this.$('.volume').addEventListener('input', (e) => {
        a.volume = Number(e.target.value);
        if (this.pcm) this.pcm.gain.gain.value = a.volume;
        try { localStorage.setItem('am-hook:volume', String(a.volume)); } catch {}
      });

      const seek = this.$('.seek');
      const ratioAt = (e) => {
        const r = seek.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      };
      seek.addEventListener('pointerdown', (e) => {
        if (!this.duration()) return;
        seek.setPointerCapture(e.pointerId);
        seek.classList.add('dragging');
        this.dragRatio = ratioAt(e);
        this.renderProgress();
      });
      seek.addEventListener('pointermove', (e) => {
        if (this.dragRatio === undefined) return;
        this.dragRatio = ratioAt(e);
        this.renderProgress();
      });
      const release = () => {
        if (this.dragRatio === undefined) return;
        this.transport().currentTime = this.dragRatio * this.duration();
        this.dragRatio = undefined;
        seek.classList.remove('dragging');
      };
      seek.addEventListener('pointerup', release);
      seek.addEventListener('pointercancel', release);
      seek.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { this.seekBy(-5); e.preventDefault(); }
        if (e.key === 'ArrowRight') { this.seekBy(5); e.preventDefault(); }
      });

      ['timeupdate', 'progress', 'durationchange', 'loadedmetadata'].forEach((ev) => a.addEventListener(ev, () => this.renderProgress()));
      ['play', 'pause', 'playing', 'waiting', 'ended'].forEach((ev) => a.addEventListener(ev, () => { this.renderToggle(); this.emit(); }));
      a.addEventListener('ended', () => this.ended());
      a.addEventListener('error', () => {
        // 尝试阶段的错误由 play() 统一处理（会自动换下一种播放方式）
        if (!this.attempting && this.current && this.current.mode !== 'mse' && this.audio.getAttribute('src')) {
          const item = this.current;
          this.showError(() => t('player.errorGeneric', { hint: fallbackHint(item) }));
        }
      });

      if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', () => this.transport().play());
        ms.setActionHandler('pause', () => this.transport().pause());
        ms.setActionHandler('seekbackward', () => this.seekBy(-10));
        ms.setActionHandler('seekforward', () => this.seekBy(10));
        try { ms.setActionHandler('seekto', (d) => { this.transport().currentTime = d.seekTime; }); } catch {}
        try {
          ms.setActionHandler('nexttrack', () => this.next());
          ms.setActionHandler('previoustrack', () => this.previous());
        } catch {}
      }
    }

    /** 空格播放 / 暂停，左右方向键快退 / 快进；iframe 中的页面也要绑定，按键不会传到外壳 */
    bindKeys(doc) {
      // 待播清单面板：按 Esc 或点击面板与播放条以外的地方（含 iframe 中的页面）时收起
      doc.addEventListener('pointerdown', (e) => {
        if (this.queuePanel.hidden || this.queuePanel.contains(e.target) || this.root.contains(e.target)) return;
        this.closeQueue();
      });
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.queuePanel.hidden) { this.closeQueue(true); return; }
        if (!this.current || e.defaultPrevented || e.target.closest('input, textarea, button, a, [role="slider"]')) return;
        if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
        if (e.key === 'ArrowLeft') this.seekBy(-5);
        if (e.key === 'ArrowRight') this.seekBy(5);
      });
    }

    /**
     * 待播清单，布局与交互参照 music.apple.com 的「待播清单」侧栏：
     * 标题与「清除」、55px 的行（封面 / 歌名与艺人 / 时长），悬停时封面左上角出现移除按钮；
     * 鼠标单击选中、双击播放，拖动整行调整顺序；触屏点按播放，拖动右侧把手调整顺序（与 iOS 相同）。
     * 键盘：↑/↓ 选择，Enter 播放，Delete 移除，Alt+↑/↓ 移动。
     * 窄屏时随机 / 重复按钮从播放条移到清单标题旁（与手机版相同）。
     * 面板放在播放条所在的文档中（外壳时为外壳），浮在播放条上方。
     */
    bindQueueUi() {
      const doc = this.root.ownerDocument;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'player-queue';
      button.innerHTML = ICON_QUEUE;
      button.setAttribute('aria-expanded', 'false');
      this.$('.player-right').insertBefore(button, this.$('.player-mode'));

      const panel = doc.createElement('section');
      panel.className = 'queue-panel';
      panel.id = 'queue-panel';
      panel.hidden = true;
      panel.innerHTML = '<header class="queue-head"><h2 class="queue-title"></h2>'
        + `<div class="queue-switches"><button class="player-switch player-shuffle" type="button" aria-pressed="false">${ICON_SHUFFLE}</button>`
        + '<button class="player-switch player-repeat" type="button" aria-pressed="false"></button></div>'
        + '<button class="queue-clear" type="button"></button></header>'
        + '<p class="queue-empty" hidden></p><ol class="queue-list"></ol>';
      doc.body.appendChild(panel);
      button.setAttribute('aria-controls', panel.id);
      this.queueButton = button;
      this.queuePanel = panel;
      this.queueKey = '';
      this.queueSelected = null;

      button.addEventListener('click', () => (panel.hidden ? this.openQueue() : this.closeQueue()));
      panel.querySelector('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      panel.querySelector('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      panel.querySelector('.queue-clear').addEventListener('click', () => {
        if (this.queue) {
          this.queue.entries.splice(this.queue.pos + 1);
          if (this.queue.ordered) this.queue.ordered = this.queue.entries.slice();
        }
        this.renderQueue(true);
        this.renderModes();
      });

      const list = panel.querySelector('.queue-list');
      const rowOf = (target) => target.closest('.queue-item');
      const indexOf = (row) => Number(row.dataset.index);
      let pointerType = 'mouse';
      list.addEventListener('click', (e) => {
        const row = rowOf(e.target);
        if (!row || !this.queue || this.queueDrag) return;
        if (e.target.closest('.queue-remove')) this.removeQueueEntry(indexOf(row));
        else if (pointerType === 'mouse') this.selectQueueRow(row);
        else this.playAt(indexOf(row));
      });
      list.addEventListener('dblclick', (e) => {
        const row = rowOf(e.target);
        if (row && this.queue && !e.target.closest('.queue-remove')) this.playAt(indexOf(row));
      });
      list.addEventListener('keydown', (e) => {
        const row = rowOf(e.target);
        if (!row || !this.queue || e.target !== row) return;
        const index = indexOf(row);
        const rows = [...list.querySelectorAll('.queue-item')];
        const at = rows.indexOf(row);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.playAt(index); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.removeQueueEntry(index); return; }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const step = e.key === 'ArrowUp' ? -1 : 1;
        if (!e.altKey) {
          const next = rows[at + step];
          if (next) { this.selectQueueRow(next); next.focus(); }
          return;
        }
        const to = index + step;
        if (to <= this.queue.pos || to >= this.queue.entries.length) return;
        this.moveQueueEntry(index, to);
        list.querySelector(`.queue-item[data-index="${to}"]`).focus();
      });

      // 拖动排序：经过其他行的中线时交换位置，松开后按新顺序写回队列。
      // 鼠标按住整行移动超过 4px 开始拖动；把手（触屏时显示）按下即开始。
      // 指针捕获放在列表上：拖动的行会在 DOM 中移动，移动会让行内元素失去捕获
      list.addEventListener('pointerdown', (e) => {
        pointerType = e.pointerType || 'mouse';
        const row = rowOf(e.target);
        if (!row || !this.queue || e.button !== 0 || e.target.closest('.queue-remove')) return;
        const entry = this.queue.entries[indexOf(row)];
        const grip = e.target.closest('.queue-grip');
        if (!entry || (!grip && pointerType !== 'mouse')) return;
        if (grip) e.preventDefault();
        const startY = e.clientY;
        let active = false;
        const begin = () => {
          active = true;
          list.setPointerCapture(e.pointerId);
          row.classList.add('dragging');
          list.classList.add('sorting');
          this.queueDrag = { row };
          this.selectQueueRow(row);
        };
        const move = (ev) => {
          if (!active) {
            if (Math.abs(ev.clientY - startY) < 4) return;
            begin();
          }
          ev.preventDefault();
          // 靠近列表上下边缘时自动滚动
          const box = list.getBoundingClientRect();
          if (ev.clientY < box.top + 28) list.scrollTop -= 8;
          else if (ev.clientY > box.bottom - 28) list.scrollTop += 8;
          for (const other of list.querySelectorAll('.queue-item:not(.dragging)')) {
            const r = other.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            // other 在拖动行之前：指针越过它的中线往上时移到它前面；在之后：越过中线往下时移到它后面
            const above = other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
            if (above && ev.clientY < mid) other.before(row);
            else if (!above && ev.clientY > mid) other.after(row);
          }
        };
        const end = () => {
          list.removeEventListener('pointermove', move);
          list.removeEventListener('pointerup', end);
          list.removeEventListener('pointercancel', end);
          if (!active) return;
          row.classList.remove('dragging');
          list.classList.remove('sorting');
          // 点击事件在 pointerup 之后触发，等它过去再允许点击
          setTimeout(() => { this.queueDrag = null; }, 0);
          // 拖动期间可能已播完一首（pos 变化）或队列被替换，按曲目重新定位
          const q = this.queue;
          const from = q ? q.entries.indexOf(entry) : -1;
          const to = q ? q.pos + 1 + [...list.querySelectorAll('.queue-item')].indexOf(row) : -1;
          if (q && from > q.pos && to > q.pos && to < q.entries.length && to !== from) this.moveQueueEntry(from, to);
          else this.renderQueue(true);
        };
        list.addEventListener('pointermove', move);
        list.addEventListener('pointerup', end);
        list.addEventListener('pointercancel', end);
        if (grip) begin();
      });

      this.renderQueueLang();
    }

    /** 选中一行（鼠标单击、方向键），重绘后按曲目保留 */
    selectQueueRow(row) {
      this.queueSelected = this.queue ? this.queue.entries[Number(row.dataset.index)] : null;
      for (const other of this.queuePanel.querySelectorAll('.queue-item')) other.classList.toggle('selected', other === row);
    }

    /** 把队列中 from 处的曲目移到 to（均在当前曲目之后） */
    moveQueueEntry(from, to) {
      const entries = this.queue.entries;
      const [entry] = entries.splice(from, 1);
      entries.splice(to, 0, entry);
      this.renderQueue(true);
    }

    removeQueueEntry(index) {
      const q = this.queue;
      const [entry] = q.entries.splice(index, 1);
      if (q.ordered) q.ordered.splice(q.ordered.indexOf(entry), 1);
      this.renderQueue(true);
      this.renderModes();
      // 焦点移到原位置的下一行，没有时回到上一行或清单按钮
      const rows = this.queuePanel.querySelectorAll('.queue-item');
      const next = rows[Math.min(index - q.pos - 1, rows.length - 1)];
      if (next) { this.selectQueueRow(next); next.focus(); } else this.queueButton.focus();
    }

    openQueue() {
      this.queuePanel.hidden = false;
      this.queueButton.setAttribute('aria-expanded', 'true');
      this.renderQueue(true);
      this.placeQueue();
      this.queuePanel.querySelector('.queue-list').scrollTop = 0;
    }

    closeQueue(refocus = false) {
      if (this.queuePanel.hidden) return;
      this.queuePanel.hidden = true;
      this.queueButton.setAttribute('aria-expanded', 'false');
      this.queueSelected = null;
      if (refocus) this.queueButton.focus();
    }

    /** 面板右边缘与播放条对齐，底部在播放条上方；播放条并入歌词界面或隐藏时收起 */
    placeQueue() {
      if (this.queuePanel.hidden) return;
      if (this.root.hidden || this.root.closest('.lyrics-controls')) { this.closeQueue(); return; }
      const win = this.root.ownerDocument.defaultView;
      const bar = this.root.getBoundingClientRect();
      this.queuePanel.style.right = `${Math.max(12, win.innerWidth - bar.right)}px`;
      this.queuePanel.style.bottom = `${win.innerHeight - bar.top + 10}px`;
    }

    renderQueueLang() {
      const label = t('player.queue');
      this.queueButton.setAttribute('aria-label', label);
      this.queueButton.title = label;
      this.queuePanel.setAttribute('aria-label', label);
      this.queuePanel.querySelector('.queue-title').textContent = label;
      this.queuePanel.querySelector('.queue-clear').textContent = t('player.queueClear');
      this.queuePanel.querySelector('.queue-empty').textContent = t('player.queueEmpty');
      this.renderModes();
      this.renderQueue(true);
    }

    /** 面板打开时重绘列表；队列与播放状态未变时跳过，拖动中不重绘 */
    renderQueue(force = false) {
      if (!this.queuePanel || this.queuePanel.hidden || (this.queueDrag && !force)) return;
      const q = this.queue;
      const upcoming = q ? q.entries.slice(q.pos + 1) : [];
      const key = q ? `${q.pos}|${q.entries.map((e) => e.track).join(',')}` : '';
      if (!force && key === this.queueKey) return;
      this.queueKey = key;
      this.queuePanel.querySelector('.queue-empty').hidden = upcoming.length > 0;
      this.queuePanel.querySelector('.queue-clear').hidden = !upcoming.length;
      const doc = this.root.ownerDocument;
      const list = this.queuePanel.querySelector('.queue-list');
      const focused = doc.activeElement && list.contains(doc.activeElement);
      list.replaceChildren(...upcoming.map((entry, i) => {
        const li = doc.createElement('li');
        li.className = 'queue-item';
        li.classList.toggle('selected', entry === this.queueSelected);
        li.dataset.index = String(q.pos + 1 + i);
        li.tabIndex = 0;
        li.title = t('player.queueHint');
        li.innerHTML = '<span class="queue-art-wrap"><img class="queue-art" alt="" loading="lazy" draggable="false">'
          + `<button class="queue-remove" type="button">${ICON_REMOVE}</button></span>`
          + '<span class="queue-text"><span class="queue-name"></span><span class="queue-artist"></span></span>'
          + `<span class="queue-time"></span><span class="queue-grip" aria-hidden="true">${ICON_GRIP}</span>`;
        const art = li.querySelector('.queue-art');
        if (entry.artwork) art.src = entry.artwork; else art.removeAttribute('src');
        li.querySelector('.queue-name').textContent = entry.name || t('player.unknownTitle');
        li.querySelector('.queue-artist').textContent = entry.artist || '';
        li.querySelector('.queue-time').textContent = entry.duration ? formatTime(entry.duration / 1000) : '';
        const remove = li.querySelector('.queue-remove');
        remove.tabIndex = -1;
        remove.setAttribute('aria-label', t('player.queueRemove', { name: entry.name || '' }));
        remove.title = t('player.queueRemove', { name: entry.name || '' });
        return li;
      }));
      if (focused && !list.contains(doc.activeElement)) this.queueButton.focus();
    }

    /* ---------- 随机播放与重复播放：状态保存在本地，与 Apple Music 相同，开启时按钮反色 ---------- */

    /** 开启随机时打乱当前曲目之后的歌曲并记住原顺序；关闭时从当前曲目在原顺序中的位置继续 */
    setShuffle(on) {
      this.shuffle = on;
      try { localStorage.setItem('am-hook:shuffle', on ? '1' : '0'); } catch {}
      const q = this.queue;
      if (q && on && !q.ordered) {
        q.ordered = q.entries.slice();
        shuffleFrom(q.entries, q.pos + 1);
      } else if (q && !on && q.ordered) {
        const rest = new Set(q.entries.slice(q.pos + 1));
        const at = q.ordered.indexOf(q.entries[q.pos]);
        q.entries.splice(q.pos + 1, Infinity, ...q.ordered.slice(at + 1).filter((entry) => rest.has(entry)));
        q.ordered = null;
      }
      this.renderModes();
      this.renderQueue(true);
    }

    /** 关 → 全部重复 → 单曲重复 → 关 */
    cycleRepeat() {
      this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
      try { localStorage.setItem('am-hook:repeat', this.repeat); } catch {}
      this.renderModes();
    }

    /** 播放条与清单标题旁的随机 / 重复按钮，以及上一首 / 下一首是否可用 */
    renderModes() {
      if (!this.queuePanel) return;
      const shuffleLabel = t('player.shuffle');
      const repeatLabel = t(`player.repeat.${this.repeat}`);
      for (const scope of [this.root, this.queuePanel]) {
        for (const btn of scope.querySelectorAll('.player-shuffle')) {
          btn.setAttribute('aria-pressed', String(this.shuffle));
          btn.setAttribute('aria-label', shuffleLabel);
          btn.title = shuffleLabel;
        }
        for (const btn of scope.querySelectorAll('.player-repeat')) {
          btn.setAttribute('aria-pressed', String(this.repeat !== 'off'));
          btn.setAttribute('aria-label', repeatLabel);
          btn.title = repeatLabel;
          if (btn.dataset.mode !== this.repeat) {
            btn.dataset.mode = this.repeat;
            btn.innerHTML = this.repeat === 'one' ? ICON_REPEAT_ONE : ICON_REPEAT;
          }
        }
      }
      const prev = this.$('.skip-prev');
      const next = this.$('.skip-next');
      if (prev) prev.disabled = !this.current;
      if (next) next.disabled = !this.hasNext();
    }

    hasNext() {
      const q = this.queue;
      return !!this.current && (!!(q && q.entries[q.pos + 1]) || this.repeat === 'all');
    }

    /** 下一首；auto 为播放到结尾时自动切换（单曲重复只在这时生效，手动下一首照常切歌） */
    next(auto = false) {
      if (!this.current) return;
      const q = this.queue;
      if (auto && this.repeat === 'one') { this.restart(); return; }
      if (q && q.entries[q.pos + 1]) { this.playAt(q.pos + 1); return; }
      if (this.repeat !== 'all') return;
      if (q && q.entries.length > 1) this.playAt(0); else this.restart();
    }

    /** 与 Apple Music 相同：已播放超过 3 秒时回到开头，否则上一首（全部重复时从第一首回到最后一首） */
    previous() {
      if (!this.current) return;
      const q = this.queue;
      const first = !q || q.pos === 0;
      if (this.transport().currentTime > 3 || (first && (this.repeat !== 'all' || !q || q.entries.length < 2))) { this.restart(); return; }
      this.playAt(first ? q.entries.length - 1 : q.pos - 1);
    }

    restart() {
      const transport = this.transport();
      transport.currentTime = 0;
      if (transport.paused) transport.play().catch((err) => this.showError(err.message));
    }

    /** 显示播放条，页面按其高度留出底部空间（通知、错误信息换行时高度会变） */
    show() {
      this.root.hidden = false;
      this.layout();
    }

    /** 播放条上边缘的位置（外壳的 iframe 铺满窗口，与页面中的坐标相同），隐藏时为 Infinity */
    barTop() {
      return this.root.hidden ? Infinity : this.root.getBoundingClientRect().top;
    }

    layout() {
      const height = `${this.root.getBoundingClientRect().height}px`;
      for (const doc of this.docs) {
        if (!doc.defaultView) { this.docs.delete(doc); continue; } // iframe 已跳转到其他页面
        if (!doc.body) continue;
        doc.body.style.setProperty('--player-height', height);
        doc.body.classList.toggle('has-player', !this.root.hidden);
      }
      this.placeQueue();
    }

    /**
     * iframe 中的页面使用外壳的播放条：返回与 AmPlayer 相同用法的接口。
     * 页面跳转后其文档失效，注册的回调随之移除。
     */
    connect(win) {
      const doc = win.document;
      if (!this.docs.has(doc)) {
        this.docs.add(doc);
        this.bindKeys(doc);
        this.layout();
      }
      const player = this;
      const scoped = (set) => (fn) => {
        const wrapped = (...args) => {
          if (!doc.defaultView) { set.delete(wrapped); return; }
          fn(...args);
        };
        set.add(wrapped);
      };
      // 条目在外壳中保存，复制为外壳的对象，页面卸载后仍可使用
      return {
        shared: true,
        get current() { return player.current; },
        get pendingTrack() { return player.pendingTrack; },
        get audio() { return player.audio; },
        transport: () => player.transport(),
        barTop: () => player.barTop(),
        play: (item) => player.play({ ...item }),
        playQueue: (entries, pos, options) => player.playQueue(entries.map((entry) => ({ ...entry })), pos, { ...options }),
        toggle: () => player.toggle(),
        pause: () => player.pause(),
        onChange: scoped(this.listeners),
        onUnsupported: scoped(this.unsupportedListeners),
      };
    }

    duration() {
      if (this.current && this.current.duration) return this.current.duration;
      return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }

    /**
     * item: { id, codecs, m3u8Url, hookM3u8Url, hookFileUrl, label, title, artist, album, artwork }
     * m3u8Url 为 CDN 原始地址（浏览器解密）；hook* 为服务端解密地址，仅 --hook 时存在。
     */
    async play(item) {
      // 单独播放另一首歌时结束队列；同一首歌切换音质时保留
      if (this.queue && item.track !== this.queue.entries[this.queue.pos].track) this.clearQueue();
      return this.start(item);
    }

    /**
     * entries：按原顺序排列的曲目（见 resolveEntry）；从 pos 开始，播完一首自动播放下一首。
     * options.shuffle 同时开启 / 关闭随机播放（页面上的「随机播放」「播放」按钮），省略时沿用当前状态。
     * 随机播放时 pos 处的歌曲排在最前，其余打乱；原顺序记在 ordered 中，关闭随机时恢复。
     */
    playQueue(entries, pos = 0, options = {}) {
      if (typeof options.shuffle === 'boolean' && options.shuffle !== this.shuffle) {
        this.shuffle = options.shuffle;
        try { localStorage.setItem('am-hook:shuffle', this.shuffle ? '1' : '0'); } catch {}
      }
      this.queue = { entries, pos, ordered: null };
      if (this.shuffle) {
        this.queue.ordered = entries.slice();
        entries.unshift(...entries.splice(pos, 1));
        shuffleFrom(entries, 1);
        this.queue.pos = 0;
      }
      return this.playAt(this.queue.pos);
    }

    clearQueue() {
      this.queue = null;
      this.queueSerial++;
      this.pendingTrack = null;
    }

    async playAt(pos) {
      const entry = this.queue.entries[pos];
      this.queue.pos = pos;
      const serial = ++this.queueSerial;
      this.pendingTrack = entry.track;
      this.emit();
      try {
        const item = await resolveEntry(entry);
        if (serial !== this.queueSerial) return;
        this.pendingTrack = null;
        await this.start(item);
      } catch (err) {
        if (serial !== this.queueSerial) return;
        this.pendingTrack = null;
        this.showError(() => (err.noPlayable ? err.message : t('album.trackFailed', { name: entry.name, msg: err.message })));
      }
      this.emit();
    }

    async start(item) {
      if (this.current && this.current.id === item.id) { this.toggle(); return; }
      const modes = detectModes(item.codecs, this.audio, !!item.hookM3u8Url);
      if (!modes.length) {
        this.showError(() => t('player.errorCodec', { codecs: item.codecs, hint: fallbackHint(item) }));
        return;
      }
      const token = ++this.playToken;
      // 同一首歌切换音质时从当前位置继续；专辑页换曲（track 不同）从头播放
      const resumeAt = this.current && this.current.track === item.track ? this.transport().currentTime : 0;
      this.current = { ...item, mode: modes[0], duration: 0 };
      this.show();
      this.showError('');
      this.$('.player-title').textContent = item.title || t('player.unknownTitle');
      this.$('.player-sub').textContent = [item.artist, item.label].filter(Boolean).join(' · ');
      const art = this.$('.player-art');
      if (item.artwork) {
        if (art.getAttribute('src') !== item.artwork) art.src = item.artwork;
      } else if (art.hasAttribute('src')) {
        art.removeAttribute('src');
      }
      this.setLoading(true);
      this.emit();
      this.updateMediaSession();

      // 依次尝试各播放方式，前一种因编码/格式不支持失败时自动换下一种
      let lastError = null;
      for (const mode of modes) {
        if (token !== this.playToken) return;
        this.current.mode = mode;
        this.current.duration = 0;
        this.renderMode();
        this.attempting = true;
        try {
          await this.tryMode(mode, item, resumeAt, token);
          this.attempting = false;
          this.renderProgress();
          return;
        } catch (err) {
          this.attempting = false;
          if (token !== this.playToken) return;
          if (err && err.name === 'NotAllowedError') {
            this.setLoading(false);
            this.showError(() => t('player.errorAutoplay'));
            return;
          }
          lastError = err;
          console.warn(`[am-hook] ${mode} 播放失败，尝试下一种方式`, err);
        }
      }

      this.teardown();
      failedCodecs.add(item.codecs);
      this.unsupportedListeners.forEach((fn) => fn(item.codecs));
      const detail = lastError && lastError.message ? ` (${lastError.message})` : '';
      this.showError(() => t('player.errorFailed', { label: item.label || item.codecs, codecs: item.codecs, hint: fallbackHint(item) }) + detail);
      this.emit();
    }

    teardown() {
      this.mse.destroy();
      if (this.pcm) { this.pcm.destroy(); this.pcm = null; }
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }

    async tryMode(mode, item, resumeAt, token) {
      this.teardown();
      if (mode === 'ec3') {
        this.pcm = new PcmEngine(() => this.updatePcm(), (err) => this.showError(err.message || String(err)), () => this.ended());
        this.pcm.gain.gain.value = this.audio.volume;
        await this.pcm.load(item.m3u8Url);
        if (token !== this.playToken) return;
        this.current.duration = this.pcm.duration;
        if (resumeAt > 0) await this.pcm.seek(resumeAt);
        await this.pcm.play();
        return;
      }
      if (mode === 'mse' || mode === 'flac') {
        await this.mse.load(item.m3u8Url, item.codecs, (err) => this.showError(err.message || String(err)), mode === 'flac');
        if (token !== this.playToken) return;
        this.current.duration = this.mse.playlist ? this.mse.playlist.duration : 0;
      } else {
        this.audio.src = mode === 'hls' ? byterangeUrl(item.hookM3u8Url) : item.hookFileUrl;
      }
      if (resumeAt > 0) this.audio.currentTime = resumeAt;
      await this.audio.play();
    }

    /** 某编码经实际尝试确认无法播放时回调 */
    onUnsupported(fn) { this.unsupportedListeners.add(fn); }

    /** 当前曲目播放到结尾（audio 与 EC-3 PCM 两种方式）：按重复模式播放下一首或重新播放 */
    ended() { if (this.current) this.next(true); }

    toggle() {
      if (!this.current) return;
      const transport = this.transport();
      if (transport.paused) transport.play().catch((err) => this.showError(err.message)); else transport.pause();
    }

    /** 其他媒体（如 MV）开始播放时暂停 */
    pause() {
      if (this.current && !this.transport().paused) this.transport().pause();
    }

    seekBy(delta) {
      const d = this.duration();
      if (!d) return;
      const transport = this.transport();
      transport.currentTime = Math.min(Math.max(0, transport.currentTime + delta), d - 0.1);
    }

    setLoading(on) {
      this.loading = on;
      this.renderToggle();
    }

    renderToggle() {
      const a = this.transport();
      const waiting = this.loading && a.paused || (!a.paused && this.current.mode !== 'ec3' && a.readyState < 3);
      if (!a.paused) this.loading = false;
      const btn = this.$('.player-toggle');
      btn.innerHTML = waiting ? ICON_LOADING : (a.paused ? ICON_PLAY : ICON_PAUSE);
      btn.setAttribute('aria-label', t(a.paused ? 'player.play' : 'player.pause'));
    }

    renderProgress() {
      const d = this.duration();
      const transport = this.transport();
      const t = this.dragRatio !== undefined ? this.dragRatio * d : transport.currentTime;
      const ratio = d ? Math.min(1, t / d) : 0;
      this.$('.seek-fill').style.width = `${ratio * 100}%`;
      this.$('.seek-thumb').style.left = `${ratio * 100}%`;
      let bufEnd = 0;
      if (this.current && this.current.mode === 'ec3' && this.pcm) {
        bufEnd = this.pcm.loadedUntil;
      } else {
        const b = this.audio.buffered;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= transport.currentTime + 0.5) bufEnd = Math.max(bufEnd, b.end(i));
        }
      }
      this.$('.seek-buffer').style.width = `${d ? Math.min(1, bufEnd / d) * 100 : 0}%`;
      this.$('.time-cur').textContent = formatTime(t);
      this.$('.time-total').textContent = formatTime(d);
      const seek = this.$('.seek');
      seek.setAttribute('aria-valuemax', String(Math.round(d)));
      seek.setAttribute('aria-valuenow', String(Math.round(t)));
      seek.setAttribute('aria-valuetext', `${formatTime(t)} / ${formatTime(d)}`);
      if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(transport.currentTime, d), playbackRate: 1 }); } catch {}
      }
    }

    updateMediaSession() {
      if (!('mediaSession' in navigator) || !global.MediaMetadata) return;
      const source = this.current.artwork || '';
      if (source !== this.mediaArtSource) {
        if (this.mediaArtController) this.mediaArtController.abort();
        if (this.mediaArtUrl) URL.revokeObjectURL(this.mediaArtUrl);
        this.mediaArtSource = source;
        this.mediaArtController = this.mediaArtUrl = this.mediaArtType = null;
        if (source) {
          // Reuse one local image for every quality of the same song.
          const controller = new AbortController();
          this.mediaArtController = controller;
          fetch(source, { signal: controller.signal, cache: 'force-cache' })
            .then((response) => {
              if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
              return response.blob();
            })
            .then((blob) => {
              if (controller.signal.aborted || this.mediaArtSource !== source) return;
              this.mediaArtUrl = URL.createObjectURL(blob);
              this.mediaArtType = blob.type || 'image/jpeg';
              this.writeMediaMetadata();
            })
            .catch(() => {}); // The player bar still displays the original image.
        }
      }
      this.writeMediaMetadata();
    }

    writeMediaMetadata() {
      const c = this.current;
      const state = {
        title: c.title || '',
        artist: c.artist || '',
        album: c.album || '',
        artwork: this.mediaArtUrl || '',
      };
      const previous = this.mediaMetadataState;
      if (previous && Object.keys(state).every((key) => state[key] === previous[key])) return;
      this.mediaMetadataState = state;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.title,
        artist: state.artist,
        album: state.album,
        artwork: this.mediaArtUrl
          ? [{ src: this.mediaArtUrl, sizes: '600x600', type: this.mediaArtType }]
          : [],
      });
    }

    /** msg 可以是函数，切换语言时重新求值 */
    showError(msg) {
      this.errorMsg = msg || null;
      this.renderError();
      if (msg) {
        this.show();
        this.setLoading(false);
      }
    }

    renderError() {
      const el = this.$('.player-msg');
      const msg = this.errorMsg;
      el.textContent = typeof msg === 'function' ? msg() : (msg || '');
      el.hidden = !msg;
    }
  }

  /** 页面的播放条：在外壳的 iframe 中时使用外壳的播放器（移除页面自己的播放条），否则在页面内创建 */
  function pagePlayer(root) {
    let shell = null;
    try { shell = global.parent !== global && global.parent.AmShell; } catch {}
    if (!shell) return new AmPlayer(root);
    root.remove();
    return shell.attach(global);
  }

  const api = { AmPlayer, pagePlayer, segmentAt, formatTime, detectMode, detectModes, mimeFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, MseEngine };
  else global.AmHook = api;
})(typeof window !== 'undefined' ? window : globalThis);
