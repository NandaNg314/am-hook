/* PlayReady, MP4 decryption, muxing and defragmentation (media.wasm, crates/am-media) run here, away from the UI thread.
 * Messages: { id, method, args } -> { id, result } | { id, error }. */
'use strict';

const encoder = new TextEncoder(), decoder = new TextDecoder();
// Host files for defrag: FileSystemSyncAccessHandle or an in-memory stand-in.
const files = new Map();
let wasm;
const memory = () => new Uint8Array(wasm.memory.buffer);
const imports = { env: {
  random_fill: (ptr, len) => { crypto.getRandomValues(new Uint8Array(wasm.memory.buffer, ptr, len)); },
  file_size: h => files.get(h).getSize(),
  file_read: (h, ptr, len, at) => files.get(h).read(new Uint8Array(wasm.memory.buffer, ptr, len), { at }),
  file_write: (h, ptr, len, at) => files.get(h).write(new Uint8Array(wasm.memory.buffer, ptr, len), { at }),
} };
const module = fetch('/assets/media.wasm').then(res => {
  if (!res.ok) throw new Error(`WASM HTTP ${res.status}`);
  return res.arrayBuffer();
}).then(bytes => WebAssembly.compile(bytes));
// A trap leaves the instance unusable; the next call starts a fresh one.
async function instance() {
  if (!wasm) wasm = (await WebAssembly.instantiate(await module, imports)).exports;
  return wasm;
}

/** Calls fn with byte/string arguments copied into wasm memory (each as ptr, len); returns a copy of the result. */
function invoke(fn, ...args) {
  const held = [];
  const flat = args.flatMap(a => {
    if (typeof a === 'string') a = encoder.encode(a);
    if (!(a instanceof Uint8Array)) return [a];
    const ptr = wasm.media_alloc(a.length);
    memory().set(a, ptr); held.push([ptr, a.length]);
    return [ptr, a.length];
  });
  try {
    if (!wasm[fn](...flat)) {
      const ptr = wasm.media_error_ptr();
      throw new Error(decoder.decode(memory().subarray(ptr, ptr + wasm.media_error_len())));
    }
    const ptr = wasm.media_result_ptr();
    return memory().slice(ptr, ptr + wasm.media_result_len());
  } finally { for (const [ptr, len] of held) wasm.media_free(ptr, len); }
}
const size = bytes => Number(new DataView(bytes.buffer).getBigUint64(0));

function withFiles(input, output, fn) {
  files.set(1, input); files.set(2, output);
  try { return fn(1, 2); } finally { files.clear(); }
}
// Synchronous OPFS handles are worker-only; the core streams through them without buffering the file.
async function defrag(song, input, output, dir) {
  let folder = await navigator.storage.getDirectory();
  if (dir) folder = await folder.getDirectoryHandle(dir);
  const source = await (await folder.getFileHandle(input)).createSyncAccessHandle();
  let target;
  try {
    target = await (await folder.getFileHandle(output, { create: true })).createSyncAccessHandle();
    target.truncate(0);
    const result = size(withFiles(source, target, (i, o) => invoke('media_defrag', i, o, song)));
    target.flush(); return result;
  } finally { source.close(); target?.close(); }
}
// Without OPFS (e.g. plain HTTP), the same code reads a Blob's bytes and returns a Blob.
async function defragBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), parts = [];
  let length = 0;
  const source = { getSize: () => bytes.length, read: (view, { at }) => { const part = bytes.subarray(at, at + view.length); view.set(part); return part.length; } };
  const target = { getSize: () => length, write: (view, { at }) => {
    if (at !== length) return -1;
    parts.push(view.slice()); length += view.length; return view.length;
  } };
  withFiles(source, target, (i, o) => invoke('media_defrag', i, o, 1));
  return new Blob(parts, { type: blob.type });
}

const methods = {
  challenge: uri => JSON.parse(decoder.decode(invoke('media_challenge', uri, Math.floor(Date.now() / 1000)))),
  license: (session, license) => invoke('media_license', session, license),
  closeSession: session => { invoke('media_close_session', session); },
  init: (name, raw, base) => invoke('media_init', name, raw, base),
  fragment: (name, raw, key, mux, sequence) => invoke('media_fragment', name, raw, key, mux ? 1 : 0, sequence),
  muxInit: (video, audio, duration) => invoke('media_mux_init', video, audio, duration),
  release: name => { invoke('media_release', name); },
  defrag: (input, output) => defrag(0, input, output),
  // defragSong(blob) or defragSong(input, output, dir): the reference song layout.
  defragSong: (...args) => args[0] instanceof Blob ? defragBlob(args[0]) : defrag(1, ...args),
};
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    if (!Object.hasOwn(methods, method)) throw new Error('Unknown media operation');
    await instance();
    const result = await methods[method](...args);
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) wasm = null;
    self.postMessage({ id, error: error.message });
  }
};
