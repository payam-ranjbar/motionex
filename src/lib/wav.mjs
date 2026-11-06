// WAV read/write in pure JS. Audio in motionex is {sampleRate, channels: Float32Array[]} (planar, -1..1).

/**
 * @typedef {{sampleRate: number, channels: Float32Array[]}} Audio
 */

/**
 * Parse a RIFF/WAVE (or RF64) buffer. Supports PCM 8/16/24/32-bit int, IEEE float 32/64 and WAVE_FORMAT_EXTENSIBLE.
 * A data chunk whose size is 0, 0xFFFFFFFF or larger than the file (ffmpeg writing to a pipe) runs to the end of the buffer.
 * @param {Buffer|Uint8Array} input
 * @returns {Audio}
 */
export function readWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const riff = buf.toString('ascii', 0, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64') || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a WAV file');
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // extensible: sub-format GUID's first 2 bytes
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      return decodePcm(buf.subarray(body, body + size), fmt);
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV file has no data chunk');
}

function decodePcm(data, { format, channels: nch, sampleRate, bits }) {
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * nch));
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  const read = (() => {
    if (format === 3 && bits === 32) return (o) => data.readFloatLE(o);
    if (format === 3 && bits === 64) return (o) => data.readDoubleLE(o);
    if (format === 1 && bits === 16) return (o) => data.readInt16LE(o) / 32768;
    if (format === 1 && bits === 24) return (o) => data.readIntLE(o, 3) / 8388608;
    if (format === 1 && bits === 32) return (o) => data.readInt32LE(o) / 2147483648;
    if (format === 1 && bits === 8) return (o) => (data[o] - 128) / 128;
    throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bits)`);
  })();
  for (let i = 0, o = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, o += bytes) channels[c][i] = read(o);
  }
  return { sampleRate, channels };
}

/**
 * Encode planar audio as a WAV buffer.
 * @param {Audio} audio
 * @param {{format?: 's16'|'s24'|'f32'}} [opts] s16 and s24 are clamped to -1..1 and rounded
 * @returns {Buffer}
 */
export function encodeWav({ sampleRate, channels }, { format = 's16' } = {}) {
  const nch = channels.length;
  const frames = nch ? channels[0].length : 0;
  const bits = format === 's24' ? 24 : format === 'f32' ? 32 : 16;
  const bytes = bits / 8;
  const dataLen = frames * nch * bytes;
  const out = Buffer.alloc(44 + dataLen);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataLen, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(format === 'f32' ? 3 : 1, 20);
  out.writeUInt16LE(nch, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * nch * bytes, 28);
  out.writeUInt16LE(nch * bytes, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLen, 40);
  let o = 44;
  const clamp = (x) => (x > 1 ? 1 : x < -1 ? -1 : x);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, o += bytes) {
      const x = channels[c][i];
      if (format === 'f32') out.writeFloatLE(x, o);
      else if (format === 's24') out.writeIntLE(Math.round(clamp(x) * 8388607), o, 3);
      else out.writeInt16LE(Math.round(clamp(x) * 32767), o);
    }
  }
  return out;
}

/** Frames (samples per channel) of an Audio. */
export const framesOf = (audio) => audio.channels[0]?.length ?? 0;
/** Duration in seconds of an Audio. */
export const secondsOf = (audio) => framesOf(audio) / audio.sampleRate;
