// sfx.synth: the built-in generic recipes, recipe loading from the workspace, palette use and error paths.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { readWav } from '../../src/lib/wav.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const GENERIC = ['rain_bed', 'glitch_cut', 'glitch_micro', 'whoosh_by', 'swish', 'thump', 'burst', 'ui_blip'];

/** Absolute sample peak in dBFS (floor -240, like signal.db). */
function peakDb(audio) {
  let p = 0;
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return 20 * Math.log10(Math.max(p, 1e-12));
}

/** Absolute mean (DC) over every sample and channel. */
function meanAbs(audio) {
  let s = 0;
  let n = 0;
  for (const ch of audio.channels)
    for (let i = 0; i < ch.length; i++) {
      s += ch[i];
      n++;
    }
  return n ? Math.abs(s / n) : 0;
}

test('every generic sound renders, normalised and DC-free', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    const run = await runTool('sfx.synth', { builtin: 'generic' }, { workspace: ws, timeoutMs: 120_000 });
    assert.deepEqual(
      run.result.sounds.map((s) => s.name).sort(),
      [...GENERIC].sort(),
      'default renders every exported sound',
    );
    const names = new Set(run.outputs.map((o) => o.name));
    for (const name of GENERIC) assert.ok(names.has(`${name}.wav`), `missing output ${name}.wav`);
    assert.ok(names.has('sounds.json'), 'missing sounds.json');

    for (const s of run.result.sounds) {
      const audio = readWav(await readFile(path.join(run.outDir, s.file)));
      assert.ok(audio.channels.length === 2, `${s.name}: stereo`);
      assert.ok(audio.channels[0].length > 0, `${s.name}: non-empty`);
      assert.ok(s.seconds > 0, `${s.name}: positive seconds`);
      const db = peakDb(audio);
      assert.ok(Math.abs(db - -1) <= 0.05, `${s.name}: peak ${db.toFixed(3)} dBFS (want -1 +/- 0.05)`);
      const dc = meanAbs(audio);
      assert.ok(dc < 1e-3, `${s.name}: DC ${dc} (want < 1e-3)`);
      assert.ok(Number.isFinite(s.peak_db) && Math.abs(s.peak_db - -1) <= 0.06, `${s.name}: reported peak`);
      assert.ok(Number.isFinite(s.rms_db), `${s.name}: rms_db`);
      assert.ok(Number.isFinite(s.peak_at_s) && s.peak_at_s >= 0, `${s.name}: peak_at_s`);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('same seed is identical; a different seed changes a random sound', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    const a = await runTool('sfx.synth', { builtin: 'generic', sounds: ['thump'], seed: 7 }, { workspace: ws });
    const b = await runTool('sfx.synth', { builtin: 'generic', sounds: ['thump'], seed: 7 }, { workspace: ws });
    assert.deepEqual(
      await readFile(path.join(a.outDir, 'thump.wav')),
      await readFile(path.join(b.outDir, 'thump.wav')),
      'the same seed must give identical bytes',
    );

    const c = await runTool(
      'sfx.synth',
      { builtin: 'generic', sounds: ['rain_bed'], seed: 1, params: { rain_bed: { seconds: 1 } } },
      { workspace: ws },
    );
    const d = await runTool(
      'sfx.synth',
      { builtin: 'generic', sounds: ['rain_bed'], seed: 2, params: { rain_bed: { seconds: 1 } } },
      { workspace: ws },
    );
    assert.notDeepEqual(
      await readFile(path.join(c.outDir, 'rain_bed.wav')),
      await readFile(path.join(d.outDir, 'rain_bed.wav')),
      'a different seed must change a randomised sound',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('a workspace recipe writes two WAVs and a described sounds.json', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    const recipe = [
      'export const sounds = {',
      '  alpha: (kit) => kit.st(kit.osc(0.1, 440)),',
      '  beta: (kit, p) => kit.st(kit.osc(p.seconds ?? 0.2, 660)),',
      '};',
      "export const describe = { alpha: 'first tone', beta: 'second tone' };",
      '',
    ].join('\n');
    await writeFixture(ws, 'sfx/two.mjs', { text: recipe });
    const run = await runTool(
      'sfx.synth',
      { recipe: 'sfx/two.mjs', params: { beta: { seconds: 0.25 } } },
      { workspace: ws },
    );
    assert.deepEqual(run.outputs.map((o) => o.name).sort(), ['alpha.wav', 'beta.wav', 'sounds.json']);
    const manifest = JSON.parse(await readFile(path.join(run.outDir, 'sounds.json'), 'utf8'));
    assert.equal(manifest.length, 2);
    assert.deepEqual(
      manifest.map((s) => s.description),
      ['first tone', 'second tone'],
    );
    assert.equal(run.result.sounds[1].file, 'beta.wav');
  } finally {
    await rmTmp(ws);
  }
});

test('a recipe finish override sets the peak; the request overrides it', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    await writeFixture(ws, 'sfx/fin.mjs', {
      text: [
        'export const sounds = { quiet: (kit) => kit.st(kit.osc(0.2, 440)) };',
        'export const finish = { quiet: { peak_db: -6 } };',
        '',
      ].join('\n'),
    });
    const run = await runTool('sfx.synth', { recipe: 'sfx/fin.mjs' }, { workspace: ws });
    const audio = readWav(await readFile(path.join(run.outDir, 'quiet.wav')));
    assert.ok(Math.abs(peakDb(audio) - -6) <= 0.05, `recipe finish peak ${peakDb(audio)}`);

    const overridden = await runTool(
      'sfx.synth',
      { recipe: 'sfx/fin.mjs', finish: { peak_db: -3 } },
      { workspace: ws },
    );
    const audio2 = readWav(await readFile(path.join(overridden.outDir, 'quiet.wav')));
    assert.ok(Math.abs(peakDb(audio2) - -3) <= 0.05, `request finish peak ${peakDb(audio2)}`);
  } finally {
    await rmTmp(ws);
  }
});

test('palette slices work; a missing palette name is invalid-input', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    await writeFixture(ws, 'tone.wav', { sine: { freq: 440, seconds: 1 } });
    await writeFixture(ws, 'sfx/pal.mjs', {
      text: "export const sounds = { tone: (kit) => kit.pal('tone', 0, 1) };\n",
    });

    const run = await runTool('sfx.synth', { recipe: 'sfx/pal.mjs', palette: { tone: 'tone.wav' } }, { workspace: ws });
    assert.equal(run.result.sounds[0].name, 'tone');
    const audio = readWav(await readFile(path.join(run.outDir, 'tone.wav')));
    assert.ok(audio.channels[0].length > 0);

    await assert.rejects(
      () => runTool('sfx.synth', { recipe: 'sfx/pal.mjs', palette: { other: 'tone.wav' } }, { workspace: ws }),
      (e) => {
        assert.equal(e.type, 'invalid-input');
        assert.match(e.message, /no palette entry "tone"/);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});

test('an unknown sound name is invalid-input listing the available names', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    await assert.rejects(
      () => runTool('sfx.synth', { builtin: 'generic', sounds: ['nope'] }, { workspace: ws }),
      (e) => {
        assert.equal(e.type, 'invalid-input');
        assert.match(e.message, /unknown sound "nope"/);
        assert.match(e.message, /thump/);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});

test('a recipe returning NaN samples is tool-failed', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-sfx-');
  try {
    await writeFixture(ws, 'sfx/nan.mjs', {
      text: 'export const sounds = { bad: () => [Float32Array.from([0, NaN, 0]), new Float32Array(3)] };\n',
    });
    await assert.rejects(
      () => runTool('sfx.synth', { recipe: 'sfx/nan.mjs' }, { workspace: ws }),
      (e) => {
        assert.equal(e.type, 'tool-failed');
        assert.match(e.message, /non-finite/);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});

// Found by the headful agent test: `thump: {freq: 52, decay_s: 0.75}` was silently ignored (thump takes seconds, pitch).
test('sfx.synth warns about params a built-in sound does not accept', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool(
      'sfx.synth',
      { builtin: 'generic', sounds: ['thump'], params: { thump: { freq: 52, pitch: 0.8 } } },
      { workspace: ws },
    );
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /thump: unknown params freq .*accepted: seconds, pitch/);
  } finally {
    await rmTmp(ws);
  }
});
