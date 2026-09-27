/* All cryptography and MP4 processing runs here, away from the UI thread. */
importScripts('/assets/mv/go.js');
const ready = (async () => {
  const go = new Go();
  const response = await fetch('/assets/mv/core.wasm');
  if (!response.ok) throw new Error(`WASM HTTP ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  go.run(instance);
  if (!self.mvCoreReady) throw new Error('MV core failed to start');
})();
// Synchronous OPFS handles are worker-only; Go streams through them without buffering the file.
async function defrag(input, output) {
  const root = await navigator.storage.getDirectory();
  const source = await (await root.getFileHandle(input)).createSyncAccessHandle();
  let target;
  try {
    target = await (await root.getFileHandle(output, { create: true })).createSyncAccessHandle();
    target.truncate(0);
    const result = self.mvDefrag(source, target);
    if (result?.error) throw new Error(result.error);
    target.flush(); return result;
  } finally { source.close(); target?.close(); }
}
const methods = { challenge: 'mvChallenge', license: 'mvLicense', closeSession: 'mvCloseSession', init: 'mvInit', fragment: 'mvFragment', muxInit: 'mvMuxInit', defrag: 'mvDefrag', release: 'mvRelease' };
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    await ready;
    if (!methods[method]) throw new Error('Unknown MV operation');
    const result = method === 'defrag' ? await defrag(...args) : self[methods[method]](...args);
    if (result?.error) throw new Error(result.error);
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
