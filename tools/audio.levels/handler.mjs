// audio.levels: per-window RMS, sample peak and ungated K-weighted LUFS of a file.
// Windows come from an explicit list, a fixed step, or a bar/beat grid; string times resolve against a timeline JSON.
import { readFile } from 'node:fs/promises';
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { kWeight, windowLufs } from '../../src/lib/loudness.mjs';
import { resolveTime } from '../../src/lib/timespec.mjs';
import { framesOf } from '../../src/lib/wav.mjs';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** Mean square over all channels and samples in [a, b). */
function meanSquare(audio, a, b) {
  const n = b - a;
  const nch = audio.channels.length;
  if (n <= 0 || nch === 0) return 0;
  let sum = 0;
  for (const ch of audio.channels) for (let i = a; i < b; i++) sum += ch[i] * ch[i];
  return sum / (n * nch);
}

/** Largest absolute sample over all channels in [a, b). */
function peakAbs(audio, a, b) {
  let p = 0;
  for (const ch of audio.channels) {
    for (let i = a; i < b; i++) {
      const v = Math.abs(ch[i]);
      if (v > p) p = v;
    }
  }
  return p;
}

/** Read and parse the optional timeline JSON. @returns {Promise<object|undefined>} */
async function readTimeline(file) {
  if (!file) return undefined;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new ToolError('input-unreadable', `could not read timeline: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ToolError('invalid-input', `timeline is not valid JSON: ${e.message}`);
  }
}

/** @param {{input: string, timeline?: string, windows?: object[], step_s?: number, grid?: object}} input refs already resolved to absolute paths */
export default async function run(input, ctx) {
  ctx.progress(0, 'decoding');
  const audio = await decodeAudio(input.input, { sampleRate: 48000, channels: null, signal: ctx.signal });
  const sr = audio.sampleRate;
  const frames = framesOf(audio);
  const duration = frames / sr;
  const timeline = await readTimeline(input.timeline);

  /** @type {{name?: string, from: number, to: number}[]} */
  let windows;
  if (input.windows) {
    windows = input.windows.map((w, i) => ({
      ...(w.name !== undefined ? { name: w.name } : {}),
      from: resolveTime(w.from, timeline, `windows[${i}].from`),
      to: resolveTime(w.to, timeline, `windows[${i}].to`),
    }));
  } else if (input.step_s != null) {
    const step = input.step_s;
    const count = Math.ceil(duration / step);
    windows = Array.from({ length: count }, (_, i) => ({
      from: r6(i * step),
      to: r6(Math.min((i + 1) * step, duration)),
    }));
  } else {
    const g = input.grid;
    const beatsPerBar = g.beats_per_bar;
    const offset = g.offset_s;
    const length = g.per === 'beat' ? 60 / g.bpm : (beatsPerBar * 60) / g.bpm;
    const count = Math.max(0, Math.ceil((duration - offset) / length));
    windows = Array.from({ length: count }, (_, i) => ({
      from: r6(offset + i * length),
      to: r6(Math.min(offset + (i + 1) * length, duration)),
    }));
  }

  ctx.progress(0.5, 'measuring');
  const kw = kWeight(audio);
  const rows = windows.map((w) => {
    const a = Math.max(0, Math.round(w.from * sr));
    const b = Math.min(frames, Math.round(w.to * sr));
    const ms = meanSquare(audio, a, b);
    const pk = peakAbs(audio, a, b);
    const lufs = windowLufs(kw, sr, w.from, w.to);
    return {
      ...(w.name !== undefined ? { name: w.name } : {}),
      from: w.from,
      to: w.to,
      rms_db: ms > 0 ? r2(10 * Math.log10(ms)) : null,
      peak_db: pk > 0 ? r2(20 * Math.log10(pk)) : null,
      lufs: r2(lufs),
    };
  });

  ctx.progress(1, 'done');
  return { result: { rows } };
}
