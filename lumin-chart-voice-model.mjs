export const modelFile = 'lumin-gemma-4-e2b-d3cfec6a.litertlm';
export const modelBytes = 2340870772;
export const modelUrl = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/2d74ac41a33d7da82f39f7d5720a04c68514a103/gemma-4-E2B-it-gpu.litertlm';
export const modelCache = 'lumin-gemma-4-e2b-v1';
const base = 'litertlm_wasm_compat_asyncify_internal';
const cdn = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.19.0/wasm/';
export const loaderFile = cdn + base + '.js';
export const wasmFile = cdn + base + '.wasm';
const engineFile = '/lumin-chart-voice-engine.js?v=1';
const captureFile = '/lumin-chart-voice-worklet.js';
const readyMarker = '/lumin-chart-voice-engine.js?v=1&verified=1';
const runtimeFiles = [engineFile, captureFile, loaderFile, wasmFile];

export function createLocalChartEngine() {
  const supported = globalThis.isSecureContext && Boolean(navigator.gpu && navigator.storage?.getDirectory
    && navigator.locks && globalThis.Worker && globalThis.caches);
  const changes = typeof BroadcastChannel === 'function' ? new BroadcastChannel(modelCache) : null;
  const listeners = new Set();
  changes?.addEventListener('message', () => listeners.forEach(fn => fn()));
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

  async function run(type, payload, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    const script = await caches.match(engineFile, { cacheName: modelCache });
    if (!script) throw new Error('missing');
    const url = URL.createObjectURL(await script.blob());
    let worker;
    try {
      signal?.throwIfAborted();
      worker = new Worker(url);
      return await new Promise((resolve, reject) => {
        const abort = () => {
          // Let the download worker flush its current offset before releasing the lock.
          if (type === 'setup') worker.postMessage({ type: 'cancel' });
          else reject(signal.reason);
        };
        const timeout = type === 'setup' ? null : setTimeout(() => reject(new Error('unavailable')), 120000);
        const finish = (fn, value) => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          fn(value);
        };
        worker.onmessage = ({ data }) => {
          if (data.progress !== undefined) { onProgress?.(data.progress); return; }
          if (signal?.aborted) finish(reject, signal.reason);
          else if (data.error) finish(reject, new Error(data.error));
          else finish(resolve, data.result);
        };
        worker.onerror = () => finish(reject, new Error('unavailable'));
        signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage({ type, ...payload });
        if (signal?.aborted) abort();
      });
    } finally {
      worker?.terminate();
      URL.revokeObjectURL(url);
    }
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
        for (const path of runtimeFiles) {
          if (await cache.match(path)) continue;
          const response = await fetch(path, { cache: 'no-store', signal, credentials: 'omit' });
          if (!response.ok || !response.headers.get('Content-Type')?.match(path === wasmFile ? /application\/wasm/i : /javascript/i)) {
            throw new Error('download');
          }
          await cache.put(path, response);
        }
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

  return { info, download, remove, interpret, loadRecorder, subscribe(fn) { listeners.add(fn); } };
}
