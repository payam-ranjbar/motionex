// audio.speech-ratio: how far a voice sits above its background inside the speech band (default 300-3400 Hz).
// Both signals are downmixed to 48 kHz mono, band-limited with one RBJ high-pass and one RBJ low-pass, cut into
// 100 ms frames, and compared over the frames whose band-limited voice power is above -45 dBFS.
import { readFile } from 'node:fs/promises';
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { biquad, rbjCoeffs } from '../../src/lib/biquad.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { fitLength } from '../../src/lib/signal.mjs';
import { resolveTime } from '../../src/lib/timespec.mjs';
import { framesOf } from '../../src/lib/wav.mjs';

const SAMPLE_RATE = 48000;
const FRAME_S = 0.1;
const FRAME_LEN = Math.round(FRAME_S * SAMPLE_RATE); // 4800
const DROP_POWER = 10 ** -4.5; // -45 dBFS
// biome-ignore lint/suspicious/noApproximativeNumericConstant: the speech-ratio metric fixes Q at 0.7071
const Q = 0.7071;

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** One high-pass then one low-pass pass over a channel. */
function bandlimit(ch, lo, hi) {
  return biquad(biquad(ch, rbjCoeffs('highpass', SAMPLE_RATE, lo, Q)), rbjCoeffs('lowpass', SAMPLE_RATE, hi, Q));
}

/** Per-frame mean square of a channel; frames run [f*FRAME_LEN, (f+1)*FRAME_LEN). */
function framePowers(ch) {
  const count = Math.floor(ch.length / FRAME_LEN);
  const out = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    const a = f * FRAME_LEN;
    let sum = 0;
    for (let i = a; i < a + FRAME_LEN; i++) sum += ch[i] * ch[i];
    out[f] = sum / FRAME_LEN;
  }
  return out;
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

/** Automatic windows: active unfiltered-voice frames merged across gaps shorter than min_gap_s. */
function autoWindows(rawPowers, thresholdDb, minGapS) {
  const threshold = 10 ** (thresholdDb / 10);
  const runs = [];
  let i = 0;
  while (i < rawPowers.length) {
    if (rawPowers[i] <= threshold) {
      i++;
      continue;
    }
    let j = i;
    while (j < rawPowers.length && rawPowers[j] > threshold) j++;
    runs.push([i, j]);
    i = j;
  }
  const merged = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && (run[0] - prev[1]) * FRAME_S < minGapS) prev[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  return merged.map(([start, end], index) => ({
    name: `line-${index + 1}`,
    from: r6(start * FRAME_S),
    to: r6(end * FRAME_S),
  }));
}

/** @param {{voice: string, background: string, timeline?: string, windows?: object[], band_hz: number[], activity_threshold_db: number, min_gap_s: number}} input refs already resolved to absolute paths */
export default async function run(input, ctx) {
  ctx.progress(0, 'decoding');
  const opts = { sampleRate: SAMPLE_RATE, channels: 1, signal: ctx.signal };
  const voice = await decodeAudio(input.voice, opts);
  const background = await decodeAudio(input.background, opts);
  const length = Math.max(framesOf(voice), framesOf(background));
  const voiceCh = fitLength(voice, length).channels[0];
  const backgroundCh = fitLength(background, length).channels[0];

  ctx.progress(0.35, 'band-limiting');
  const [lo, hi] = input.band_hz;
  const voiceBand = bandlimit(voiceCh, lo, hi);
  const backgroundBand = bandlimit(backgroundCh, lo, hi);

  ctx.progress(0.6, 'framing');
  const voicePower = framePowers(voiceBand);
  const backgroundPower = framePowers(backgroundBand);
  const timeline = await readTimeline(input.timeline);

  /** @type {{name: string, from: number, to: number}[]} */
  let windows;
  if (input.windows) {
    windows = input.windows.map((w, i) => ({
      name: w.name ?? `window-${i + 1}`,
      from: resolveTime(w.from, timeline, `windows[${i}].from`),
      to: resolveTime(w.to, timeline, `windows[${i}].to`),
    }));
  } else {
    windows = autoWindows(framePowers(voiceCh), input.activity_threshold_db, input.min_gap_s);
  }

  ctx.progress(0.8, 'measuring');
  const rows = windows.map((w) => {
    const first = Math.max(0, Math.ceil(w.from / FRAME_S - 1e-9));
    const end = Math.min(voicePower.length, Math.floor((w.to + 1e-9) / FRAME_S));
    let kept = 0;
    let voiceSum = 0;
    let backgroundSum = 0;
    for (let f = first; f < end; f++) {
      if (voicePower[f] < DROP_POWER) continue;
      kept++;
      voiceSum += voicePower[f];
      backgroundSum += backgroundPower[f];
    }
    let voiceDb = null;
    let backgroundDb = null;
    let ratioDb = null;
    if (kept > 0) {
      const meanVoice = voiceSum / kept;
      const meanBackground = backgroundSum / kept;
      voiceDb = meanVoice > 0 ? r2(10 * Math.log10(meanVoice)) : null;
      backgroundDb = meanBackground > 0 ? r2(10 * Math.log10(meanBackground)) : null;
      ratioDb = voiceDb != null && backgroundDb != null ? r2(voiceDb - backgroundDb) : null;
    }
    return { name: w.name, from: w.from, to: w.to, voice_db: voiceDb, background_db: backgroundDb, ratio_db: ratioDb };
  });

  const ratios = rows.map((r) => r.ratio_db).filter((x) => x != null);
  let summary = null;
  if (ratios.length) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    summary = { min_db: r2(sorted[0]), median_db: r2(median) };
  }

  ctx.progress(1, 'done');
  return { result: { rows, summary } };
}
