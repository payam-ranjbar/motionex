import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const FEATURES = needs('ffmpeg');

/** Write a solid-colour PNG of the given size. */
async function solid(ws, rel, w, h, color) {
  const abs = path.join(ws, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${w}x${h}`,
    '-frames:v',
    '1',
    abs,
  ]);
  return rel;
}

/** Read an image's size from ffmpeg's stream line. */
async function sizeOf(abs) {
  try {
    await runFfmpeg(['-hide_banner', '-i', abs]);
  } catch (e) {
    const m = /, (\d{2,5})x(\d{2,5})/.exec(e?.detail ?? '');
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  throw new Error(`no size for ${abs}`);
}

test('image.contact-sheet: images of other shapes than the first fit their cells', FEATURES, async () => {
  const ws = await mkTmp();
  try {
    const images = [
      await solid(ws, 'a/wide.png', 320, 180, 'red'),
      await solid(ws, 'a/tall.png', 180, 320, 'green'),
      await solid(ws, 'a/square.png', 200, 200, 'blue'),
      await solid(ws, 'a/panorama.png', 400, 100, 'white'),
    ];
    const { result, outputs } = await runTool(
      'image.contact-sheet',
      { images, columns: 2, cell_width: 160, gap_px: 4 },
      { workspace: ws },
    );
    // Every cell is shaped like the first image: 160 wide, 90 high.
    assert.equal(result.cells, 4);
    assert.equal(result.width, 2 * 160 + 4);
    assert.equal(result.height, 2 * 90 + 4);
    const sheet = outputs.find((o) => o.name === 'sheet.png');
    assert.ok(sheet, 'sheet.png written');
    assert.deepEqual(await sizeOf(sheet.abs), { width: result.width, height: result.height });
  } finally {
    await rmTmp(ws);
  }
});
