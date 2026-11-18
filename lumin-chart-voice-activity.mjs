export function createVoiceActivityDetector(sampleRate) {
  const silenceSamples = sampleRate * 3;
  const confirmationSamples = sampleRate * 0.09;
  let samplesSeen = 0;
  let activeSamples = 0;
  let lastVoiceSample = 0;
  let noiseFloor = 0.002;

  return (samples) => {
    let energy = 0;
    let peak = 0;
    for (const sample of samples) {
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const level = Math.sqrt(energy / samples.length);
    const active = level >= Math.max(0.009, noiseFloor * 2.5);
    samplesSeen += samples.length;
    if (active) {
      activeSamples += samples.length;
      if (activeSamples >= confirmationSamples) lastVoiceSample = samplesSeen;
    } else {
      activeSamples = 0;
      noiseFloor += (level - noiseFloor) * 0.05;
    }
    const shouldStop = lastVoiceSample > 0 && !active && samplesSeen - lastVoiceSample >= silenceSamples;
    return { peak, shouldStop, lastVoiceSample };
  };
}
