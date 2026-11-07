// ON THE ONE — EP5 · THE SUN SWALLOWER — sound effects
// Pure synthesis through the motionex DSP kit. Sparse: a few, well-placed cues.
const TAU = 2 * Math.PI;

const noiseOf = (ct, kind, sec) => (kind === 'white' ? ct.white(sec) : kind === 'brown' ? ct.brown(sec) : ct.pink(sec));

/** metallic bell partials + a noise transient (mono) */
function struck(ct, sec, freqs, dec, g){
  const out = ct.buf(sec)[0];
  for (let i = 0; i < freqs.length; i++){
    const a = ct.envApply(ct.osc(sec, freqs[i] * (1 + 0.002 * i)), (t) => Math.min(1, t / 0.0015) * Math.exp(-t / (dec / (1 + i * 0.55))));
    for (let j = 0; j < out.length; j++) out[j] += a[j] * (g / (1 + i * 0.8));
  }
  return out;
}

/** a small gold sparkle when a word is drawn */
function shimmer(ct, { seconds = 1.1 } = {}){
  const b = ct.buf(seconds);
  const r = () => ct.rng();
  let t = 0;
  while (t < seconds * 0.8){
    t += -Math.log(1 - r()) / 110;
    const f = 2400 * Math.pow(3.4, r());
    const d = 0.015 + 0.07 * r();
    const len = Math.min(seconds - t, d * 7);
    if (len <= 0.002) continue;
    const x = ct.envApply(ct.osc(len, f), (tt) => Math.min(1, tt / 0.001) * Math.exp(-tt / d));
    const pan = r() * 2 - 1;
    ct.add(b, ct.stPan(x, () => pan), t, (0.04 + 0.26 * r()) * Math.exp(-t / 0.55));
  }
  // a breath of air under it
  const air = ct.svf(noiseOf(ct, 'white', seconds), 'bp', ct.bpx([[0, 4200], [seconds * 0.25, 7200], [seconds, 3800]]), 1.4);
  ct.envApply(air, (tt) => Math.min(1, tt / 0.02) * Math.exp(-tt / 0.3));
  ct.add(b, ct.st(air), 0, 0.10);
  return ct.echo(b, { time: 0.11, fb: 0.32, wet: 0.3, tail: 0.45 });
}

/** the sun coming out: a deep driven thump with a long room */
function thump(ct, { seconds = 1.5, pitch = 1 } = {}){
  const sec = seconds;
  const b = ct.buf(sec);
  const body = ct.envApply(
    ct.osc(sec, ct.bpx([[0, 132 * pitch], [0.09, 40 * pitch], [sec, 32 * pitch]])),
    (t) => Math.min(1, t / 0.003) * Math.exp(-t / (sec * 0.22)),
  );
  ct.add(b, ct.st(ct.sat(body, 2.4)), 0, 0.95);
  const click = ct.envApply(noiseOf(ct, 'white', 0.05), (t) => Math.exp(-t / 0.006));
  ct.add(b, ct.st(click), 0, 0.25);
  return ct.reverb(b, { wet: 0.18, size: 0.8, damp: 0.4, tail: 1.2 });
}

/** gold explosion: bright burst, debris, metal tail */
function burst(ct, { seconds = 1.8 } = {}){
  const b = ct.buf(seconds);
  const r = () => ct.rng();
  const crack = ct.envApply(ct.svf(noiseOf(ct, 'white', seconds * 0.35), 'bp', ct.bpx([[0, 5200], [seconds * 0.35, 1400]]), 0.8), (t) => Math.min(1, t / 0.001) * Math.exp(-t / 0.07));
  ct.add(b, ct.st(crack), 0, 0.55);
  // debris grains
  let t = 0.01;
  while (t < seconds * 0.8){
    t += -Math.log(1 - r()) / 90;
    const f = 700 * Math.pow(5, r());
    const d = 0.004 + 0.01 * r();
    const x = ct.envApply(ct.osc(d * 5, f), (tt) => Math.exp(-tt / d));
    const pan = r() * 2 - 1;
    ct.add(b, ct.stPan(x, () => pan), t, (0.05 + 0.45 * r()) * Math.exp(-t / 0.3));
  }
  ct.add(b, ct.st(struck(ct, seconds, [523, 897, 1320, 1980], 0.9, 0.12)), 0, 0.5);
  return ct.reverb(b, { wet: 0.24, size: 0.85, damp: 0.45, tail: 1.4 });
}

/** air over a coil: a band-passed sweep */
function swish(ct, { seconds = 0.55, pitch = 1 } = {}){
  const sec = seconds;
  const b = ct.buf(sec + 0.1);
  const pk = sec * 0.42;
  const cf = ct.bpx([[0, 520 * pitch], [pk, 2100 * pitch], [sec, 620 * pitch]]);
  const e = (t) => (t < pk ? (t / pk) ** 1.7 : Math.exp(-(t - pk) / (sec * 0.14)));
  const x = ct.svf(noiseOf(ct, 'pink', sec + 0.1), 'bp', cf, 1.0);
  ct.envApply(x, e);
  ct.add(b, ct.stPan(x, (t) => -0.5 + Math.min(1, t / sec)), 0, 0.9);
  const y = ct.svf(noiseOf(ct, 'white', sec + 0.1), 'bp', (t) => cf(t) * 2.4, 1.6);
  ct.envApply(y, e);
  ct.add(b, ct.stPan(y, (t) => 0.5 - Math.min(1, t / sec)), 0, 0.25);
  return ct.echo(b, { time: 0.09, fb: 0.2, wet: 0.18, tail: 0.3 });
}

/** a struck daf: skin thump + a jingle of rings */
function ring(ct, { seconds = 0.9 } = {}){
  const b = ct.buf(seconds);
  const skin = ct.envApply(ct.osc(seconds, ct.bpx([[0, 210], [0.03, 118], [0.2, 96]])), (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.11));
  ct.add(b, ct.st(ct.sat(skin, 1.5)), 0, 0.8);
  const jingle = struck(ct, seconds, [1180, 1930, 2640, 3310], 0.45, 0.16);
  ct.add(b, ct.stPan(jingle, () => 0.25), 0.004, 0.55);
  const air = ct.envApply(ct.svf(noiseOf(ct, 'white', 0.12), 'bp', 3600, 1.2), (t) => Math.exp(-t / 0.02));
  ct.add(b, ct.st(air), 0, 0.18);
  return ct.reverb(b, { wet: 0.2, size: 0.6, damp: 0.5, tail: 0.7 });
}

export const sounds = { shimmer, thump, burst, swish, ring };

export const describe = {
  shimmer: 'gold grains and air when a word is drawn',
  thump: 'deep driven impact for the sun coming out',
  burst: 'gold explosion: crack, debris, metal tail',
  swish: 'air sweeping over a serpent coil',
  ring: 'a struck daf with jingling rings'
};

export const finish = {
  shimmer: { peak_db: -6, fade_out_s: 0.08 },
  thump: { peak_db: -3, fade_out_s: 0.12 },
  burst: { peak_db: -3, fade_out_s: 0.15 },
  swish: { peak_db: -9, fade_out_s: 0.06 },
  ring: { peak_db: -5, fade_out_s: 0.08 }
};
