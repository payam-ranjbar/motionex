// EP3 HEIST ON THE OFFBEAT - SFX recipes (paper-cut noir heist).
// Contract: export const sounds = { name(kit, params) => [Float32Array, Float32Array] at kit.SR }.
// Everything is seeded through kit.rng()/kit.white()/kit.pink(), so a render is reproducible.

const noise = (ct, kind, sec) =>
  kind === 'white' ? ct.white(sec) : kind === 'brown' ? ct.brown(sec) : ct.pink(sec);

/** attack/decay envelope: linear in over a, exponential out over d */
const decay = (ct, x, a, d) => ct.envApply(x, (t) => (t < a ? t / a : Math.exp(-(t - a) / d)));

export const describe = {
  stamp: 'rubber stamp impact: paper slap plus a low thud (the onomatopoeia stamps)',
  paper_slide: 'a cut-paper panel sliding across the desk',
  dial_click: 'three safe-dial ticks in a row',
  vault_boom: 'the vault door opening: deep boom, metal ring, falling debris',
  coin_rain: 'gold paper coins scattering on the floor',
  siren: 'two-tone alarm for the getaway',
};

export const finish = {
  stamp: { peak_db: -1.5 },
  paper_slide: { peak_db: -3 },
  dial_click: { peak_db: -3 },
  vault_boom: { peak_db: -1.5 },
  coin_rain: { peak_db: -3 },
  siren: { peak_db: -3 },
};

export const sounds = {
  // A rubber stamp hitting paper: bright paper slap, then a low thud.
  stamp(ct, { seconds = 0.45, pitch = 1 } = {}) {
    const b = ct.buf(seconds);
    const paper = decay(ct, ct.hp(ct.lp(noise(ct, 'white', 0.14), 6500), 800), 0.001, 0.022);
    ct.add(b, ct.st(paper, -0.12), 0, 0.75);
    const thud = ct.sat(
      ct.envApply(ct.osc(0.3, ct.bpx([[0, 155 * pitch], [0.05, 60 * pitch]])), (t) => Math.min(1, t / 0.002) * Math.exp(-t / 0.075)),
      1.8,
    );
    ct.add(b, ct.st(thud, 0), 0, 0.95);
    const ring = decay(ct, ct.bpf(noise(ct, 'white', 0.25), 2500, 6), 0.001, 0.05);
    ct.add(b, ct.st(ring, 0.25), 0.004, 0.22);
    return b;
  },

  // Cut-paper sliding: a band-passed sweep plus a few crinkle grains.
  paper_slide(ct, { seconds = 0.42, pitch = 1 } = {}) {
    const b = ct.buf(seconds);
    const pk = seconds * 0.32;
    const cf = ct.bpx([[0, 800 * pitch], [pk, 3000 * pitch], [seconds, 620 * pitch]]);
    const e = (t) => (t < pk ? (t / pk) ** 1.5 : Math.exp(-(t - pk) / (seconds * 0.14)));
    const x = ct.svf(noise(ct, 'pink', seconds), 'bp', cf, 0.8);
    ct.envApply(x, e);
    ct.add(b, ct.stPan(x, (t) => -0.5 + Math.min(1, t / seconds)), 0, 1);
    const rng = () => ct.rng();
    let t = 0;
    while (t < seconds * 0.8) {
      const d = 0.004 + rng() * 0.01;
      const g = (0.1 + rng() * 0.3) * e(t);
      const g1 = ct.envApply(ct.bpf(noise(ct, 'white', d), 2500 + rng() * 4000, 3), (tt) => Math.exp(-tt / (d * 0.4)));
      ct.add(b, ct.st(g1, rng() * 1.4 - 0.7), t, g);
      t += 0.012 + rng() * 0.05;
    }
    return ct.stf(b, (x) => ct.hp(x, 500));
  },

  // Safe dial / split-flap: three dry ticks.
  dial_click(ct, { seconds = 0.3, pitch = 1 } = {}) {
    const b = ct.buf(seconds);
    const hits = [[0, 2600, 0.85], [0.058, 1750, 0.6], [0.115, 3400, 0.5]];
    for (const [at, f, g] of hits) {
      const x = ct.envApply(ct.bpf(noise(ct, 'white', 0.05), f * pitch, 5), (t) => Math.min(1, t / 0.0005) * Math.exp(-t / 0.007));
      ct.add(b, ct.st(x, (at * 5) % 1.4 - 0.7), at, g);
    }
    return b;
  },

  // The vault opening: deep boom, metal ring, falling debris.
  vault_boom(ct, { seconds = 1.7 } = {}) {
    const b = ct.buf(seconds);
    const boom = ct.sat(
      ct.envApply(ct.osc(1.3, ct.bpx([[0, 115], [0.09, 36]])), (t) => Math.min(1, t / 0.004) * Math.exp(-t / 0.24)),
      2.2,
    );
    ct.add(b, ct.st(boom, 0), 0, 1);
    const metal = ct.reverb(
      ct.stf(decay(ct, ct.bpf(noise(ct, 'white', 1.4), 1500, 3), 0.002, 0.34), (x) => ct.hp(x, 320)),
      { wet: 0.4, dry: 1, size: 0.8, damp: 0.45, tail: 0.35 },
    );
    ct.add(b, metal, 0.008, 0.45);
    const debris = ct.stf(
      ct.envApply(ct.bpf(noise(ct, 'white', 1.3), 3400, 2), (t) => Math.exp(-t / 0.42) * Math.min(1, t / 0.02)),
      (x) => ct.hp(x, 900),
    );
    ct.add(b, debris, 0.02, 0.3);
    return b;
  },

  // Gold paper coins hitting the floor.
  coin_rain(ct, { seconds = 1.3 } = {}) {
    const b = ct.buf(seconds);
    const rng = () => ct.rng();
    let t = 0;
    while (t < seconds - 0.08) {
      t += 0.012 + rng() * 0.055;
      const f = 1700 + rng() * 3400;
      const d = 0.02 + rng() * 0.05;
      const g = (0.12 + rng() * 0.6) * Math.exp(-t / (seconds * 0.8));
      const x = ct.envApply(
        ct.osc(d, (tt) => f * (1 + 0.45 * tt), { type: 'sine' }),
        (tt) => Math.exp(-tt / (d * 0.35)) * Math.min(1, tt / 0.0008),
      );
      ct.add(b, ct.st(x, rng() * 1.6 - 0.8), t, g);
    }
    return ct.stf(b, (x) => ct.hp(x, 450));
  },

  // Two-tone alarm for the getaway.
  siren(ct, { seconds = 1.6, pitch = 1 } = {}) {
    const b = ct.buf(seconds);
    const two = (t) => (Math.floor(t * 5) % 2 ? 950 : 620) * pitch;
    const x = ct.envApply(ct.osc(seconds, two, { type: 'square' }), (t) => Math.min(1, t / 0.01) * Math.min(1, (seconds - t) / 0.06));
    ct.add(b, ct.st(ct.lp(ct.hp(x, 320), 3000), 0), 0, 0.55);
    const y = ct.envApply(ct.osc(seconds, ct.bpx([[0, 480], [seconds, 1150]]), { type: 'saw' }), (t) => 0.3 * Math.sin((Math.PI * t) / seconds));
    ct.add(b, ct.st(ct.lp(y, 2200), 0.35), 0, 0.4);
    return b;
  },
};
