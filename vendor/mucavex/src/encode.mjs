// Output encoders. WAV and MP3 are pure JS and always available; FLAC/OGG/Opus/M4A
// are piped through ffmpeg when it's installed (the `full` image target ships it).
import { spawn, spawnSync } from 'node:child_process';
import { Mp3Encoder } from '@breezystack/lamejs';
import { encodeWav } from './wav.mjs';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const FFMPEG_FORMATS = {
  flac: { type: 'audio/flac', ext: 'flac', args: ['-c:a', 'flac', '-f', 'flac'] },
  ogg: { type: 'audio/ogg', ext: 'ogg', args: (o) => ['-c:a', 'libvorbis', '-q:a', String(o.quality ?? 6), '-f', 'ogg'] },
  opus: { type: 'audio/ogg', ext: 'opus', args: (o) => ['-c:a', 'libopus', '-b:a', `${o.bitrate ?? 160}k`, '-f', 'ogg'] },
  m4a: { type: 'audio/mp4', ext: 'm4a', args: (o) => ['-c:a', 'aac', '-b:a', `${o.bitrate ?? 192}k`, '-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4'] },
};

let ffmpegAvailable;
export function hasFfmpeg() {
  ffmpegAvailable ??= spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
  return ffmpegAvailable;
}

export function availableFormats() {
  return ['wav', 'wav32', 'mp3', ...(hasFfmpeg() ? Object.keys(FFMPEG_FORMATS) : [])];
}

export const ALL_FORMATS = ['wav', 'wav32', 'mp3', ...Object.keys(FFMPEG_FORMATS)];

function encodeMp3(channels, sampleRate, { bitrate = 192 } = {}) {
  // LAME only supports the MPEG sample rates; 44.1/48 kHz cover our defaults.
  const encoder = new Mp3Encoder(2, sampleRate, bitrate);
  const toInt16 = (ch) => Int16Array.from(ch, (s) => Math.max(-1, Math.min(1, s)) * 0x7fff);
  const left = toInt16(channels[0]);
  const right = toInt16(channels[1] ?? channels[0]);
  const parts = [];
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const out = encoder.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
    if (out.length) parts.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  }
  const end = encoder.flush();
  if (end.length) parts.push(Buffer.from(end.buffer, end.byteOffset, end.byteLength));
  return Buffer.concat(parts);
}

function encodeFfmpeg(channels, sampleRate, format, options) {
  if (!hasFfmpeg()) throw new Error(`format "${format}" needs ffmpeg, which isn't installed in this image`);
  const spec = FFMPEG_FORMATS[format];
  const args = typeof spec.args === 'function' ? spec.args(options) : spec.args;
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', ...args, 'pipe:1']);
    const out = [];
    const err = [];
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${Buffer.concat(err).toString().trim()}`)),
    );
    proc.stdin.end(encodeWav(channels, sampleRate, { float32: true }));
  });
}

/** @returns {Promise<{bytes: Buffer, type: string, ext: string}>} */
export async function encode(channels, sampleRate, format = 'wav', options = {}) {
  switch (format) {
    case 'wav':
      return { bytes: encodeWav(channels, sampleRate), type: 'audio/wav', ext: 'wav' };
    case 'wav32':
      return { bytes: encodeWav(channels, sampleRate, { float32: true }), type: 'audio/wav', ext: 'wav' };
    case 'mp3':
      return { bytes: encodeMp3(channels, sampleRate, options), type: 'audio/mpeg', ext: 'mp3' };
    default: {
      const spec = FFMPEG_FORMATS[format];
      if (!spec) throw new Error(`unknown format "${format}"`);
      return { bytes: await encodeFfmpeg(channels, sampleRate, format, options), type: spec.type, ext: spec.ext };
    }
  }
}
