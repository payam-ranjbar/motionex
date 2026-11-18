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
