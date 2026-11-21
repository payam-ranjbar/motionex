// audio.mix planner: turn a validated request into a plan (track_defaults applied, every clip's and
// automation point's `at` time resolved to samples, a clip's `land_at` turned into its real start, read
// offset and length, mix length N, and cross-references checked). Pure apart from reading the optional
// timeline JSON file.
import { readFile } from 'node:fs/promises';
import { ToolError } from '../errors.mjs';
import { deepMerge } from '../presets.mjs';
import { resolveTime } from '../timespec.mjs';
import { resolveAutomation } from './automation.mjs';
import { resolveCues } from './cues.mjs';

const DEFAULT_OUTPUT = { name: 'mix.wav', format: 'wav32f', stems: false, preview_mp3: false };

/** Read and parse a timeline.json ref (already resolved to an absolute path). @returns {Promise<object|null>} */
export async function loadTimeline(file, { signal } = {}) {
  if (!file) return null;
  if (signal?.aborted) throw new ToolError('canceled', 'canceled');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new ToolError('input-unreadable', `could not read timeline ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ToolError('invalid-input', `timeline ${file} is not valid JSON: ${e.message}`);
  }
}

/** Apply the per-track scalar/object defaults that are NOT in the JSON schema, so a preset's
 * track_defaults can win over them (defaults < track_defaults < track). */
function normalizeTrack(track) {
  return {
    ...track,
    gain_db: track.gain_db ?? 0,
    mute: track.mute ?? false,
    clips: (track.clips ?? []).map((clip) => ({
      ...clip,
      offset_s: clip.offset_s ?? 0,
      gain_db: clip.gain_db ?? 0,
      pan: clip.pan ?? 0,
      fade_in_s: clip.fade_in_s ?? 0,
      fade_out_s: clip.fade_out_s ?? 0,
    })),
  };
}

/**
 * For every track whose name is a key of `trackDefaults`, merge the default UNDER the track
 * (`deepMerge(trackDefaults[name], track)`, the request's track wins), then fill scalar defaults.
 * @param {object[]} tracks @param {Record<string, object>} [trackDefaults] @returns {object[]}
 */
export function applyTrackDefaults(tracks, trackDefaults = {}) {
  return tracks.map((track) => {
    const def = trackDefaults?.[track.name];
    return normalizeTrack(def ? deepMerge(def, track) : track);
  });
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Place a clip by the moment its onset is heard (`land_at`, already resolved to seconds).
 * The clip starts `onset_s - offset_s` before the landing, so the source sample at `onset_s` falls on it. When that
 * start is before 0 the lead-in is trimmed (the read offset is raised) and the onset still lands. `duration_s` is
 * counted from the onset, so the lead-in that is played is added to it. An `offset_s` after a given `onset_s` leaves
 * no onset in the played part: the played start lands instead.
 * @param {object} clip a normalized clip @param {number} landS @param {number} sampleRate
 * @param {string} label how warnings name the clip @param {string[]} warnings
 * @returns {{atSample: number, landSample: number, offset_s: number, duration_s: number|undefined}}
 */
function placeLanding(clip, landS, sampleRate, label, warnings) {
  const landSample = Math.round(landS * sampleRate);
  const offset = clip.offset_s ?? 0;
  const onset = clip.onset_s ?? 0;
  let lead = onset - offset;
  if (lead < 0) {
    if (clip.onset_s != null)
      warnings.push(
        `${label}: offset_s ${offset} s is after onset_s ${onset} s, so the onset is not in the part played; ` +
          `the start of the played part lands at ${landS} s`,
      );
    lead = 0;
  }
  let leadFrames = Math.round(lead * sampleRate);
  let offsetS = offset;
  if (leadFrames > landSample) {
    const trimFrames = leadFrames - landSample;
    offsetS = offset + trimFrames / sampleRate;
    leadFrames = landSample;
    warnings.push(
      `${label}: landing at ${landS} s leaves no room for the ${r4(lead)} s before the onset; the first ` +
        `${r4(trimFrames / sampleRate)} s of it was trimmed (reading from ${r4(offsetS)} s) and the onset still ` +
        `lands at ${landS} s`,
    );
  }
  return {
    atSample: landSample - leadFrames,
    landSample,
    offset_s: offsetS,
    duration_s: clip.duration_s != null ? clip.duration_s + leadFrames / sampleRate : undefined,
  };
}

/** Resolve each clip's `at` or `land_at` (number or timespec string) to seconds and to a rounded sample index.
 * A clip placed with `at` keeps its fields and gets `atS`/`atSample` (plus `landSample` when it states an `onset_s`
 * that is in the played part). A clip placed with `land_at` gets its real start in `atS`/`atSample`, the landing in
 * `landS`/`landSample`, and `offset_s`/`duration_s` replaced by the values actually read (see placeLanding).
 * @param {object[]} tracks @param {object|null} timeline @param {number} sampleRate
 * @param {string[]} [warnings] gets a line for every trimmed lead-in and every onset outside the played part
 * @returns {object[]}
 * @throws {ToolError} invalid-input for an unparseable time, a negative placement, or a clip with both or neither
 *   of `at` and `land_at` */
export function resolveClipTimes(tracks, timeline, sampleRate, warnings = []) {
  return tracks.map((track, ti) => ({
    ...track,
    clips: (track.clips ?? []).map((clip, ci) => {
      const where = `tracks[${ti}].clips[${ci}]`;
      const hasAt = clip.at != null;
      const hasLand = clip.land_at != null;
      if (hasAt && hasLand) throw new ToolError('invalid-input', `${where}: give "at" or "land_at", not both`);
      if (!hasAt && !hasLand)
        throw new ToolError(
          'invalid-input',
          `${where}: needs "at" (where the clip starts) or "land_at" (where its onset is heard)`,
        );
      if (clip.onset_s != null && !(Number.isFinite(clip.onset_s) && clip.onset_s >= 0))
        throw new ToolError('invalid-input', `${where}.onset_s: expected a number of seconds >= 0`);

      if (hasAt) {
        const what = `${where}.at`;
        const atS = resolveTime(clip.at, timeline, what);
        const atSample = Math.round(atS * sampleRate);
        if (atSample < 0) throw new ToolError('invalid-input', `${what}: negative time ${atS}s`);
        const lead = clip.onset_s != null ? clip.onset_s - (clip.offset_s ?? 0) : -1;
        if (lead < 0) return { ...clip, atS, atSample };
        return { ...clip, atS, atSample, landSample: atSample + Math.round(lead * sampleRate) };
      }

      const what = `${where}.land_at`;
      const landS = resolveTime(clip.land_at, timeline, what);
      if (Math.round(landS * sampleRate) < 0) throw new ToolError('invalid-input', `${what}: negative time ${landS}s`);
      const label = `track "${track.name}" clip ${ci}`;
      const placed = placeLanding(clip, landS, sampleRate, label, warnings);
      const { duration_s, ...rest } = placed;
      return {
        ...clip,
        ...rest,
        ...(duration_s != null ? { duration_s } : {}),
        atS: r4(placed.atSample / sampleRate),
        landS,
      };
    }),
  }));
}

/** The set of declared bus names. @returns {Set<string>} */
export function busNames(buses = []) {
  return new Set(buses.map((b) => b.name));
}

/** Every track.bus must name a declared bus. @throws {ToolError} invalid-input */
export function validateBusRefs(tracks, buses = []) {
  const names = busNames(buses);
  tracks.forEach((track, i) => {
    if (track.bus != null && !names.has(track.bus))
      throw new ToolError('invalid-input', `tracks[${i}].bus: unknown bus "${track.bus}"`);
  });
}

/** Keep only sidechain entries whose target and key name a track; skip the rest with a warning.
 * A preset may name tracks (for example "sfx") that the request does not have, which must not fail the mix.
 * @returns {object[]} the entries whose target and key both name a track */
export function validateSidechainRefs(sidechain = [], tracks) {
  const names = new Set(tracks.map((t) => t.name));
  return sidechain.filter((s) => {
    const missing = !names.has(s.target) ? s.target : !names.has(s.key) ? s.key : null;
    if (missing == null) return true;
    console.warn(`sidechain ${s.target}<-${s.key} skipped: no track named ${missing}`);
    return false;
  });
}

/** `clip_leveling.to` may be a LUFS number or exactly the string "median". @throws {ToolError} invalid-input */
export function validateClipLeveling(tracks) {
  tracks.forEach((track, i) => {
    const to = track.clip_leveling?.to;
    if (typeof to === 'string' && to !== 'median')
      throw new ToolError(
        'invalid-input',
        `tracks[${i}].clip_leveling.to: expected a LUFS number or "median", got "${to}"`,
      );
  });
}

/**
 * Mix length in samples: `round(duration_s * sample_rate)` when duration_s was given, otherwise the
 * largest `atSample + clipFrames` over all clips (0 when there are none).
 * @param {{durationFrames: number|null, tracks: object[]}} plan @param {(clip: object) => number} clipFrames
 * @returns {number} */
export function computeN(plan, clipFrames) {
  if (plan.durationFrames != null) return plan.durationFrames;
  let n = 0;
  for (const track of plan.tracks) {
    for (const clip of track.clips ?? []) {
      const end = clip.atSample + (clipFrames(clip) ?? 0);
      if (end > n) n = end;
    }
  }
  return n;
}

/**
 * Build the mix plan from a validated request.
 * @param {object} input the validated input (refs resolved to absolute paths)
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{sampleRate: number, channels: number, durationFrames: number|null,
 *   tracks: object[], buses: object[], sidechain: object[], master: object, output: object, timeline: object|null,
 *   cues: {reference: string, tracks: string[], window: string}|null, warnings: string[]}>}
 */
export async function buildPlan(input, { signal } = {}) {
  const sampleRate = input.sample_rate ?? 48000;
  const channels = input.channels ?? 2;
  const timeline = input.timeline ? await loadTimeline(input.timeline, { signal }) : null;
  const warnings = [];
  const tracks = resolveAutomation(
    resolveClipTimes(applyTrackDefaults(input.tracks, input.track_defaults ?? {}), timeline, sampleRate, warnings),
    timeline,
    sampleRate,
    warnings,
  );
  const buses = input.buses ?? [];

  if (!tracks.length) throw new ToolError('invalid-input', 'tracks must contain at least one track');
  const sidechain = validateSidechainRefs(input.sidechain ?? [], tracks);
  validateBusRefs(tracks, buses);
  validateClipLeveling(tracks);
  const cues = resolveCues(input.cues, tracks);

  return {
    sampleRate,
    channels,
    durationFrames: input.duration_s != null ? Math.round(input.duration_s * sampleRate) : null,
    tracks,
    buses,
    sidechain,
    master: input.master ?? {},
    output: { ...DEFAULT_OUTPUT, ...(input.output ?? {}) },
    timeline,
    cues,
    warnings,
  };
}
