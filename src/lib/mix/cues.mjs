// audio.mix cue table (input `cues`): for every clip of the named tracks, the level of its track over the clip's
// window next to the level of a reference track over the same window. Levels are measured on the stems, so after
// the track fx, gain_db, automation, level and sidechains. A level is the K-weighted loudness of the window
// (BS.1770 weighting, no gating) in LUFS: -0.691 + 10*log10(sum over channels of the mean square), so ratio_db is a
// difference in LU (= dB). The window comes from the clip itself (its placement, gain and fades), not from the
// track's fx.
import { ToolError } from '../errors.mjs';
import { kWeight } from '../loudness.mjs';
import { fromDb } from '../signal.mjs';

/** At most this many rows are copied into the job result; report.json always holds every row. */
export const CUES_IN_RESULT = 100;
/** Window "audible": the heard part of a clip without its leading and trailing parts this many dB under its peak. */
export const AUDIBLE_RANGE_DB = 30;

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Check the request's `cues` against the track names.
 * @param {{reference: string, tracks?: string[], window?: 'audible'|'clip'}|undefined} cues
 * @param {{name: string}[]} tracks
 * @returns {{reference: string, tracks: string[], window: 'audible'|'clip'}|null} null when `cues` is absent;
 *   `tracks` defaults to every track except the reference, in mix order
 * @throws {ToolError} invalid-input when a name is not a track
 */
export function resolveCues(cues, tracks) {
  if (!cues) return null;
  const names = new Set(tracks.map((t) => t.name));
  if (!names.has(cues.reference))
    throw new ToolError('invalid-input', `cues.reference: unknown track "${cues.reference}"`);
  const listed = cues.tracks ?? tracks.map((t) => t.name).filter((name) => name !== cues.reference);
  listed.forEach((name, i) => {
    if (!names.has(name)) throw new ToolError('invalid-input', `cues.tracks[${i}]: unknown track "${name}"`);
  });
  return { reference: cues.reference, tracks: [...new Set(listed)], window: cues.window ?? 'audible' };
}

/**
 * The measured window of one prepared clip (post gain, fades and pan), in samples from the clip start, end exclusive.
 * "clip" is the heard part [0, audibleLen); "audible" is that part without its leading and trailing samples more
 * than AUDIBLE_RANGE_DB under the clip's peak. A silent or unheard clip gives an empty window {start: 0, end: 0}.
 * @param {Float32Array[]} channels @param {number} audibleLen @param {'audible'|'clip'} [window]
 * @returns {{start: number, end: number}}
 */
export function clipWindow(channels, audibleLen, window = 'audible') {
  const len = Math.max(0, Math.min(audibleLen, channels[0]?.length ?? 0));
  if (window === 'clip') return { start: 0, end: len };
  let p = 0;
  for (const ch of channels)
    for (let i = 0; i < len; i++) {
      const a = Math.abs(ch[i]);
      if (a > p) p = a;
    }
  if (p === 0) return { start: 0, end: 0 };
  const threshold = p * fromDb(-AUDIBLE_RANGE_DB);
  const loud = (i) => channels.some((ch) => Math.abs(ch[i]) >= threshold);
  let start = 0;
  while (start < len && !loud(start)) start++;
  let end = len;
  while (end > start && !loud(end - 1)) end--;
  return { start, end };
}

/**
 * Ungated loudness of K-weighted channels over samples [from, to).
 * @param {Float32Array[]} kw @param {number} from @param {number} to @returns {number|null} null when empty or silent
 */
export function windowLoudness(kw, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(kw[0]?.length ?? 0, to);
  if (b <= a) return null;
  let z = 0;
  for (const ch of kw) {
    let s = 0;
    for (let i = a; i < b; i++) s += ch[i] * ch[i];
    z += s / (b - a);
  }
  return z > 0 ? -0.691 + 10 * Math.log10(z) : null;
}

/** Median of a non-empty numeric list. */
function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Build the cue rows and their per-track summary.
 * @param {{sampleRate: number, cues: {reference: string, tracks: string[], window: string}}} plan
 * @param {Map<string, import('../wav.mjs').Audio>} stems
 * @param {Map<string, {clip: number, name: string|null, from: number, to: number}[]>} spans absolute sample windows
 *   per cue track (from clips.mjs buildTrackBuffers)
 * @returns {{rows: object[], summary: {reference: string, window: string, rows: number, tracks: Record<string, object>}}}
 */
export function cueTable(plan, stems, spans) {
  const { reference, tracks, window } = plan.cues;
  const sr = plan.sampleRate;
  const referenceKw = kWeight(stems.get(reference));
  const rows = [];
  const summary = {};
  for (const track of tracks) {
    // One K-weighted track at a time (next to the reference), so a long mix with many tracks stays small in memory.
    const kw = track === reference ? referenceKw : kWeight(stems.get(track));
    const trackSpans = spans.get(track) ?? [];
    const ratios = [];
    for (const span of trackSpans) {
      const level = windowLoudness(kw, span.from, span.to);
      const ref = windowLoudness(referenceKw, span.from, span.to);
      const ratio = level != null && ref != null ? level - ref : null;
      if (ratio != null) ratios.push(ratio);
      rows.push({
        track,
        clip: span.clip,
        name: span.name,
        at: r4(span.from / sr),
        end: r4(span.to / sr),
        level_db: r2(level),
        reference_db: r2(ref),
        ratio_db: r2(ratio),
      });
    }
    summary[track] = {
      clips: trackSpans.length,
      min_ratio_db: ratios.length ? r2(Math.min(...ratios)) : null,
      median_ratio_db: ratios.length ? r2(median(ratios)) : null,
      max_ratio_db: ratios.length ? r2(Math.max(...ratios)) : null,
    };
  }
  return { rows, summary: { reference, window, rows: rows.length, tracks: summary } };
}

/**
 * Add the cue table to a result. The result gets `cues_summary`, plus `cues` (every row) when there are at most
 * CUES_IN_RESULT rows; the report (report.json) always gets every row.
 * @param {object} result @param {{rows: object[], summary: object}|null} table
 * @returns {{result: object, report: object}}
 */
export function attachCues(result, table) {
  if (!table) return { result, report: result };
  const withSummary = { ...result, cues_summary: table.summary };
  return {
    result: table.rows.length <= CUES_IN_RESULT ? { ...withSummary, cues: table.rows } : withSummary,
    report: { ...withSummary, cues: table.rows },
  };
}
