// Small signal helpers shared by tools. Audio = {sampleRate, channels: Float32Array[]}.

/** Linear amplitude -> dB (floored at -240). */
export const db = (x) => 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
/** dB -> linear amplitude. */
export const fromDb = (d) => 10 ** (d / 20);

/** Absolute sample peak over all channels (linear). */
export function peak(audio) {
  let p = 0;
  for (const ch of audio.channels)
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > p) p = a;
    }
  return p;
}

/** RMS in dBFS of one channel between sample indices [from, to). -Infinity for digital silence. */
export function rmsDb(ch, from = 0, to = ch.length) {
  const a = Math.max(0, from);
  const b = Math.min(ch.length, to);
  if (b <= a) return Number.NEGATIVE_INFINITY;
  let s = 0;
  for (let i = a; i < b; i++) s += ch[i] * ch[i];
  return s === 0 ? Number.NEGATIVE_INFINITY : 10 * Math.log10(s / (b - a));
}

/** Mono mix (L+R)/n as a new Float32Array. */
export function mono(audio) {
  const n = audio.channels.length;
  const len = audio.channels[0]?.length ?? 0;
  if (n === 1) return Float32Array.from(audio.channels[0]);
  const out = new Float32Array(len);
  for (const ch of audio.channels) for (let i = 0; i < len; i++) out[i] += ch[i] / n;
  return out;
}

/**
 * Seconds until speech ends: the last sample (any channel) louder than threshold_db, plus tail_s,
 * capped at the file length. Ported from motion-studio build.mjs:96-103 (threshold 0.01 = -40 dBFS, +30 ms).
 */
export function speechEnd(audio, { threshold_db = -40, tail_s = 0.03 } = {}) {
  const thr = fromDb(threshold_db);
  const len = audio.channels[0]?.length ?? 0;
  for (let i = len - 1; i > 0; i--) {
    for (const ch of audio.channels) {
      if (Math.abs(ch[i]) > thr) return Math.min(len, i + audio.sampleRate * tail_s) / audio.sampleRate;
    }
  }
  return 0;
}

/** A copy of `audio` trimmed or zero-padded to exactly n frames per channel. */
export function fitLength(audio, n) {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((ch) => {
      if (ch.length === n) return ch;
      const out = new Float32Array(n);
      out.set(ch.length > n ? ch.subarray(0, n) : ch);
      return out;
    }),
  };
}

/** Seeded PRNG (mulberry32), returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
