// ON THE ONE - EP2 "ONE PIXEL" - SFX recipes.
//
// The hero is an 8-bit pixel, so its voice is a bit-crushed square-wave blip:
//   hop1..hop4   one blip per hop, a whole tone higher each time
//   blink        a near-silent tick when the pixel blinks
//   assemble     a brighter blip when a word snaps together out of pixels
//   land         the low thump of the picture snapping onto the grid
//   swish_in     soft airy swish as the pixel rain falls in
//   scatter      noise burst when the picture explodes back to a loose grid
//   bow          a small descending two-note figure for the bow
//   final        a bright rising arpeggio for the endcard
//
// Every random draw goes through ct.rng(), so a given kit seed reproduces the sound.

const TAU = 2 * Math.PI;

/** Square-wave 8-bit blip: a two-tone hit plus a sparkle, bit-crushed and echoed. */
function blip(ct, f, { sec = 0.12, bits = 4, hold = 2, wet = 0.20, tail = 0.15 } = {}) {
  const b = ct.buf(sec + 0.32);
  const tone = (freq, at, dur, g, dec) => {
    const x = ct.mono(
      (t) => (Math.sin(TAU * freq * t) >= 0 ? 1 : -1) * Math.min(1, t / 0.0012) * Math.exp(-t / dec),
      dur,
    );
    ct.add(b, ct.st(ct.crush(x, bits, hold)), at, g);
  };
  tone(f, 0, sec, 0.55, 0.020);
  tone(f * 1.5, 0.036, sec, 0.40, 0.018);
  tone(f * 3, 0.036, sec * 0.6, 0.10, 0.012);
  return ct.echo(b, { time: 0.055, fb: 0.16, wet, tail });
}

/** Soft airy swish sweeping up and across: the pixel rain arriving. */
function swishIn(ct, { seconds = 0.6, pitch = 1 } = {}) {
  const pk = seconds * 0.55;
  const b = ct.buf(seconds + 0.25);
  const e = (t) => (t < pk ? (t / pk) ** 2 : Math.exp(-(t - pk) / (seconds * 0.14)));
  const cf = ct.bpx([
    [0, 500 * pitch],
    [pk, 3200 * pitch],
    [seconds, 900 * pitch],
  ]);
  const pan = (t) => -0.5 + 1.0 * Math.min(1, t / seconds);
  const x = ct.svf(ct.pink(seconds + 0.25), 'bp', cf, 0.9);
  ct.envApply(x, e);
  ct.add(b, ct.stPan(x, pan), 0, 1);
  const y = ct.svf(ct.white(seconds + 0.25), 'bp', (t) => cf(t) * 2.4, 1.4);
  ct.envApply(y, e);
  ct.add(b, ct.stPan(y, pan), 0, 0.28);
  return ct.reverb(b, { wet: 0.18, size: 0.7, damp: 0.5, tail: 0.4 });
}

/** Low soft thump with a grid tick on top: the picture snapping to the grid. */
function land(ct, { seconds = 0.55, pitch = 1 } = {}) {
  const b = ct.buf(seconds + 0.3);
  const sub = ct.mono((t) => {
    const f = 52 * pitch + 120 * pitch * Math.exp(-t / 0.045);
    return Math.sin(TAU * f * t) * Math.min(1, t / 0.003) * Math.exp(-t / 0.13);
  }, seconds);
  ct.add(b, ct.st(ct.sat(sub, 1.9)), 0, 0.95);
  // a short bright tick so it reads as "clicked into place"
  const tick = ct.mono((t) => (ct.rng() * 2 - 1) * Math.exp(-t / 0.012), 0.09);
  ct.add(b, ct.st(ct.hp(ct.lp(tick, 9000), 2200)), 0, 0.30);
  return b;
}

/** Noise burst of scattering pixels: a low body plus grains flying outward. */
function scatterSfx(ct, { seconds = 0.85 } = {}) {
  const b = ct.buf(seconds);
  const body = ct.mono((t) => (ct.rng() * 2 - 1) * Math.exp(-t / 0.09), 0.4);
  ct.add(b, ct.st(ct.hp(ct.lp(body, 5000), 200)), 0, 0.55);
  const sub = ct.mono((t) => {
    const f = 90 + 140 * Math.exp(-t / 0.05);
    return Math.sin(TAU * f * t) * Math.exp(-t / 0.10);
  }, 0.5);
  ct.add(b, ct.st(ct.sat(sub, 1.6)), 0, 0.8);
  // grains: many tiny crushed ticks flying out
  let t = 0.004;
  while (t < seconds * 0.75) {
    const n = 0.006 + ct.rng() * 0.012;
    const x = ct.crush(ct.white(n), 4, 2 + Math.floor(ct.rng() * 6));
    ct.envApply(x, (tt) => Math.min(1, tt / 0.0006) * Math.exp(-tt / (n * 0.35)));
    const pan = ct.rng() * 1.7 - 0.85;
    ct.add(b, ct.stPan(x, () => pan), t, (0.35 + ct.rng() * 0.5) * Math.exp(-t / (seconds * 0.45)));
    t += 0.008 + ct.rng() * 0.03;
  }
  return ct.reverb(b, { wet: 0.22, size: 0.8, damp: 0.4, tail: 0.5 });
}

/** A small descending two-note figure: the bow. */
function bow(ct) {
  const b = ct.buf(0.5);
  const tone = (f, at, dur, g, dec) => {
    const x = ct.mono(
      (t) => (Math.sin(TAU * f * t) >= 0 ? 1 : -1) * Math.min(1, t / 0.002) * Math.exp(-t / dec),
      dur,
    );
    ct.add(b, ct.st(ct.crush(x, 5, 2)), at, g);
  };
  tone(1318, 0, 0.16, 0.5, 0.05);
  tone(880, 0.12, 0.22, 0.5, 0.09);
  return ct.echo(b, { time: 0.08, fb: 0.2, wet: 0.22, tail: 0.25 });
}

/** Bright rising arpeggio: the endcard. */
function final(ct) {
  const b = ct.buf(1.6);
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  notes.forEach((f, i) => {
    const x = ct.mono(
      (t) => (Math.sin(TAU * f * t) >= 0 ? 1 : -1) * Math.min(1, t / 0.0015) * Math.exp(-t / 0.11),
      0.6,
    );
    ct.add(b, ct.st(ct.crush(x, 5, 1), -0.3 + i * 0.15), i * 0.09, 0.34);
  });
  return ct.reverb(ct.echo(b, { time: 0.1, fb: 0.25, wet: 0.25, tail: 0.5 }), {
    wet: 0.28,
    size: 0.8,
    damp: 0.45,
    tail: 0.6,
  });
}

export const sounds = {
  hop1: (ct) => blip(ct, 880),
  hop2: (ct) => blip(ct, 988),
  hop3: (ct) => blip(ct, 1109),
  hop4: (ct) => blip(ct, 1245),
  blink: (ct) => blip(ct, 2200, { sec: 0.05, bits: 5, hold: 1, wet: 0.06, tail: 0.1 }),
  assemble: (ct) => blip(ct, 1568, { sec: 0.09, bits: 5, hold: 1, wet: 0.12, tail: 0.12 }),
  swish_in: swishIn,
  land,
  scatter: scatterSfx,
  bow,
  final,
};

export const describe = {
  hop1: '8-bit hop blip, root',
  hop2: '8-bit hop blip, +2 semitones',
  hop3: '8-bit hop blip, +4 semitones',
  hop4: '8-bit hop blip, +6 semitones',
  blink: 'tiny pixel blink tick',
  assemble: 'brighter blip for a word snapping together',
  swish_in: 'soft airy swish for the pixel rain',
  land: 'low soft thump with a grid tick',
  scatter: 'noise burst of scattering pixels',
  bow: 'small descending two-note figure',
  final: 'bright rising arpeggio for the endcard',
};

// The mix does the balancing; these just keep the short sounds from peaking the bus.
export const finish = {
  hop1: { peak_db: -8 },
  hop2: { peak_db: -8 },
  hop3: { peak_db: -8 },
  hop4: { peak_db: -8 },
  blink: { peak_db: -16 },
  assemble: { peak_db: -10 },
  swish_in: { peak_db: -10 },
  land: { peak_db: -3 },
  scatter: { peak_db: -5 },
  bow: { peak_db: -9 },
  final: { peak_db: -4 },
};
