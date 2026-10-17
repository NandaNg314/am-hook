/**
 * 本机（浏览器端）下载共享逻辑：解密 + 标准 m4a 封装 + 官方元数据/封面/歌词注入。
 *
 * 背景（修复动机）：
 *   原先 song.mjs 有完整的 AmDecrypt + tagMp4 链路，而 album.mjs / playlist.mjs /
 *   artist.mjs 的「本机下载」直接把 `master m3u8 的 _m.mp4 直链` 丢给 `<a download>`——
 *   那串 URL 是**加密媒体**，产物既无标签也放不出声。四视图行为不一致且批量路径完全失效。
 *
 *   本模块把 song.mjs 中验证过的实现抽出来，供四个视图统一调用，杜绝再次分叉。
 *
 * 关键不变量（改动前务必阅读 PROJECT_MEMORY.md §3.1 / §3.24）：
 *   1. MP4 iTunes 标签名含非 ASCII 的 `\xa9`，必须用 charCodeAt 保证单字节（TextEncoder 会编成 2 字节）。
 *   2. `moov -> udta -> meta` 内必须有 33 字节 `hdlr`(mdir/appl)。
 *   3. 注入标签使 moov 变大 delta 字节；若 mdat 在 moov 之后，必须同步修补 stco/co64，
 *      否则播放器按旧偏移读到 moov 内部垃圾（典型症状：开头响一声随即卡死）。
 *   4. 标签数据来自 amp-api 元数据，缺元数据时不要静默产出零标签文件。
 */

/** 元数据查询候选区：与服务端保持一致的中文优先策略 */
// 华语区嗅探顺序：cn 简体优先，us 次之（常返回 zh-Hans-CN 简体，如 1721449919），
// 再退 hk / tw 繁体（后续经 toSimplified 归一）。
// 实测：hk 与 tw 覆盖互补——536248195 只有 cn/tw 有，1721449919 只有 hk/us 有，
// 因此四区都要试，不能因为前面的区 404 就收手。
const CHINESE_STOREFRONTS = ['cn', 'us', 'hk', 'tw'];

/* ==================== 采样描述规范化（修复 Salt Player 等严格解析器「编码错误」） ==================== */

/**
 * 规范化 MP4 的 `stsd` 采样描述，使其与 ffmpeg `-c copy` 重封装产物一致：
 *   1. 剥除样本条目内被解密流程改名成 `free` 的保护头（原 `sinf`，97 字节零填充）——
 *      严格解析器（Salt Player / Android ExoPlayer `Mp4Extractor`）在样本条目里遇到该 `free`
 *      会直接抛 ParserException（界面显示「编码错误」）。
 *   2. 合并字节完全相同的重复样本条目，并把 `stsc` 的 sample_description_index 重映射到保留项。
 *   3. 同步修补所有祖先 box（trak/mdia/minf/stbl/moov）的 size，以及 mdat 位于 moov 之后时
 *      所有 stco/co64 的 chunk offset（收缩 delta 为负，偏移整体前移）。
 *
 * 背景：Apple 加密 HLS 的 init 段 `stsd` 常含两个 identical `enca` 条目；解密时两者都被改回
 * `alac` 并各带一个 `free`（原 `sinf`），defrag 原样保留 → 产物结构异于服务端 ffmpeg 重封装结果。
 * 服务端走 ffmpeg 会自动剥 `free` 并去重，浏览器端（无 ffmpeg）必须自行等价处理。
 *
 * @param {Uint8Array} input 已解碎片的 progressive MP4
 * @returns {Uint8Array} 规范化后的 MP4（未做任何修改时原样返回）
 */
export function normalizeSampleEntries(input) {
  const bytes = input;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type4 = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  const be32 = (o) => dv.getUint32(o, false);
  const boxSize = (o) => {
    let size = be32(o);
    if (size === 1) size = Number(dv.getBigUint64(o + 8, false));
    return size;
  };
  const sections = (start, end) => {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      const size = boxSize(p);
      if (size < 8 || p + size > end) break;
      out.push({ start: p, size, type: type4(p + 4), body: p + 8, end: p + size });
      p += size;
    }
    return out;
  };
  const findChild = (start, end, name) => {
    for (const s of sections(start, end)) if (s.type === name) return s.start;
    return -1;
  };
  const AUDIO_FIELDS = (t) => ['mp4a', 'alac', 'enca', 'ec-3', 'fLaC'].includes(t);
  const stripFree = (e) => {
    const fields = AUDIO_FIELDS(e.type) ? 28 : 78;
    let q = e.start + 8 + fields;
    let cut = e.end;
    while (q + 8 <= e.end) {
      const cs = be32(q);
      const ct = type4(q + 4);
      if (cs < 8) break;
      if (ct === 'free' || ct === 'skip') { cut = q; break; }
      q += cs;
    }
    return cut;
  };
  const hasFreeOrDup = (entries) => {
    if (entries.length > 1) return true;
    return entries.some((e) => stripFree(e) !== e.end);
  };

  const moov = findChild(0, bytes.length, 'moov');
  if (moov < 0) return input;
  const moovSize = be32(moov);
  const moovEnd = moov + moovSize;

  const edits = [];
  for (const trak of sections(moov + 8, moovEnd)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(trak.body, trak.end, 'mdia');
    if (mdia < 0) continue;
    const minf = findChild(mdia + 8, mdia + be32(mdia), 'minf');
    if (minf < 0) continue;
    const stbl = findChild(minf + 8, minf + be32(minf), 'stbl');
    if (stbl < 0) continue;
    const stblEnd = stbl + be32(stbl);
    const stsd = findChild(stbl + 8, stblEnd, 'stsd');
    if (stsd < 0) continue;
    const stsdEnd = stsd + be32(stsd);
    const entryCount = be32(stsd + 12);

    const entries = [];
    let p = stsd + 16;
    for (let i = 0; i < entryCount && p + 8 <= stsdEnd; i++) {
      const size = be32(p);
      if (size < 8) break;
      entries.push({ start: p, size, type: type4(p + 4), end: p + size });
      p += size;
    }
    if (!entries.length || !hasFreeOrDup(entries)) continue;

    // 剥 `free` 尾部并按内容去重
    const stripped = entries.map((e) => {
      const cut = stripFree(e);
      const buf = bytes.slice(e.start, cut);
      new DataView(buf.buffer).setUint32(0, buf.length, false);
      return { type: e.type, bytes: buf };
    });
    const unique = [];
    const indexMap = new Map();
    for (let i = 0; i < stripped.length; i++) {
      const s = stripped[i];
      let found = unique.findIndex((u) => u.bytes.length === s.bytes.length && u.bytes.every((v, k) => v === s.bytes[k]));
      if (found === -1) { unique.push(s); found = unique.length - 1; }
      indexMap.set(i + 1, found + 1);
    }

    // 组装新的 stsd
    let payloadLen = 8;
    for (const u of unique) payloadLen += u.bytes.length;
    const newStsd = new Uint8Array(payloadLen + 8);
    const nv = new DataView(newStsd.buffer);
    nv.setUint32(0, newStsd.length, false);
    newStsd.set(new TextEncoder().encode('stsd'), 4);
    nv.setUint32(8, 0, false); // version & flags
    nv.setUint32(12, unique.length, false); // entry_count
    let off = 16;
    for (const u of unique) { newStsd.set(u.bytes, off); off += u.bytes.length; }

    const stsdDelta = newStsd.length - (stsdEnd - stsd);
    edits.push({ start: stsd, end: stsdEnd, replacement: newStsd });
    for (const anc of [trak.start, mdia, minf, stbl]) {
      const patched = bytes.slice(anc, anc + 8);
      new DataView(patched.buffer).setUint32(0, (be32(anc) + stsdDelta) >>> 0, false);
      edits.push({ start: anc, end: anc + 8, replacement: patched });
    }

    // 重映射 stsc 的 sample_description_index
    const stsc = findChild(stbl + 8, stblEnd, 'stsc');
    if (stsc >= 0 && [...indexMap].some(([o, n]) => o !== n)) {
      const stscEnd = stsc + be32(stsc);
      const copy = bytes.slice(stsc, stscEnd);
      const cv = new DataView(copy.buffer);
      const cnt = cv.getUint32(12, false);
      for (let i = 0; i < cnt; i++) {
        const at = 16 + i * 12 + 8;
        const oldIdx = cv.getUint32(at, false);
        const newIdx = indexMap.get(oldIdx) || oldIdx;
        cv.setUint32(at, newIdx, false);
      }
      edits.push({ start: stsc, end: stscEnd, replacement: copy });
    }
  }

  if (!edits.length) return input;
  edits.sort((a, b) => a.start - b.start);

  let delta = 0;
  for (const e of edits) delta += e.replacement.length - (e.end - e.start);
  if (delta === 0) return input;

  const out = new Uint8Array(bytes.length + delta);
  let src = 0;
  let dst = 0;
  for (const e of edits) {
    out.set(bytes.subarray(src, e.start), dst);
    dst += e.start - src;
    out.set(e.replacement, dst);
    dst += e.replacement.length;
    src = e.end;
  }
  out.set(bytes.subarray(src), dst);

  const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  odv.setUint32(moov, moovSize + delta, false);
  const newMoovEnd = moov + moovSize + delta;

  // mdat 位于 moov 之后：所有 chunk offset 随 moov 收缩前移 delta
  let mdat = -1;
  let q = 0;
  while (q + 8 <= out.length) {
    const s = odv.getUint32(q, false);
    if (String.fromCharCode(out[q + 4], out[q + 5], out[q + 6], out[q + 7]) === 'mdat') { mdat = q; break; }
    if (s === 0) break;
    q += s;
  }
  if (mdat > moov) {
    const oType = (o) => String.fromCharCode(out[o], out[o + 1], out[o + 2], out[o + 3]);
    const oSections = (start, end) => {
      const res = [];
      let pp = start;
      while (pp + 8 <= end) {
        const size = odv.getUint32(pp, false);
        if (size < 8 || pp + size > end) break;
        res.push({ start: pp, size, type: oType(pp + 4), body: pp + 8, end: pp + size });
        pp += size;
      }
      return res;
    };
    const oFind = (start, end, name) => {
      for (const s of oSections(start, end)) if (s.type === name) return s.start;
      return -1;
    };
    for (const trak of oSections(moov + 8, newMoovEnd)) {
      if (trak.type !== 'trak') continue;
      const mdia = oFind(trak.body, trak.end, 'mdia'); if (mdia < 0) continue;
      const minf = oFind(mdia + 8, mdia + odv.getUint32(mdia, false), 'minf'); if (minf < 0) continue;
      const stbl = oFind(minf + 8, minf + odv.getUint32(minf, false), 'stbl'); if (stbl < 0) continue;
      const stblEnd = stbl + odv.getUint32(stbl, false);
      for (const name of ['stco', 'co64']) {
        const box = oFind(stbl + 8, stblEnd, name);
        if (box < 0) continue;
        const cnt = odv.getUint32(box + 12, false);
        const esz = name === 'co64' ? 8 : 4;
        for (let i = 0; i < cnt; i++) {
          const at = box + 16 + i * esz;
          if (esz === 4) odv.setUint32(at, (odv.getUint32(at, false) + delta) >>> 0, false);
          else odv.setBigUint64(at, odv.getBigUint64(at, false) + BigInt(delta), false);
        }
      }
    }
  }
  return out;
}

/* ==================== MP4 标签注入引擎 ==================== */

function createDataAtom(type, flags, payload) {
  // MP4 fourcc 必须精确 4 字节，非 ASCII (如 \xa9) 必须用 charCodeAt 保证单字节
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const dataHeader = new Uint8Array(16);
  const dataView = new DataView(dataHeader.buffer);
  const dataSize = 16 + payload.length;
  dataView.setUint32(0, dataSize, false);
  dataHeader.set(new TextEncoder().encode('data'), 4);
  dataView.setUint32(8, flags, false);
  dataView.setUint32(12, 0, false);

  const atomSize = 8 + dataSize;
  const atomHeader = new Uint8Array(8);
  new DataView(atomHeader.buffer).setUint32(0, atomSize, false);
  atomHeader.set(typeBytes, 4);

  const res = new Uint8Array(atomSize);
  res.set(atomHeader, 0);
  res.set(dataHeader, 8);
  res.set(payload, 24);
  return res;
}

function createTextAtom(name, text) {
  if (!text) return new Uint8Array(0);
  return createDataAtom(name, 1, new TextEncoder().encode(String(text)));
}

function createTrackAtom(trackNum, totalTracks = 0) {
  if (!trackNum) return new Uint8Array(0);
  const buf = new Uint8Array(8);
  const v = new DataView(buf.buffer);
  v.setUint16(2, Number(trackNum) || 0, false);
  v.setUint16(4, Number(totalTracks) || 0, false);
  return createDataAtom('trkn', 0, buf);
}

function createDiscAtom(discNum, totalDiscs = 0) {
  if (!discNum) return new Uint8Array(0);
  const buf = new Uint8Array(6);
  const v = new DataView(buf.buffer);
  v.setUint16(2, Number(discNum) || 0, false);
  v.setUint16(4, Number(totalDiscs) || 0, false);
  return createDataAtom('disk', 0, buf);
}

function createCoverAtom(imageBuf) {
  if (!imageBuf || !imageBuf.length) return new Uint8Array(0);
  const isPng = imageBuf[0] === 0x89 && imageBuf[1] === 0x50 && imageBuf[2] === 0x4e && imageBuf[3] === 0x47;
  const flag = isPng ? 14 : 13;
  return createDataAtom('covr', flag, imageBuf);
}

/**
 * 向标准 Progressive MP4 注入 iTunes 元数据（含封面与歌词）。
 * @returns {{ bytes: Uint8Array, tagged: boolean }} tagged=false 表示未写入任何标签（元数据为空）
 */
export function tagMp4(mp4Bytes, tags) {
  const atoms = [];
  if (tags.title) atoms.push(createTextAtom('\xa9nam', tags.title));
  if (tags.artist) atoms.push(createTextAtom('\xa9ART', tags.artist));
  if (tags.album) atoms.push(createTextAtom('\xa9alb', tags.album));
  if (tags.albumArtist) atoms.push(createTextAtom('aART', tags.albumArtist));
  if (tags.date) atoms.push(createTextAtom('\xa9day', String(tags.date)));
  if (tags.genre) atoms.push(createTextAtom('\xa9gen', tags.genre));
  if (tags.composer) atoms.push(createTextAtom('\xa9wrt', tags.composer));
  if (tags.copyright) atoms.push(createTextAtom('cprt', tags.copyright));
  if (tags.lyrics) atoms.push(createTextAtom('\xa9lyr', tags.lyrics));
  if (tags.trackNumber) atoms.push(createTrackAtom(tags.trackNumber, tags.totalTracks || 0));
  if (tags.discNumber) atoms.push(createDiscAtom(tags.discNumber, tags.totalDiscs || 0));
  if (tags.cover) atoms.push(createCoverAtom(tags.cover));

  const totalPayloadLen = atoms.reduce((sum, a) => sum + a.length, 0);
  // 标签一个都没写成时必须可见，不能静默返回原文件
  if (totalPayloadLen === 0) {
    console.warn('[am-hook] tagMp4: 无有效标签可写入（元数据缺失），跳过注入');
    return { bytes: mp4Bytes, tagged: false };
  }

  const ilstSize = 8 + totalPayloadLen;
  const fullNewIlst = new Uint8Array(ilstSize);
  new DataView(fullNewIlst.buffer).setUint32(0, ilstSize, false);
  fullNewIlst.set(new TextEncoder().encode('ilst'), 4);
  let pos = 8;
  for (const a of atoms) {
    fullNewIlst.set(a, pos);
    pos += a.length;
  }

  const dv = new DataView(mp4Bytes.buffer, mp4Bytes.byteOffset, mp4Bytes.byteLength);
  let moovOffset = -1;
  let moovSize = 0;
  let mdatOffset = -1;
  let offset = 0;
  while (offset + 8 <= mp4Bytes.length) {
    let size = dv.getUint32(offset, false);
    const type = String.fromCharCode(...mp4Bytes.subarray(offset + 4, offset + 8));
    if (size === 1) {
      if (offset + 16 <= mp4Bytes.length) size = Number(dv.getBigUint64(offset + 8, false));
      else break;
    }
    if (type === 'moov') {
      moovOffset = offset;
      moovSize = size;
    } else if (type === 'mdat') {
      if (mdatOffset === -1) mdatOffset = offset;
    }
    if (size === 0) break;
    offset += size;
  }
  if (moovOffset === -1) return { bytes: mp4Bytes, tagged: false };

  const moovBytes = mp4Bytes.subarray(moovOffset, moovOffset + moovSize);
  let udtaOffset = -1;
  let udtaSize = 0;
  let uOffset = 8;
  const mdv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  while (uOffset + 8 <= moovBytes.length) {
    const size = mdv.getUint32(uOffset, false);
    const type = String.fromCharCode(...moovBytes.subarray(uOffset + 4, uOffset + 8));
    if (type === 'udta') {
      udtaOffset = uOffset;
      udtaSize = size;
      break;
    }
    if (size === 0) break;
    uOffset += size;
  }

  // 标准 iTunes Metadata Handler (33 字节，所有播放器与系统属性读取器均强制要求)
  const hdlrBox = new Uint8Array([
    0x00, 0x00, 0x00, 0x21, // size: 33
    0x68, 0x64, 0x6c, 0x72, // 'hdlr'
    0x00, 0x00, 0x00, 0x00, // version & flags
    0x00, 0x00, 0x00, 0x00, // predefined
    0x6d, 0x64, 0x69, 0x72, // handler type: 'mdir'
    0x61, 0x70, 0x70, 0x6c, // handler subtype: 'appl'
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
    0x00                     // name
  ]);

  const metaSize = 12 + hdlrBox.length + fullNewIlst.length;
  const metaBox = new Uint8Array(metaSize);
  new DataView(metaBox.buffer).setUint32(0, metaSize, false);
  metaBox.set(new TextEncoder().encode('meta'), 4);
  metaBox.set(hdlrBox, 12);
  metaBox.set(fullNewIlst, 12 + hdlrBox.length);

  const udtaTotal = 8 + metaBox.length;
  const finalUdta = new Uint8Array(udtaTotal);
  new DataView(finalUdta.buffer).setUint32(0, udtaTotal, false);
  finalUdta.set(new TextEncoder().encode('udta'), 4);
  finalUdta.set(metaBox, 8);

  const newMoovSize = (udtaOffset === -1 ? moovSize : moovSize - udtaSize) + finalUdta.length;
  const newMoov = new Uint8Array(newMoovSize);
  const moovBeforeUdta = udtaOffset === -1 ? moovBytes : moovBytes.subarray(0, udtaOffset);
  const moovAfterUdta = udtaOffset === -1 ? new Uint8Array(0) : moovBytes.subarray(udtaOffset + udtaSize);

  newMoov.set(moovBeforeUdta, 0);
  newMoov.set(finalUdta, moovBeforeUdta.length);
  newMoov.set(moovAfterUdta, moovBeforeUdta.length + finalUdta.length);
  new DataView(newMoov.buffer).setUint32(0, newMoovSize, false);

  const delta = newMoovSize - moovSize;

  // 当 moov 位于 mdat 之前时，moov 扩容 delta 字节导致 mdat 整体后移 delta 字节，
  // 必须同步修正 moov 内所有 stco / co64 chunk offset
  if (delta !== 0 && mdatOffset !== -1 && mdatOffset > moovOffset) {
    const patchView = new DataView(newMoov.buffer, newMoov.byteOffset, newMoov.byteLength);
    for (let i = 0; i <= newMoov.length - 16; i++) {
      const type = String.fromCharCode(...newMoov.subarray(i + 4, i + 8));
      if (type === 'stco') {
        const boxSize = patchView.getUint32(i, false);
        const entryCount = patchView.getUint32(i + 12, false);
        if (boxSize === 16 + entryCount * 4) {
          let p = i + 16;
          for (let e = 0; e < entryCount; e++) {
            patchView.setUint32(p, patchView.getUint32(p, false) + delta, false);
            p += 4;
          }
          i += boxSize - 1;
        }
      } else if (type === 'co64') {
        const boxSize = patchView.getUint32(i, false);
        const entryCount = patchView.getUint32(i + 12, false);
        if (boxSize === 16 + entryCount * 8) {
          let p = i + 16;
          for (let e = 0; e < entryCount; e++) {
            patchView.setBigUint64(p, patchView.getBigUint64(p, false) + BigInt(delta), false);
            p += 8;
          }
          i += boxSize - 1;
        }
      }
    }
  }

  const finalMp4 = new Uint8Array(mp4Bytes.length - moovSize + newMoovSize);
  finalMp4.set(mp4Bytes.subarray(0, moovOffset), 0);
  finalMp4.set(newMoov, moovOffset);
  finalMp4.set(mp4Bytes.subarray(moovOffset + moovSize), moovOffset + newMoovSize);
  return { bytes: finalMp4, tagged: true };
}

/* ==================== 歌词解析 ==================== */

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const str = timeStr.trim().replace(/s$/i, '');
  if (str.includes(':')) {
    const parts = str.split(':');
    if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(str) || 0;
}

function formatLrcTimestamp(seconds) {
  const safeSec = Math.max(0, seconds);
  const m = Math.floor(safeSec / 60);
  const s = (safeSec % 60).toFixed(2);
  return `[${String(m).padStart(2, '0')}:${s.padStart(5, '0')}]`;
}

const EMPTY_LYRICS = { hasLyrics: false, isDynamic: false, lrc: '', plain: '', ttml: '' };

/** 与 cloud-service.mjs 的 unescapeXml 等价：TTML 文本节点实体还原 */
const unescapeXml = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/**
 * 与 cloud-service.mjs 的 normalizeLyricGlyphs 完全一致：
 * Apple 的日文歌词正文里混入了康熙部首码位（「⼆⼈」实为「二人」），多数播放器渲染成方块，NFKC 归一化后等价还原。
 * 只处理：康熙部首 (2E80–2FFF) / 兼容汉字 (F900–FAFF) / 全角 ASCII (FF01–FF5E) / 半全角片假名 (FF61–FF9F)。
 * ⚠️ 不可整段处理 U+FF00–FFEF：其中 U+FFA0–FFDC 是半角谚文，NFKC 会拆成组合字母，正文出现就会乱码。
 */
export function normalizeLyricGlyphs(str) {
  if (!str) return str;
  return str.replace(/[\u2E80-\u2FFF\uF900-\uFAFF\uFF01-\uFF5E\uFF61-\uFF9F]/g, (ch) => ch.normalize('NFKC'));
}

/**
 * 罗马音 → 平假名（Apple 只给罗马音，假名由这里反推）
 *
 * ⚠️ 与 cloud-service.mjs 的 romanToHiragana **必须逐字一致**（浏览器端无法 import 服务端文件）。
 *    改一边必须同步改另一边。详细策略见服务端注释。
 */
function romanToHiragana(roman) {
  if (!roman) return '';
  // 三字母优先于两字母（否则 sh/ny/j 等前缀会抢占）
  const TRIPLE = {
    kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
    sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
    cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
    nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ', hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
    bya: 'びゃ', byu: 'びゅ', byo: 'びょ', pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
    mya: 'みゃ', myu: 'みゅ', myo: 'みょ', rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
    dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
    // n + 拗音 / n + j（shinjuku → しんじゅく），必须早于两字母 nj / ja
    nja: 'んじゃ', nju: 'んじゅ', njo: 'んじょ',
    nji: 'んじ', nje: 'んじぇ',
    // nn 表拨音而非促音
    nna: 'んな', nni: 'んに', nnu: 'んぬ', nne: 'んね', nno: 'んの',
    // 三字母基本音节（否则会先撞上两字母的 sh/ch/ts 前缀而落空）
    shi: 'し', chi: 'ち', tsu: 'つ', she: 'しぇ', che: 'ちぇ', je: 'じぇ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
    dhi: 'でぃ', dhu: 'でゅ',
  };
  const PAIR = {
    ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
    sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ', za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
    ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と', da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
    na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の', ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
    ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ', pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
    ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も', ya: 'や', yu: 'ゆ', yo: 'よ',
    ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ', wa: 'わ', wo: 'を',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
    wi: 'うぃ', we: 'うぇ',
    // 外来语两字母写法（fe 等三字母表同名项在此也需保留，否则 fensu → ふえんす）
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
  };
  const SINGLE = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', n: 'ん' };
  // 单个辅音字母（法语词 fensu、德语词 等罗马音里偶尔出现的非日语音节）的近似转写，
  // 保证假名模式下**不残留拉丁字母**
  const LONE = {
    k: 'く', g: 'ぐ', s: 'す', z: 'ず', j: 'じ', t: 'と', d: 'ど',
    h: 'ふ', f: 'ふ', b: 'ぶ', p: 'ぷ', m: 'む', y: 'い', r: 'る', w: 'う',
    c: 'く', v: 'ゔ', l: 'る', q: 'く', x: 'く',
  };
  const isVowel = (c) => 'aiueo'.includes(c);
  const isConsonant = (c) => c >= 'a' && c <= 'z' && !isVowel(c) && c !== 'n';

  /** 转换单个纯字母片段；返回 { text, complete }。complete=false 表示有字母没转成假名 */
  const convertChunk = (s) => {
    const out = [];
    let i = 0;
    let complete = true;
    while (i < s.length) {
      const ch = s[i];
      // 促音：同辅音双写（kko → っこ），n 双写表示拨音不算促音
      if (ch !== 'n' && isConsonant(ch) && s[i + 1] === ch) {
        out.push('っ');
        i += 1;
        continue;
      }
      // n 结尾，或 n 后接辅音（非 y/j）→ ん；n + y/j 能构成拗音时才合并（konya → こにゃ、shinjuku → しんじゅく）
      if (ch === 'n') {
        const next = s[i + 1];
        const mergesWithN = (next === 'y' || next === 'j') && TRIPLE[s.slice(i, i + 3)];
        if (next === undefined || (next !== 'y' && next !== 'j' && !isVowel(next)) || ((next === 'y' || next === 'j') && !mergesWithN)) {
          out.push('ん');
          i += 1;
          continue;
        }
      }
      const tri = s.slice(i, i + 3);
      if (TRIPLE[tri]) { out.push(TRIPLE[tri]); i += 3; continue; }
      const pair = s.slice(i, i + 2);
      if (PAIR[pair]) { out.push(PAIR[pair]); i += 2; continue; }
      if (SINGLE[ch]) { out.push(SINGLE[ch]); i += 1; continue; }
      // 兜底：单字母近似，不让拉丁字母漏进假名行
      complete = false;
      out.push(LONE[ch] || ch);
      i += 1;
    }
    return { text: out.join(''), complete };
  };

  // 按拉丁字母段切分，空格 / 标点 / 数字原样保留。
  // 转换失败的字母按单字母近似兜底（fensu → ふぇんす），保证假名行不残留拉丁字母。
  return String(roman)
    .split(/([a-z]+)/i)
    .map((part) => (/[a-z]/i.test(part) ? convertChunk(part.toLowerCase()).text : part))
    .join('')
    .replace(/ー+/g, 'ー');
}

/** 从 TTML 的 <transliterations> 按 itunes:key 提取日语罗马音行 */
export function extractTransliterationMap(ttmlContent) {
  const block = ttmlContent.match(/<transliterations\b[^>]*>([\s\S]*?)<\/transliterations>/i);
  if (!block) return null;
  const latin = block[1].match(/<transliteration\b[^>]*xml:lang=["']ja-Latn["'][^>]*>([\s\S]*?)<\/transliteration>/i);
  if (!latin) return null;
  const map = {};
  const textRe = /<text\b[^>]*for=["']([^"']+)["'][^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = textRe.exec(latin[1])) !== null) {
    const body = unescapeXml(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (m[1] && body) map[m[1]] = body;
  }
  return Object.keys(map).length ? map : null;
}

/**
 * 给结构化歌词行附加注音行，每行输出顺序固定为「原文 / 注音 / 译文」。
 * 无日语罗马音（非日文歌）时返回 null，由调用方保持原文。
 */
export function annotateLyricLines(ttmlContent, baseLines, mode = 'roman') {
  if (!ttmlContent || !Array.isArray(baseLines) || !baseLines.length) return null;
  const transMap = extractTransliterationMap(ttmlContent);
  if (!transMap) return null;
  const out = [];
  let injected = 0;
  for (const line of baseLines) {
    const prefix = line.time ? `${line.time} ` : '';
    out.push(`${prefix}${line.text}`);
    // 只有带 itunes:key 的行才能对齐罗马音；纯文本降级路径 key 为 ''，命中会串行
    const roman = line.key ? transMap[line.key] : '';
    if (roman) {
      const plainBody = String(line.text || '').replace(/\s+/g, '').toLowerCase();
      let note = '';
      if (roman.replace(/\s+/g, '').toLowerCase() !== plainBody) {
        note = mode === 'kana' ? romanToHiragana(roman) : roman;
      }
      if (note) { out.push(`${prefix}${note}`); injected += 1; }
    }
    if (line.translation) out.push(`${prefix}${line.translation}`);
  }
  return injected ? out : null;
}

/** TTML → LRC / 纯文本（剥离翻译、罗马音、背景和声）；lines 保留时间轴与 itunes:key 供注音对齐 */
export function ttmlToLrc(ttmlContent) {
  if (!ttmlContent || typeof ttmlContent !== 'string') return { ...EMPTY_LYRICS };
  ttmlContent = normalizeLyricGlyphs(ttmlContent);
  let cleaned = ttmlContent;
  cleaned = cleaned.replace(/<div[^>]*type=["']translation["'][^>]*>[\s\S]*?<\/div>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-translation["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*ttm:role=["']x-roman["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*type=["']pronunciation["'][^>]*>[\s\S]*?<\/span>/gi, '');
  cleaned = cleaned.replace(/<span[^>]*\bpronunciation=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi, (match, pron, innerText) => {
    const rawText = innerText.replace(/<[^>]+>/g, '').trim();
    if (!rawText) return '';
    if (rawText.toLowerCase() === pron.trim().toLowerCase() || (/^[a-zA-Z\s'-]+$/.test(rawText) && pron)) return '';
    return innerText;
  });

  const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  const timedLines = [];
  const plainLines = [];
  const structLines = [];
  let match;
  while ((match = pRegex.exec(cleaned)) !== null) {
    const pAttrs = match[1] || '';
    let text = match[2].replace(/<[^>]+>/g, '');
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .trim();
    if (!text) continue;
    plainLines.push(text);
    const beginMatch = pAttrs.match(/\bbegin=["']([^"']+)["']/i);
    if (beginMatch) {
      const ts = formatLrcTimestamp(parseTimeToSeconds(beginMatch[1]));
      timedLines.push(`${ts} ${text}`);
      const keyMatch = pAttrs.match(/\bitunes:key=["']([^"']+)["']/i);
      structLines.push({ key: keyMatch ? keyMatch[1] : '', time: ts, text, translation: '' });
    }
  }
  if (plainLines.length === 0) return { ...EMPTY_LYRICS };
  const isDynamic = timedLines.length > 0;
  return {
    hasLyrics: true,
    isDynamic,
    lrc: isDynamic ? timedLines.join('\n') : plainLines.join('\n'),
    plain: plainLines.join('\n'),
    ttml: ttmlContent,
    lines: structLines,
  };
}

/** 官方翻译 → 双语 LRC（同时间戳两行：原文 + 译文）。译文按 itunes:key 与 <text for> 对齐。 */
export function ttmlToBilingualLrc(ttmlContent, targetLang = 'zh-Hans-CN') {
  if (!ttmlContent || typeof ttmlContent !== 'string') return null;
  ttmlContent = normalizeLyricGlyphs(ttmlContent);
  // 原文已是中文：无需翻译
  const rootLang = (ttmlContent.match(/<tt\b[^>]*xml:lang=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
  if (rootLang.startsWith('zh')) return null;

  const unescape = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

  const all = [];
  const tRe = /<translation\b[^>]*xml:lang=["']([^"']+)["'][^>]*>([\s\S]*?)<\/translation>/gi;
  let tm;
  while ((tm = tRe.exec(ttmlContent)) !== null) {
    all.push({ lang: (tm[1] || '').toLowerCase(), auto: /\bautomaticallyCreated=["'](true|1)["']/i.test(tm[0]), body: tm[2] });
  }
  const wantBase = targetLang.split('-')[0];
  const pick = all.find((t) => t.lang === targetLang.toLowerCase() && !t.auto)
    || all.find((t) => t.lang.split('-')[0] === wantBase && !t.auto)
    || all.find((t) => !t.auto) || all[0];
  if (!pick) return null;
  const block = pick.body;
  if (!block) return null;

  const transMap = {};
  const textRe = /<text\b[^>]*for=["']([^"']+)["'][^>]*>([\s\S]*?)<\/text>/gi;
  let xm;
  while ((xm = textRe.exec(block)) !== null) {
    const key = xm[1];
    const txt = unescape(xm[2].replace(/<span[^>]*ttm:role=["']x-bg["'][^>]*>[\s\S]*?<\/span>/gi, '').replace(/<[^>]+>/g, '')).trim();
    if (key && txt) transMap[key] = txt;
  }

  const pRe = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  const lines = [];
  const structLines = [];
  let pm;
  while ((pm = pRe.exec(ttmlContent)) !== null) {
    const attrs = pm[1] || '';
    const body = unescape(pm[2].replace(/<[^>]+>/g, '')).trim();
    if (!body) continue;
    const beginMatch = attrs.match(/\bbegin=["']([^"']+)["']/i);
    const keyMatch = attrs.match(/\bitunes:key=["']([^"']+)["']/i);
    if (!beginMatch) continue;
    const ts = formatLrcTimestamp(parseTimeToSeconds(beginMatch[1]));
    const key = keyMatch ? keyMatch[1] : '';
    const translation = key && transMap[key] ? transMap[key] : '';
    lines.push(`${ts} ${body}`);
    if (translation) lines.push(`${ts} ${translation}`);
    structLines.push({ key, time: ts, text: body, translation });
  }
  if (!lines.length) return null;
  // plain 与服务端 / ttmlToLrc 语义一致：去时间戳的纯文本行（原文 + 译文，不含注音）
  const plainLines = [];
  for (const l of structLines) {
    if (l.text) plainLines.push(l.text);
    if (l.translation) plainLines.push(l.translation);
  }
  return { hasLyrics: true, isDynamic: true, lrc: lines.join('\n'), plain: plainLines.join('\n'), ttml: ttmlContent, lines: structLines };
}

/* ==================== 元数据 ==================== */

/**
 * 拉取并解析歌词。
 * @param {string} trackId
 * @param {boolean} translate 是否附加官方中文翻译
 * @param {(s: string) => string} simplify 简繁转换
 * @param {{ ruby?: boolean, rubyMode?: 'roman'|'kana' }} [opts] 注音：日文罗马音或平假名
 */
export async function fetchLyricsData(trackId, translate = false, simplify = (s) => s, opts = {}) {
  try {
    const { ruby = false, rubyMode = 'roman' } = opts;
    const url = `/lyrics/${trackId}${(translate || ruby) ? '?language=zh-Hans-CN' : ''}`;
    const res = await fetch(url);
    if (!res.ok) return { ...EMPTY_LYRICS };
    const rawTtml = await res.text();
    let parsed = null;
    if (translate) parsed = ttmlToBilingualLrc(rawTtml, 'zh-Hans-CN');
    if (!parsed) parsed = ttmlToLrc(rawTtml);
    if (!parsed || !parsed.hasLyrics) return { ...EMPTY_LYRICS };
    // 注音：该曲无日语罗马音时保持原文，不报错
    let rubyApplied = false;
    if (ruby && parsed.lines && parsed.lines.length) {
      const annotated = annotateLyricLines(parsed.ttml, parsed.lines, rubyMode === 'kana' ? 'kana' : 'roman');
      if (annotated) {
        parsed = { ...parsed, lrc: annotated.join('\n'), plain: annotated.join('\n') };
        rubyApplied = true;
      }
    }
    // ⚠️ 注音模式下 lrc 是「原文 / 罗马音 / 译文」交错，罗马音行不含假名，
    //    逐行 simplify 会与原文行走出不同分支，破坏上下行对齐。此时整体跳过简繁转换（与服务端一致）。
    if (!rubyApplied) {
      if (parsed.lrc) parsed.lrc = simplify(parsed.lrc);
      if (parsed.plain) parsed.plain = simplify(parsed.plain);
      if (parsed.ttml) parsed.ttml = simplify(parsed.ttml);
    }
    return parsed;
  } catch (err) {
    console.warn('[am-hook] fetchLyricsData failed:', err);
    return { ...EMPTY_LYRICS };
  }
}

/**
 * 经服务端 /amp 代理请求 amp-api 的 songs 资源，返回规范化后的元数据对象。
 *
 * 华语补全逻辑与服务端 cloud-service 对齐：艺人名/专辑名缺中文时向 cn→tw→hk→us 嗅探，
 * 但**只补全元数据，绝不替换整体资源**（跨区 adamId 会导致"无版权"误判，见 §3.12）。
 *
 * @param {string} adamId
 * @param {{ country?: string, simplify?: (s: string) => string }} [opts]
 */
export async function fetchSongMeta(adamId, opts = {}) {
  const country = (opts.country || 'us').toLowerCase();
  const simplify = opts.simplify || ((s) => s);
  const preferredStorefront = (window.AmI18n?.storefront || '').toLowerCase();
  const candidateRegions = [...new Set([preferredStorefront, country, 'jp', 'cn', 'us'].filter((c) => /^[a-z]{2}$/.test(c)))];

  let rawSong = null;
  let resolvedCountry = country;
  for (const cc of candidateRegions) {
    try {
      const url = new URL(`/amp/v1/catalog/${cc}/songs/${adamId}`, location.origin);
      url.searchParams.set('include', 'albums,artists');
      const l = await window.AmI18n?.catalogLang?.(cc);
      if (l) url.searchParams.set('l', l);
      let res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 400 && url.searchParams.has('l')) {
        url.searchParams.delete('l');
        res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      }
      if (!res.ok) continue;
      const song = (await res.json()).data?.[0];
      if (song?.attributes) {
        rawSong = song;
        resolvedCountry = cc;
        break;
      }
    } catch {}
  }
  if (!rawSong) return null;

  const attr = rawSong.attributes;
  const audioLocale = (attr.audioLocale || '').toLowerCase();
  const genreList = attr.genreNames || [];
  const isJapanese = audioLocale === 'ja' || genreList.some((g) => /j-pop|japanese|anime|アニメ/i.test(g));
  const isChinese = audioLocale.startsWith('zh') || /[\u4e00-\u9fa5]/.test((attr.name || '') + (attr.artistName || ''));

  // 日文歌：保持日文原貌（假名/日文汉字），绝不要欧美区罗马音
  if (isJapanese && resolvedCountry !== 'jp') {
    try {
      const jpUrl = new URL(`/amp/v1/catalog/jp/songs/${adamId}`, location.origin);
      jpUrl.searchParams.set('include', 'albums,artists');
      jpUrl.searchParams.set('l', 'ja');
      const jpRes = await fetch(jpUrl, { signal: AbortSignal.timeout(6000) });
      if (jpRes.ok) {
        const jpSong = (await jpRes.json()).data?.[0];
        if (jpSong?.attributes) {
          rawSong = jpSong;
          resolvedCountry = 'jp';
        }
      }
    } catch {}
  } else if (isChinese) {
    // 中文歌：按 cn -> us -> hk -> tw 依次取「官方中文元数据」，命中带汉字的区即采用。
    //
    // 为什么不能只看 resolvedCountry：源链接常常来自 tr/hk 这类小区域，
    // 它们虽然能返回数据，但字段是英文艺名（实测 tr 的 1721449919 返回 Say Goodbye / Jay Chou / The Era，
    // 而 cn/tw 直接 404，只有 hk(繁) 与 us(简) 有中文名）。旧实现把 resolvedCountry 又请求一遍，等于空转。
    // us 排在 hk 前是因为 us 返回 zh-Hans-CN 简体，比港区繁体少一次繁简转换。
    for (const cnTarget of ['cn', 'us', 'hk', 'tw']) {
      if (cnTarget === resolvedCountry) {
        // 已命中的源区如果本身就带汉字，无需重复请求
        if (/[\u4e00-\u9fa5]/.test((rawSong.attributes?.name || '') + (rawSong.attributes?.artistName || ''))) break;
        continue;
      }
      try {
        const cnUrl = new URL(`/amp/v1/catalog/${cnTarget}/songs/${adamId}`, location.origin);
        cnUrl.searchParams.set('include', 'albums,artists');
        cnUrl.searchParams.set('l', 'zh-Hans-CN');
        const cnRes = await fetch(cnUrl, { signal: AbortSignal.timeout(6000) });
        if (!cnRes.ok) continue;
        const cnSong = (await cnRes.json()).data?.[0];
        if (!cnSong?.attributes) continue;
        rawSong = cnSong;
        if (/[\u4e00-\u9fa5]/.test((cnSong.attributes.name || '') + (cnSong.attributes.artistName || ''))) break;
      } catch {}
    }
  }

  // 华语元数据补全：歌名/艺人名/专辑名缺中文时（海外华语歌常见）向华语区嗅探正统中文名。
  //
  // 规则（与服务端 cloud-service.mjs 的华语嗅探同源，但更保守）：
  //   1. 只有在「源曲目本身是华语」或「元数据不带 locale（老歌常见 zxx/空）」时才允许用中文补名，
  //      避免把西洋歌在 cn 区的官方译名当成正名。
  //   2. 歌名 / 艺人 / 专辑三者各自独立判定，都是「缺中文才补」，不做「有英文就覆盖」。
  //   3. 三者都补齐才提前结束，避免歌名仍为英文就 break。
  //   4. 嗅探顺序固定 cn -> us -> hk -> tw（见 CHINESE_STOREFRONTS 注释：四区覆盖互补）。
  const allowChineseSniff = !isJapanese
    && (!audioLocale || audioLocale.startsWith('zh') || isChinese);
  if (allowChineseSniff) {
    const hasHan = (s) => /[\u4e00-\u9fa5]/.test(s || '');
    const pending = new Set();
    if (!hasHan(rawSong.attributes?.name)) pending.add('title');
    if (!hasHan(rawSong.attributes?.artistName)) pending.add('artist');
    if (!hasHan(rawSong.attributes?.albumName)) pending.add('album');
    for (const sf of CHINESE_STOREFRONTS) {
      if (!pending.size) break;
      if (sf === resolvedCountry) continue;
      try {
        const sfUrl = new URL(`/amp/v1/catalog/${sf}/songs/${adamId}`, location.origin);
        sfUrl.searchParams.set('include', 'albums,artists');
        sfUrl.searchParams.set('l', 'zh-Hans-CN');
        const sfRes = await fetch(sfUrl, { signal: AbortSignal.timeout(4000) });
        if (!sfRes.ok) continue;
        const sfAttr = (await sfRes.json()).data?.[0]?.attributes;
        if (!sfAttr) continue;
        const merged = { ...rawSong.attributes };
        if (pending.has('title') && hasHan(sfAttr.name)) {
          merged.name = sfAttr.name;
          pending.delete('title');
        }
        if (pending.has('artist') && hasHan(sfAttr.artistName)) {
          merged.artistName = sfAttr.artistName;
          pending.delete('artist');
        }
        if (pending.has('album') && hasHan(sfAttr.albumName)) {
          merged.albumName = sfAttr.albumName;
          pending.delete('album');
        }
        rawSong = { ...rawSong, attributes: merged };
      } catch {}
    }
  }

  const a = rawSong.attributes;
  const albumAttr = rawSong.relationships?.albums?.data?.[0]?.attributes;
  // 只要字符串本身含中文就做繁简转换，避免嗅探回的繁体名残留
  const simp = (str) => {
    const s = str || '';
    return isChinese || /[\u4e00-\u9fa5]/.test(s) ? simplify(s) : s;
  };

  return {
    country: resolvedCountry,
    audioLocale,
    isJapanese,
    isChinese,
    title: simp(a.name || ''),
    artist: simp(a.artistName || ''),
    album: simp(a.albumName || ''),
    // 嗅探补上的是 attributes.artistName，若 albumArtistName 仍为英文艺名需同步，否则标签里的专辑艺人会残留英文
    albumArtist: simp(
      (/[\u4e00-\u9fa5]/.test(a.artistName || '') && !/[\u4e00-\u9fa5]/.test(a.albumArtistName || '')
        ? a.artistName
        : a.albumArtistName) || albumAttr?.artistName || a.artistName || ''
    ),
    albumId: rawSong.relationships?.albums?.data?.[0]?.id || '',
    trackNumber: a.trackNumber || 1,
    totalTracks: albumAttr?.trackCount || 0,
    discNumber: a.discNumber || 1,
    totalDiscs: 1,
    composer: simp(a.composerName || ''),
    copyright: simp(albumAttr?.copyright || ''),
    artwork: a.artwork?.url ? a.artwork.url.replace('{w}', 600).replace('{h}', 600).replace('{c}', 'bb').replace('{f}', 'jpg') : '',
    genre: a.genreNames?.[0] || '',
    releaseDate: a.releaseDate || '',
    durationMs: a.durationInMillis,
    explicit: a.contentRating === 'explicit',
    url: a.url || '',
    resource: rawSong,
  };
}

/** 抓取 1400×1400 封面（失败回退 600×600），返回 Uint8Array 或 null */
export async function fetchCoverBytes(meta) {
  const candidates = [];
  if (meta?.artwork) candidates.push(meta.artwork.replace('600x600', '1400x1400'));
  const rawArt = meta?.resource?.attributes?.artwork?.url;
  if (rawArt) candidates.push(rawArt.replace('{w}', '1400').replace('{h}', '1400').replace('{c}', 'bb').replace('{f}', 'jpg'));
  if (meta?.artwork) candidates.push(meta.artwork);
  for (const url of candidates) {
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      console.warn('[am-hook] 封面抓取失败，尝试下一个:', err);
    }
  }
  return null;
}

/* ==================== 单曲下载编排 ==================== */

/**
 * 完整下载一首歌：解密 → 注入标签/封面/歌词 → 返回 Blob。
 *
 * @param {object} p
 * @param {{codecs?:string, sample_rate?:number, bit_depth?:number}} p.variant  已选定的音质变体
 * @param {object} p.meta           fetchSongMeta 的返回值
 * @param {string} p.m3u8Url        浏览器直连 CDN 的 media playlist 地址
 * @param {object} [p.lyricsOpts]   { embedMode:'lrc'|'ttml'|'off', saveFormats:string[], translateOn:boolean }
 * @param {AbortSignal} [p.signal]
 * @param {(done:number,total:number)=>void} [p.onProgress]
 * @param {()=>void} [p.onDefrag]
 * @param {(s:string)=>string} [p.simplify]
 * @param {number|string} p.trackId  用于查歌词
 * @returns {Promise<{ blob: Blob, size: number, tagged: boolean, dispose:()=>Promise<void>|void }>}
 */
export async function downloadDecryptedTrack(p) {
  const { AmDecrypt } = window;
  const simplify = p.simplify || ((s) => s);
  const lyrOpts = p.lyricsOpts || { embedMode: 'lrc', saveFormats: [], translateOn: false };
  const shouldEmbed = lyrOpts.embedMode !== 'off';

  const track = await AmDecrypt.openTrack(p.m3u8Url, p.signal);
  const result = await AmDecrypt.download(track, {
    signal: p.signal,
    onProgress: p.onProgress,
    onDefrag: p.onDefrag,
  });

  let rawBuf;
  try {
    rawBuf = await result.file.arrayBuffer();
  } finally {
    // 立即释放 OPFS 临时解密文件和 Web Lock，防止批量下载多首歌曲时累积占用数 GB 浏览器磁盘空间
    try { await result.dispose?.(); } catch {}
  }

  try {
    const meta = p.meta || {};
    const lyricsData = await fetchLyricsData(p.trackId, lyrOpts.translateOn && !meta.isChinese, simplify, {
      ruby: Boolean(lyrOpts.rubyOn),
      rubyMode: lyrOpts.rubyMode || 'roman',
    });

    let embedLyricsText = '';
    if (shouldEmbed && lyricsData.hasLyrics) {
      if (lyrOpts.embedMode === 'ttml' && lyricsData.ttml) embedLyricsText = lyricsData.ttml;
      else embedLyricsText = lyricsData.isDynamic ? lyricsData.lrc : lyricsData.plain;
    }

    const coverBuf = await fetchCoverBytes(meta);

    // 先规范化采样描述（剥除解密遗留的 `free` 保护头、去重重复样本条目），再注入标签。
    // 否则 Salt Player / Android ExoPlayer 会因样本条目内的 `free` 报「编码错误」。
    // 服务端路径由 ffmpeg 重封装自动完成等价处理，浏览器端必须显式执行。
    let normalized = new Uint8Array(rawBuf);
    try {
      normalized = normalizeSampleEntries(normalized);
    } catch (normErr) {
      console.warn('[am-hook] 采样描述规范化失败，继续使用原始解密产物:', normErr);
      normalized = new Uint8Array(rawBuf);
    }

    const { bytes, tagged } = tagMp4(normalized, {
      title: simplify(meta.title),
      artist: simplify(meta.artist),
      album: simplify(meta.album),
      albumArtist: simplify(meta.albumArtist || meta.artist),
      date: meta.releaseDate,
      genre: meta.genre,
      composer: simplify(meta.composer),
      copyright: meta.copyright,
      trackNumber: meta.trackNumber,
      totalTracks: meta.totalTracks,
      discNumber: meta.discNumber,
      totalDiscs: meta.totalDiscs || 1,
      lyrics: embedLyricsText,
      cover: coverBuf,
    });
    return { blob: new Blob([bytes], { type: 'audio/mp4' }), size: bytes.length, tagged, lyricsData, dispose: async () => {} };
  } catch (err) {
    // 注入失败也不能丢音频：退回原始解密产物
    console.error('[am-hook] 元数据/标签注入失败，返回未打标签音频:', err);
    return { blob: new Blob([rawBuf], { type: 'audio/mp4' }), size: rawBuf.byteLength, tagged: false, lyricsData: null, dispose: async () => {} };
  }
}

/** 触发浏览器保存（Blob），并在稍后释放临时资源 */
const pendingSaves = new Set();

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  const entry = { url };
  pendingSaves.add(entry);
  setTimeout(() => { URL.revokeObjectURL(url); pendingSaves.delete(entry); }, 60000);
  return url;
}

/** 保存一个文本文件（歌词） */
export function saveTextFile(content, fileName, mime = 'text/plain;charset=utf-8') {
  if (!content || !content.trim()) return;
  saveBlob(new Blob([content], { type: mime }), fileName);
}
