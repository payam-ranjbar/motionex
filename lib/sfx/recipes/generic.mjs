// Built-in generic SFX recipes for the sfx.synth tool. Pure synthesis: every sound only uses the DSP kit
// (createKit) and never the palette, a file or the network. Ported and simplified from an earlier
// in-house sound library.
//
// A recipe module exports `sounds` (name -> (kit, params) => [Float32Array, Float32Array] at kit.SR) and may
// export `describe` (name -> one-line string) and `finish` (name -> per-sound finish overrides). Every random
// draw goes through kit.rng()/kit.white()/kit.pink()/kit.brown() so a given kit seed is reproducible.

const TAU = 2 * Math.PI;

/** Smoothstep 0..1 over [a, b]. */
const sm = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Noise for a given colour; no seed = the kit's own reproducible stream. */
function noise(ct, kind, sec) {
  if (kind === 'white') return ct.white(sec);
  if (kind === 'brown') return ct.brown(sec);
  return ct.pink(sec);
}

/** Two decorrelated noise channels drawn from the kit's stream. */
const stereoNoise = (ct, sec, kind) => [noise(ct, kind, sec), noise(ct, kind, sec)];

/** A band-limited noise burst with an attack/decay envelope (mono). */
function burstNoise(ct, sec, { color = 'white', lo = 0, hi = 0, bpF = 0, q = 1, a = 0.001, d = 0.05 } = {}) {
  let x = noise(ct, color, sec);
  if (bpF) x = ct.bpf(x, bpF, q);
  if (lo) x = ct.hp(x, lo);
  if (hi) x = ct.lp(x, hi);
  return ct.envApply(x, (t) => (t < a ? t / a : Math.exp(-(t - a) / d)));
}

/** Sine thump with a pitch drop and tanh drive (mono). */
function thumpMono(ct, sec, f0, f1, tdrop, dec, { drive = 1.5 } = {}) {
  const tone = ct.envApply(
    ct.osc(
      sec,
      ct.bpx([
        [0, f0],
        [tdrop, f1],
      ]),
    ),
    (t) => Math.min(1, t / 0.002) * Math.exp(-t / dec),
  );
  return ct.sat(tone, drive);
}

/**
 * Scatter grains/droplets into a stereo buffer in place (ported from the earlier library's `scatter`).
 * @param {object} ct kit
 * @param {import('../../dsp/kit.mjs').Stereo} b destination stereo buffer
 * @param {{from?: number, to: number, rate: number, rng: () => number, f?: [number, number], d?: [number, number],
 *   g?: [number, number], tone?: number, glide?: number, panW?: number, shape?: (t: number) => number}} o
 */
function scatter(
  ct,
  b,
  {
    from = 0,
    to,
    rate,
    rng,
    f = [2000, 7000],
    d = [0.002, 0.006],
    g = [0.05, 0.4],
    tone = 0.4,
    glide = 0,
    panW = 1,
    shape = () => 1,
  },
) {
  const SR = ct.SR;
  const n = ct.len(b);
  let t = from;
  while (true) {
    t += -Math.log(1 - rng()) / rate;
    if (t >= to) break;
    const fr = f[0] * (f[1] / f[0]) ** rng();
    const dc = d[0] + (d[1] - d[0]) * rng();
    const gg = (g[0] + (g[1] - g[0]) * rng() ** 2.2) * shape(t);
    const pn = (rng() * 2 - 1) * panW;
    const grainN = Math.round(dc * 7 * SR);
    const ph = rng() * TAU;
    const a = ((pn + 1) * Math.PI) / 4;
    const gl = Math.cos(a) * gg;
    const gr = Math.sin(a) * gg;
    const off = Math.round(t * SR);
    let nz = 0;
    for (let i = 0; i < grainN; i++) {
      const tt = i / SR;
      nz = 0.6 * nz + 0.4 * (rng() * 2 - 1);
      const e = Math.exp(-tt / dc) * Math.min(1, i / 8);
      const v = e * (tone * Math.sin(ph + TAU * fr * tt * (1 + glide * tt)) + (1 - tone) * nz);
      const j = off + i;
      if (j >= 0 && j < n) {
        b[0][j] += v * gl;
        b[1][j] += v * gr;
      }
    }
  }
  return b;
}

/** A looping-friendly rain bed: hiss body, tiny patter, heavy drops, gutter drips and a low rumble. */
function rainBed(ct, { seconds = 8, density = 1, tone = 0.5 } = {}) {
  const rng = () => ct.rng();
  const b = ct.buf(seconds);
  const dens = Math.max(0, density);
  const t0 = Math.max(0, Math.min(1, tone));

  // Body: decorrelated filtered hiss with a slow swell.
  const body = stereoNoise(ct, seconds, 'pink');
  for (const ch of body) ct.hp(ct.lp(ch, 4000 + 5000 * t0), 350 + 500 * t0);
  const knots = Array.from({ length: Math.ceil(seconds / 1.3) + 2 }, () => 0.82 + rng() * 0.18);
  const swell = (off) => (t) => {
    const k = t / 1.3 + off;
    const i = Math.floor(k);
    const fr = k - i;
    return knots[i] + (knots[i + 1] - knots[i]) * fr;
  };
  ct.envApply(body[0], swell(0));
  ct.envApply(body[1], swell(0.5));
  ct.add(b, body, 0, 0.55);

  // Patter: thousands of tiny impacts, brighter with `tone`.
  const pat = ct.buf(seconds);
  scatter(ct, pat, {
    to: seconds,
    rate: 260 * dens,
    rng,
    f: [1800 + 1500 * t0, 9000],
    d: [0.0015, 0.005],
    g: [0.04, 0.5],
    tone: 0.25 + 0.4 * t0,
  });
  ct.add(
    b,
    ct.stf(pat, (x) => ct.hp(x, 900)),
    0,
    0.9,
  );

  // Heavier drops and splats.
  const heavy = ct.buf(seconds);
  scatter(ct, heavy, {
    to: seconds,
    rate: 14 * dens,
    rng,
    f: [700, 2600],
    d: [0.004, 0.012],
    g: [0.2, 0.9],
    tone: 0.55,
    glide: 6,
  });
  ct.add(
    b,
    ct.stf(heavy, (x) => ct.hp(x, 300)),
    0,
    0.6,
  );

  // Gutter drips: bubbly plinks, a little reverb.
  const drips = ct.buf(seconds);
  scatter(ct, drips, {
    to: seconds,
    rate: 2.2 * dens,
    rng,
    f: [900, 2400],
    d: [0.012, 0.03],
    g: [0.3, 1],
    tone: 0.95,
    glide: 18,
    panW: 0.7,
  });
  ct.add(b, ct.reverb(drips, { wet: 0.5, dry: 1, size: 0.7, damp: 0.5, tail: 0.3 }), 0, 0.5);

  // Distant roar.
  const rum = stereoNoise(ct, seconds, 'brown');
  ct.add(b, [ct.lp(rum[0], 220), ct.lp(rum[1], 220)], 0, 0.25 + 0.15 * dens);

  return b;
}

/** A digital cut glitch: four crushed frames, a bright zap, a tonal blip and a ping-ponged echo. */
function glitchCut(ct, { seconds = 0.25 } = {}) {
  const rng = () => ct.rng();
  const FR = seconds / 4;
  const b = ct.buf(seconds);
  for (let f = 0; f < 4; f++) {
    const at = f * FR + (rng() - 0.5) * 0.004;
    const n = FR * (0.75 + rng() * 0.25);
    const kind = Math.floor(rng() * 4);
    const lvl = (1 - f * 0.16) * (0.7 + rng() * 0.3);
    let x;
    if (kind === 0) x = ct.crush(ct.bpf(ct.white(n), 700 + rng() * 5000, 1.2), 4, 3 + Math.floor(rng() * 10));
    else if (kind === 1) x = ct.crush(ct.osc(n, 180 + rng() * 2400, { type: 'square' }), 5, 1);
    else if (kind === 2) x = ct.crush(ct.white(n), 3, 10 + Math.floor(rng() * 30));
    else {
      const fm = 40 + rng() * 90;
      x = ct.crush(
        ct.mono((t) => Math.sign(Math.sin(TAU * fm * t)) * (rng() * 2 - 1), n),
        4,
        2,
      );
    }
    x = ct.hp(x, 120);
    ct.envApply(x, (t) => Math.min(1, t / 0.0008) * Math.min(1, (n - t) / 0.0015));
    ct.add(b, ct.st(x, (f % 2 ? 1 : -1) * (0.3 + rng() * 0.5)), at, lvl);
  }
  // The RGB flash: a bright zap down.
  const zap = ct.envApply(
    ct.osc(
      0.07,
      ct.bpx([
        [0, 5200],
        [0.07, 380],
      ]),
      { type: 'saw' },
    ),
    (t) => Math.exp(-t / 0.018),
  );
  ct.add(b, ct.st(ct.lp(zap, 9000)), 0, 0.45);
  // Tonal blip stack.
  const blip = ct.envApply(
    ct.osc(
      0.05,
      ct.bpx([
        [0, 1600 + rng() * 1400],
        [0.05, 600],
      ]),
      { type: 'square' },
    ),
    (t) => Math.exp(-t / 0.012),
  );
  ct.add(b, ct.st(ct.lp(ct.crush(blip, 5, 2), 6000)), 0.068, 0.35);
  // Weight.
  ct.add(b, ct.st(thumpMono(ct, 0.25, 140, 42, 0.06, 0.07)), 0, 0.5);
  // A crushed echo of the head, ping-ponged.
  const head = [b[0].slice(0, Math.round(0.14 * ct.SR)), b[1].slice(0, Math.round(0.14 * ct.SR))];
  const ec = ct.echo(
    ct.stf(head, (x) => ct.lp(ct.crush(x, 6, 4), 4500)),
    { time: 0.075, fb: 0.3, wet: 1, tail: 0.3 },
  );
  const wetOnly = [ec[0].map((v, i) => v - (head[0][i] ?? 0)), ec[1].map((v, i) => v - (head[1][i] ?? 0))];
  ct.add(b, wetOnly, 0, 0.4);
  return b;
}

/** A tiny glitch tick for flickers and tears. */
function glitchMicro(ct, { seconds = 0.08 } = {}) {
  const rng = () => ct.rng();
  const b = ct.buf(seconds + 0.15);
  let t = 0;
  while (t < seconds) {
    const n = 0.006 + rng() * 0.018;
    const x =
      rng() < 0.5
        ? ct.crush(ct.bpf(ct.white(n), 1500 + rng() * 6000, 1.5), 4, 2 + Math.floor(rng() * 8))
        : ct.crush(ct.osc(n, 300 + rng() * 3000, { type: 'square' }), 4, 1);
    ct.envApply(x, (tt) => Math.min(1, tt / 0.0005) * Math.min(1, (n - tt) / 0.001));
    ct.add(b, ct.st(x, rng() * 1.6 - 0.8), t, 0.5 + rng() * 0.5);
    t += n + (rng() < 0.4 ? rng() * 0.012 : 0);
  }
  return ct.stf(b, (x) => ct.hp(x, 400));
}

/** An airy pass-by whoosh: two band-passed noise layers, a doppler whine and a zing. */
function whooshBy(ct, { seconds = 0.9, pitch = 1 } = {}) {
  const sec = seconds;
  const pass = sec * 0.4;
  const b = ct.buf(sec);
  const ampF = (t) => {
    const d = Math.abs(t - pass);
    return t < pass ? 1 / (1 + (d / 0.07) ** 2) : 1 / (1 + (d / 0.05) ** 2);
  };
  const cf = (t) =>
    t < pass ? 700 * (3200 / 700) ** ((t / pass) ** 2) : 3200 * 0.35 ** Math.min(1, (t - pass) / 0.15);
  const pan = (t) => -0.7 + 1.4 * sm(pass - 0.08, pass + 0.12, t);
  for (const [k, q, g] of [
    [0, 1.3, 1],
    [1, 3, 0.5],
  ]) {
    const x = ct.svf(noise(ct, 'pink', sec), 'bp', (t) => cf(t) * pitch * (k ? 1.6 : 1), q);
    ct.envApply(x, ampF);
    ct.add(b, ct.stPan(x, pan), 0, g);
  }
  // Doppler whine.
  const whine = ct.lp(
    ct.envApply(
      ct.osc(sec, (t) => 1100 * pitch * (1 + 0.18 * Math.tanh((pass - t) / 0.04)), { type: 'saw' }),
      ampF,
    ),
    4000,
  );
  ct.add(b, ct.stPan(whine, pan), 0, 0.25);
  // Zing.
  const zing = ct.envApply(
    ct.osc(sec, (t) => 3600 * pitch * (1 + 0.12 * Math.tanh((pass - t) / 0.03))),
    (t) => ampF(t) ** 2,
  );
  ct.add(b, ct.stPan(zing, pan), 0, 0.2);
  return b;
}

/** A cloth/air swish: two band-passed noise layers sweeping up then falling, panned across. */
function swish(ct, { seconds = 0.35 } = {}) {
  const sec = seconds;
  const b = ct.buf(sec + 0.1);
  const pk = sec * 0.35;
  const e = (t) => (t < pk ? (t / pk) ** 2 : Math.exp(-(t - pk) / (sec * 0.12)));
  const cf = ct.bpx([
    [0, 700],
    [pk, 2600],
    [sec, 700 * 0.8],
  ]);
  const pan = (t) => -0.3 + 0.6 * Math.min(1, t / sec);
  const x = ct.svf(noise(ct, 'pink', sec + 0.1), 'bp', cf, 0.9);
  ct.envApply(x, e);
  ct.add(b, ct.stPan(x, pan), 0, 1);
  const y = ct.svf(noise(ct, 'white', sec + 0.1), 'bp', (t) => cf(t) * 2.6, 1.5);
  ct.envApply(y, e);
  ct.add(b, ct.stPan(y, pan), 0, 0.3);
  return b;
}

/** A low impact: a driven sine thump with a fast pitch drop. */
function thump(ct, { seconds = 0.6, pitch = 1 } = {}) {
  const x = thumpMono(ct, seconds, 130 * pitch, 45 * pitch, seconds * 0.18, seconds * 0.35, { drive: 2.2 });
  return ct.st(x);
}

/** A big hit with a decay tail: body crack, sub impact, debris crackle, metallic tail and reverb. */
function burst(ct, { seconds = 1.2 } = {}) {
  const rng = () => ct.rng();
  const b = ct.buf(seconds);
  ct.add(b, ct.st(burstNoise(ct, seconds * 0.4, { lo: 120, hi: 6000, a: 0.001, d: 0.08 })), 0, 0.8);
  ct.add(b, ct.st(thumpMono(ct, seconds * 0.8, 90, 38, 0.12, 0.3, { drive: 2.4 })), 0, 0.9);
  const debris = ct.buf(seconds);
  scatter(ct, debris, {
    from: 0.02,
    to: seconds * 0.9,
    rate: 70,
    rng,
    f: [600, 4000],
    d: [0.002, 0.008],
    g: [0.1, 0.6],
    tone: 0.2,
    shape: (t) => Math.exp(-t / 0.25),
  });
  ct.add(b, debris, 0, 0.35);
  const tail = ct.envApply(burstNoise(ct, seconds, { bpF: 2500, q: 0.8, a: 0.002, d: 0.5 }), (t) => Math.exp(-t / 0.4));
  ct.add(b, ct.st(tail), 0, 0.3);
  return ct.reverb(b, { wet: 0.2, size: 0.78, damp: 0.45, tail: 0.9 });
}

/** A short two-tone UI blip with a high sparkle and a short echo. */
function uiBlip(ct, { pitch = 1 } = {}) {
  const b = ct.buf(0.35);
  const tone = (f) =>
    ct.lp(
      ct.envApply(ct.osc(0.06, f * pitch, { type: 'square' }), (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.025)),
      5000,
    );
  ct.add(b, ct.st(tone(1320)), 0, 0.5);
  ct.add(b, ct.st(tone(1980)), 0.045, 0.5);
  ct.add(b, ct.st(ct.envApply(ct.osc(0.1, 3960 * pitch), ct.expd(1 / 0.015))), 0.045, 0.12);
  return ct.echo(b, { time: 0.09, fb: 0.25, wet: 0.25, tail: 0.25 });
}

/** Every built-in recipe: name -> (kit, params) => [Float32Array, Float32Array] at kit.SR. */
export const sounds = {
  rain_bed: rainBed,
  glitch_cut: glitchCut,
  glitch_micro: glitchMicro,
  whoosh_by: whooshBy,
  swish,
  thump,
  burst,
  ui_blip: uiBlip,
};

/** One-line descriptions, surfaced in the job result and sounds.json. */
export const describe = {
  rain_bed: 'looping-friendly rain bed with patter, heavy drops and a low rumble',
  glitch_cut: 'digital cut glitch: four crushed frames, a bright zap and a crushed echo',
  glitch_micro: 'tiny glitch tick for flickers and tears',
  whoosh_by: 'airy pass-by whoosh with a doppler whine',
  swish: 'cloth or air swish sweeping up and across',
  thump: 'low impact thump with a fast pitch drop',
  burst: 'big hit with a body crack, sub impact and a decay tail',
  ui_blip: 'short two-tone UI blip with a high sparkle',
};

/**
 * The parameters each built-in sound accepts, with their defaults. sfx.synth warns about any other key, so a
 * misspelt or invented parameter (e.g. `freq` on thump) is reported instead of silently ignored.
 */
export const params = {
  rain_bed: { seconds: 8, density: 1, tone: 0.5 },
  glitch_cut: { seconds: 0.25 },
  glitch_micro: { seconds: 0.08 },
  whoosh_by: { seconds: 0.9, pitch: 1 },
  swish: { seconds: 0.35 },
  thump: { seconds: 0.6, pitch: 1 },
  burst: { seconds: 1.2 },
  ui_blip: { pitch: 1 },
};
