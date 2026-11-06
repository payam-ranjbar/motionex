import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createKit } from '../../src/lib/dsp/kit.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { fromDb } from '../../src/lib/signal.mjs';
import { encodeWav } from '../../src/lib/wav.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

/** A decaying stereo tone at an arbitrary sample rate (for palette / readWav tests). */
function toneStereo(sampleRate, sec) {
  const n = Math.round(sampleRate * sec);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const v = Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t / 1.5);
    l[i] = v;
    r[i] = v * 0.9;
  }
  return { sampleRate, channels: [l, r] };
}

/** Assert a value (number | buffer | envelope fn) is finite / NaN-free, recursively. */
function assertClean(value, label) {
  if (typeof value === 'function') {
    assertClean(value(0), `${label}(0)`);
    assertClean(value(0.01), `${label}(0.01)`);
    return;
  }
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${label} = ${value}`);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    for (let i = 0; i < value.length; i++) assert.ok(Number.isFinite(value[i]), `${label}[${i}] = ${value[i]}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertClean(value[i], `${label}[${i}]`);
    return;
  }
  assert.fail(`${label} is not finite: ${String(value)}`);
}

const meanOf = (a) => {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
};

const diffRms = (a) => {
  let s = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    s += d * d;
  }
  return Math.sqrt(s / (a.length - 1));
};

test('dsp kit: every returned function is callable without NaN', async () => {
  const tmp = await mkTmp('mx-dsp-');
  try {
    const wavPath = path.join(tmp, 'src.wav');
    await writeFile(wavPath, encodeWav(toneStereo(44100, 2), { format: 'f32' }));
    const kit = createKit({ palette: { gong: toneStereo(44100, 2) }, seed: 3 });

    const calls = {
      buf: () => kit.buf(0.02),
      len: () => kit.len(kit.st(kit.osc(0.02, 440))),
      mono: () => kit.osc(0.02, 440),
      st: () => kit.st(kit.osc(0.02, 440), 0.2),
      stPan: () => kit.stPan(kit.osc(0.02, 440), (t) => t * 2 - 1),
      add: () => kit.add(kit.buf(0.02), kit.osc(0.02, 440), 0.005, 0.5),
      db: () => kit.db(-6),
      gain: () => kit.gain(kit.osc(0.02, 440), 0.5),
      envApply: () => kit.envApply(kit.st(kit.osc(0.02, 440)), (t) => 1 - t),
      rng: () => kit.rng(),
      white: () => kit.white(0.02),
      pink: () => kit.pink(0.02),
      brown: () => kit.brown(0.02),
      expd: () => kit.expd(3),
      ad: () => kit.ad(0.005, 0.02),
      bp: () =>
        kit.bp([
          [0, 0],
          [0.01, 1],
          [0.02, 0],
        ]),
      bpx: () =>
        kit.bpx([
          [0, 100],
          [0.02, 800],
        ]),
      osc: () => kit.osc(0.02, 440, { type: 'saw' }),
      bell: () =>
        kit.bell(0.02, 220, [
          [1, 1, 0.2],
          [2.7, 0.5, 0.1],
        ]),
      svf: () => kit.svf(kit.white(0.02), 'lp', 1000),
      lp: () => kit.lp(kit.osc(0.02, 440), 800),
      hp: () => kit.hp(kit.osc(0.02, 440), 200),
      bpf: () => kit.bpf(kit.osc(0.02, 440), 500, 1),
      stf: () => kit.stf(kit.st(kit.osc(0.02, 440)), (x) => kit.lp(x, 800)),
      sat: () => kit.sat(kit.osc(0.02, 440), 2),
      crush: () => kit.crush(kit.osc(0.02, 440), 6, 4),
      stutter: () => kit.stutter(kit.osc(0.02, 440), 0.005, 0.5),
      reverb: () => kit.reverb(kit.st(kit.osc(0.02, 440)), { tail: 0.02 }),
      echo: () => kit.echo(kit.st(kit.osc(0.02, 440)), { time: 0.005, tail: 0.02 }),
      readWav: () => kit.readWav(wavPath),
      resample: () => kit.resample(kit.osc(0.02, 440), 2),
      semis: () => kit.semis(2),
      pitch: () => kit.pitch(kit.st(kit.osc(0.02, 440)), 2),
      vari: () => kit.vari(kit.osc(0.02, 440), () => 1, 0.01),
      rev: () => kit.rev(kit.st(kit.osc(0.02, 440))),
      pal: () => kit.pal('gong', 0, 0.1),
      peakOf: () => kit.peakOf(kit.st(kit.osc(0.02, 440))),
      norm: () => kit.norm(kit.st(kit.white(0.02)), -1),
      trimHead: () => kit.trimHead(kit.st(kit.white(0.02)), -60),
      trimTail: () => kit.trimTail(kit.st(kit.white(0.02)), -60),
      fadeOut: () => kit.fadeOut(kit.st(kit.white(0.02)), 0.005),
      fadeIn: () => kit.fadeIn(kit.st(kit.white(0.02)), 0.005),
      finish: () => kit.finish(kit.st(kit.white(0.1)), {}),
      cat2: () => kit.cat2(kit.st(kit.osc(0.01, 440)), kit.st(kit.osc(0.01, 660))),
    };

    const fns = Object.keys(kit).filter((k) => typeof kit[k] === 'function');
    assert.deepEqual(Object.keys(calls).sort(), fns.slice().sort(), 'smoke table must cover every function');
    assert.equal(kit.SR, 48000);
    for (const [name, fn] of Object.entries(calls)) assertClean(fn(), `kit.${name}`);
  } finally {
    await rmTmp(tmp);
  }
});

test('dsp kit: same seed is deterministic, different seeds differ', () => {
  const a = createKit({ seed: 42 });
  const b = createKit({ seed: 42 });
  const c = createKit({ seed: 43 });
  assert.deepEqual(Array.from(a.white(0.2)), Array.from(b.white(0.2)));
  assert.deepEqual(Array.from(a.pink(0.2)), Array.from(b.pink(0.2)));
  assert.notDeepEqual(Array.from(a.white(0.2)), Array.from(c.white(0.2)));
  assert.notDeepEqual(Array.from(a.pink(0.2)), Array.from(c.pink(0.2)));
  // Explicit per-call seeds are independent of the kit seed.
  assert.deepEqual(Array.from(createKit({ seed: 1 }).white(0.2, 5)), Array.from(createKit({ seed: 2 }).white(0.2, 5)));
});

test('dsp kit: finish trims, fades, normalises and DC-blocks', () => {
  const kit = createKit({ seed: 5 });
  const input = kit.cat2(kit.buf(0.2), kit.st(kit.white(0.2)), kit.buf(0.3));
  const out = kit.finish(input, { peak_db: -1 });
  assert.equal(out.length, 2);
  assert.equal(out[0].length, out[1].length);
  // ~0.2 s of lead silence and part of the tail are gone (input is 0.7 s).
  assert.ok(kit.len(input) - kit.len(out) > 0.3 * kit.SR, `trimmed too little: ${kit.len(out)}`);
  assert.ok(kit.len(out) / kit.SR > 0.2 && kit.len(out) / kit.SR < 0.35, `out ${kit.len(out) / kit.SR}s`);
  // Starts at ~0 (fade-in) and peaks exactly at the target.
  assert.ok(Math.abs(out[0][0]) < 1e-9, `left starts at ${out[0][0]}`);
  assert.ok(Math.abs(out[1][0]) < 1e-9, `right starts at ${out[1][0]}`);
  assert.ok(Math.abs(kit.peakOf(out) - fromDb(-1)) < 1e-4, `peak ${kit.peakOf(out)} vs ${fromDb(-1)}`);
  assert.ok(Math.max(Math.abs(meanOf(out[0])), Math.abs(meanOf(out[1]))) < 1e-3);
});

test('dsp kit: pal slices the palette at 48 kHz and rejects unknown names', () => {
  const kit = createKit({ palette: { gong: toneStereo(44100, 2) }, seed: 1 });
  const s = kit.pal('gong', 0, 0.5);
  assert.equal(s.length, 2);
  assert.ok(s[0] instanceof Float32Array && s[1] instanceof Float32Array);
  assert.ok(s[0].length > 0.45 * kit.SR, `slice is ${s[0].length} samples`);
  assert.ok(s[0].length <= 0.5 * kit.SR, `slice is ${s[0].length} samples`);
  const untrimmed = kit.pal('gong', 1, 0.5, { trim: false });
  assert.equal(untrimmed[0].length, 0.5 * kit.SR, 'a 0.5 s slot is 24000 samples at 48 kHz');
  assert.throws(
    () => kit.pal('nope', 0, 1),
    (e) => e instanceof ToolError && e.type === 'invalid-input' && /no palette entry "nope"/.test(e.detail),
  );
});

test('dsp kit: lp removes high-frequency energy, hp removes DC', () => {
  const kit = createKit({ seed: 9 });
  const x = kit.white(1, 4);
  const low = kit.lp(x, 500);
  assert.ok(diffRms(low) < diffRms(x) * 0.5, `lp diffRms ${diffRms(low)} vs ${diffRms(x)}`);
  const dc = kit.mono(() => 0.5, 0.5);
  const hpd = kit.hp(dc, 200);
  assert.equal(meanOf(dc), 0.5);
  assert.ok(Math.abs(meanOf(hpd)) < 0.01, `hp mean ${meanOf(hpd)}`);
});

test('dsp kit: reverb extends the buffer and stays finite', () => {
  const kit = createKit({ seed: 3 });
  const x = kit.st(kit.osc(0.1, 440));
  const y = kit.reverb(x, { tail: 0.5 });
  assert.equal(y.length, 2);
  assert.ok(y[0].length >= x[0].length);
  assert.equal(y[0].length, y[1].length);
  for (const ch of y) for (const v of ch) assert.ok(Number.isFinite(v));
});
