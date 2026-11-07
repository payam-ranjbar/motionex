// Reusable SFX synthesis DSP kit: stereo [L, R] Float32Array buffers at 48 kHz.
//
// Ported from an earlier in-house DSP script. Differences from the original:
//   - no module-level state: createKit() returns an isolated kit with its own seeded PRNG;
//   - no env vars and no writing: save() became finish(), which returns the processed buffer;
//   - pal() reads from the in-memory `palette` passed to createKit() instead of a scratch folder.
// Recipes call kit.* and keep the original argument orders.
import fs from 'node:fs';
import { ToolError } from '../errors.mjs';
import { mulberry32 } from '../signal.mjs';
import { readWav as readWavFile } from '../wav.mjs';

/** Sample rate (Hz) of every buffer this kit produces. */
export const SR = 48000;

/**
 * @typedef {[Float32Array, Float32Array]} Stereo
 * @typedef {{sampleRate: number, channels: Float32Array[]}} Audio
 */

/**
 * Build an isolated DSP kit.
 * @param {{palette?: Record<string, Audio>, seed?: number}} [options] decoded palette samples by name; PRNG seed
 * @returns {object} every synthesis/processing function plus `SR`
 */
export function createKit({ palette = {}, seed = 1 } = {}) {
  const kitRng = mulberry32(seed);
  const palCache = new Map();

  /** PRNG for a call: an explicit seed, or the kit's own stream when omitted. */
  const rngFor = (s) => (s === undefined ? kitRng : mulberry32(s >>> 0));

  // ---------------------------------------------------------------- buffers
  /** A fresh stereo buffer of `sec` seconds. */
  const buf = (sec) => [new Float32Array(Math.ceil(sec * SR)), new Float32Array(Math.ceil(sec * SR))];
  /** Frames per channel of a stereo buffer. */
  const len = (b) => b[0].length;

  /** Build a mono buffer from a per-sample function fn(t, i). */
  function mono(fn, sec) {
    const n = Math.ceil(sec * SR);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = fn(i / SR, i);
    return a;
  }

  /** Mono -> stereo with constant-power pan in -1..1. */
  const st = (m, pan = 0) => {
    const p = ((pan + 1) * Math.PI) / 4;
    const l = Math.cos(p);
    const r = Math.sin(p);
    return [m.map((x) => x * l), m.map((x) => x * r)];
  };

  /**
   * Mono -> stereo with a constant-power pan in -1..1. `pan` is a number (constant pan for the
   * whole buffer) or a function pan(t) of time in seconds (time-varying pan).
   */
  function stPan(m, pan) {
    const pf = typeof pan === 'function' ? pan : () => pan;
    const L = new Float32Array(m.length);
    const R = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) {
      const p = ((Math.max(-1, Math.min(1, pf(i / SR))) + 1) * Math.PI) / 4;
      L[i] = m[i] * Math.cos(p);
      R[i] = m[i] * Math.sin(p);
    }
    return [L, R];
  }

  /** Mix src into dst at time `at` seconds with linear gain g; src may be mono or stereo. */
  function add(dst, src, at = 0, g = 1) {
    if (!Array.isArray(src)) src = st(src);
    const off = Math.round(at * SR);
    for (let c = 0; c < 2; c++) {
      const d = dst[c];
      const s = src[c];
      for (let i = 0; i < s.length; i++) {
        const j = i + off;
        if (j >= 0 && j < d.length) d[j] += s[i] * g;
      }
    }
    return dst;
  }

  /** dB -> linear amplitude. */
  const db = (x) => 10 ** (x / 20);

  /** Multiply every sample by g (in place). */
  function gain(b, g) {
    for (const ch of Array.isArray(b) ? b : [b]) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    return b;
  }

  /**
   * Multiply every sample by an envelope (in place). `env` is a number (constant gain for the whole
   * buffer) or a function env(t) of time in seconds (time-varying gain envelope).
   */
  function envApply(b, env) {
    const ef = typeof env === 'function' ? env : () => env;
    for (const ch of Array.isArray(b) ? b : [b]) for (let i = 0; i < ch.length; i++) ch[i] *= ef(i / SR);
    return b;
  }

  // ---------------------------------------------------------------- random
  /** Next float in [0, 1) from the kit's seeded PRNG. */
  const rng = () => kitRng();

  /** White noise; `s` (optional) overrides the kit stream. */
  function white(sec, s) {
    const r = rngFor(s);
    return mono(() => r() * 2 - 1, sec);
  }

  /** Pink (1/f) noise; `s` overrides the kit stream. */
  function pink(sec, s) {
    const r = rngFor(s);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    return mono(() => {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const o = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      return o * 0.11;
    }, sec);
  }

  /** Brown (1/f^2) noise; `s` overrides the kit stream. */
  function brown(sec, s) {
    const r = rngFor(s);
    let y = 0;
    return mono(() => {
      y = (y + 0.02 * (r() * 2 - 1)) / 1.02;
      return y * 3.5;
    }, sec);
  }

  // ---------------------------------------------------------------- envelopes
  /** Exponential decay envelope exp(-k t). */
  const expd = (k) => (t) => Math.exp(-k * t);

  /** Attack/decay envelope. */
  const ad =
    (a, d, curve = 1) =>
    (t) =>
      t < a ? (t / a) ** curve : Math.exp(-(t - a) / d);

  /** Piecewise-linear breakpoints [[t, v], ...]. */
  const bp = (pts) => (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++)
      if (t <= pts[i][0]) {
        const [t0, v0] = pts[i - 1];
        const [t1, v1] = pts[i];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    return pts[pts.length - 1][1];
  };

  /** Exponential interpolation between breakpoints (good for frequency). */
  const bpx = (pts) => (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++)
      if (t <= pts[i][0]) {
        const [t0, v0] = pts[i - 1];
        const [t1, v1] = pts[i];
        return v0 * (v1 / v0) ** ((t - t0) / (t1 - t0));
      }
    return pts[pts.length - 1][1];
  };

  // ---------------------------------------------------------------- oscillators
  /** Oscillator; `freq` may be a number or a fn(t). */
  function osc(sec, freq, { type = 'sine', phase = 0, amp = 1 } = {}) {
    const f = typeof freq === 'function' ? freq : () => freq;
    let ph = phase;
    return mono((t) => {
      ph += f(t) / SR;
      ph -= Math.floor(ph);
      switch (type) {
        case 'sine':
          return amp * Math.sin(2 * Math.PI * ph);
        case 'saw':
          return amp * (2 * ph - 1);
        case 'square':
          return amp * (ph < 0.5 ? 1 : -1);
        case 'tri':
          return amp * (1 - 4 * Math.abs(ph - 0.5));
        default:
          return 0;
      }
    }, sec);
  }

  /** Inharmonic metallic partials [[ratio, amp, decay], ...] around base f. */
  function bell(sec, f, partials, { seed: s } = {}) {
    const r = rngFor(s);
    const ph = partials.map(() => r());
    return mono((t) => {
      let sum = 0;
      for (let k = 0; k < partials.length; k++) {
        const [ratio, a, d] = partials[k];
        sum += a * Math.exp(-t / d) * Math.sin(2 * Math.PI * (f * ratio * t + ph[k]));
      }
      return sum;
    }, sec);
  }

  // ---------------------------------------------------------------- filters
  /** TPT state-variable filter; cutoff and q may be fns of t. mode: lp|hp|bp|notch. */
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: keep the original 0.707 default for recipe parity
  function svf(x, mode, cutoff, q = 0.707) {
    const fc = typeof cutoff === 'function' ? cutoff : () => cutoff;
    const fq = typeof q === 'function' ? q : () => q;
    const y = new Float32Array(x.length);
    let ic1 = 0;
    let ic2 = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const g = Math.tan((Math.PI * Math.min(fc(t), SR * 0.45)) / SR);
      const k = 1 / fq(t);
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const v3 = x[i] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      if (mode === 'lp') y[i] = v2;
      else if (mode === 'bp') y[i] = v1 * k;
      else if (mode === 'hp') y[i] = x[i] - k * v1 - v2;
      else y[i] = x[i] - k * v1;
    }
    return y;
  }

  /** Low-pass. */
  const lp = (x, f, q) => svf(x, 'lp', f, q);
  /** High-pass. */
  const hp = (x, f, q) => svf(x, 'hp', f, q);
  /** Band-pass. */
  const bpf = (x, f, q) => svf(x, 'bp', f, q);
  /** Apply fn to each channel of a stereo pair. */
  const stf = (b, fn) => [fn(b[0]), fn(b[1])];

  // ---------------------------------------------------------------- dirt
  /** tanh saturation. */
  const sat = (x, drive = 2) => x.map((v) => Math.tanh(v * drive) / Math.tanh(drive));

  /** Bit-depth and sample-rate reduction. */
  function crush(x, bits = 6, hold = 4) {
    const q = 2 ** (bits - 1);
    const y = new Float32Array(x.length);
    const hf = typeof hold === 'function' ? hold : () => hold;
    let h = 0;
    let cnt = 0;
    for (let i = 0; i < x.length; i++) {
      if (cnt <= 0) {
        h = Math.round(x[i] * q) / q;
        cnt = Math.max(1, Math.round(hf(i / SR)));
      }
      cnt--;
      y[i] = h;
    }
    return y;
  }

  /** Gate x on for `duty` of each period (period may be a fn of t). */
  function stutter(x, period, duty = 0.5) {
    const pf = typeof period === 'function' ? period : () => period;
    const y = new Float32Array(x.length);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      ph += 1 / (pf(i / SR) * SR);
      ph -= Math.floor(ph);
      y[i] = ph < duty ? x[i] : 0;
    }
    return y;
  }

  // ---------------------------------------------------------------- reverb (freeverb-ish, stereo)
  /** Freeverb-ish stereo reverb; the output is `tail` seconds longer than the input. */
  function reverb(b, { size = 0.84, damp = 0.3, wet = 0.3, dry = 1, pre = 0.01, tail = 1.5, width = 1 } = {}) {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round((n * SR) / 44100));
    const aps = [556, 441, 341, 225].map((n) => Math.round((n * SR) / 44100));
    const n = len(b) + Math.round(tail * SR);
    const out = [new Float32Array(n), new Float32Array(n)];
    const preN = Math.round(pre * SR);
    for (let c = 0; c < 2; c++) {
      const sp = c ? 23 : 0;
      const cb = combs.map((d) => ({ mem: new Float32Array(d + sp), i: 0, f: 0 }));
      const ab = aps.map((d) => ({ mem: new Float32Array(d + sp), i: 0 }));
      for (let i = 0; i < n; i++) {
        const j = i - preN;
        const xin = j >= 0 && j < len(b) ? (b[0][j] + b[1][j]) * 0.5 * 0.03 : 0;
        let s = 0;
        for (const C of cb) {
          const y = C.mem[C.i];
          C.f = y * (1 - damp) + C.f * damp;
          C.mem[C.i] = xin + C.f * size;
          C.i = (C.i + 1) % C.mem.length;
          s += y;
        }
        for (const A of ab) {
          const bo = A.mem[A.i];
          const y = -s + bo;
          A.mem[A.i] = s + bo * 0.5;
          A.i = (A.i + 1) % A.mem.length;
          s = y;
        }
        out[c][i] = s;
      }
    }
    const res = [new Float32Array(n), new Float32Array(n)];
    const w1 = wet * (width / 2 + 0.5);
    const w2 = wet * ((1 - width) / 2);
    for (let i = 0; i < n; i++) {
      const dl = i < len(b) ? b[0][i] : 0;
      const dr = i < len(b) ? b[1][i] : 0;
      res[0][i] = dl * dry + out[0][i] * w1 + out[1][i] * w2;
      res[1][i] = dr * dry + out[1][i] * w1 + out[0][i] * w2;
    }
    return res;
  }

  /** Stereo delay / echo; the output is `tail` seconds longer than the input. */
  function echo(b, { time = 0.25, fb = 0.35, wet = 0.4, tail = 1.5, pingpong = true } = {}) {
    const d = Math.round(time * SR);
    const n = len(b) + Math.round(tail * SR);
    const out = [new Float32Array(n), new Float32Array(n)];
    const L = new Float32Array(d);
    const R = new Float32Array(d);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const xl = i < len(b) ? b[0][i] : 0;
      const xr = i < len(b) ? b[1][i] : 0;
      const yl = L[k];
      const yr = R[k];
      if (pingpong) {
        L[k] = xl + yr * fb;
        R[k] = xr + yl * fb;
      } else {
        L[k] = xl + yl * fb;
        R[k] = xr + yr * fb;
      }
      k = (k + 1) % d;
      out[0][i] = xl + yl * wet;
      out[1][i] = xr + yr * wet;
    }
    return out;
  }

  // ---------------------------------------------------------------- wav io
  /** Convert a decoded Audio to a 48 kHz stereo pair (duplicating mono). */
  function toStereo48(audio) {
    const chans = audio.channels;
    let l = chans[0];
    let r = chans.length > 1 ? chans[1] : chans[0].slice();
    if (audio.sampleRate !== SR) {
      const ratio = audio.sampleRate / SR;
      l = resample(l, ratio);
      r = resample(r, ratio);
    }
    return [l, r];
  }

  /** Read a WAV file from disk, resampled to 48 kHz stereo. */
  function readWav(absPath) {
    return toStereo48(readWavFile(fs.readFileSync(absPath)));
  }

  /** Cubic-interpolating resample; ratio > 1 = faster / higher. */
  function resample(x, ratio) {
    const n = Math.floor((x.length - 1) / ratio);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio;
      const k = Math.floor(p);
      const f = p - k;
      const xm = x[Math.max(0, k - 1)];
      const x0 = x[k];
      const x1 = x[Math.min(x.length - 1, k + 1)];
      const x2 = x[Math.min(x.length - 1, k + 2)];
      y[i] = x0 + 0.5 * f * (x1 - xm + f * (2 * xm - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm)));
    }
    return y;
  }

  /** Semitones -> playback ratio. */
  const semis = (s) => 2 ** (s / 12);

  /** Pitch-shift a stereo buffer by `s` semitones. */
  const pitch = (b, s) => [resample(b[0], semis(s)), resample(b[1], semis(s))];

  /**
   * Variable-rate playback. `rate` is a number (constant playback rate) or a function rate(t) of
   * output time in seconds (e.g. doppler / tape stop).
   */
  function vari(x, rate, sec) {
    const rf = typeof rate === 'function' ? rate : () => rate;
    const n = Math.ceil(sec * SR);
    const y = new Float32Array(n);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(p);
      const f = p - k;
      if (k + 1 >= x.length) break;
      y[i] = x[k] * (1 - f) + x[k + 1] * f;
      p += rf(i / SR);
    }
    return y;
  }

  /** Reverse the samples of every channel. */
  const rev = (b) => b.map((c) => c.slice().reverse());

  /** Slice slot `k` of `slot` seconds from palette sample `name` (resampled to 48 kHz); trims lead silence. */
  function pal(name, k, slot, { trim = true } = {}) {
    const entry = palette[name];
    if (!entry) {
      const available = Object.keys(palette).join(', ') || '(none)';
      throw new ToolError('invalid-input', `no palette entry "${name}"; available: ${available}`);
    }
    let w = palCache.get(name);
    if (!w) {
      w = toStereo48(entry);
      palCache.set(name, w);
    }
    const a = Math.round(k * slot * SR);
    const b = Math.min(len(w), Math.round((k + 1) * slot * SR));
    let s = [w[0].slice(a, b), w[1].slice(a, b)];
    if (trim) s = trimHead(s, -50);
    return s;
  }

  /** Absolute peak over all channels. */
  function peakOf(b) {
    let m = 0;
    for (const c of b) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
    return m;
  }

  /** Normalise (in place) so the absolute peak equals `peakDb` dBFS. */
  function norm(b, peakDb = 0) {
    const p = peakOf(b);
    return p ? gain(b, db(peakDb) / p) : b;
  }

  /** Trim leading samples below `thDb` dBFS; returns new channels. */
  function trimHead(b, thDb = -60) {
    const th = peakOf(b) * db(thDb);
    let i = 0;
    while (i < len(b) && Math.abs(b[0][i]) < th && Math.abs(b[1][i]) < th) i++;
    return [b[0].slice(i), b[1].slice(i)];
  }

  /** Trim trailing samples below `thDb` dBFS; returns new channels. */
  function trimTail(b, thDb = -66) {
    const th = peakOf(b) * db(thDb);
    let i = len(b) - 1;
    while (i > 0 && Math.abs(b[0][i]) < th && Math.abs(b[1][i]) < th) i--;
    return [b[0].slice(0, i + 1), b[1].slice(0, i + 1)];
  }

  /** Cosine-squared fade out over `sec` seconds (in place). */
  function fadeOut(b, sec) {
    const n = Math.min(len(b), Math.round(sec * SR));
    const s0 = len(b) - n;
    for (const c of b) for (let i = 0; i < n; i++) c[s0 + i] *= Math.cos((i / n) * (Math.PI / 2)) ** 2;
    return b;
  }

  /** Sine-squared fade in over `sec` seconds (in place). */
  function fadeIn(b, sec) {
    const n = Math.min(len(b), Math.round(sec * SR));
    for (const c of b) for (let i = 0; i < n; i++) c[i] *= Math.sin((i / n) * (Math.PI / 2)) ** 2;
    return b;
  }

  /**
   * Finalise a buffer: DC block, head/tail trim, fades, then peak normalisation. Returns new channels.
   * @param {Stereo} b
   * @param {{head?: boolean, head_db?: number, tail_db?: number, fade_in_s?: number, fade_out_s?: number, peak_db?: number}} [opts]
   * @returns {Stereo}
   */
  function finish(
    b,
    { head = true, head_db = -54, tail_db = -62, fade_in_s = 0.002, fade_out_s = 0.03, peak_db = -1 } = {},
  ) {
    // DC block into fresh channels (the input is not mutated)
    b = b.map((c) => {
      const y = new Float32Array(c.length);
      let xp = 0;
      let yp = 0;
      for (let i = 0; i < c.length; i++) {
        yp = c[i] - xp + 0.9995 * yp;
        xp = c[i];
        y[i] = yp;
      }
      return y;
    });
    norm(b, peak_db);
    if (head) b = trimHead(b, head_db);
    b = trimTail(b, tail_db);
    fadeIn(b, fade_in_s);
    fadeOut(b, Math.min(fade_out_s, len(b) / SR / 3));
    norm(b, peak_db);
    return b;
  }

  /** Concatenate stereo buffers end to end. */
  const cat2 = (...bs) => {
    const n = bs.reduce((a, b) => a + len(b), 0);
    const o = [new Float32Array(n), new Float32Array(n)];
    let p = 0;
    for (const b of bs) {
      o[0].set(b[0], p);
      o[1].set(b[1], p);
      p += len(b);
    }
    return o;
  };

  return {
    SR,
    buf,
    len,
    mono,
    st,
    stPan,
    add,
    db,
    gain,
    envApply,
    rng,
    white,
    pink,
    brown,
    expd,
    ad,
    bp,
    bpx,
    osc,
    bell,
    svf,
    lp,
    hp,
    bpf,
    stf,
    sat,
    crush,
    stutter,
    reverb,
    echo,
    readWav,
    resample,
    semis,
    pitch,
    vari,
    rev,
    pal,
    peakOf,
    norm,
    trimHead,
    trimTail,
    fadeOut,
    fadeIn,
    finish,
    cat2,
  };
}
