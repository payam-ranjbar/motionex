// audio.mix clips: decode each distinct clip once (cached), then apply gain, fades and the pan law
// and mix every clip into its track buffer. Also exports the pure building blocks (panGains, mixInto).
import { readFile } from 'node:fs/promises';
import { decodeAudio } from '../audio-io.mjs';
import { ToolError } from '../errors.mjs';
import { checkChain } from '../ffmpeg.mjs';
import { integratedLufs } from '../loudness.mjs';
import { db, fromDb } from '../signal.mjs';
import { framesOf, readWav } from '../wav.mjs';
import { clipWindow } from './cues.mjs';
import { levelClips } from './dynamics.mjs';
import { computeN } from './plan.mjs';

/** Identity of a decode task: two clips with the same key can share one decoded buffer. The planner has already
 * turned a `land_at` placement into the `offset_s` and `duration_s` actually read, so those are what is compared. */
export function clipKey(clip) {
  return `${clip.src}\u0000${clip.offset_s ?? 0}\u0000${clip.duration_s ?? ''}\u0000${clip.fx ?? ''}`;
}

/**
 * Per-output-channel, per-input-channel gains for a pan position.
 *  - mono -> stereo: equal-power law, gL = cos((pan+1)·π/4), gR = sin((pan+1)·π/4) (pan 0 = −3 dB each,
 *    matching ffmpeg's mono upmix and keeping the integrated LUFS).
 *  - stereo -> stereo: balance law, gL = pan > 0 ? cos(pan·π/2) : 1, gR = pan < 0 ? cos(−pan·π/2) : 1
 *    (pan 0 is sample-identical).
 *  - into mono: stereo becomes (L+R)/2; mono is unchanged; pan is ignored.
 * @param {number} pan −1..1
 * @param {number} inCh input channel count
 * @param {number} outCh output channel count (1 or 2)
 * @returns {number[][]} gains[outputChannel][inputChannel]
 */
export function panGains(pan, inCh, outCh) {
  const gains = Array.from({ length: outCh }, () => new Array(inCh).fill(0));
  if (outCh === 1) {
    if (inCh === 1) gains[0][0] = 1;
    else for (let c = 0; c < inCh; c++) gains[0][c] = 1 / inCh;
    return gains;
  }
  if (inCh === 1) {
    gains[0][0] = Math.cos(((pan + 1) * Math.PI) / 4);
    gains[1][0] = Math.sin(((pan + 1) * Math.PI) / 4);
    return gains;
  }
  if (inCh === 2) {
    gains[0][0] = pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1;
    gains[1][1] = pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1;
    return gains;
  }
  // >2 input channels into stereo: take the first two as L/R (a clip is expected to be mono or stereo).
  gains[0][0] = 1;
  gains[1][1] = 1;
  return gains;
}

/** Apply a gain in dB plus linear fades (in starts at the first sample, out ends on the last sample).
 * `audibleLen` is how many samples of the clip are actually heard (the mix may cut it short): the
 * fade-out then ends at that sample instead of at the end of the buffer, so the cut is not a hard one.
 * @param {Float32Array[]} channels @param {{audibleLen?: number}} [opts]
 * @returns {Float32Array[]} new arrays */
export function applyGainFades(channels, { gainDb = 0, fadeInS = 0, fadeOutS = 0, sampleRate, audibleLen }) {
  const g = fromDb(gainDb);
  const len = channels[0]?.length ?? 0;
  const end = Math.max(0, Math.min(len, audibleLen ?? len));
  const fadeIn = Math.max(0, Math.round(fadeInS * sampleRate));
  const fadeOut = Math.max(0, Math.round(fadeOutS * sampleRate));
  return channels.map((ch) => {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let f = g;
      if (fadeIn > 0 && i < fadeIn) f *= i / fadeIn;
      // `end - 1 - i` reaches 0 on the last audible sample; samples past it are inaudible, so clamp at 0.
      if (fadeOut > 0 && i > end - 1 - fadeOut) f *= Math.max(0, (end - 1 - i) / fadeOut);
      out[i] = ch[i] * f;
    }
    return out;
  });
}

/** Apply the pan law, returning `outCh` new channel arrays. @returns {Float32Array[]} */
export function panClip(channels, pan, outCh) {
  const inCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const gains = panGains(pan, inCh, outCh);
  return gains.map((row) => {
    const out = new Float32Array(len);
    for (let c = 0; c < inCh; c++) {
      const g = row[c];
      if (g === 0) continue;
      const src = channels[c];
      for (let i = 0; i < len; i++) out[i] += src[i] * g;
    }
    return out;
  });
}

/** Gain + fades + pan for one clip. `extraGainDb` carries per-clip leveling gain.
 * `audibleLen` (samples) lets a fade-out end where the mix cuts the clip. @returns {Float32Array[]} */
export function prepareClip(audio, clip, { outCh, extraGainDb = 0, audibleLen } = {}) {
  const gained = applyGainFades(audio.channels, {
    gainDb: (clip.gain_db ?? 0) + extraGainDb,
    fadeInS: clip.fade_in_s ?? 0,
    fadeOutS: clip.fade_out_s ?? 0,
    sampleRate: audio.sampleRate,
    audibleLen,
  });
  return panClip(gained, clip.pan ?? 0, outCh);
}

/** Add `src` channel arrays into `dst` starting at `atSample` (a plain sum; samples past the end are dropped). */
export function mixInto(dst, src, atSample = 0) {
  const n = dst[0]?.length ?? 0;
  const nch = Math.min(dst.length, src.length);
  for (let c = 0; c < nch; c++) {
    const s = src[c];
    const d = dst[c];
    for (let i = 0; i < s.length; i++) {
      const j = atSample + i;
      if (j >= n) break;
      if (j >= 0) d[j] += s[i];
    }
  }
  return dst;
}

/** Decode one clip. Fast path: a .wav already at the mix sample rate with no fx/offset/duration. */
async function decodeOne(clip, sampleRate, { signal } = {}) {
  const fx = clip.fx ? checkChain(clip.fx, 'clip fx') : null;
  const offset = clip.offset_s ?? 0;
  const duration = clip.duration_s;
  if (/\.wav$/i.test(clip.src) && !fx && !offset && duration == null) {
    try {
      const audio = readWav(await readFile(clip.src));
      if (audio.sampleRate === sampleRate) return audio;
    } catch {
      // not a plain WAV / not the right rate -> fall through to ffmpeg
    }
  }
  return decodeAudio(clip.src, {
    sampleRate,
    channels: null,
    start_s: offset,
    duration_s: duration,
    filter: fx ?? undefined,
    signal,
  });
}

/**
 * Decode every DISTINCT clip once, up to `concurrency` in parallel.
 * @param {object} plan @param {{signal?: AbortSignal, concurrency?: number}} [opts]
 * @returns {Promise<Map<string, import('../wav.mjs').Audio>>} keyed by clipKey()
 */
export async function decodeClips(plan, { signal, concurrency = 4 } = {}) {
  const tasks = new Map();
  for (const track of plan.tracks)
    for (const clip of track.clips ?? []) if (!tasks.has(clipKey(clip))) tasks.set(clipKey(clip), clip);
  const entries = [...tasks.entries()];
  const decoded = new Map();
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, async () => {
    while (next < entries.length) {
      const [key, clip] = entries[next++];
      decoded.set(key, await decodeOne(clip, plan.sampleRate, { signal }));
    }
  });
  await Promise.all(workers);
  return decoded;
}

/** A cut-off part of a clip whose peak (after the clip gain) is at or under this level is not worth a warning. */
export const TRUNCATION_AUDIBLE_DB = -50;

/** Absolute sample peak over all channels from sample `from` to the end (linear). */
function peakFrom(channels, from) {
  let p = 0;
  for (const ch of channels)
    for (let i = Math.max(0, from); i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > p) p = a;
    }
  return p;
}

/**
 * The warning for a clip the mix length cuts, or null when the part that is cut off is inaudible: its peak after
 * the clip gain (and any clip_leveling gain) is at or under TRUNCATION_AUDIBLE_DB. Music files often run on into
 * silence past the mix end, which is not worth a warning.
 * @param {{name: string}} track @param {number} ci clip index @param {object} clip
 * @param {import('../wav.mjs').Audio} audio the decoded clip @param {number} audibleLen samples heard
 * @param {number} gainDb clip gain plus leveling gain
 * @returns {string|null}
 */
export function truncationWarning(track, ci, clip, audio, audibleLen, gainDb) {
  const cutFrames = framesOf(audio) - audibleLen;
  if (cutFrames <= 0) return null;
  const cutPeak = peakFrom(audio.channels, audibleLen) * fromDb(gainDb);
  if (cutPeak <= fromDb(TRUNCATION_AUDIBLE_DB)) return null;
  const seconds = Number((cutFrames / audio.sampleRate).toFixed(3));
  const peakDb = db(cutPeak).toFixed(1);
  const what =
    `track "${track.name}" clip ${ci} extends past the mix length and was truncated: ` +
    `${seconds} s cut, peaking at ${peakDb} dBFS`;
  const fadeOut = clip.fade_out_s ?? 0;
  return fadeOut > 0 ? `${what}; its ${fadeOut} s fade-out was applied at the cut` : what;
}

/**
 * Place every clip into its track buffer (post gain/fades/pan, before track fx). Also computes N.
 * When `track.clip_leveling` is set, clips are measured and levelled first. When `plan.cues` is set, the
 * measured window of every clip of a cue track is returned in `spans` (absolute samples, end exclusive), with
 * `land` (the sample its onset falls on) for a clip that states one. Every position comes from `clip.atSample`,
 * the clip's real start, whether it was placed with `at` or with `land_at`.
 * @param {object} plan @param {Map<string, import('../wav.mjs').Audio>} decoded
 * @returns {{buffers: Map<string, import('../wav.mjs').Audio>, n: number, warnings: string[],
 *   spans: Map<string, {clip: number, name: string|null, from: number, to: number, land?: number}[]>}}
 */
export function buildTrackBuffers(plan, decoded) {
  const warnings = [];
  const n = computeN(plan, (clip) => framesOf(decoded.get(clipKey(clip))));
  if (n <= 0) throw new ToolError('invalid-input', 'mix has no length: provide clips or duration_s');

  const cueTracks = new Set(plan.cues?.tracks ?? []);
  const buffers = new Map();
  const spans = new Map();
  for (const track of plan.tracks) {
    const trackCh = Array.from({ length: plan.channels }, () => new Float32Array(n));
    const clips = track.clips ?? [];
    const trackSpans = cueTracks.has(track.name) ? [] : null;
    let levelGains = null;
    if (track.clip_leveling) {
      levelGains = levelClips(
        clips.map((clip) => integratedLufs(decoded.get(clipKey(clip)))),
        track.clip_leveling,
      );
    }
    clips.forEach((clip, ci) => {
      const audio = decoded.get(clipKey(clip));
      const frames = framesOf(audio);
      const truncated = clip.atSample + frames > n;
      // A truncated clip is heard from atSample to the mix end only, so its fade-out must end there.
      const audibleLen = truncated ? Math.max(0, n - clip.atSample) : frames;
      const extraGainDb = levelGains?.[ci] ?? 0;
      const processed = prepareClip(audio, clip, { outCh: plan.channels, extraGainDb, audibleLen });
      if (truncated) {
        const warning = truncationWarning(track, ci, clip, audio, audibleLen, (clip.gain_db ?? 0) + extraGainDb);
        if (warning) warnings.push(warning);
      }
      if (trackSpans) {
        const { start, end } = clipWindow(processed, audibleLen, plan.cues.window);
        const from = clip.atSample + start;
        const span = { clip: ci, name: clip.name ?? null, from, to: from + (end - start) };
        if (clip.landSample != null) span.land = clip.landSample;
        trackSpans.push(span);
      }
      mixInto(trackCh, processed, clip.atSample);
    });
    buffers.set(track.name, { sampleRate: plan.sampleRate, channels: trackCh });
    if (trackSpans) spans.set(track.name, trackSpans);
  }
  return { buffers, n, warnings, spans };
}
