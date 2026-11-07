// music.render: renders Strudel songs with the vendored Mucavex engine. Split by behaviour so a failure
// points at one thing. Everything gates on ffmpeg because the tool is unavailable without it (the manifest
// requires it); the sample test additionally needs a warm sample cache.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fromDb, mono, rmsDb } from '../../src/lib/signal.mjs';
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

// The VCSL darbuka WAVs have a 20-byte `fmt ` chunk that node-web-audio-api rejects ("malformed fmt_pcm chunk");
// the fallback transcodes them through ffmpeg, so the events are audible and the warning names the file.
test('music.render: a sample the decoder rejects is transcoded, not silent', needs('ffmpeg', 'samples'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool('music.render', { code: 's("darbuka*4")', cycles: 2, offline: true }, { workspace: ws });
    const { audio } = await readOutput(run, 'music.wav');
    assert.ok(peakOf(audio) > fromDb(-40), `peak ${peakOf(audio)} should be above -40 dBFS`);
    const transcode = run.result.warnings.filter((w) => /decoded through ffmpeg/.test(w));
    assert.equal(transcode.length, 1, JSON.stringify(run.result.warnings));
    assert.match(transcode[0], /Darbuka/i);
    assert.ok(
      !run.result.warnings.some((w) => /event\(s\) skipped/.test(w)),
      `no sample should be skipped: ${JSON.stringify(run.result.warnings)}`,
    );
  } finally {
    await rmTmp(ws);
  }
});

// The analyzer counts the silent render tail as "silent cycles"; the handler reports only cycles inside the song.
test('music.render: tail-only silence does not warn about silent cycles', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: 'note("c3").s("sawtooth")', cycles: 2, tail_s: 2, offline: true },
      { workspace: ws },
    );
    const warnings = [...run.result.warnings, ...(run.result.analysis?.warnings ?? [])];
    assert.deepEqual(
      warnings.filter((w) => /silent cycles/.test(w)),
      [],
      JSON.stringify(run.result.analysis?.warnings),
    );
    // The song itself is audible, so the missing warning is not just a fully silent render.
    assert.ok(run.result.peak_db > -40, `peak_db ${run.result.peak_db} should show signal`);
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

// Agents cannot hear a missing part: an unknown sound name must come back as a warning, not silence.
test('music.render: unknown sound names are reported as warnings', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool(
      'music.render',
      { code: '$: note("c3 e3").s("sawtooth")\n$: s("definitely_not_a_sound*4")', cycles: 1, offline: true },
      { workspace: ws },
    );
    assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings));
    assert.match(result.warnings[0], /4 event\(s\) skipped.*definitely_not_a_sound/);
    const ok = await runTool(
      'music.render',
      { code: 'note("c3").s("sine")', cycles: 1, offline: true },
      { workspace: ws },
    );
    assert.deepEqual(ok.result.warnings, []);
  } finally {
    await rmTmp(ws);
  }
});

// Two agents shipped renders peaking at +4.7 and +1.2 dBFS: the integer encoders clamp that silently, and the
// result only said so when `analyze` was on. The peak is now always measured, the clamp is warned about, and
// `peak_db` scales the whole render before encoding.
const dbOf = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const HOT = { code: 'note("c3 e3 g3").s("sine").gain(3)', cycles: 1, offline: true };
const CLIP_WARNING =
  /^the render peaks at \+[\d.]+ dBFS; \d+ samples clip in wav: lower \.gain\(\)\/\.postgain\(\), or set peak_db \(or use format wav32, which keeps overs\)$/;

test('music.render: an over-hot render reports peak_db and warns about the clamp', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool('music.render', HOT, { workspace: ws });
    assert.ok(run.result.peak_db > 0, `peak_db ${run.result.peak_db} should be above 0 dBFS`);
    assert.equal(run.result.gain_db_applied, null, 'nothing was scaled');
    const clipWarnings = run.result.warnings.filter((w) => /samples clip in/.test(w));
    assert.equal(clipWarnings.length, 1, JSON.stringify(run.result.warnings));
    assert.match(clipWarnings[0], CLIP_WARNING);
    assert.ok(run.result.analysis.clippedSamples > 0, 'analyze agrees that samples clipped');
    // The 16-bit file really is clamped, so the warning is not cosmetic.
    const { audio } = await readOutput(run, 'music.wav');
    assert.ok(peakOf(audio) > 0.99, `the written peak is clamped, got ${peakOf(audio)}`);

    // wav32 keeps the overs, so the same song gets no clip warning there.
    const wide = await runTool('music.render', { ...HOT, format: 'wav32' }, { workspace: ws });
    assert.ok(wide.result.peak_db > 0);
    assert.ok(!wide.result.warnings.some((w) => /samples clip in/.test(w)), JSON.stringify(wide.result.warnings));
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: peak_db scales the render before encoding, so nothing clips', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool('music.render', { ...HOT, peak_db: -1 }, { workspace: ws });
    const { audio } = await readOutput(run, 'music.wav');
    const written = dbOf(peakOf(audio));
    assert.ok(Math.abs(written + 1) < 0.1, `the written WAV should peak at -1 dBFS, got ${written.toFixed(2)}`);
    assert.ok(Math.abs(run.result.peak_db + 1) < 0.05, `peak_db ${run.result.peak_db} should be -1`);
    assert.ok(run.result.gain_db_applied < 0, `gain_db_applied ${run.result.gain_db_applied} should be negative`);
    assert.ok(!run.result.warnings.some((w) => /samples clip in/.test(w)), JSON.stringify(run.result.warnings));
    // The analysis measures the same (scaled) render, so it agrees with peak_db.
    assert.ok(Math.abs(run.result.analysis.peakDb + 1) < 0.1, `analysis peak ${run.result.analysis.peakDb}`);
    // A silent render has no peak to scale, so it is left alone and says so.
    const silent = await runTool(
      'music.render',
      { code: 'note("c3 e3").s("sine").gain(0)', cycles: 1, offline: true, peak_db: -1 },
      { workspace: ws },
    );
    assert.equal(silent.result.peak_db, null);
    assert.equal(silent.result.gain_db_applied, null);
    assert.ok(
      silent.result.warnings.some((w) => /render is silent, so peak_db/.test(w)),
      JSON.stringify(silent.result.warnings),
    );
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: a quiet render is untouched (no scaling, same bytes)', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  const bytesOf = async (run) => readFile(run.outputs.find((o) => o.name === 'music.wav').abs);
  try {
    const quiet = { code: 'note("c3 e3 g3").s("sine").gain(0.2)', cycles: 1, offline: true };
    const a = await runTool('music.render', quiet, { workspace: ws });
    assert.ok(a.result.peak_db < 0, `peak_db ${a.result.peak_db} should be below 0 dBFS`);
    assert.equal(a.result.gain_db_applied, null, 'no peak_db means no gain');
    assert.deepEqual(a.result.warnings, [], 'a quiet render warns about nothing');
    // The measured peak is the written file's peak: the samples were not scaled on the way out.
    const { audio } = await readOutput(a, 'music.wav');
    assert.ok(Math.abs(dbOf(peakOf(audio)) - a.result.peak_db) < 0.01);
    // Untouched means the bytes are exactly what the encoder receives, so a repeat run is identical.
    const b = await runTool('music.render', quiet, { workspace: ws });
    assert.deepEqual(await bytesOf(a), await bytesOf(b), 'the untouched render is byte-identical');
    // Only peak_db changes the bytes.
    const scaled = await runTool('music.render', { ...quiet, peak_db: -1 }, { workspace: ws });
    assert.notDeepEqual(await bytesOf(a), await bytesOf(scaled));
  } finally {
    await rmTmp(ws);
  }
});
