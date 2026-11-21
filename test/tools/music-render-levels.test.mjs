// music.render: how loud each part of the render is (`levels`, and `rms_db` on markers_found), and the warning for a
// render that sits at one level. A render once succeeded as two bars of music and then one stuck tone, and nothing
// in the result showed it. Synth-only songs, offline, so no sample is needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mono, rmsDb } from '../../src/lib/signal.mjs';
import { readWav } from '../../src/lib/wav.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const FLAT_WARNING = /^(\d+) of (\d+) cycles sit within 1 dB of each other, around (-[\d.]+) dBFS: /;
const flatWarnings = (result) => result.warnings.filter((w) => /sit within 1 dB of each other/.test(w));

/** RMS in dBFS of seconds [from_s, to_s) of the written music.wav, measured the way the tool says it measures. */
async function writtenRms(run, from_s, to_s) {
  const audio = readWav(await readFile(run.outputs.find((o) => o.name === 'music.wav').abs));
  return rmsDb(mono(audio), Math.round(from_s * audio.sampleRate), Math.round(to_s * audio.sampleRate));
}

test(
  'music.render: levels has one row per cycle of the song, measured on the written file',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      // 120 bpm, 4 beats per cycle: one cycle is 2 s. The 1 s tail is not part of the song, so it gets no row.
      const run = await runTool(
        'music.render',
        { code: 'note("c3 e3 g3 e3").s("sawtooth").lpf(900).gain(0.3)', cycles: 3, bpm: 120, tail_s: 1, offline: true },
        { workspace: ws },
      );
      const { levels } = run.result;
      assert.equal(run.result.seconds, 7);
      assert.deepEqual(
        levels.map(({ cycle, at_s, to_s }) => ({ cycle, at_s, to_s })),
        [
          { cycle: 0, at_s: 0, to_s: 2 },
          { cycle: 1, at_s: 2, to_s: 4 },
          { cycle: 2, at_s: 4, to_s: 6 },
        ],
      );
      for (const row of levels) {
        assert.deepEqual(Object.keys(row), ['cycle', 'at_s', 'to_s', 'rms_db']);
        assert.ok(row.rms_db < run.result.peak_db && row.rms_db > -40, `sane level, got ${JSON.stringify(row)}`);
        const written = await writtenRms(run, row.at_s, row.to_s);
        assert.ok(Math.abs(row.rms_db - written) < 0.05, `cycle ${row.cycle}: ${row.rms_db} vs file ${written}`);
      }
      // Three rows are too few to call anything flat, although the cycles are alike.
      assert.deepEqual(run.result.warnings, []);

      // peak_db scales the file, and the levels are of the file: every row moves by the gain.
      const scaled = await runTool(
        'music.render',
        {
          code: 'note("c3 e3 g3 e3").s("sawtooth").lpf(900).gain(0.3)',
          cycles: 3,
          bpm: 120,
          peak_db: -1,
          offline: true,
        },
        { workspace: ws },
      );
      for (const [i, row] of scaled.result.levels.entries()) {
        const moved = row.rms_db - levels[i].rms_db;
        assert.ok(Math.abs(moved - scaled.result.gain_db_applied) < 0.05, `row ${i} moved ${moved.toFixed(2)} dB`);
      }
    } finally {
      await rmTmp(ws);
    }
  },
);

test('music.render: a song that ends inside a cycle gets a shorter last row', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: 'note("c3*4").s("sine").gain(0.3)', seconds: 2.5, cps: 1, offline: true },
      { workspace: ws },
    );
    assert.deepEqual(
      run.result.levels.map(({ cycle, at_s, to_s }) => ({ cycle, at_s, to_s })),
      [
        { cycle: 0, at_s: 0, to_s: 1 },
        { cycle: 1, at_s: 1, to_s: 2 },
        { cycle: 2, at_s: 2, to_s: 2.5 },
      ],
    );
  } finally {
    await rmTmp(ws);
  }
});

test(
  'music.render: loud cycles and silent cycles show in levels and in the markers rms_db',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      // Cycles 0-1 play, 2-3 are silent, 4-5 play again more quietly. GONE is past the end of the song.
      const code = [
        'let INTRO = 0;',
        'let BREAK = 2;',
        'let BACK = BREAK + 2;',
        'let GONE = 6;',
        'note("c3*8").s("sine").decay(0.05).sustain(0).gain("<0.5 0.5 0 0 0.1 0.1>")',
      ].join('\n');
      const run = await runTool('music.render', { code, cycles: 6, cps: 1, offline: true }, { workspace: ws });
      const levels = run.result.levels.map((row) => row.rms_db);
      assert.equal(levels.length, 6);
      assert.ok(levels[0] > -40 && levels[1] > -40, `cycles 0-1 sound: ${levels}`);
      assert.deepEqual(levels.slice(2, 4), [null, null], `cycles 2-3 are digital silence: ${levels}`);
      assert.ok(levels[4] > -60 && levels[5] > -60, `cycles 4-5 sound: ${levels}`);
      assert.ok(levels[0] - levels[4] > 10, `the last part is much quieter: ${levels}`);

      const marker = Object.fromEntries(run.result.markers_found.map((m) => [m.name, m]));
      assert.ok(Math.abs(marker.INTRO.rms_db - (await writtenRms(run, 0, 2))) < 0.05, JSON.stringify(marker.INTRO));
      assert.equal(marker.BREAK.rms_db, null, 'the break is silent from its marker to the next');
      assert.ok(Math.abs(marker.BACK.rms_db - (await writtenRms(run, 4, 6))) < 0.05, JSON.stringify(marker.BACK));
      assert.ok(marker.INTRO.rms_db - marker.BACK.rms_db > 10, 'the sections differ as the cycles do');
      // Nothing of the song lies after GONE, so there is nothing to measure: the field is absent, not null.
      assert.equal('rms_db' in marker.GONE, false);
      // The fields the form already had are untouched.
      assert.deepEqual(
        { ...marker.BACK, rms_db: undefined },
        { name: 'BACK', value: 4, line: 3, expression: 'BREAK + 2', at_s: 4, bar: 4, rms_db: undefined },
      );
      // Two levels and a silence: not flat. The silent cycles are the analysis's to report.
      assert.deepEqual(flatWarnings(run.result), []);
      assert.ok(run.result.analysis.warnings.includes('silent cycles: 2, 3'), `${run.result.analysis.warnings}`);
    } finally {
      await rmTmp(ws);
    }
  },
);

test(
  'music.render: one sustained tone for many cycles is warned about, with the numbers',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      // What the stuck render was: two cycles of music, then one held note to the end.
      const code = [
        '$: note("c3 e3 g3 b3 c4 b3 g3 e3").s("sawtooth").lpf(1200).gain(0.5).mask("<1 1 0 0 0 0 0 0 0 0 0 0>")',
        '$: note("a2").s("sine").gain(0.1).mask("<0 0 1 1 1 1 1 1 1 1 1 1>")',
      ].join('\n');
      const run = await runTool('music.render', { code, cycles: 12, cps: 1, offline: true }, { workspace: ws });
      const flat = flatWarnings(run.result);
      assert.equal(flat.length, 1, JSON.stringify(run.result.warnings));
      const m = FLAT_WARNING.exec(flat[0]);
      assert.ok(m, flat[0]);
      assert.equal(Number(m[1]), 10, 'the ten held cycles');
      assert.equal(Number(m[2]), 12);
      const held = run.result.levels.slice(2).map((row) => row.rms_db);
      assert.ok(Math.max(...held) - Math.min(...held) <= 1, `the held cycles are flat: ${held}`);
      assert.ok(Math.abs(Number(m[3]) - held[5]) < 0.1, `the warning names their level: ${flat[0]} vs ${held}`);
      assert.match(flat[0], /stuck note/);
      assert.match(flat[0], /Check the render/);
      // A warning, never an error: the job succeeded and wrote its file.
      assert.ok(run.outputs.some((o) => o.name === 'music.wav'));

      // The same held note under 8 cycles says nothing: too few rows to judge.
      const short = await runTool(
        'music.render',
        { code: 'note("a2").s("sine").gain(0.1)', cycles: 7, cps: 1, offline: true },
        { workspace: ws },
      );
      assert.deepEqual(short.result.warnings, []);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('music.render: a song whose level changes, or a silent one, gets no flat warning', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    // Four levels, 6 dB apart, each for a quarter of the cycles: no level holds three quarters of them.
    const varied = await runTool(
      'music.render',
      { code: 'note("c3*4").s("sine").gain("<0.05 0.1 0.2 0.4>")', cycles: 12, cps: 1, offline: true },
      { workspace: ws },
    );
    const levels = varied.result.levels.map((row) => row.rms_db);
    assert.equal(levels.length, 12);
    assert.ok(levels[3] - levels[0] > 12, `the levels do vary: ${levels}`);
    assert.deepEqual(varied.result.warnings, []);

    // Silence is every cycle at "one level" too, but it has its own warning: no second one here.
    const silent = await runTool(
      'music.render',
      { code: 'note("c3*4").s("sine").gain(0)', cycles: 12, cps: 1, offline: true },
      { workspace: ws },
    );
    assert.deepEqual(
      silent.result.levels.map((row) => row.rms_db),
      Array(12).fill(null),
    );
    assert.deepEqual(silent.result.warnings, []);
    assert.ok(silent.result.analysis.warnings.includes('render is completely silent'));
  } finally {
    await rmTmp(ws);
  }
});

test('music.render: stems_only renders no mix, so there are no levels to give', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const code = 'let B = 1;\na: note("c3*4").s("sine").gain(0.3)\nb: note("g3*4").s("square").gain(0.1)';
    const input = { code, cycles: 2, cps: 1, offline: true, stems: { first: ['a'] } };
    const only = await runTool('music.render', { ...input, stems_only: true }, { workspace: ws });
    assert.equal(only.result.levels, null);
    assert.deepEqual(only.result.markers_found, [{ name: 'B', value: 1, line: 1, at_s: 1, bar: 1 }]);
    // With the mix, the levels are the mix's; the stem entries are what they were.
    const full = await runTool('music.render', input, { workspace: ws });
    assert.equal(full.result.levels.length, 2);
    assert.equal(typeof full.result.markers_found[0].rms_db, 'number');
    assert.deepEqual(Object.keys(full.result.stems[0]).sort(), [
      'file',
      'lines',
      'name',
      'parts',
      'peak_db',
      'render_ms',
    ]);
  } finally {
    await rmTmp(ws);
  }
});
