export function encodeWav(chunks, sourceRate, sampleLimit = Infinity) {
  const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const source = new Float32Array(Math.min(total, sampleLimit));
  let offset = 0;
  for (const chunk of chunks) {
    const used = Math.min(chunk.length, source.length - offset);
    source.set(chunk.subarray(0, used), offset);
    offset += used;
    if (offset === source.length) break;
  }
  const rate = 16000;
  const count = Math.floor(source.length * rate / sourceRate);
  const view = new DataView(new ArrayBuffer(44 + count * 2));
  function tag(position, value) {
    for (const [index, character] of [...value].entries()) {
      view.setUint8(position + index, character.charCodeAt(0));
    }
  }
  tag(0, "RIFF");
  view.setUint32(4, view.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, count * 2, true);
  let peak = 0;
  for (let index = 0; index < count; index++) {
    const position = index * sourceRate / rate;
    const start = Math.floor(position);
    const end = Math.floor((index + 1) * sourceRate / rate);
    let sample = source[start];
    if (end > start + 1) {
      let sum = 0;
      for (let i = start; i < end; i++) sum += source[i];
      sample = sum / (end - start);
    }
    peak = Math.max(peak, Math.abs(sample));
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
  }
  return { blob: new Blob([view], { type: "audio/wav" }), seconds: count / rate, peak };
}
