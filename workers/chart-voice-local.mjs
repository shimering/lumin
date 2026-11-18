import { Backend, Engine, loadLiteRtLm } from "@litert-lm/core";
import { chartPrompt, chartSchema } from "./chart-voice-prompt.mjs";
import { loaderFile, modelBytes, modelCache, modelFile, modelUrl, wasmFile } from "../lumin-chart-voice-model.mjs";

let engine;
let loadingWasm;
let setup;
const modelHandle = async (create = false) => {
  const directory = await navigator.storage.getDirectory();
  return directory.getFileHandle(modelFile, { create });
};

function progress(bytes) {
  self.postMessage({ progress: bytes });
}

async function download(signal) {
  signal.throwIfAborted();
  const handle = await (await modelHandle(true)).createSyncAccessHandle();
  try {
    let offset = handle.getSize();
    if (offset === modelBytes) {
      progress(offset);
      return;
    }
    if (offset > modelBytes) {
      handle.truncate(0);
      offset = 0;
    }
    const response = await fetch(modelUrl, {
      headers: offset ? { Range: "bytes=" + offset + "-" } : {},
      cache: "no-store",
      signal,
    });
    if (!response.ok || !response.body) throw new Error("download");
    if (response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== modelBytes) {
        await response.body.cancel();
        throw new Error("download");
      }
    } else if (offset) {
      handle.truncate(0);
      offset = 0;
    }
    const reader = response.body.getReader();
    let reported = -1;
    let flushed = offset;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > modelBytes) throw new Error("download");
        const written = handle.write(value, { at: offset });
        offset += written;
        if (written !== value.byteLength) throw new Error("storage");
        if (offset - flushed >= 8 * 1024 * 1024) { handle.flush(); flushed = offset; }
        const percent = Math.floor(offset / modelBytes * 100);
        if (percent !== reported) {
          reported = percent;
          progress(offset);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (offset !== modelBytes) throw new Error("download");
  } finally {
    try { handle.flush(); }
    finally { handle.close(); }
  }
}

function initializeRuntime() {
  loadingWasm ??= (async () => {
    const [loader, wasm] = await Promise.all([loaderFile, wasmFile].map(
      path => caches.match(path, { cacheName: modelCache })));
    if (!loader || !wasm) throw new Error("missing");
    const script = URL.createObjectURL(await loader.blob());
    const binary = URL.createObjectURL(await wasm.blob());
    try {
      self.Module = { locateFile: () => binary };
      await loadLiteRtLm(script + "#runtime.js");
    } finally {
      URL.revokeObjectURL(script);
      URL.revokeObjectURL(binary);
    }
  })().catch((error) => {
    loadingWasm = undefined;
    throw error;
  });
  return loadingWasm;
}

async function getEngine() {
  if (engine) return engine;
  const file = await (await modelHandle()).getFile();
  if (file.size !== modelBytes) throw new Error("missing");
  await initializeRuntime();
  engine = await Engine.create({
    model: file,
    backend: Backend.GPU,
    audioBackend: Backend.CPU,
    mainExecutorSettings: { maxNumTokens: 2048 },
  });
  return engine;
}

async function interpret({ prompt, blob }, confirm = false) {
  const model = await getEngine();
  const conversation = await model.createConversation({
    sessionConfig: { maxOutputTokens: confirm ? 64 : 1200 },
    preface: { messages: [{ role: "system", content: [{ type: "text", text: confirm
      ? "Transcribe exactly what the speaker actually said in the original language. Preserve all negations and extra words. If there is no intelligible speech, output [unclear]. Output only the transcript."
      : chartPrompt + "\nExpected schema: " + JSON.stringify(chartSchema) }] }] },
  });
  try {
    const content = blob
      ? [{ type: "audio", data: blob }, { type: "text", text: confirm
        ? "Transcribe this recording verbatim, without translation."
        : "Interpret this recorded procedure command and return JSON." }]
      : [{ type: "text", text: prompt }];
    let text = "";
    for await (const event of conversation.sendMessageStreaming({ role: "user", content })) {
      for (const item of event.content ?? []) if (item.type === "text") text += item.text;
    }
    if (!text.trim()) throw new Error("draft");
    return text;
  } finally {
    await conversation.delete();
  }
}

self.onmessage = async ({ data }) => {
  const { type } = data;
  if (type === "cancel") { setup?.abort(); return; }
  try {
    let result;
    if (type === "setup") {
      setup = new AbortController();
      await initializeRuntime();
      await download(setup.signal);
      setup.signal.throwIfAborted();
      result = await interpret({ prompt: "Add a planned composite filling on upper right six." });
    } else {
      result = await interpret(data, type === "confirm");
    }
    self.postMessage({ result });
  } catch (error) {
    const known = ["storage", "missing", "download", "draft"];
    self.postMessage({ error: error?.name === "QuotaExceededError" ? "storage"
      : known.includes(error?.message) ? error.message : type === "setup" ? "download" : "unavailable" });
  }
};
