// music.render: renders Strudel songs with the vendored Mucavex engine. Split by behaviour so a failure
// points at one thing. Everything gates on ffmpeg because the tool is unavailable without it (the manifest
// requires it); the sample test additionally needs a warm sample cache.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mono, rmsDb } from '../../src/lib/signal.mjs';
import { readWav } from '../../src/lib/wav.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const peakOf = (audio) => Math.max(...audio.channels.map((ch) => ch.reduce((m, s) => Math.max(m, Math.abs(s)), 0)));

/** Read a written output back as planar audio. */
async function readOutput(run, name) {
  const output = run.outputs.find((o) => o.name === name);
  assert.ok(output, `expected output "${name}", got ${run.outputs.map((o) => o.name).join(', ')}`);
  return { output, audio: readWav(await readFile(output.abs)) };
}

test('music.render: sawtooth triad renders 48 kHz stereo WAV with signal', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: 'note("c3 e3 g3").s("sawtooth")', cycles: 2, offline: true },
      { workspace: ws },
    );
    const { audio } = await readOutput(run, 'music.wav');
    assert.equal(audio.sampleRate, 48000);
    assert.equal(audio.channels.length, 2);
    assert.ok(peakOf(audio) > 0.05, `peak ${peakOf(audio)} should be above 0.05`);
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: bpm 120 means cps 0.5 and 2 cycles are 4 s', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool(
      'music.render',
      { code: 'note("c3 e3 g3").s("sawtooth").lpf(800)', cycles: 2, bpm: 120, offline: true },
      { workspace: ws },
    );
    assert.equal(result.cps, 0.5);
    assert.ok(Math.abs(result.seconds - 4) <= 0.01, `seconds ${result.seconds} should be 4`);
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: markers rewrite the first matching declaration line', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const code = '// theme\nlet DROP = 2;\nnote("c3 e3 g3").s("sawtooth")';
    const run = await runTool(
      'music.render',
      { code, markers: { DROP: 5 }, cycles: 1, offline: true },
      { workspace: ws },
    );
    const songOutput = run.outputs.find((o) => o.name === 'song.strudel');
    assert.ok(songOutput, 'song.strudel written');
    assert.match(await readFile(songOutput.abs, 'utf8'), /let DROP = 5;/);
    assert.deepEqual(run.result.markers_applied, [{ name: 'DROP', value: 5, line: 2 }]);
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: a missing marker is invalid-input and lists the markers found', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const code = 'let DROP = 2;\nlet HUNT = 4;\nnote("c3").s("sine")';
    await assert.rejects(
      runTool('music.render', { code, markers: { NOPE: 1 }, cycles: 1, offline: true }, { workspace: ws }),
      (err) => {
        assert.equal(err.type, 'invalid-input');
        assert.match(err.detail, /NOPE/);
        assert.match(err.detail, /DROP, HUNT/);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: a syntax error is invalid-input', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await assert.rejects(
      runTool('music.render', { code: 'note("c3"', cycles: 1, offline: true }, { workspace: ws }),
      (err) => {
        assert.equal(err.type, 'invalid-input');
        assert.match(err.detail, /does not parse/i);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: max_polyphony reaches the engine (voice stealing shrinks the tail)', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  const rmsTail = (audio) => {
    const m = mono(audio);
    return rmsDb(m, Math.floor(m.length / 2), m.length);
  };
  try {
    // Each event is held for a whole cycle (legato 64), so at any instant ~64 voices overlap. With only
    // 16 voices superdough steals and fades the older ones, so the tail loses energy; 4096 keeps them all.
    // Different pitches avoid the phase cancellation a single repeated pitch would produce. Metered here:
    // ~5.7 dB more tail RMS at 4096, no clipping. This is the voice-stealing bug `max_polyphony` fixes.
    const code = 'note("<c3 e3 g3 b3>*16").s("sawtooth").legato(64).sustain(1).gain(0.15)';
    const low = await runTool('music.render', { code, cycles: 2, max_polyphony: 16, offline: true }, { workspace: ws });
    const high = await runTool(
      'music.render',
      { code, cycles: 2, max_polyphony: 4096, offline: true },
      { workspace: ws },
    );
    const lowAudio = await readOutput(low, 'music.wav');
    const highAudio = await readOutput(high, 'music.wav');
    const delta = rmsTail(highAudio.audio) - rmsTail(lowAudio.audio);
    assert.ok(delta > 3, `4096 should be > 3 dB louder in the tail (got ${delta.toFixed(2)} dB)`);
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: the same seed is byte-identical, another seed differs', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const code = 's("white").gain(0.3)';
    const a = await runTool('music.render', { code, cycles: 1, seed: 7, offline: true }, { workspace: ws });
    const b = await runTool('music.render', { code, cycles: 1, seed: 7, offline: true }, { workspace: ws });
    const c = await runTool('music.render', { code, cycles: 1, seed: 8, offline: true }, { workspace: ws });
    const bytes = async (run) => readFile(run.outputs.find((o) => o.name === 'music.wav').abs);
    const [ba, bb, bc] = await Promise.all([bytes(a), bytes(b), bytes(c)]);
    assert.deepEqual(ba, bb, 'seed 7 should render identical bytes');
    assert.notDeepEqual(ba, bc, 'seed 8 should render different bytes');
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: a drum bank loads from the warm sample cache', needs('ffmpeg', 'samples'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: 's("bd sd").bank("RolandTR909")', cycles: 2, offline: true },
      { workspace: ws },
    );
    const { audio } = await readOutput(run, 'music.wav');
    assert.ok(peakOf(audio) > 0.01, `peak ${peakOf(audio)} should be above 0.01`);
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: format mp3 writes music.mp3', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: 'note("c3").s("sine")', cycles: 1, format: 'mp3', offline: true },
      { workspace: ws },
    );
    assert.ok(
      run.outputs.some((o) => o.name === 'music.mp3'),
      'music.mp3 written',
    );
    const bytes = await readFile(run.outputs.find((o) => o.name === 'music.mp3').abs);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1] & 0xe0, 0xe0);
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: user console.log noise does not break the result', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: 'console.log("hello from strudel"); note("c3").s("sine")', cycles: 1, offline: true },
      { workspace: ws },
    );
    // The engine writes chatty progress/log lines to stdout; node-host reads results over IPC, so they
    // must not break the job. `console.log` in user code goes through Strudel's logger, not raw stdout.
    assert.ok(run.result.seconds > 0);
    assert.match(run.log, /strudel|superdough/i);
  } finally {
    await rmTmp(ws);
  }
});

// Found by the headful agent test: it passed `name: "music.wav"` (other tools take a name) and got a 422.
test('music.render: an optional name sets the output file, extension follows format', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const base = { code: 'note("c3").s("sine")', cycles: 1, offline: true };
    const a = await runTool('music.render', { ...base, name: 'score', format: 'mp3' }, { workspace: ws });
    assert.ok(
      a.outputs.some((o) => o.name === 'score.mp3'),
      a.outputs.map((o) => o.name).join(','),
    );
    const b = await runTool('music.render', { ...base, name: 'theme.wav' }, { workspace: ws });
    assert.ok(
      b.outputs.some((o) => o.name === 'theme.wav'),
      b.outputs.map((o) => o.name).join(','),
    );
    const c = await runTool('music.render', base, { workspace: ws });
    assert.ok(c.outputs.some((o) => o.name === 'music.wav'));
  } finally {
    await rmTmp(ws);
  }
});
