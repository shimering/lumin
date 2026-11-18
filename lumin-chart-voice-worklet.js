class VoiceCapture extends AudioWorkletProcessor {
  buffer = new Float32Array(2048);
  used = 0;
  finished = false;

  constructor() {
    super();
    this.port.onmessage = () => {
      this.finished = true;
      if (this.used) this.port.postMessage(this.buffer.slice(0, this.used));
      this.port.postMessage("flushed");
    };
  }

  process(inputs) {
    if (this.finished) return false;
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const sample of samples) {
      this.buffer[this.used++] = sample;
      if (this.used === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.used = 0;
      }
    }
    // Output buffers remain silent, preventing live microphone feedback.
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
