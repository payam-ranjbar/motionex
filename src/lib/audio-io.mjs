// Decode any audio/video file to planar float audio, and write audio files.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.mjs';
import { runFfmpeg } from './ffmpeg.mjs';
import { encodeWav, readWav } from './wav.mjs';

/**
 * Decode the first audio stream of a file with ffmpeg.
 * Order: input seek (start_s) and length (duration_s) trim the SOURCE first, then `filter`, then resampling/channels.
 * @param {string} file absolute path
 * @param {{sampleRate?: number|null, channels?: number|null, filter?: string, start_s?: number, duration_s?: number, signal?: AbortSignal}} [opts]
 *   sampleRate/channels null = keep the file's native rate/channel count. Defaults: 48000 / 2.
 * @returns {Promise<import('./wav.mjs').Audio>}
 */
export async function decodeAudio(
  file,
  { sampleRate = 48000, channels = 2, filter, start_s, duration_s, signal } = {},
) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error'];
  if (start_s) args.push('-ss', String(start_s));
  if (duration_s != null) args.push('-t', String(duration_s));
  args.push('-i', file, '-map', '0:a:0', '-vn');
  if (filter) args.push('-af', filter);
  if (channels) args.push('-ac', String(channels));
  if (sampleRate) args.push('-ar', String(sampleRate));
  args.push('-c:a', 'pcm_f32le', '-f', 'wav', 'pipe:1');
  let r;
  try {
    r = await runFfmpeg(args, { signal });
  } catch (e) {
    if (e.type === 'canceled') throw e;
    throw new ToolError(
      'input-unreadable',
      `could not decode audio from ${path.basename(file)}: ${e.detail ?? e.message}`,
    );
  }
  if (!r.stdout?.length) throw new ToolError('input-unreadable', `no audio decoded from ${path.basename(file)}`);
  return readWav(r.stdout);
}

/**
 * Run an ffmpeg filter chain over an in-memory Audio (f32 WAV in through stdin, f32 WAV out through stdout).
 * The result keeps the input's sample rate and channel count unless the chain changes them; its LENGTH may differ
 * (echo tails, atempo...). Use fitLength() from signal.mjs when you need exactly N samples.
 * @param {import('./wav.mjs').Audio} audio
 * @param {string} chain an ffmpeg -af chain (check agent-supplied chains with checkChain() first)
 * @param {{signal?: AbortSignal, sampleRate?: number, channels?: number}} [opts] force an output rate/channel count
 * @returns {Promise<import('./wav.mjs').Audio>}
 */
export async function filterAudio(audio, chain, { signal, sampleRate, channels } = {}) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-af', chain];
  if (channels) args.push('-ac', String(channels));
  if (sampleRate) args.push('-ar', String(sampleRate));
  args.push('-c:a', 'pcm_f32le', '-f', 'wav', 'pipe:1');
  let r;
  try {
    r = await runFfmpeg(args, { input: encodeWav(audio, { format: 'f32' }), signal });
  } catch (e) {
    if (e.type === 'canceled') throw e;
    throw new ToolError('invalid-input', `filter chain "${chain}" failed: ${e.detail ?? e.message}`);
  }
  return readWav(r.stdout);
}

/**
 * Write audio to a file. wav = 16-bit, wav24 = 24-bit, wav32f = 32-bit float; flac/mp3 go through ffmpeg.
 * @param {string} file absolute path
 * @param {import('./wav.mjs').Audio} audio
 * @param {{format?: 'wav'|'wav24'|'wav32f'|'flac'|'mp3', bitrate_k?: number, signal?: AbortSignal}} [opts]
 */
export async function writeAudio(file, audio, { format = 'wav', bitrate_k = 192, signal } = {}) {
  if (format === 'wav' || format === 'wav24' || format === 'wav32f') {
    const enc = format === 'wav' ? 's16' : format === 'wav24' ? 's24' : 'f32';
    await writeFile(file, encodeWav(audio, { format: enc }));
    return;
  }
  const codec =
    format === 'flac' ? ['-c:a', 'flac'] : format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${bitrate_k}k`] : null;
  if (!codec) throw new ToolError('invalid-input', `unknown audio format "${format}"`);
  await runFfmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'wav', '-i', 'pipe:0', ...codec, file], {
    input: encodeWav(audio, { format: 'f32' }),
    signal,
  });
}
