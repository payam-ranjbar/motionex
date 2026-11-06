// STUB (owner: P6b). Replace the bodies; keep the exported names and signatures.
// Master stage of audio.mix: master fx chain, master gain, optional loudness target (gain+limiter or two-pass loudnorm).
import { ToolError } from '../errors.mjs';

/**
 * @param {import('../wav.mjs').Audio} audio  the summed mix (any length; returned audio has the SAME length)
 * @param {{gain_db?: number, fx?: string, loudness?: {target_lufs: number, true_peak_db?: number, method?: 'gain+limiter'|'loudnorm', lra?: number}}} master
 * @returns {Promise<{audio: import('../wav.mjs').Audio, report: {before: object, after: object, gain_db: number, method: string|null}}>}
 *   before/after = loudness.measureAudio() results */
export async function applyMaster(audio, master = {}, { signal } = {}) {
  throw new ToolError('internal', 'not implemented: applyMaster');
}
