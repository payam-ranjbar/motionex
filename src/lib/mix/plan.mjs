// audio.mix planner: turn a validated request into a plan (track_defaults applied, every clip's
// `at` time resolved to samples, mix length N, and cross-references checked). Pure apart from
// reading the optional timeline JSON file.
import { readFile } from 'node:fs/promises';
import { ToolError } from '../errors.mjs';
import { deepMerge } from '../presets.mjs';
import { resolveTime } from '../timespec.mjs';

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

/** Resolve each clip's `at` (number or timespec string) to seconds and to a rounded sample index.
 * @param {object[]} tracks @param {object|null} timeline @param {number} sampleRate @returns {object[]}
 * @throws {ToolError} invalid-input for an unparseable time or a negative placement */
export function resolveClipTimes(tracks, timeline, sampleRate) {
  return tracks.map((track, ti) => ({
    ...track,
    clips: (track.clips ?? []).map((clip, ci) => {
      const what = `tracks[${ti}].clips[${ci}].at`;
      const atS = resolveTime(clip.at, timeline, what);
      const atSample = Math.round(atS * sampleRate);
      if (atSample < 0) throw new ToolError('invalid-input', `${what}: negative time ${atS}s`);
      return { ...clip, atS, atSample };
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
 *   tracks: object[], buses: object[], sidechain: object[], master: object, output: object, timeline: object|null}>}
 */
export async function buildPlan(input, { signal } = {}) {
  const sampleRate = input.sample_rate ?? 48000;
  const channels = input.channels ?? 2;
  const timeline = input.timeline ? await loadTimeline(input.timeline, { signal }) : null;
  const tracks = resolveClipTimes(applyTrackDefaults(input.tracks, input.track_defaults ?? {}), timeline, sampleRate);
  const buses = input.buses ?? [];

  if (!tracks.length) throw new ToolError('invalid-input', 'tracks must contain at least one track');
  const sidechain = validateSidechainRefs(input.sidechain ?? [], tracks);
  validateBusRefs(tracks, buses);
  validateClipLeveling(tracks);

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
  };
}
