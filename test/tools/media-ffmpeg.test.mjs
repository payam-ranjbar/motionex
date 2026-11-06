import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { peak } from '../../src/lib/signal.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { getRegistry, runTool, testConfig } from '../helpers/tool-harness.mjs';

const SINE = { sine: { freq: 1000, seconds: 2, amplitude_db: -20 } };

/** Write a solid-colour PNG with ffmpeg. */
async function writePng(ws, rel, color, width = 320, height = 180) {
  const abs = path.join(ws, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${width}x${height}`,
    '-frames:v',
    '1',
    abs,
  ]);
}

test('media.ffmpeg: registry collects refs inside additionalProperties', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const registry = await getRegistry(testConfig(ws));
    const v = registry.validate('media.ffmpeg', {
      args: ['-i', '{in:a}', '{out:o.wav}'],
      inputs: { a: 'tone.wav' },
      outputs: ['o.wav'],
    });
    assert.ok(v.ok, v.errors?.map((e) => `${e.field} ${e.message}`).join('; '));
    assert.deepStrictEqual(v.refPointers, ['/inputs/a']);
  } finally {
    await rmTmp(ws);
  }
});

test('media.ffmpeg: volume=-3dB example writes quiet.wav at -3 dB', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', SINE);
    const { result, outDir } = await runTool(
      'media.ffmpeg',
      {
        args: ['-i', '{in:a}', '-af', 'volume=-3dB', '{out:quiet.wav}'],
        inputs: { a: 'tone.wav' },
        outputs: ['quiet.wav'],
      },
      { workspace: ws },
    );
    assert.deepStrictEqual(
      result.outputs.map((o) => o.name),
      ['quiet.wav'],
    );
    assert.ok(result.outputs[0].bytes > 0);
    const original = await decodeAudio(path.join(ws, 'tone.wav'), { sampleRate: 48000, channels: 2 });
    const quiet = await decodeAudio(path.join(outDir, 'quiet.wav'), { sampleRate: 48000, channels: 2 });
    const ratio = peak(quiet) / peak(original);
    assert.ok(Math.abs(ratio - 10 ** (-3 / 20)) < 0.02, `peak ratio ${ratio} is not -3 dB`);
  } finally {
    await rmTmp(ws);
  }
});

test('media.ffmpeg: an argument with .. is refused', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', SINE);
    await assert.rejects(
      runTool('media.ffmpeg', { args: ['-i', '../x.wav', '{out:o.wav}'], outputs: ['o.wav'] }, { workspace: ws }),
      (e) => e.type === 'invalid-input',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('media.ffmpeg: absolute paths are refused', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    for (const abs of ['C:/x.wav', '/etc/x']) {
      await assert.rejects(
        runTool('media.ffmpeg', { args: ['-i', abs, '{out:o.wav}'], outputs: ['o.wav'] }, { workspace: ws }),
        (e) => e.type === 'invalid-input',
        `expected ${abs} to be refused`,
      );
    }
  } finally {
    await rmTmp(ws);
  }
});

test('media.ffmpeg: file-reading filters are refused', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', SINE);
    await assert.rejects(
      runTool(
        'media.ffmpeg',
        {
          args: ['-i', '{in:a}', '-af', 'amovie=x', '{out:o.wav}'],
          inputs: { a: 'tone.wav' },
          outputs: ['o.wav'],
        },
        { workspace: ws },
      ),
      (e) => e.type === 'invalid-input',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('media.ffmpeg: a declared output that is never written fails clearly', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', SINE);
    await assert.rejects(
      runTool(
        'media.ffmpeg',
        {
          args: ['-i', '{in:a}', '-af', 'volume=-3dB', '{out:quiet.wav}'],
          inputs: { a: 'tone.wav' },
          outputs: ['quiet.wav', 'missing.wav'],
        },
        { workspace: ws },
      ),
      (e) => (e.type === 'tool-failed' || e.type === 'invalid-input') && /missing\.wav/.test(e.message),
    );
  } finally {
    await rmTmp(ws);
  }
});

test('media.ffmpeg: a filter_complex_script mixes two inputs', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'a.wav', { sine: { freq: 440, seconds: 1, amplitude_db: -20 } });
    await writeFixture(ws, 'b.wav', { sine: { freq: 880, seconds: 1, amplitude_db: -20 } });
    const { result } = await runTool(
      'media.ffmpeg',
      {
        args: [
          '-i',
          '{in:a}',
          '-i',
          '{in:b}',
          '-filter_complex_script',
          '{script:fc}',
          '-map',
          '[out]',
          '{out:mix.wav}',
        ],
        inputs: { a: 'a.wav', b: 'b.wav' },
        outputs: ['mix.wav'],
        scripts: { fc: '[0:a][1:a]amix=inputs=2:duration=longest[out]' },
      },
      { workspace: ws },
    );
    assert.deepStrictEqual(
      result.outputs.map((o) => o.name),
      ['mix.wav'],
    );
    assert.ok(result.outputs[0].bytes > 0);
  } finally {
    await rmTmp(ws);
  }
});

test('image.contact-sheet: six images in three columns gives width 496 and two rows', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const colours = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta'];
    for (let i = 0; i < colours.length; i++) await writePng(ws, `img${i}.png`, colours[i]);
    const { result, outputs } = await runTool(
      'image.contact-sheet',
      { images: colours.map((_c, i) => `img${i}.png`), columns: 3, cell_width: 160, gap_px: 8 },
      { workspace: ws },
    );
    assert.equal(result.width, 3 * 160 + 2 * 8);
    assert.equal(result.height, 2 * 90 + 1 * 8);
    assert.equal(result.cells, 6);
    assert.equal(result.columns, 3);
    assert.equal(result.rows, 2);
    assert.ok(
      outputs.some((o) => o.name === 'sheet.png'),
      'sheet.png was not written',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('image.contact-sheet: a single image still works', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writePng(ws, 'one.png', 'red');
    const { result, outputs } = await runTool(
      'image.contact-sheet',
      { images: ['one.png'], cell_width: 160 },
      { workspace: ws },
    );
    assert.equal(result.cells, 1);
    assert.equal(result.rows, 1);
    assert.equal(result.width, 160);
    assert.equal(result.height, 90);
    assert.ok(
      outputs.some((o) => o.name === 'sheet.png'),
      'sheet.png was not written',
    );
  } finally {
    await rmTmp(ws);
  }
});

test(
  'image.contact-sheet: labels "auto" runs (warning allowed when drawtext is missing)',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      await writePng(ws, 'a.png', 'red');
      await writePng(ws, 'b.png', 'green');
      const { result, outputs } = await runTool(
        'image.contact-sheet',
        { images: ['a.png', 'b.png'], columns: 2, cell_width: 160, labels: 'auto' },
        { workspace: ws },
      );
      assert.ok(Array.isArray(result.warnings));
      assert.ok(
        outputs.some((o) => o.name === 'sheet.png'),
        'sheet.png was not written',
      );
    } finally {
      await rmTmp(ws);
    }
  },
);
