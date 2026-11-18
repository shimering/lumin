export const modelFile = 'lumin-gemma-4-e2b-d3cfec6a.litertlm';
export const modelBytes = 2340870772;
export const modelUrl = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/2d74ac41a33d7da82f39f7d5720a04c68514a103/gemma-4-E2B-it-gpu.litertlm';
export const modelCache = 'lumin-gemma-4-e2b-v1';
const base = 'litertlm_wasm_compat_asyncify_internal';
const cdn = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.19.0/wasm/';
export const loaderFile = cdn + base + '.js';
export const wasmFile = cdn + base + '.wasm';
const engineFile = '/lumin-chart-voice-engine.js?v=2';
const captureFile = '/lumin-chart-voice-worklet.js';
const readyMarker = '/lumin-chart-voice-engine.js?v=1&verified=1'; // Verification is for the unchanged model file.
const runtimeFiles = [engineFile, captureFile, loaderFile, wasmFile];

export function createLocalChartEngine() {
  const supported = globalThis.isSecureContext && Boolean(navigator.gpu && navigator.storage?.getDirectory
    && navigator.locks && globalThis.Worker && globalThis.caches);
  const changes = typeof BroadcastChannel === 'function' ? new BroadcastChannel(modelCache) : null;
  const listeners = new Set();
  let worker, idleTimer;
  changes?.addEventListener('message', () => {
    if (!worker?.onmessage) unload();
    listeners.forEach(fn => fn());
  });
  const notify = () => {
    changes?.postMessage('changed');
    listeners.forEach(fn => fn());
  };

  async function info() {
    if (!supported) return { supported, bytes: 0, ready: false };
    const dir = await navigator.storage.getDirectory();
    let bytes = 0;
    try {
      const handle = await dir.getFileHandle(modelFile);
      bytes = (await handle.getFile()).size;
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    const cached = await Promise.all([...runtimeFiles, readyMarker].map(
      path => caches.match(path, { cacheName: modelCache })));
    return { supported, bytes, ready: bytes === modelBytes && cached.every(Boolean),
      hasFiles: bytes > 0 || cached.some(Boolean) };
  }

  function exclusive(callback) {
    return navigator.locks.request(modelCache, { ifAvailable: true }, lock => {
      if (!lock) throw new Error('otherTab');
      return callback();
    });
  }

  function unload() {
    clearTimeout(idleTimer);
    worker?.terminate();
    worker = undefined;
  }

  async function getWorker(signal) {
    if (worker) return worker;
    const script = await caches.match(engineFile, { cacheName: modelCache });
    if (!script) throw new Error('missing');
    const url = URL.createObjectURL(await script.blob());
    try {
      signal?.throwIfAborted();
      worker = new Worker(url);
      return worker;
    } finally { URL.revokeObjectURL(url); }
  }

  async function run(type, payload, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    clearTimeout(idleTimer);
    const active = await getWorker(signal);
    try {
      const result = await new Promise((resolve, reject) => {
        const abort = () => {
          // Let the download worker flush its current offset before releasing the lock.
          if (type === 'setup') active.postMessage({ type: 'cancel' });
          else finish(reject, signal.reason);
        };
        const timeout = type === 'setup' ? null : setTimeout(() => finish(reject, new Error('unavailable')), 120000);
        const finish = (fn, value) => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          active.onmessage = active.onerror = null;
          fn(value);
        };
        active.onmessage = ({ data }) => {
          if (data.progress !== undefined) { onProgress?.(data.progress); return; }
          if (signal?.aborted) finish(reject, signal.reason);
          else if (data.error) finish(reject, new Error(data.error));
          else finish(resolve, data.result);
        };
        active.onerror = () => finish(reject, new Error('unavailable'));
        signal?.addEventListener('abort', abort, { once: true });
        try { active.postMessage({ type, ...payload }); }
        catch (error) { finish(reject, error); return; }
        if (signal?.aborted) abort();
      });
      idleTimer = setTimeout(unload, 120000);
      return result;
    } catch (error) {
      unload();
      throw error;
    }
  }

  async function cacheRuntimeFile(cache, path, signal) {
    if (await cache.match(path)) return;
    const response = await fetch(path, { cache: 'no-store', signal, credentials: 'omit' });
    if (!response.ok || !response.headers.get('Content-Type')?.match(path === wasmFile ? /application\/wasm/i : /javascript/i)) {
      throw new Error('download');
    }
    await cache.put(path, response);
  }

  async function updateRuntime() {
    if (!supported || navigator.onLine === false || !await caches.match(readyMarker, { cacheName: modelCache })) return;
    await exclusive(async () => {
      await cacheRuntimeFile(await caches.open(modelCache), engineFile);
    });
  }

  async function download({ signal, report, acceptsSample }) {
    if (!supported) throw new Error('unsupported');
    try {
      await exclusive(async () => {
        const stored = await info();
        if (stored.ready) return;
        if (!await navigator.gpu.requestAdapter()) throw new Error('unsupported');
        await navigator.storage.persist?.().catch(() => {});
        const estimate = await navigator.storage.estimate?.().catch(() => null);
        if (estimate?.quota && estimate.quota - estimate.usage < Math.max(0, modelBytes - stored.bytes)) {
          throw new Error('storage');
        }
        const cache = await caches.open(modelCache);
        report('runtime');
        for (const path of runtimeFiles) await cacheRuntimeFile(cache, path, signal);
        report('model', stored.bytes);
        const sample = await run('setup', {}, {
          signal, onProgress: bytes => report(bytes === modelBytes ? 'verify' : 'model', bytes)
        });
        if (!acceptsSample(sample)) throw new Error('sample');
        await cache.put(readyMarker, new Response('ready'));
      });
    } catch (error) {
      if (error.name === 'QuotaExceededError') throw new Error('storage');
      throw error;
    } finally { notify(); }
  }

  async function remove() {
    try {
      await exclusive(async () => {
        unload();
        const dir = await navigator.storage.getDirectory();
        try { await dir.removeEntry(modelFile); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
        await caches.delete(modelCache);
      });
    } finally { notify(); }
  }

  async function interpret(input, signal) {
    return exclusive(async () => {
      if (!(await info()).ready) throw new Error('missing');
      return run(input.confirmation ? 'confirm' : 'interpret', input, { signal });
    });
  }

  async function loadRecorder(context) {
    const script = await caches.match(captureFile, { cacheName: modelCache });
    if (!script) throw new Error('missing');
    const url = URL.createObjectURL(await script.blob());
    try { await context.audioWorklet.addModule(url); }
    finally { URL.revokeObjectURL(url); }
  }

  return { info, updateRuntime, download, remove, interpret, loadRecorder, unload, subscribe(fn) { listeners.add(fn); } };
}
