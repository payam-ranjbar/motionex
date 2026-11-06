// EBU R128 / ITU BS.1770-4 loudness: ffmpeg ebur128 parsing plus a pure-JS K-weighted meter.
import { ToolError } from './errors.mjs';
import { parseDuration, runFfmpeg } from './ffmpeg.mjs';
import { encodeWav, framesOf } from './wav.mjs';

const EBUR128_FILTER = 'ebur128=framelog=quiet:peak=true+sample';

/** Parse the "Summary:" block of ffmpeg ebur128 (peak=true+sample) stderr. Missing or -inf values -> null.
 * @returns {{integrated_lufs: number|null, lra_lu: number|null, sample_peak_dbfs: number|null, true_peak_dbtp: number|null}}
 * @throws {ToolError} tool-failed when there is no Summary block */
export function parseEbur128Summary(stderr) {
  const text = String(stderr ?? '');
  const at = text.lastIndexOf('Summary:');
  if (at < 0) throw new ToolError('tool-failed', 'ffmpeg printed no ebur128 summary');
  const block = text.slice(at);
  const value = (re) => {
    const m = re.exec(block);
    if (!m) return null;
    return m[1] === '-inf' ? null : Number(m[1]);
  };
  return {
    integrated_lufs: value(/I:\s+(-?[\d.]+|-inf) LUFS/),
    lra_lu: value(/LRA:\s+(-?[\d.]+|-inf) LU\b/),
    sample_peak_dbfs: value(/Sample peak:\s+Peak:\s+(-?[\d.]+|-inf)/),
    true_peak_dbtp: value(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)/),
  };
}

/** Measure a file: ffmpeg -i file -map 0:a:0 -af ebur128=framelog=quiet:peak=true+sample -f null -
 * @returns {Promise<{integrated_lufs: number|null, lra_lu: number|null, true_peak_dbtp: number|null, sample_peak_dbfs: number|null, duration_s: number|null}>} */
export async function ebur128(file, { signal } = {}) {
  const args = ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', EBUR128_FILTER, '-f', 'null', '-'];
  const { stderr } = await runFfmpeg(args, { signal });
  return { ...parseEbur128Summary(stderr), duration_s: parseDuration(stderr) };
}

/** Same as ebur128() for an in-memory Audio (piped to ffmpeg as f32 WAV; no temp files).
 * @returns {Promise<{integrated_lufs: number|null, lra_lu: number|null, true_peak_dbtp: number|null, sample_peak_dbfs: number|null, duration_s: number}>} */
export async function measureAudio(audio, { signal } = {}) {
  const args = [
    '-hide_banner',
    '-nostats',
    '-f',
    'wav',
    '-i',
    'pipe:0',
    '-map',
    '0:a:0',
    '-af',
    EBUR128_FILTER,
    '-f',
    'null',
    '-',
  ];
  const { stderr } = await runFfmpeg(args, { input: encodeWav(audio, { format: 'f32' }), signal });
  return { ...parseEbur128Summary(stderr), duration_s: framesOf(audio) / audio.sampleRate };
}

// BS.1770 K-weighting high shelf (pyloudnorm form, normalised by a0):
// f0 = 1681.974450955533 Hz, G = 3.999843853973347 dB, Q = 0.7071752369554196, Vb = Vh^0.4996667741545416.
// This bilinear design reproduces the published BS.1770-4 48 kHz coefficients exactly.
function shelfCoef(fs) {
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const fc = 1681.974450955533;
  const K = Math.tan((Math.PI * fc) / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

// RBJ high-pass, normalised by a0. f0 = 38.13547087602444 Hz, Q = 0.5003270373238773.
function highpassCoef(fs) {
  const Q = 0.5003270373238773;
  const fc = 38.13547087602444;
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const c = Math.cos(w0);
  const b0 = (1 + c) / 2;
  const b1 = -(1 + c);
  const b2 = (1 + c) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * c;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Direct form II transposed, Float64 state, Float64 output.
function biquad(input, { b0, b1, b2, a1, a2 }) {
  const out = new Float64Array(input.length);
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + d1;
    d1 = b1 * x - a1 * y + d2;
    d2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

/** K-weighting pre-filter (BS.1770 stage 1 shelf + stage 2 high-pass) for ANY sample rate.
 * Coefficients from the analog prototype via the bilinear transform (pyloudnorm formulas: shelf f0=1681.974450955533 Hz,
 * G=3.999843853973347 dB, Q=0.7071752369554196; high-pass f0=38.13547087602444 Hz, Q=0.5003270373238773).
 * @returns {Float32Array[]} filtered channels */
export function kWeight(audio) {
  const shelf = shelfCoef(audio.sampleRate);
  const hp = highpassCoef(audio.sampleRate);
  return audio.channels.map((ch) => {
    const staged = biquad(biquad(ch, shelf), hp);
    const out = new Float32Array(staged.length);
    for (let i = 0; i < staged.length; i++) out[i] = staged[i];
    return out;
  });
}

/** BS.1770-4 integrated loudness: 400 ms blocks, 75% overlap, absolute gate -70 LUFS, relative gate -10 LU.
 * Channel weights 1.0 (mono/stereo). Must agree with ffmpeg ebur128 within 0.2 LU. null for silence / too short.
 * @returns {number|null} */
export function integratedLufs(audio) {
  const kw = kWeight(audio);
  const sr = audio.sampleRate;
  const frames = framesOf(audio);
  const block = Math.round(0.4 * sr);
  const hop = Math.round(0.1 * sr);
  if (block <= 0 || frames < block) return null;

  const blocks = [];
  for (let start = 0; start + block <= frames; start += hop) {
    let z = 0;
    for (const ch of kw) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += ch[i] * ch[i];
      z += s / block;
    }
    blocks.push({ z, l: -0.691 + 10 * Math.log10(z) });
  }
  const gated = blocks.filter((b) => b.l > -70);
  if (!gated.length) return null;
  const meanGated = gated.reduce((s, b) => s + b.z, 0) / gated.length;
  if (!(meanGated > 0)) return null;
  const relativeGate = -0.691 + 10 * Math.log10(meanGated) - 10;
  const kept = gated.filter((b) => b.l > relativeGate);
  if (!kept.length) return null;
  const meanKept = kept.reduce((s, b) => s + b.z, 0) / kept.length;
  if (!(meanKept > 0)) return null;
  return -0.691 + 10 * Math.log10(meanKept);
}

/** Ungated loudness of already K-weighted channels over [from_s, to_s): -0.691 + 10*log10(sum of channel mean squares).
 * @returns {number|null} null when the window is empty or silent */
export function windowLufs(kw, sampleRate, from_s, to_s) {
  const frames = kw[0]?.length ?? 0;
  const from = Math.max(0, Math.round(from_s * sampleRate));
  const to = Math.min(frames, Math.round(to_s * sampleRate));
  if (to <= from) return null;
  const n = to - from;
  let z = 0;
  for (const ch of kw) {
    let s = 0;
    for (let i = from; i < to; i++) s += ch[i] * ch[i];
    z += s / n;
  }
  if (!(z > 0)) return null;
  return -0.691 + 10 * Math.log10(z);
}

/** Momentary (0.4 s) or short-term (3 s) loudness every step_s. Point t is the END of its window (t = window_s, window_s+step_s, ...
 * while t <= duration); windows shorter than window_s at the start are skipped.
 * @returns {{t: number, lufs: number|null}[]} */
export function loudnessCurve(audio, { window_s = 0.4, step_s = 0.1 } = {}) {
  const kw = kWeight(audio);
  const sr = audio.sampleRate;
  const duration = framesOf(audio) / sr;
  const round1e6 = (x) => Math.round(x * 1e6) / 1e6;
  const points = [];
  for (let t = window_s; t <= duration + 1e-9; t += step_s) {
    const lufs = windowLufs(kw, sr, t - window_s, t);
    points.push({ t: round1e6(t), lufs: lufs == null ? null : Math.round(lufs * 100) / 100 });
  }
  return points;
}
