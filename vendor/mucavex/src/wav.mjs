// Encode planar Float32 channels as a PCM WAV file (16-bit int or 32-bit float).
export function encodeWav(channels, sampleRate, { float32 = false } = {}) {
  const numChannels = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = float32 ? 4 : 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float32 ? 3 : 1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (float32) {
        buf.writeFloatLE(s, offset);
      } else {
        buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), offset);
      }
      offset += bytesPerSample;
    }
  }
  return buf;
}
