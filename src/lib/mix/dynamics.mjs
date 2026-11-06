// STUB (owner: P14). Replace the bodies; keep the exported names and signatures.
// Optional mixer dynamics: clip leveling, relative track levels, sidechain compression.
import { ToolError } from '../errors.mjs';

/** Gain (dB) per clip that brings it to the target loudness (the median of non-null clipLufs, or a LUFS number).
 * Clips already within tolerance_lu get 0; null (silent) clips get 0; gains are clamped to [min_db, max_db].
 * @param {(number|null)[]} clipLufs @returns {number[]} */
export function levelClips(clipLufs, { to = 'median', tolerance_lu = 0.75, min_db = -9, max_db = 6 } = {}) {
  throw new ToolError('internal', 'not implemented: levelClips');
}

/** Extra gain (dB) per track for `level` specs: {lufs: n} -> n - measured[name]; {relative_to: other, lu: n} -> (measured[other] + gains[other]) + n - measured[name].
 * Resolved in dependency order. Tracks without `level` get 0. measured[name] is the track's integrated LUFS after its fx and gain_db (null = silent -> 0).
 * @param {{name: string, level?: {lufs?: number, relative_to?: string, lu?: number}}[]} tracks @param {Record<string, number|null>} measured
 * @returns {Record<string, number>} @throws {ToolError} invalid-input on unknown relative_to or a cycle */
export function trackLevelGains(tracks, measured) {
  throw new ToolError('internal', 'not implemented: trackLevelGains');
}

/** Apply sidechain compression to TRACK buffers, in array order. Key = buffers[key] advanced by lookahead_s and padded to the target's length.
 * ffmpeg sidechaincompress=threshold:ratio:attack:release:knee:makeup with the target as input 0 and the key as input 1.
 * @param {Record<string, import('../wav.mjs').Audio>} buffers @param {{target: string, key: string, threshold?: number, ratio?: number, attack_ms?: number, release_ms?: number, knee?: number, makeup?: number, lookahead_s?: number}[]} sidechains
 * @returns {Promise<Record<string, import('../wav.mjs').Audio>>} new map; untouched tracks are passed through; every buffer keeps its length */
export async function applySidechains(buffers, sidechains, { signal } = {}) {
  throw new ToolError('internal', 'not implemented: applySidechains');
}
