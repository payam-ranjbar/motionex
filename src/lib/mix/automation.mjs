// audio.mix track gain automation: a list of {at, gain_db} points per track. Between two points the gain ramps
// linearly in dB; before the first point it holds the first value and after the last point the last value. Two
// points at the same time make a step. It is applied to the summed track right after the track fx and gain_db
// (render.mjs buildMix), so `level`, sidechains and the stems all see the automated track.
import { ToolError } from '../errors.mjs';
import { fromDb } from '../signal.mjs';
import { resolveTime } from '../timespec.mjs';

/**
 * Resolve every automation point's `at` (seconds or a timespec, exactly like a clip's `at`) to seconds and to a
 * rounded sample index, and sort the points by time. The sort is stable, so points at the same time keep their order.
 * @param {object[]} tracks @param {object|null} timeline @param {number} sampleRate
 * @param {string[]} [warnings] receives one line per track whose points were not in time order
 * @returns {object[]} the tracks, `automation` replaced by sorted `{at, gain_db, atS, atSample}` points (absent stays absent)
 * @throws {ToolError} invalid-input for an empty list or a time that does not resolve
 */
export function resolveAutomation(tracks, timeline, sampleRate, warnings = []) {
  return tracks.map((track, ti) => {
    if (track.automation == null) return track;
    if (!Array.isArray(track.automation) || track.automation.length === 0)
      throw new ToolError('invalid-input', `tracks[${ti}].automation: needs at least one point`);
    const points = track.automation.map((point, pi) => {
      if (!Number.isFinite(point.gain_db))
        throw new ToolError('invalid-input', `tracks[${ti}].automation[${pi}].gain_db: must be a finite number`);
      const atS = resolveTime(point.at, timeline, `tracks[${ti}].automation[${pi}].at`);
      return { ...point, atS, atSample: Math.round(atS * sampleRate) };
    });
    if (points.some((p, i) => i > 0 && p.atS < points[i - 1].atS)) {
      points.sort((a, b) => a.atS - b.atS);
      warnings.push(`track "${track.name}" automation points were not in time order; they were sorted by time`);
    }
    return { ...track, automation: points };
  });
}

/**
 * The automation gain in dB at sample `i`. `points` are sorted resolved points (see resolveAutomation).
 * @param {{atSample: number, gain_db: number}[]} points @param {number} i @returns {number}
 */
export function automationDbAt(points, i) {
  let k = 0;
  while (k + 1 < points.length && points[k + 1].atSample <= i) k++;
  return segmentDb(points, k, i);
}

/** Gain in dB at sample i, where k is the last point at or before i (or 0 when i is before the first point). */
function segmentDb(points, k, i) {
  const a = points[k];
  if (i < a.atSample || k === points.length - 1) return a.gain_db;
  const b = points[k + 1];
  return a.gain_db + ((b.gain_db - a.gain_db) * (i - a.atSample)) / (b.atSample - a.atSample);
}

/**
 * Multiply a track by its automation curve. Returns the input unchanged when there are no points or every point
 * is 0 dB; a curve with one value is a constant gain.
 * @param {import('../wav.mjs').Audio} audio @param {{atSample: number, gain_db: number}[]|undefined} points
 * @returns {import('../wav.mjs').Audio} a new Audio of the same length
 */
export function applyAutomation(audio, points) {
  if (!points?.length) return audio;
  const constant = points.every((p) => p.gain_db === points[0].gain_db);
  if (constant && points[0].gain_db === 0) return audio;
  const n = audio.channels[0]?.length ?? 0;
  const out = audio.channels.map(() => new Float32Array(n));
  let k = 0;
  let lastDb = Number.NaN;
  let g = 1;
  for (let i = 0; i < n; i++) {
    while (k + 1 < points.length && points[k + 1].atSample <= i) k++;
    const gainDb = constant ? points[0].gain_db : segmentDb(points, k, i);
    if (gainDb !== lastDb) {
      lastDb = gainDb;
      g = fromDb(gainDb);
    }
    for (let c = 0; c < out.length; c++) out[c][i] = audio.channels[c][i] * g;
  }
  return { sampleRate: audio.sampleRate, channels: out };
}
