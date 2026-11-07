// audio.process: run a list of processing steps, in order, over one or more audio files (usually voice takes).
// Steps that need real DSP go through ffmpeg (filterAudio): the agent's own filter chain, pitch, tempo.
// gain, silence trim, pause tightening, fades and peak normalisation are plain JS on the planar Float32 buffers.
// Ported from motion-studio build.mjs:195-242 (tightenPauses, 16-bit mono) and videos/shapur/video.json (voice fx).
import path from 'node:path';
import { decodeAudio, filterAudio, writeAudio } from '../../src/lib/audio-io.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { atempoChain, checkChain } from '../../src/lib/ffmpeg.mjs';
import { isSafeName } from '../../src/lib/paths.mjs';
import { db, fromDb, peak } from '../../src/lib/signal.mjs';
import { framesOf } from '../../src/lib/wav.mjs';

/** Formats that store integers: samples above 0 dBFS are clamped and lost. */
const INTEGER_FORMATS = new Set(['wav', 'wav24', 'flac', 'mp3']);

const has = (o, k) => Object.hasOwn(o, k);

/** Peak magnitude of every channel at frame `i` (linear). */
function framePeak(audio, i) {
  let p = 0;
  for (const ch of audio.channels) {
    const a = Math.abs(ch[i]);
    if (a > p) p = a;
  }
  return p;
}

/** Onset threshold: the first frame at or above this dBFS is where the file becomes audible. */
const ONSET_THRESHOLD_DB = -30;

/** New Audio holding frames [from, to) of every channel. */
function sliceAudio(audio, from, to) {
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((ch) => ch.slice(from, to)) };
}

/** Seconds of the first frame (any channel) at or above threshold_db, or null when the file is silent. */
function onsetSeconds(audio, threshold_db) {
  const thr = fromDb(threshold_db);
  const len = framesOf(audio);
  for (let i = 0; i < len; i++) if (framePeak(audio, i) >= thr) return i / audio.sampleRate;
  return null;
}

/** Seconds of the first frame holding the file's largest peak, or null when the file is silent. */
function peakAtSeconds(audio) {
  const len = framesOf(audio);
  let best = 0;
  let at = null;
  for (let i = 0; i < len; i++) {
    const p = framePeak(audio, i);
    if (p > best) {
      best = p;
      at = i;
    }
  }
  return at === null ? null : at / audio.sampleRate;
}

/** Scale every sample by g, in place. */
function scaleInPlace(audio, g) {
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
}

/**
 * Cut leading and/or trailing audio whose peak (over all channels) is below threshold_db, keeping keep_s of it.
 * Ported from motion-studio build.mjs:191-194 (silenceremove start_periods=1, start_silence=0.03).
 * @param {import('../../src/lib/wav.mjs').Audio} audio mutated copy
 * @param {{threshold_db: number, start: boolean, end: boolean, keep_s: number}} o
 */
function trimSilence(audio, { threshold_db, start, end, keep_s }) {
  const sr = audio.sampleRate;
  const len = framesOf(audio);
  const thr = fromDb(threshold_db);
  let first = -1;
  let last = -1;
  for (let i = 0; i < len; i++) {
    if (framePeak(audio, i) > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    // nothing above the threshold: keep only the head of it
    const keep = Math.min(len, Math.round(keep_s * sr));
    return start || end ? sliceAudio(audio, 0, keep) : audio;
  }
  let from = 0;
  let to = len;
  if (start) from = Math.max(0, first - Math.round(keep_s * sr));
  if (end) to = Math.min(len, last + 1 + Math.round(keep_s * sr));
  return from === 0 && to === len ? audio : sliceAudio(audio, from, to);
}

/**
 * Shorten every INTERNAL pause longer than max_pause_s to exactly max_pause_s, keeping half on each side of the
 * cut. Leading and trailing silence are left alone. A window is silent when its peak (over all channels) is below
 * threshold_db. Ported from motion-studio build.mjs:195-242, which does the same on 16-bit mono PCM.
 * @param {import('../../src/lib/wav.mjs').Audio} audio
 * @param {{max_pause_s: number, threshold_db: number, window_ms: number}} o
 * @returns {import('../../src/lib/wav.mjs').Audio}
 */
function tightenPauses(audio, { max_pause_s, threshold_db, window_ms }) {
  const sr = audio.sampleRate;
  const len = framesOf(audio);
  const win = Math.max(1, Math.round((sr * window_ms) / 1000));
  const thr = fromDb(threshold_db);
  const windows = Math.ceil(len / win);
  const quiet = new Array(windows);
  for (let w = 0; w < windows; w++) {
    const from = w * win;
    const to = Math.min(len, from + win);
    let p = 0;
    for (const ch of audio.channels)
      for (let i = from; i < to; i++) {
        const a = Math.abs(ch[i]);
        if (a > p) p = a;
      }
    quiet[w] = p < thr;
  }
  const half = Math.round((max_pause_s * sr) / 2);
  const keep = [];
  let from = 0;
  for (let w = 0; w < windows; ) {
    if (!quiet[w]) {
      w++;
      continue;
    }
    let e = w;
    while (e < windows && quiet[e]) e++;
    const a = w * win;
    const b = Math.min(len, e * win);
    if (w > 0 && e < windows && b - a > 2 * half) {
      // inside the line, and too long: keep the head and the tail, drop the middle
      keep.push([from, a + half]);
      from = b - half;
    }
    w = e;
  }
  keep.push([from, len]);
  const total = keep.reduce((n, [x, y]) => n + (y - x), 0);
  if (total === len && keep.length === 1) return audio;
  const channels = audio.channels.map(() => new Float32Array(total));
  let at = 0;
  for (const [x, y] of keep) {
    for (let c = 0; c < channels.length; c++) channels[c].set(audio.channels[c].subarray(x, y), at);
    at += y - x;
  }
  return { sampleRate: sr, channels };
}

/** Linear fade over `seconds` at the start ('in') or the end ('out') of the audio, in place. */
function fade(audio, seconds, at) {
  const len = framesOf(audio);
  const n = Math.min(len, Math.round(seconds * audio.sampleRate));
  if (n < 2) return;
  const denom = n - 1;
  for (let k = 0; k < n; k++) {
    const g = at === 'in' ? k / denom : 1 - k / denom;
    const i = at === 'in' ? k : len - n + k;
    for (const ch of audio.channels) ch[i] *= g;
  }
}

/** Number of sample values (any channel) outside -1..1. */
function countClipped(audio) {
  let n = 0;
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) if (ch[i] > 1 || ch[i] < -1) n++;
  return n;
}

/** A file-name-safe basename (letters, digits, _ . - ; never empty). */
function slug(name) {
  const clean = name
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 100);
  const out = clean || 'audio';
  return isSafeName(out) ? out : 'audio';
}

/**
 * @param {{inputs: string[], preset?: string, steps?: object[], format?: 'wav'|'wav24'|'wav32f'|'flac'|'mp3',
 *   sample_rate?: number, channels?: 1|2}} input refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const warnings = [];
  const files = [];
  const taken = new Set();
  const format = input.format ?? 'wav';
  const ext = format === 'flac' || format === 'mp3' ? format : 'wav';
  const total = input.inputs.length;

  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new ToolError('canceled', 'canceled');
    const abs = input.inputs[i];
    const rawRef = ctx.rawInput?.inputs?.[i] ?? abs;
    const stem = slug(path.basename(abs, path.extname(abs)));
    ctx.progress(i / total, `processing ${path.basename(abs)}`);

    // Step 1: decode at the file's native rate and channel count.
    let audio = await decodeAudio(abs, { sampleRate: null, channels: null, signal: ctx.signal });
    const chain = [];

    // Step 2: the steps, in order.
    for (const [j, step] of (input.steps ?? []).entries()) {
      const at = `steps[${j}]`;
      if (has(step, 'filter')) {
        const af = checkChain(step.filter, `${at}.filter`);
        if (!af) throw new ToolError('invalid-input', `${at}.filter must not be empty`);
        audio = await filterAudio(audio, af, { signal: ctx.signal });
        chain.push(af);
      } else if (has(step, 'pitch_semitones')) {
        // asetrate rescales the rate (pitch follows), aresample restores the rate, atempo restores the duration.
        const k = 2 ** (step.pitch_semitones / 12);
        const sr = audio.sampleRate;
        const af = `asetrate=${Math.round(sr * k)},aresample=${sr},${atempoChain(1 / k)}`;
        audio = await filterAudio(audio, af, { signal: ctx.signal });
        chain.push(af);
      } else if (has(step, 'tempo')) {
        const af = atempoChain(step.tempo);
        audio = await filterAudio(audio, af, { signal: ctx.signal });
        chain.push(af);
      } else if (has(step, 'gain_db')) {
        scaleInPlace(audio, fromDb(step.gain_db));
      } else if (has(step, 'trim_silence')) {
        audio = trimSilence(audio, step.trim_silence);
      } else if (has(step, 'tighten_pauses')) {
        audio = tightenPauses(audio, step.tighten_pauses);
      } else if (has(step, 'fade_in_s')) {
        fade(audio, step.fade_in_s, 'in');
      } else if (has(step, 'fade_out_s')) {
        fade(audio, step.fade_out_s, 'out');
      } else if (has(step, 'normalize_peak_db')) {
        const p = peak(audio);
        if (p > 0) scaleInPlace(audio, fromDb(step.normalize_peak_db) / p);
      } else {
        throw new ToolError('invalid-input', `${at} has no known step`);
      }
    }

    // Step 3: an explicit output rate/channel count.
    if (input.sample_rate != null || input.channels != null) {
      audio = await filterAudio(audio, 'anull', {
        signal: ctx.signal,
        sampleRate: input.sample_rate,
        channels: input.channels,
      });
      chain.push('anull');
    }

    // Step 4: integer formats clamp above 0 dBFS, so say how many samples were lost.
    const p = peak(audio);
    const clipped = INTEGER_FORMATS.has(format) && p > 1 ? countClipped(audio) : 0;

    let name = `${stem}.${ext}`;
    for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.${ext}`;
    taken.add(name);
    await writeAudio(path.join(ctx.outDir, name), audio, { format, signal: ctx.signal });
    if (clipped > 0) warnings.push(`${name}: ${clipped} samples over 0 dBFS were clipped`);

    files.push({
      input: rawRef,
      name,
      seconds: framesOf(audio) / audio.sampleRate,
      sample_rate: audio.sampleRate,
      channels: audio.channels.length,
      peak_db: p > 0 ? db(p) : null,
      onset_s: onsetSeconds(audio, ONSET_THRESHOLD_DB),
      peak_at_s: peakAtSeconds(audio),
      clipped_samples: clipped,
      chain,
    });
  }

  ctx.progress(1, 'done');
  return { result: { files, warnings }, outputs: files.map((f) => ({ name: f.name })) };
}
