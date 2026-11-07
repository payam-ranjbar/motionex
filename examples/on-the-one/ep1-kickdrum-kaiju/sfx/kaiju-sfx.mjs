// ON THE ONE - EP1 KICKDRUM KAIJU - sound effects.
// The kick is the footstep, so there is no extra impact on kicks: this library only holds
//   glass_crack_a/b : the glass crack under a slammed word (two pitch variants),
//   sub_thump       : the drop shockwave (a driven sub with a pitch drop and an air push),
//   radio_static    : a short PA/radio static burst just before each broadcast line,
//   alert_beep      : the three-tone emergency alert under the "BRACE" countdown.
// Contract: every entry returns [L, R] Float32Array at kit.SR (48000). All randomness goes through
// kit.rng(), so a given kit seed is reproducible.

const sm = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A glass crack: sub-millisecond transient, a high inharmonic ring, then shards flying off. */
function glassCrack(kit, { seconds = 0.6, pitch = 1 } = {}) {
  const sr = 48000;
  const b = kit.buf(seconds);
  // 1. the transient: a bright noise snap
  const snap = kit.hp(kit.envApply(kit.white(0.06), kit.expd(1 / 0.005)), 1600 * pitch);
  kit.add(b, kit.st(snap, 0.1), 0, 0.85);
  // 2. the glass ring: inharmonic, detuned partials that die at different rates
  const ring = kit.bell(
    seconds,
    2450 * pitch,
    [
      [1, 1, 0.075],
      [1.41, 0.75, 0.05],
      [2.09, 0.5, 0.034],
      [2.83, 0.34, 0.022],
      [3.92, 0.22, 0.014],
      [5.04, 0.13, 0.009],
    ],
    { seed: 7 },
  );
  kit.add(b, kit.st(kit.hp(ring, 1200 * pitch), -0.12), 0, 0.7);
  // 3. shards: tiny grains scattering left/right over the first 300 ms
  const grains = kit.buf(seconds);
  for (let i = 0; i < 9; i++) {
    const at = 0.004 + kit.rng() * Math.min(0.3, seconds * 0.6);
    const f = (1400 + kit.rng() * 5200) * pitch;
    const d = 0.003 + kit.rng() * 0.022;
    const x = kit.envApply(kit.osc(d * 4, f, { type: 'tri' }), (t) => Math.exp(-t / (d * 0.45)));
    kit.add(grains, kit.st(x, -1 + 2 * kit.rng()), at, 0.25 + kit.rng() * 0.5);
  }
  kit.add(b, grains, 0, 0.55);
  // 4. a small room so the crack has a place to happen in
  return kit.reverb(b, { size: 0.6, damp: 0.55, wet: 0.16, tail: 0.35 });
}

/** A shockwave: a fast sub pitch drop, a body knock and an air push, with a big tail. */
function subThump(kit, { seconds = 0.9, pitch = 1 } = {}) {
  const b = kit.buf(seconds);
  const sub = kit.osc(
    seconds,
    kit.bpx([
      [0, 108 * pitch],
      [0.12, 42 * pitch],
      [seconds, 34 * pitch],
    ]),
    { type: 'sine' },
  );
  kit.envApply(sub, (t) => Math.min(1, t / 0.005) * Math.exp(-t / (seconds * 0.3)));
  kit.add(b, kit.st(kit.sat(sub, 2.4), 0), 0, 1);
  // the knock
  const knock = kit.envApply(kit.lp(kit.white(0.14), 800), kit.expd(1 / 0.028));
  kit.add(b, kit.st(knock, 0), 0, 0.4);
  // the air being pushed out of the way
  const air = kit.svf(
    kit.white(seconds * 0.7),
    'bp',
    kit.bpx([
      [0, 1800],
      [seconds * 0.45, 220],
    ]),
    0.8,
  );
  kit.envApply(air, (t) => Math.exp(-t / (seconds * 0.14)));
  kit.add(b, kit.st(air, 0), 0, 0.32);
  return kit.reverb(b, { size: 0.86, damp: 0.4, wet: 0.2, tail: 0.3 });
}

/** A short PA/radio static burst before a broadcast line. */
function radioStatic(kit, { seconds = 0.34 } = {}) {
  const b = kit.buf(seconds);
  const x = kit.bpf(kit.white(seconds), 1900, 0.7);
  kit.envApply(x, (t) => Math.exp(-t / (seconds * 0.3)) * (0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 42 * t))));
  kit.add(b, kit.st(x, 0.05), 0, 1);
  const hiss = kit.hp(kit.bpf(kit.white(seconds * 0.7), 5200, 1.1), 2400);
  kit.envApply(hiss, (t) => Math.exp(-t / (seconds * 0.16)));
  kit.add(b, kit.st(hiss, -0.25), 0, 0.4);
  const click = kit.hp(kit.envApply(kit.white(0.02), kit.expd(1 / 0.0035)), 2000);
  kit.add(b, kit.st(click, 0), 0, 0.5);
  return kit.echo(b, { time: 0.09, fb: 0.22, wet: 0.2, tail: 0.25 });
}

/** The emergency alert: three clipped square tones, panned alternately. */
function alertBeep(kit, { pitch = 1 } = {}) {
  const b = kit.buf(0.8);
  const tone = (f, d) =>
    kit.lp(
      kit.envApply(kit.osc(d, f * pitch, { type: 'square' }), (t) => Math.min(1, t / 0.004) * Math.exp(-t / (d * 0.4))),
      4200,
    );
  kit.add(b, kit.st(tone(900, 0.2), -0.25), 0, 0.45);
  kit.add(b, kit.st(tone(660, 0.2), 0.25), 0.22, 0.45);
  kit.add(b, kit.st(tone(900, 0.22), -0.25), 0.46, 0.45);
  return kit.echo(b, { time: 0.1, fb: 0.2, wet: 0.18, tail: 0.2 });
}

export const sounds = {
  glass_crack_a: (kit, p) => glassCrack(kit, { pitch: 1, ...p }),
  glass_crack_b: (kit, p) => glassCrack(kit, { pitch: 1.18, ...p }),
  sub_thump: subThump,
  radio_static: radioStatic,
  alert_beep: alertBeep,
};

export const describe = {
  glass_crack_a: 'glass crack under a slammed word: snap, inharmonic ring, flying shards',
  glass_crack_b: 'the same crack a whole tone up, for alternating words',
  sub_thump: 'drop shockwave: driven sub pitch drop, body knock and an air push',
  radio_static: 'short PA static burst before a broadcast line',
  alert_beep: 'three-tone emergency alert',
};

export const params = {
  glass_crack_a: { seconds: 0.6, pitch: 1 },
  glass_crack_b: { seconds: 0.6, pitch: 1.18 },
  sub_thump: { seconds: 0.9, pitch: 1 },
  radio_static: { seconds: 0.34 },
  alert_beep: { pitch: 1 },
};

export const finish = {
  glass_crack_a: { peak_db: -2 },
  glass_crack_b: { peak_db: -2 },
  sub_thump: { peak_db: -1.5, fade_out_s: 0.06 },
  radio_static: { peak_db: -3 },
  alert_beep: { peak_db: -4 },
};
