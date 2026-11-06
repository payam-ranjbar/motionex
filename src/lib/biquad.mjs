// RBJ audio-EQ-cookbook biquads (low-pass / high-pass), normalised by a0, direct form II transposed.
// A small DSP primitive shared by analysis tools: the caller chooses type, corner frequency and Q, nothing is implied.

/**
 * @typedef {{b0: number, b1: number, b2: number, a1: number, a2: number}} BiquadCoeffs
 *   Coefficients normalised by a0 (the delay coefficients are already negated, so y = b0*x + d1).
 */

/**
 * RBJ cookbook coefficients for a low-pass or high-pass biquad, normalised by a0.
 * @param {'lowpass'|'highpass'} type filter shape
 * @param {number} sampleRate samples per second
 * @param {number} f0 corner frequency in Hz
 * @param {number} [q] quality factor (default 1/sqrt(2), i.e. Butterworth)
 * @returns {BiquadCoeffs}
 */
export function rbjCoeffs(type, sampleRate, f0, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const a1 = (-2 * cosw0) / a0;
  const a2 = (1 - alpha) / a0;
  if (type === 'lowpass') {
    const b0 = (1 - cosw0) / 2 / a0;
    const b1 = (1 - cosw0) / a0;
    return { b0, b1, b2: b0, a1, a2 };
  }
  if (type === 'highpass') {
    const b0 = (1 + cosw0) / 2 / a0;
    const b1 = -(1 + cosw0) / a0;
    return { b0, b1, b2: b0, a1, a2 };
  }
  throw new TypeError(`rbjCoeffs: unknown filter type "${type}"`);
}

/**
 * Apply a biquad to one channel: direct form II transposed, Float64 state, Float32 output.
 * @param {Float32Array} ch input samples
 * @param {BiquadCoeffs} c coefficients from rbjCoeffs()
 * @returns {Float32Array} filtered samples (new array, same length)
 */
export function biquad(ch, c) {
  const { b0, b1, b2, a1, a2 } = c;
  const out = new Float32Array(ch.length);
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    const y = b0 * x + d1;
    d1 = b1 * x - a1 * y + d2;
    d2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * One RBJ high-pass pass over a channel.
 * @param {Float32Array} ch input samples
 * @param {number} sr sample rate in Hz
 * @param {number} f corner frequency in Hz
 * @param {number} [q] quality factor
 * @returns {Float32Array}
 */
export const highpass = (ch, sr, f, q) => biquad(ch, rbjCoeffs('highpass', sr, f, q));

/**
 * One RBJ low-pass pass over a channel.
 * @param {Float32Array} ch input samples
 * @param {number} sr sample rate in Hz
 * @param {number} f corner frequency in Hz
 * @param {number} [q] quality factor
 * @returns {Float32Array}
 */
export const lowpass = (ch, sr, f, q) => biquad(ch, rbjCoeffs('lowpass', sr, f, q));
