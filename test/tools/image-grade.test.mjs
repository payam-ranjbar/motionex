import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { mulberry32 } from '../../src/lib/signal.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const FEATURES = needs('ffmpeg');
const CH = { gray: 1, rgb24: 3, rgba: 4 };

/** Write a PNG whose pixel (x, y) is fn(x, y) (an array of CH[pixFmt] bytes). */
async function writePng(ws, rel, w, h, fn, pixFmt = 'rgb24') {
  const ch = CH[pixFmt];
  const buf = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      for (let k = 0; k < ch; k++) buf[(y * w + x) * ch + k] = c[k];
    }
  }
  const abs = path.join(ws, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await runFfmpeg(
    ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${w}x${h}`, '-i', '-'].concat([
      '-frames:v',
      '1',
      abs,
    ]),
    { input: buf },
  );
  return abs;
}

/** Decode an image to raw bytes (rgb24, rgba or gray). */
async function decode(abs, pixFmt = 'rgb24') {
  const { stdout } = await runFfmpeg(
    ['-hide_banner', '-v', 'error', '-i', abs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'],
    { stdout: 'buffer' },
  );
  return stdout;
}

const outAbs = (outputs, name) => {
  const o = outputs.find((x) => x.name === name);
  assert.ok(o, `no output ${name} (got ${outputs.map((x) => x.name).join(', ')})`);
  return o.abs;
};
const pixel = (buf, w, x, y, ch = 3) => [...buf.subarray((y * w + x) * ch, (y * w + x) * ch + ch)];

/** A 48x32 image of seeded random colours with varied alpha. */
function noisy(seed) {
  const r = mulberry32(seed);
  const cells = Array.from({ length: 48 * 32 }, () => [
    Math.floor(r() * 256),
    Math.floor(r() * 256),
    Math.floor(r() * 256),
    Math.floor(128 + r() * 128),
  ]);
  return (x, y) => cells[y * 48 + x];
}

/** A warm room: a yellow-cast wall, a bright orange lamp with a near-white core, a subject in the middle. */
const ROOM = { w: 96, h: 64 };
function room(x, y) {
  if (x >= 8 && x < 20 && y >= 8 && y < 20)
    return x >= 12 && x < 16 && y >= 12 && y < 16 ? [255, 250, 238] : [255, 160, 50];
  if (x >= 40 && x < 64 && y >= 20 && y < 56) return [176, 140, 112];
  return [140, 120, 70];
}
const roomMask = (x, y) => (x >= 40 && x < 64 && y >= 20 && y < 56 ? [255] : [0]);

const invalidOf = async (input, ws) => {
  const err = await runTool('image.grade', input, { workspace: ws }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, `expected an error for ${JSON.stringify(input.steps ?? input.images)}`);
  return err;
};

test('image.grade: neutral steps leave every pixel (and the alpha) unchanged', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'noise.png', 48, 32, noisy(7), 'rgba');
    const { result, outputs } = await runTool(
      'image.grade',
      {
        images: [{ image: 'noise.png' }],
        steps: [
          { op: 'cast', axis: 'yellow', amount: 0, protect: 'lights' },
          { op: 'saturation', amount: 1 },
          { op: 'saturation', amount: 1, hue: { center_deg: 40, width_deg: 90 }, rest: 1 },
          { op: 'curve' },
          { op: 'curve', contrast: 0, lift: 0, shoulder: 0, gamma: 1 },
          { op: 'exposure', ev: 0 },
          { op: 'clarity', amount: 0 },
          { op: 'tint', amount: 0, color: '#ff0000' },
          { op: 'vignette', amount: 0 },
        ],
      },
      { workspace: ws },
    );
    const src = await decode(path.join(ws, 'noise.png'), 'rgba');
    const out = await decode(outAbs(outputs, 'noise.png'), 'rgba');
    assert.ok(src.equals(out), 'the output pixels differ from the source');
    const [img] = result.images;
    assert.deepEqual(img.before, img.after);
    assert.deepEqual(img.skipped_steps, []);
    assert.match(result.warnings.join(' '), /steps\[3\] is a curve with no fields/);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: cast yellow removes b* from the wall and keeps a protected lamp as it was', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'room.png', ROOM.w, ROOM.h, room);
    const protectedRun = await runTool(
      'image.grade',
      { images: [{ image: 'room.png' }], steps: [{ op: 'cast', axis: 'yellow', amount: 0.8, protect: 'lights' }] },
      { workspace: ws },
    );
    const [img] = protectedRun.result.images;
    assert.ok(img.before.cast_b > 20, `the wall should start yellow (b* ${img.before.cast_b})`);
    assert.ok(img.after.cast_b < img.before.cast_b * 0.35, `b* ${img.before.cast_b} -> ${img.after.cast_b}`);
    assert.ok(img.lights_pct > 1 && img.lights_pct < 10, `lights_pct ${img.lights_pct}`);
    assert.ok(Math.abs(img.after.luma - img.before.luma) < 3, 'a cast move should barely change L*');

    const out = await decode(outAbs(protectedRun.outputs, 'room.png'));
    assert.deepEqual(pixel(out, ROOM.w, 10, 10), [255, 160, 50], 'the protected lamp keeps its colour');
    assert.deepEqual(pixel(out, ROOM.w, 13, 13), [255, 250, 238], 'the lamp core keeps its colour');
    const wall = pixel(out, ROOM.w, 85, 5);
    assert.ok(wall[2] > 70 + 30, `the wall gains blue as yellow leaves: ${wall}`);

    const bare = await runTool(
      'image.grade',
      { images: [{ image: 'room.png' }], steps: [{ op: 'cast', axis: 'yellow', amount: 0.8 }] },
      { workspace: ws },
    );
    const lamp = pixel(await decode(outAbs(bare.outputs, 'room.png')), ROOM.w, 10, 10);
    assert.ok(lamp[2] > 50 + 20, `without protect the lamp loses its yellow too: ${lamp}`);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: tint outside-mask darkens the background, not the subject, held off by grow', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'room.png', ROOM.w, ROOM.h, room);
    // A half-size mask, to be resized to the image.
    await writePng(ws, 'mask.png', ROOM.w / 2, ROOM.h / 2, (x, y) => roomMask(x * 2, y * 2), 'gray');
    const { result, outputs } = await runTool(
      'image.grade',
      {
        images: [{ image: 'room.png', mask: 'mask.png' }],
        steps: [{ op: 'tint', amount: 0.5, where: 'outside-mask', grow: 0.05, feather: 0.05 }],
      },
      { workspace: ws },
    );
    const out = await decode(outAbs(outputs, 'room.png'));
    assert.deepEqual(pixel(out, ROOM.w, 52, 38), [176, 140, 112], 'the subject is untouched');
    assert.deepEqual(pixel(out, ROOM.w, 66, 38), [140, 120, 70], 'the background within grow is untouched');
    assert.deepEqual(pixel(out, ROOM.w, 90, 60), [70, 60, 35], 'the far background is half-way to black');
    const mid = pixel(out, ROOM.w, 70, 38);
    assert.ok(mid[0] > 80 && mid[0] < 130, `the feather fades the tint in: ${mid}`);

    const [img] = result.images;
    assert.ok(img.subject, 'subject numbers are reported with a mask');
    assert.ok(Math.abs(img.subject.mask_pct - 14.06) < 2, `mask_pct ${img.subject.mask_pct}`);
    assert.ok(img.subject.separation_db > img.subject.separation_db_before + 2, JSON.stringify(img.subject));
    assert.ok(img.after.luma < img.before.luma);
    assert.match(result.warnings.join(' '), /the mask is 48x32; it was resized to 96x64/);

    // Without a mask the same step is skipped for that image, with a warning.
    const bare = await runTool(
      'image.grade',
      { images: [{ image: 'room.png' }], steps: [{ op: 'tint', amount: 0.5, where: 'outside-mask' }] },
      { workspace: ws },
    );
    assert.deepEqual(bare.result.images[0].skipped_steps, [0]);
    assert.equal(bare.result.images[0].subject, undefined);
    assert.match(bare.result.warnings.join(' '), /steps\[0\] \(tint\) was skipped: where is "outside-mask"/);
    const src = await decode(path.join(ws, 'room.png'));
    assert.ok(src.equals(await decode(outAbs(bare.outputs, 'room.png'))), 'a skipped tint changes nothing');
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: an identity .cube changes nothing; a channel-swap .cube swaps red and blue', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'noise.png', 48, 32, noisy(11));
    const identity = ['TITLE "identity"', '# a comment', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1', 'LUT_3D_SIZE 3'];
    for (const b of [0, 0.5, 1])
      for (const g of [0, 0.5, 1]) for (const r of [0, 0.5, 1]) identity.push(`${r} ${g} ${b}`);
    await writeFile(path.join(ws, 'identity.cube'), `${identity.join('\n')}\n`);
    const swap = ['LUT_3D_SIZE 2'];
    for (const b of [0, 1]) for (const g of [0, 1]) for (const r of [0, 1]) swap.push(`${b} ${g} ${r}`);
    await writeFile(path.join(ws, 'swap.cube'), `${swap.join('\r\n')}\r\n`);

    const src = await decode(path.join(ws, 'noise.png'));
    const same = await runTool(
      'image.grade',
      { images: [{ image: 'noise.png' }], steps: [{ op: 'lut', file: 'identity.cube' }] },
      { workspace: ws },
    );
    const out = await decode(outAbs(same.outputs, 'noise.png'));
    for (let i = 0; i < src.length; i++) assert.ok(Math.abs(src[i] - out[i]) <= 1, `byte ${i}: ${src[i]} -> ${out[i]}`);

    const swapped = await runTool(
      'image.grade',
      {
        images: [{ image: 'noise.png', name: 'swapped' }],
        steps: [{ op: 'lut', file: 'swap.cube' }],
        format: 'jpeg',
        quality: 100,
      },
      { workspace: ws },
    );
    assert.equal(swapped.result.images[0].file, 'swapped.jpg');
    const jpg = await decode(outAbs(swapped.outputs, 'swapped.jpg'));
    assert.equal(jpg.length, src.length);
    // JPEG is lossy, so compare the channel means: red and blue trade places.
    const mean = (buf, c) => {
      let s = 0;
      for (let i = c; i < buf.length; i += 3) s += buf[i];
      return s / (buf.length / 3);
    };
    assert.ok(Math.abs(mean(jpg, 0) - mean(src, 2)) < 3, `red mean ${mean(jpg, 0)} vs source blue ${mean(src, 2)}`);
    assert.ok(Math.abs(mean(jpg, 2) - mean(src, 0)) < 3, `blue mean ${mean(jpg, 2)} vs source red ${mean(src, 0)}`);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: per-op validation names the bad field', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'room.png', ROOM.w, ROOM.h, room);
    await writeFile(path.join(ws, 'short.cube'), 'LUT_3D_SIZE 2\n0 0 0\n1 1 1\n');
    const images = [{ image: 'room.png' }];
    const cases = [
      [
        [
          { op: 'curve', contrast: 0.1 },
          { op: 'exposure', ev: 0 },
          { op: 'cast', axis: 'yellow' },
        ],
        /steps\[2\]\.amount is required for op "cast"/,
      ],
      [[{ op: 'cast', amount: 0.5 }], /steps\[0\]\.axis is required for op "cast"/],
      [[{ op: 'cast', axis: 'yellow', amount: 0.5, ev: 1 }], /steps\[0\]\.ev is not a field of op "cast"/],
      [[{ op: 'tint', amount: 1.5 }], /steps\[0\]\.amount must be from 0 to 1 for op "tint"/],
      [[{ op: 'exposure' }], /steps\[0\]\.ev is required for op "exposure"/],
      [[{ op: 'saturation', amount: 1, rest: 0.5 }], /steps\[0\]\.rest needs steps\[0\]\.hue/],
      [[{ op: 'lut', file: 'short.cube' }], /steps\[0\]\.file "short\.cube" is not a usable \.cube LUT: has 2 entries/],
    ];
    for (const [steps, re] of cases) {
      const err = await invalidOf({ images, steps }, ws);
      assert.equal(err.type, 'invalid-input', `${JSON.stringify(steps)}: ${err.message}`);
      assert.match(err.message, re);
    }
    const schemaErr = await invalidOf({ images, steps: [{ op: 'blur', amount: 1 }] }, ws);
    assert.equal(schemaErr.type, 'invalid-input');
    assert.match(schemaErr.message, /steps\/0\/op/);

    const dup = await invalidOf(
      {
        images: [
          { image: 'room.png', name: 'a' },
          { image: 'room.png', name: 'a' },
        ],
      },
      ws,
    );
    assert.match(dup.message, /images\[1\]\.name "a" is already the name of another image/);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: the result fields, the glow layer and the light mask', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'stills/room.png', ROOM.w, ROOM.h, room);
    await writePng(ws, 'mattes/room.png', ROOM.w, ROOM.h, (x, y) => [255, 255, 255, roomMask(x, y)[0]], 'rgba');
    const { result, outputs } = await runTool(
      'image.grade',
      {
        images: [{ image: 'stills/room.png', mask: 'mattes/room.png' }, { image: 'stills/room.png' }],
        steps: [
          { op: 'cast', axis: 'yellow', amount: 0.6, protect: 'lights' },
          { op: 'curve', contrast: 0.2, shoulder: 0.1 },
          { op: 'tint', amount: 0.4, where: 'outside-mask', grow: 0.02, feather: 0.05, protect: 'lights' },
          { op: 'vignette', amount: 0.2 },
        ],
        light_mask: { write_masks: true },
        glow: { radii: [0.02, 0.08] },
      },
      { workspace: ws },
    );
    assert.deepEqual(
      result.images.map((i) => i.name),
      ['room', 'room-2'],
      'default names come from the source and stay unique',
    );
    const names = outputs.map((o) => o.name).sort();
    assert.deepEqual(names, [
      'room-2-glow.png',
      'room-2-lights.png',
      'room-2.png',
      'room-glow.png',
      'room-lights.png',
      'room.png',
    ]);
    for (const img of result.images) {
      assert.equal(img.width, ROOM.w);
      assert.equal(img.height, ROOM.h);
      for (const k of ['before', 'after']) {
        assert.ok(img[k].luma > 0 && img[k].luma < 100, `${k}.luma ${img[k].luma}`);
        assert.ok(Number.isFinite(img[k].cast_a) && Number.isFinite(img[k].cast_b));
      }
      assert.ok(img.lights_pct > 0 && img.lights_pct < 20, `lights_pct ${img.lights_pct}`);
      assert.equal(img.glow_file, `${img.name}-glow.png`);
      assert.equal(img.lights_file, `${img.name}-lights.png`);
    }
    const [masked, unmasked] = result.images;
    assert.ok(masked.subject.luma_in > masked.subject.luma_out);
    assert.deepEqual(masked.skipped_steps, []);
    assert.equal(unmasked.subject, undefined);
    assert.deepEqual(unmasked.skipped_steps, [2], 'the outside-mask tint is skipped without a mask');

    const lights = await decode(outAbs(outputs, 'room-lights.png'), 'gray');
    assert.equal(lights[10 * ROOM.w + 10], 255, 'the lamp is in the light mask');
    assert.equal(lights[13 * ROOM.w + 13], 255, 'its near-white core too');
    assert.equal(lights[50 * ROOM.w + 85], 0, 'the wall is not');
    assert.equal(lights[38 * ROOM.w + 52], 0, 'the subject is not');

    const glow = await decode(outAbs(outputs, 'room-glow.png'));
    const lamp = pixel(glow, ROOM.w, 13, 13);
    assert.ok(Math.max(...lamp) > 200, `the glow is bright at the lamp: ${lamp}`);
    assert.ok(lamp[0] > lamp[2], `and warm: ${lamp}`);
    assert.deepEqual(pixel(glow, ROOM.w, 90, 60), [0, 0, 0], 'and black far from it');
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: the same input gives the same result and the same files', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'room.png', ROOM.w, ROOM.h, room);
    await writePng(ws, 'mask.png', ROOM.w, ROOM.h, roomMask, 'gray');
    const input = {
      images: [{ image: 'room.png', mask: 'mask.png' }],
      steps: [
        { op: 'cast', axis: 'yellow', amount: 0.5, protect: 'lights' },
        { op: 'saturation', amount: 1.2, hue: { center_deg: 30, width_deg: 60 }, rest: 0.9 },
        { op: 'exposure', ev: 0.4 },
        { op: 'curve', shoulder: 0.2, gamma: 1.1, lift: 0.02 },
        { op: 'clarity', amount: 0.5, radius: 0.05 },
        { op: 'tint', amount: 0.3, color: '#102030', where: 'outside-mask', feather: 0.03 },
        { op: 'vignette', amount: 0.3, softness: 0.8 },
      ],
      glow: {},
    };
    const a = await runTool('image.grade', input, { workspace: ws });
    const b = await runTool('image.grade', input, { workspace: ws });
    assert.deepEqual(a.result, b.result);
    for (const name of ['room.png', 'room-glow.png']) {
      const [x, y] = await Promise.all([readFile(outAbs(a.outputs, name)), readFile(outAbs(b.outputs, name))]);
      assert.ok(x.equals(y), `${name} differs between runs`);
    }
    const src = await decode(path.join(ws, 'room.png'));
    assert.ok(!src.equals(await decode(outAbs(a.outputs, 'room.png'))), 'the grade changed the image');
  } finally {
    await rmTmp(ws);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// White balance: the neutrals and the balance op

/** CIELAB (D65) of an 8-bit sRGB colour, written out here so the tool's numbers are checked against the formulas. */
function labOf([r, g, b]) {
  const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const chromaOf = (rgb) => Math.hypot(...labOf(rgb).slice(1));
const near = (got, want, tol, what) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got}, expected ${want} within ${tol}`);

/**
 * A street under a pink cast: two greys of road (the neutrals), a white sky and a black shadow (outside the midtone
 * band), a red car and a blue sign (saturated, so not neutrals). Half of the grey is each road colour.
 */
const STREET = { w: 96, h: 64 };
const ROAD = [164, 148, 152];
const ROAD_DARK = [122, 108, 112];
const CAR = [200, 40, 60];
const SIGN = [40, 70, 190];
const SKY = [250, 250, 250];
const SHADOW = [12, 12, 12];
const inCar = (x, y) => x >= 16 && x < 40 && y >= 24 && y < 40;
function street(x, y) {
  if (y < 8) return SKY;
  if (y >= 56) return SHADOW;
  if (inCar(x, y)) return CAR;
  if (x >= 60 && x < 76 && y >= 24 && y < 40) return SIGN;
  return y < 32 ? ROAD : ROAD_DARK;
}
const STREET_GREYS = [0, 1, 2].map((k) => (labOf(ROAD)[k] + labOf(ROAD_DARK)[k]) / 2);
const STREET_GREY_PCT = (100 * 3968) / (STREET.w * STREET.h);

test('image.grade: the neutrals are the near-neutral midtones, not the whole frame', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'street.png', STREET.w, STREET.h, street);
    const run = (extra) => runTool('image.grade', { images: [{ image: 'street.png' }], ...extra }, { workspace: ws });
    const plain = await run({});
    const [img] = plain.result.images;
    near(img.before.greys_a, STREET_GREYS[1], 0.02, 'greys_a');
    near(img.before.greys_b, STREET_GREYS[2], 0.02, 'greys_b');
    near(img.before.greys_pct, STREET_GREY_PCT, 0.01, 'greys_pct');
    assert.ok(img.before.greys_a > 5, `the road carries a pink cast (greys_a ${img.before.greys_a})`);
    assert.ok(
      img.before.cast_a > img.before.greys_a + 2,
      `the whole-frame number follows the car and the sign: cast_a ${img.before.cast_a}, greys_a ${img.before.greys_a}`,
    );
    assert.deepEqual(img.after, img.before, 'no steps: the numbers stay');
    assert.equal(img.balance, undefined, 'no balance step, no balance report');

    // A chroma limit under the cast finds no neutral; the whole L* range takes the sky and the shadow in.
    const tight = await run({ neutral: { max_chroma: 3, min_l: 30 } });
    const none = tight.result.images[0].before;
    assert.deepEqual([none.greys_a, none.greys_b, none.greys_pct], [null, null, 0]);
    const wide = await run({ neutral: { min_l: 0, max_l: 100 } });
    const all = wide.result.images[0].before;
    near(all.greys_pct, (100 * (3968 + 2 * 768)) / (STREET.w * STREET.h), 0.01, 'greys_pct over every L*');
    assert.ok(all.greys_a < img.before.greys_a - 1, `neutral sky and shadow pull the mean down: ${all.greys_a}`);

    const err = await invalidOf({ images: [{ image: 'street.png' }], neutral: { min_l: 60, max_l: 50 } }, ws);
    assert.equal(err.type, 'invalid-input');
    assert.match(err.message, /neutral\.min_l \(60\) must be below neutral\.max_l \(50\)/);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: balance puts the greys on the target and keeps the colour that cast drains', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'street.png', STREET.w, STREET.h, street);
    await writePng(ws, 'car-mask.png', STREET.w, STREET.h, (x, y) => [inCar(x, y) ? 255 : 0], 'gray');
    const run = (steps, extra = {}) =>
      runTool(
        'image.grade',
        { images: [{ image: 'street.png', ...extra.image }], steps, ...extra.input },
        { workspace: ws },
      );
    const carAt = [20, 30];
    const signAt = [64, 30];
    const labAt = async (r, [x, y]) => labOf(pixel(await decode(outAbs(r.outputs, 'street.png')), STREET.w, x, y));

    const balanced = await run([{ op: 'balance' }]);
    const [img] = balanced.result.images;
    near(img.after.greys_a, 0, 0.6, 'greys_a after');
    near(img.after.greys_b, 0, 0.6, 'greys_b after');
    near(img.after.greys_pct, STREET_GREY_PCT, 0.01, 'the same pixels are still the greys');
    near(img.after.luma, img.before.luma, 0.5, 'luma');
    assert.deepEqual(img.skipped_steps, []);
    assert.equal(img.balance.length, 1);
    assert.equal(img.balance[0].step, 0);
    const [da, db] = img.balance[0].shift_ab;
    near(da, -STREET_GREYS[1], 0.02, 'reported shift on a*');
    near(db, -STREET_GREYS[2], 0.02, 'reported shift on b*');
    // Every colour moves by the same (da, db), saturated or not.
    for (const [what, at, src] of [
      ['car', carAt, CAR],
      ['sign', signAt, SIGN],
    ]) {
      const [l0, a0, b0] = labOf(src);
      const [l1, a1, b1] = await labAt(balanced, at);
      near(l1, l0, 1, `${what} L*`);
      near(a1 - a0, da, 1, `${what} a* shift`);
      near(b1 - b0, db, 1, `${what} b* shift`);
    }
    const carChroma = chromaOf(CAR);
    const kept = Math.hypot(...(await labAt(balanced, carAt)).slice(1));
    assert.ok(kept > 0.85 * carChroma, `balance keeps the car's chroma: ${carChroma} -> ${kept}`);

    // The old way to take the pink out: it neutralises the road too, and takes the red out of the car with it.
    const drained = await run([{ op: 'cast', axis: 'red', amount: 1 }]);
    near(drained.result.images[0].after.greys_a, 0, 0.6, 'greys_a after cast');
    const left = Math.hypot(...(await labAt(drained, carAt)).slice(1));
    assert.ok(left < 0.6 * carChroma, `cast drains the car: ${carChroma} -> ${left}`);

    // Half-way to a warm target.
    const half = await run([{ op: 'balance', target_ab: [2, 6], amount: 0.5 }]);
    const h = half.result.images[0];
    near(h.after.greys_a, (h.before.greys_a + 2) / 2, 0.6, 'greys_a half-way to the target');
    near(h.after.greys_b, (h.before.greys_b + 6) / 2, 0.6, 'greys_b half-way to the target');

    // The shift is measured on the image as it is when the step runs: after an earlier shift, it undoes that too.
    const twice = await run([{ op: 'balance', shift_ab: [4, 4] }, { op: 'balance' }], {
      input: { neutral: { max_chroma: 20 } },
    });
    const t = twice.result.images[0];
    assert.deepEqual(t.balance[0], { step: 0, shift_ab: [4, 4] });
    near(t.balance[1].shift_ab[0], -(t.before.greys_a + 4), 0.05, 'second shift on a*');
    near(t.balance[1].shift_ab[1], -(t.before.greys_b + 4), 0.05, 'second shift on b*');
    near(t.after.greys_a, 0, 0.6, 'greys_a after both');
    near(t.after.greys_b, 0, 0.6, 'greys_b after both');

    // protect: mask keeps the subject as it was; the greys are still measured over the whole image.
    const guarded = await run([{ op: 'balance', protect: 'mask' }], { image: { mask: 'car-mask.png' } });
    const out = await decode(outAbs(guarded.outputs, 'street.png'));
    assert.deepEqual(pixel(out, STREET.w, ...carAt), CAR, 'the protected car keeps its colour');
    near(guarded.result.images[0].after.greys_a, 0, 0.6, 'greys_a with the car protected');
    const noMask = await run([{ op: 'balance', protect: 'mask' }]);
    assert.deepEqual(noMask.result.images[0].skipped_steps, [0]);
    assert.match(noMask.result.warnings.join(' '), /steps\[0\] \(balance\) was skipped: protect is "mask"/);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: balance with shift_ab shifts a cut-out without measuring it', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    // A cut-out car: opaque red, a soft edge, nothing around it. No neutral ground of its own.
    const cutout = (x, y) => (inCar(x, y) ? [...CAR, x === 16 || x === 39 ? 128 : 255] : [0, 0, 0, 0]);
    await writePng(ws, 'car.png', STREET.w, STREET.h, cutout, 'rgba');
    const run = (steps) => runTool('image.grade', { images: [{ image: 'car.png' }], steps }, { workspace: ws });
    const src = await decode(path.join(ws, 'car.png'), 'rgba');

    const measured = await run([{ op: 'balance' }]);
    const [m] = measured.result.images;
    assert.deepEqual([m.before.greys_a, m.before.greys_b, m.before.greys_pct], [null, null, 0]);
    assert.deepEqual(m.skipped_steps, [0]);
    assert.equal(m.balance, undefined);
    assert.match(
      measured.result.warnings.join('\n'),
      /^car: steps\[0\] \(balance\) was skipped: the image has no near-neutral midtone to measure/m,
    );
    assert.ok(
      src.equals(await decode(outAbs(measured.outputs, 'car.png'), 'rgba')),
      'a skipped balance changes nothing',
    );

    const shifted = await run([{ op: 'balance', shift_ab: [-6, 2] }]);
    const [s] = shifted.result.images;
    assert.deepEqual(s.skipped_steps, []);
    assert.deepEqual(s.balance, [{ step: 0, shift_ab: [-6, 2] }]);
    assert.deepEqual(shifted.result.warnings, []);
    const out = await decode(outAbs(shifted.outputs, 'car.png'), 'rgba');
    const [l0, a0, b0] = labOf(CAR);
    const [l1, a1, b1] = labOf(pixel(out, STREET.w, 20, 30, 4));
    near(l1, l0, 1, 'L*');
    near(a1 - a0, -6, 1, 'a* shift');
    near(b1 - b0, 2, 1, 'b* shift');
    for (let i = 3; i < src.length; i += 4) assert.equal(out[i], src[i], `alpha of pixel ${(i - 3) / 4}`);

    const half = await run([{ op: 'balance', shift_ab: [-6, 2], amount: 0.5 }]);
    assert.deepEqual(half.result.images[0].balance, [{ step: 0, shift_ab: [-3, 1] }]);
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: balance skips an image with too little grey, with a warning naming it', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'street.png', STREET.w, STREET.h, street);
    // A wall of red with one small grey plate: 48 of 6144 pixels, 0.78%.
    const wall = (x, y) => (x < 8 && y < 6 ? ROAD : CAR);
    await writePng(ws, 'wall.png', STREET.w, STREET.h, wall);
    const images = [{ image: 'street.png' }, { image: 'wall.png' }];
    const { result, outputs } = await runTool(
      'image.grade',
      {
        images,
        steps: [
          { op: 'curve', gamma: 1 },
          { op: 'balance', min_pct: 5 },
        ],
      },
      { workspace: ws },
    );
    const [st, wl] = result.images;
    assert.deepEqual(st.skipped_steps, []);
    near(st.after.greys_a, 0, 0.6, 'the street has grey enough and is balanced');
    near(wl.before.greys_pct, 0.78, 0.005, 'greys_pct of the wall');
    assert.deepEqual(wl.skipped_steps, [1]);
    assert.equal(wl.balance, undefined);
    assert.deepEqual(wl.after, wl.before);
    assert.deepEqual(result.warnings, [
      'wall: steps[1] (balance) was skipped: near-neutral midtones are 0.78% of the image, under min_pct 5',
    ]);
    const src = await decode(path.join(ws, 'wall.png'));
    assert.ok(src.equals(await decode(outAbs(outputs, 'wall.png'))), 'the skipped image is unchanged');

    // Without min_pct any grey is trusted.
    const trusted = await runTool(
      'image.grade',
      { images: [{ image: 'wall.png' }], steps: [{ op: 'balance' }] },
      { workspace: ws },
    );
    assert.deepEqual(trusted.result.images[0].skipped_steps, []);
    near(trusted.result.images[0].after.greys_a, 0, 0.6, 'greys_a of the wall');
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: balance keeps the alpha and measures only what is opaque', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    // Opaque pink-cast grey on the left, a half-transparent column of it, and fully transparent green-cast grey.
    const GREEN_GREY = [146, 156, 146];
    assert.ok(chromaOf(GREEN_GREY) < 10, 'the hidden grey would count as a neutral if it were opaque');
    const layer = (x) => (x < 40 ? [...ROAD, 255] : x < 48 ? [...ROAD, 128] : [...GREEN_GREY, 0]);
    await writePng(ws, 'layer.png', STREET.w, STREET.h, layer, 'rgba');
    const { result, outputs } = await runTool(
      'image.grade',
      { images: [{ image: 'layer.png' }], steps: [{ op: 'balance' }] },
      { workspace: ws },
    );
    const [img] = result.images;
    const [, a, b] = labOf(ROAD);
    near(img.before.greys_a, a, 0.02, 'greys_a is the opaque grey alone');
    near(img.before.greys_b, b, 0.02, 'greys_b is the opaque grey alone');
    assert.equal(img.before.greys_pct, 100, 'every opaque pixel is a neutral');
    near(img.after.greys_a, 0, 0.6, 'greys_a after');
    near(img.after.greys_b, 0, 0.6, 'greys_b after');
    assert.deepEqual(img.skipped_steps, []);

    const src = await decode(path.join(ws, 'layer.png'), 'rgba');
    const out = await decode(outAbs(outputs, 'layer.png'), 'rgba');
    assert.equal(out.length, src.length);
    for (let i = 3; i < src.length; i += 4) assert.equal(out[i], src[i], `alpha of pixel ${(i - 3) / 4}`);
    assert.notDeepEqual(pixel(out, STREET.w, 10, 10, 4), [...ROAD, 255], 'the colour did move');
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: with no balance step, or one of no strength, the pixels stay', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'noise.png', 48, 32, noisy(23), 'rgba');
    const src = await decode(path.join(ws, 'noise.png'), 'rgba');
    for (const steps of [
      [],
      [{ op: 'balance', amount: 0 }],
      [{ op: 'balance', shift_ab: [0, 0] }],
      [{ op: 'balance', amount: 0, target_ab: [5, -5], min_pct: 100, protect: 'lights' }],
    ]) {
      const { result, outputs } = await runTool(
        'image.grade',
        { images: [{ image: 'noise.png' }], steps },
        { workspace: ws },
      );
      const what = JSON.stringify(steps);
      assert.ok(src.equals(await decode(outAbs(outputs, 'noise.png'), 'rgba')), `${what}: the pixels differ`);
      const [img] = result.images;
      assert.deepEqual(img.after, img.before, what);
      assert.deepEqual(img.skipped_steps, [], what);
      assert.deepEqual(result.warnings, [], what);
      for (const k of ['greys_a', 'greys_b', 'greys_pct'])
        assert.ok(k in img.before && k in img.after, `${what}: ${k}`);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('image.grade: balance validation names the bad field', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'street.png', STREET.w, STREET.h, street);
    const images = [{ image: 'street.png' }];
    const cases = [
      [[{ op: 'balance', amount: 1.5 }], /steps\[0\]\.amount must be from 0 to 1 for op "balance"/],
      [[{ op: 'balance', axis: 'red' }], /steps\[0\]\.axis is not a field of op "balance"/],
      [
        [{ op: 'balance', shift_ab: [1, 2], target_ab: [0, 0] }],
        /steps\[0\]\.target_ab cannot go with steps\[0\]\.shift_ab/,
      ],
      [[{ op: 'balance', shift_ab: [1, 2], min_pct: 3 }], /steps\[0\]\.min_pct cannot go with steps\[0\]\.shift_ab/],
      [[{ op: 'cast', axis: 'red', amount: 1, shift_ab: [1, 2] }], /steps\[0\]\.shift_ab is not a field of op "cast"/],
      [[{ op: 'balance', shift_ab: [1] }], /steps\/0\/shift_ab/],
      [[{ op: 'balance', min_pct: 101 }], /steps\/0\/min_pct/],
    ];
    for (const [steps, re] of cases) {
      const err = await invalidOf({ images, steps }, ws);
      assert.equal(err.type, 'invalid-input', `${JSON.stringify(steps)}: ${err.message}`);
      assert.match(err.message, re);
    }
  } finally {
    await rmTmp(ws);
  }
});
