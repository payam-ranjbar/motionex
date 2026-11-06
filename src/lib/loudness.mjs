// STUB (owner: W0b-loudness). Replace the bodies; keep the exported names and signatures.
// EBU R128 / ITU BS.1770-4 loudness: ffmpeg ebur128 parsing plus a pure-JS K-weighted meter.
import { ToolError } from './errors.mjs';

/** Parse the "Summary:" block of ffmpeg ebur128 (peak=true+sample) stderr. Missing or -inf values -> null.
 * @returns {{integrated_lufs: number|null, lra_lu: number|null, sample_peak_dbfs: number|null, true_peak_dbtp: number|null}}
 * @throws {ToolError} tool-failed when there is no Summary block */
export function parseEbur128Summary(stderr) {
  throw new ToolError('internal', 'not implemented: parseEbur128Summary');
}

/** Measure a file: ffmpeg -i file -map 0:a:0 -af ebur128=framelog=quiet:peak=true+sample -f null -
 * @returns {Promise<{integrated_lufs: number|null, lra_lu: number|null, true_peak_dbtp: number|null, sample_peak_dbfs: number|null, duration_s: number|null}>} */
export async function ebur128(file, { signal } = {}) {
  throw new ToolError('internal', 'not implemented: ebur128');
}

/** Same as ebur128() for an in-memory Audio (piped to ffmpeg as f32 WAV; no temp files).
 * @returns {Promise<{integrated_lufs: number|null, lra_lu: number|null, true_peak_dbtp: number|null, sample_peak_dbfs: number|null, duration_s: number}>} */
export async function measureAudio(audio, { signal } = {}) {
  throw new ToolError('internal', 'not implemented: measureAudio');
}

/** K-weighting pre-filter (BS.1770 stage 1 shelf + stage 2 high-pass) for ANY sample rate.
 * Coefficients from the analog prototype via the bilinear transform (pyloudnorm formulas: shelf f0=1681.974450955533 Hz,
 * G=3.999843853973347 dB, Q=0.7071752369554196; high-pass f0=38.13547087602444 Hz, Q=0.5003270373238773).
 * @returns {Float32Array[]} filtered channels */
export function kWeight(audio) {
  throw new ToolError('internal', 'not implemented: kWeight');
}

/** BS.1770-4 integrated loudness: 400 ms blocks, 75% overlap, absolute gate -70 LUFS, relative gate -10 LU.
 * Channel weights 1.0 (mono/stereo). Must agree with ffmpeg ebur128 within 0.2 LU. null for silence / too short.
 * @returns {number|null} */
export function integratedLufs(audio) {
  throw new ToolError('internal', 'not implemented: integratedLufs');
}

/** Ungated loudness of already K-weighted channels over [from_s, to_s): -0.691 + 10*log10(sum of channel mean squares).
 * @returns {number|null} null when the window is empty or silent */
export function windowLufs(kw, sampleRate, from_s, to_s) {
  throw new ToolError('internal', 'not implemented: windowLufs');
}

/** Momentary (0.4 s) or short-term (3 s) loudness every step_s. Point t is the END of its window (t = window_s, window_s+step_s, ...
 * while t <= duration); windows shorter than window_s at the start are skipped.
 * @returns {{t: number, lufs: number|null}[]} */
export function loudnessCurve(audio, { window_s = 0.4, step_s = 0.1 } = {}) {
  throw new ToolError('internal', 'not implemented: loudnessCurve');
}
