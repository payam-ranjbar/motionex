import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

// A dark ground, a broad gaussian-blurred orange glow, and a sharp dark ring on top that traps glow in its hole.
// The ring is the "figure"; the glow inside the hole is the pocket the matte must clear.
async function makeRing(ws, rel) {
  const abs = path.join(ws, rel);
  await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0b0b12:s=256x256',
    '-f',
    'lavfi',
    '-i',
    'color=c=0xffb066:s=256x256',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x2a1408:s=256x256',
    '-filter_complex',
    [
      '[0]format=rgba[bg]',
      "[1]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-128,Y-128),170),255,0)',gblur=sigma=20[glow]",
      "[2]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(hypot(X-128,Y-128),62,92),255,0)'[ring]",
      '[bg][glow]overlay[g1]',
      '[g1][ring]overlay,format=rgb24[out]',
    ].join(';'),
    '-map',
    '[out]',
    '-frames:v',
    '1',
    abs,
  ]);
  return abs;
}

async function makeFlat(ws, rel) {
  const abs = path.join(ws, rel);
  await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x203040:s=64x64',
    '-frames:v',
    '1',
    abs,
  ]);
  return abs;
}

async function makeBig(ws, rel) {
  const abs = path.join(ws, rel);
  await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=5000x4000',
    '-frames:v',
    '1',
    abs,
  ]);
  return abs;
}

/** Decode a PNG to raw pixels. `pixFmt` is 'rgba' (4 bytes) or 'gray' (1 byte) per pixel. */
async function decode(file, pixFmt = 'rgba') {
  const { stdout } = await runFfmpeg(
    ['-hide_banner', '-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'],
    { stdout: 'buffer' },
  );
  assert.ok(stdout, `could not decode ${file}`);
  return stdout;
}

const alphaAt = (buf, x, y, w = 256) => buf[(y * w + x) * 4 + 3];
const outAbs = (outputs, name) => outputs.find((o) => o.name === name)?.abs;

const FEATURES = needs('ffmpeg', 'ffprobe');

test('image.matte: cuts the ring figure and clears the enclosed glow pocket', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await makeRing(ws, 'ring.png');
    const { result, outputs } = await runTool('image.matte', { image: 'ring.png' }, { workspace: ws });
    assert.deepEqual([result.width, result.height], [256, 256]);
    assert.ok(result.figure_pct > 2 && result.figure_pct < 98, `figure_pct ${result.figure_pct}`);
    assert.deepEqual(result.warnings, []);

    const pocket = result.pockets_cleared.find((p) => p.x >= 120 && p.x <= 136 && p.y >= 120 && p.y <= 136);
    assert.ok(pocket, `no pocket at the ring centre: ${JSON.stringify(result.pockets_cleared)}`);
    assert.ok(pocket.px >= 250, `pocket px ${pocket.px}`);
    assert.ok(pocket.mean_grad < 2.8, `pocket mean_grad ${pocket.mean_grad}`);
    assert.ok(pocket.dist < 60, `pocket dist ${pocket.dist}`);

    const matte = await decode(outAbs(outputs, 'matte.png'));
    // The ring is the figure: opaque.
    for (const [x, y] of [
      [128, 50],
      [128, 205],
      [50, 128],
      [205, 128],
    ]) {
      assert.equal(alphaAt(matte, x, y), 255, `ring pixel ${x},${y} should be opaque`);
    }
    // The outer glow is background: transparent.
    assert.equal(alphaAt(matte, 5, 5), 0, 'the outer glow should be transparent');
    assert.equal(alphaAt(matte, 128, 8), 0, 'the glow above the ring should be transparent');
    // The glow trapped inside the ring was cleared.
    assert.equal(alphaAt(matte, 128, 128), 0, 'the pocket inside the ring should be transparent');
  } finally {
    await rmTmp(ws);
  }
});

test('image.matte: pockets: false keeps the enclosed glow', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await makeRing(ws, 'ring.png');
    const { result, outputs } = await runTool('image.matte', { image: 'ring.png', pockets: false }, { workspace: ws });
    assert.deepEqual(result.pockets_cleared, []);
    assert.ok(result.figure_pct > 35, `figure_pct ${result.figure_pct} should include the kept pocket`);
    const matte = await decode(outAbs(outputs, 'matte.png'));
    assert.equal(alphaAt(matte, 128, 128), 255, 'the pocket should stay opaque when clearance is off');
  } finally {
    await rmTmp(ws);
  }
});

test('image.matte: mask: true writes mask.png', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await makeRing(ws, 'ring.png');
    const { outputs } = await runTool('image.matte', { image: 'ring.png', mask: true }, { workspace: ws });
    const maskAbs = outAbs(outputs, 'mask.png');
    assert.ok(maskAbs, `expected mask.png, got ${outputs.map((o) => o.name).join(', ')}`);
    const mask = await decode(maskAbs, 'gray');
    assert.equal(mask[128 * 256 + 128], 0, 'the cleared pocket should be black in the mask');
    assert.ok(mask[50 * 256 + 128] > 200, 'the ring should be white in the mask');
    assert.ok(mask[5 * 256 + 5] < 20, 'the outer glow should be black in the mask');
  } finally {
    await rmTmp(ws);
  }
});

test('image.matte: a flat image warns that nothing was cut', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await makeFlat(ws, 'flat.png');
    const { result } = await runTool('image.matte', { image: 'flat.png' }, { workspace: ws });
    assert.ok(result.figure_pct < 2, `figure_pct ${result.figure_pct}`);
    assert.ok(result.warnings.length >= 1, 'expected a warning');
    assert.match(result.warnings.join(' '), /nothing was cut/);
  } finally {
    await rmTmp(ws);
  }
});

test('image.matte: images over 16 megapixels are invalid-input', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    await makeBig(ws, 'big.png');
    const err = await runTool('image.matte', { image: 'big.png' }, { workspace: ws }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'expected an error');
    assert.equal(err.type, 'invalid-input');
    assert.match(err.message, /megapixels/);
  } finally {
    await rmTmp(ws);
  }
});
