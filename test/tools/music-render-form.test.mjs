// music.render: the song's form (markers_found) and stems of named parts. Synth-only songs, offline, so no sample
// is needed. The part parser is also tested directly (no render), because a mistaken part is a silent failure.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mono, rmsDb } from '../../src/lib/signal.mjs';
import { markerForm } from '../../src/lib/strudel-markers.mjs';
import { readWav } from '../../src/lib/wav.mjs';
import { findParts, planStems } from '../../tools/music.render/stems.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

/**
 * RMS in dBFS of each cycle of a written WAV output (cps cycles per second), skipping the first quarter of every
 * cycle so the release tail of the cycle before does not count.
 */
async function cycleRms(run, name, cps, cycles) {
  const output = run.outputs.find((o) => o.name === name);
  assert.ok(output, `expected output "${name}", got ${run.outputs.map((o) => o.name).join(', ')}`);
  const audio = readWav(await readFile(output.abs));
  const m = mono(audio);
  const per = Math.round(audio.sampleRate / cps);
  return Array.from({ length: cycles }, (_, c) => rmsDb(m, c * per + Math.round(per / 4), (c + 1) * per));
}

const bytesOf = async (run, name) => readFile(run.outputs.find((o) => o.name === name).abs);

// Part `a` plays in cycle 0 only, part `b` in cycle 1 only, on different notes and waves.
const TWO_PARTS = [
  'a: note("c3*4").s("sine").gain(0.5).mask("<1 0>")',
  'b: note("g3*4").s("square").gain(0.2).mask("<0 1>")',
].join('\n');

test('markerForm: numbers, arithmetic over earlier markers, and text it cannot resolve', () => {
  const code = [
    'setcpm(120/4)',
    'let INTRO = 0;',
    'let DROP = 4;   // works for 3..6',
    'let OUTRO = DROP + 8;',
    'const HALF = -0.5;',
    'let LATER = BARS * 2;',
    'const span = (a, b) => cat(...Array(a).fill(0), 1);',
    'const LP = "<200 400>";',
  ].join('\n');
  assert.deepEqual(markerForm(code, 0.5), [
    { name: 'INTRO', value: 0, line: 2, at_s: 0, bar: 0 },
    { name: 'DROP', value: 4, line: 3, at_s: 8, bar: 4 },
    { name: 'OUTRO', value: 12, line: 4, expression: 'DROP + 8', at_s: 24, bar: 12 },
    { name: 'HALF', value: -0.5, line: 5, at_s: -1, bar: -0.5 },
    { name: 'LATER', value: 'BARS * 2', line: 6 },
  ]);
});

test(
  'music.render: markers_found gives each marker its time at the bpm, after a rewrite',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      const code = 'let BUILD = 1;\nlet DROP = 2;\nlet END = DROP + 1;\nnote("c3 e3").s("sine").gain(0.3)';
      // 120 bpm, 4 beats per cycle: one cycle is 2 s.
      const plain = await runTool('music.render', { code, cycles: 1, bpm: 120, offline: true }, { workspace: ws });
      assert.deepEqual(plain.result.markers_found, [
        { name: 'BUILD', value: 1, line: 1, at_s: 2, bar: 1 },
        { name: 'DROP', value: 2, line: 2, at_s: 4, bar: 2 },
        { name: 'END', value: 3, line: 3, expression: 'DROP + 1', at_s: 6, bar: 3 },
      ]);
      // The form is read from the code that was rendered: a rewritten marker moves, and so does what depends on it.
      const moved = await runTool(
        'music.render',
        { code, cycles: 1, bpm: 90, markers: { DROP: 3 }, offline: true },
        { workspace: ws },
      );
      const cps = 90 / 60 / 4;
      assert.equal(moved.result.cps, cps);
      const drop = moved.result.markers_found.find((m) => m.name === 'DROP');
      assert.equal(drop.value, 3);
      assert.ok(Math.abs(drop.at_s - 3 / cps) < 0.001, `DROP at_s ${drop.at_s} should be ${3 / cps}`);
      assert.equal(moved.result.markers_found.find((m) => m.name === 'END').value, 4);
      assert.equal('stems' in moved.result, false, 'no stems asked, no stems field');
    } finally {
      await rmTmp(ws);
    }
  },
);

test('music.render: two stems each hold only their own part, and sum to the mix', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const run = await runTool(
      'music.render',
      { code: TWO_PARTS, cycles: 2, cps: 1, offline: true, stems: { first: ['a'], second: ['b'] } },
      { workspace: ws },
    );
    const names = run.outputs.map((o) => o.name).sort();
    assert.deepEqual(names, [
      'analysis.json',
      'music.wav',
      'song.strudel',
      'stems/first.strudel',
      'stems/first.wav',
      'stems/second.strudel',
      'stems/second.wav',
    ]);
    assert.deepEqual(
      run.result.stems.map(({ name, file, parts, lines }) => ({ name, file, parts, lines })),
      [
        { name: 'first', file: 'stems/first.wav', parts: ['a'], lines: [1] },
        { name: 'second', file: 'stems/second.wav', parts: ['b'], lines: [2] },
      ],
    );
    assert.deepEqual(run.result.warnings, []);
    const [a0, a1] = await cycleRms(run, 'stems/first.wav', 1, 2);
    const [b0, b1] = await cycleRms(run, 'stems/second.wav', 1, 2);
    assert.ok(a0 > -40, `stem first should sound in cycle 0 (${a0.toFixed(1)} dBFS)`);
    assert.ok(a1 < a0 - 40, `stem first should be silent in cycle 1 (${a1.toFixed(1)} vs ${a0.toFixed(1)} dBFS)`);
    assert.ok(b1 > -40, `stem second should sound in cycle 1 (${b1.toFixed(1)} dBFS)`);
    assert.ok(b0 < b1 - 40, `stem second should be silent in cycle 0 (${b0.toFixed(1)} vs ${b1.toFixed(1)} dBFS)`);
    for (const stem of run.result.stems) assert.ok(stem.peak_db < 0 && stem.peak_db > -40, JSON.stringify(stem));

    // The stems add up to the mix (each part is its own voices), so a mix can rebalance them.
    const read = async (name) => readWav(await bytesOf(run, name));
    const [mix, first, second] = await Promise.all([
      read('music.wav'),
      read('stems/first.wav'),
      read('stems/second.wav'),
    ]);
    const residual = mix.channels.map((ch, c) => ch.map((s, i) => s - first.channels[c][i] - second.channels[c][i]));
    const left = rmsDb(residual[0]);
    assert.ok(
      left < rmsDb(mix.channels[0]) - 40,
      `mix minus stems should be near silence, got ${left.toFixed(1)} dBFS`,
    );

    // The muted song for each stem is written next to it: the other part carries Strudel's `_` mute.
    const firstCode = await readFile(run.outputs.find((o) => o.name === 'stems/first.strudel').abs, 'utf8');
    assert.equal(firstCode, TWO_PARTS.replace('\nb:', '\n_b:'));
  } finally {
    await rmTmp(ws);
  }
});

test(
  'music.render: a stem is the song rendered with the other parts muted, with or without the mix',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      // Anonymous $: parts are selected by order; the second $: line is $2.
      const code = '$: note("c3*2").s("sawtooth").lpf(600).gain(0.3)\n$: note("e4*4").s("triangle").gain(0.3)';
      const stems = { top: ['$2'] };
      const full = await runTool('music.render', { code, cycles: 1, offline: true, stems }, { workspace: ws });
      const only = await runTool(
        'music.render',
        { code, cycles: 1, offline: true, stems, stems_only: true },
        { workspace: ws },
      );
      const muted = await runTool('music.render', { code: `_${code}`, cycles: 1, offline: true }, { workspace: ws });
      const stem = await bytesOf(full, 'stems/top.wav');
      // Buffer.equals, not deepEqual: a deepEqual diff of two large buffers takes minutes and gigabytes to build.
      assert.ok(stem.equals(await bytesOf(muted, 'music.wav')), 'the stem equals a render of the muted song');
      assert.ok((await bytesOf(only, 'stems/top.wav')).equals(stem), 'stems_only renders the same stem');
      assert.deepEqual(full.result.stems[0].lines, [2]);

      // stems_only skips the mix: no music file, no analysis, no mix peak.
      assert.ok(!only.outputs.some((o) => o.name === 'music.wav' || o.name === 'analysis.json'));
      assert.equal(only.result.analysis, null);
      assert.equal(only.result.peak_db, null);
      assert.equal(only.result.seconds, full.result.seconds);
      assert.equal(only.result.stems[0].peak_db, full.result.stems[0].peak_db);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('music.render: peak_db scales the stems by the same gain as the mix', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const base = { code: TWO_PARTS, cycles: 2, cps: 1, offline: true, stems: { first: ['a'] } };
    const plain = await runTool('music.render', base, { workspace: ws });
    const scaled = await runTool('music.render', { ...base, peak_db: -1 }, { workspace: ws });
    const gain = scaled.result.gain_db_applied;
    assert.ok(Math.abs(scaled.result.peak_db + 1) < 0.05, `mix peak ${scaled.result.peak_db}`);
    const moved = scaled.result.stems[0].peak_db - plain.result.stems[0].peak_db;
    assert.ok(Math.abs(moved - gain) < 0.05, `the stem moved ${moved.toFixed(2)} dB, the mix gain is ${gain} dB`);
  } finally {
    await rmTmp(ws);
  }
});

test(
  'music.render: an unknown part is invalid-input that lists the parts, not object keys',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      // `gain:` (an object key), `pad:` (inside a comment) and `keys:` (inside a string) are not parts.
      const code = [
        'const opts = {',
        '  gain: 0.3,',
        '};',
        '// pad: comes later',
        'const words = "keys: soon";',
        'drums: note("c2*4").s("sine").gain(opts.gain)',
        'bass: note("c1").s("sawtooth").gain(opts.gain)',
        '$: note("c4").s("triangle").gain(0.1)',
        '_$: note("c5").s("triangle").gain(0.1)',
      ].join('\n');
      for (const missing of ['gain', 'pad', 'keys', '$3']) {
        await assert.rejects(
          runTool('music.render', { code, cycles: 1, offline: true, stems: { x: [missing] } }, { workspace: ws }),
          (err) => {
            assert.equal(err.type, 'invalid-input');
            assert.equal(
              err.detail,
              `stem "x": part "${missing}" not found; parts in this song: drums, bass, $1 (line 8); muted in the song: $2`,
            );
            return true;
          },
        );
      }
      await assert.rejects(
        runTool('music.render', { code, cycles: 1, offline: true, stems: { x: ['$2'] } }, { workspace: ws }),
        (err) => err.type === 'invalid-input' && /part "\$2" is muted in the song/.test(err.detail),
      );
    } finally {
      await rmTmp(ws);
    }
  },
);

test('music.render: stems_only needs stems, and cannot take peak_db', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const base = { code: TWO_PARTS, cycles: 1, offline: true };
    await assert.rejects(
      runTool('music.render', { ...base, stems_only: true }, { workspace: ws }),
      (err) => err.type === 'invalid-input' && /stems_only needs stems/.test(err.detail),
    );
    await assert.rejects(
      runTool('music.render', { ...base, stems: { a: ['a'] }, stems_only: true, peak_db: -1 }, { workspace: ws }),
      (err) => err.type === 'invalid-input' && /peak_db/.test(err.detail),
    );
  } finally {
    await rmTmp(ws);
  }
});

test(
  'music.render: without stems the result is what it was, plus markers_found and levels',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      const run = await runTool('music.render', { code: TWO_PARTS, cycles: 2, offline: true }, { workspace: ws });
      assert.deepEqual(Object.keys(run.result).sort(), [
        'analysis',
        'cps',
        'events',
        'gain_db_applied',
        'levels',
        'markers_applied',
        'markers_found',
        'peak_db',
        'render_ms',
        'seconds',
        'warnings',
      ]);
      assert.deepEqual(run.result.markers_found, []);
      assert.deepEqual(run.outputs.map((o) => o.name).sort(), ['analysis.json', 'music.wav', 'song.strudel']);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('stems parser: labels on expressions, .p() names, solo, and what is not a part', () => {
  const code = [
    'outer: for (let i = 0; i < 1; i++) { break outer; }',
    "const cfg = { lead: 1, 'bass': 2 };",
    'drums: s("bd*4")',
    'note("c3").s("sine").p(\'keys\')',
    'Strings: note("c4").s("sawtooth")',
    'S$: note("e4").s("sine")',
    'S: note("g4").s("sine")',
    '$: note("c2").s("square")',
  ].join('\n');
  const { parts, dynamic } = findParts(code);
  assert.deepEqual(dynamic, []);
  assert.deepEqual(
    parts.map(({ label, line, anonymous, index, solo }) => ({ label, line, anonymous, index, solo })),
    [
      { label: 'drums', line: 3, anonymous: false, index: undefined, solo: false },
      { label: 'keys', line: 4, anonymous: false, index: undefined, solo: false },
      { label: 'Strings', line: 5, anonymous: false, index: undefined, solo: true },
      { label: 'S$', line: 6, anonymous: true, index: 1, solo: true },
      { label: 'S', line: 7, anonymous: false, index: undefined, solo: false },
      { label: '$', line: 8, anonymous: true, index: 2, solo: false },
    ],
  );
  const plan = planStems(code, { k: ['keys', '$2'] });
  assert.deepEqual(plan.stems[0].lines, [4, 8]);
  assert.match(plan.stems[0].code, /\n_drums: s/);
  assert.match(plan.stems[0].code, /\.p\('keys'\)/);
  assert.match(plan.stems[0].code, /\n_Strings: /);
  assert.match(plan.stems[0].code, /\n_S\$: /);
  assert.match(plan.stems[0].code, /\n_S: /);
  assert.match(plan.stems[0].code, /\n\$: note\("c2"\)/);
  assert.match(plan.stems[0].code, /^outer: for/, 'a loop label is plain JavaScript and stays');
  assert.deepEqual(
    plan.solo.map((p) => p.label),
    ['Strings', 'S$'],
  );
  const muteKeys = planStems(code, { d: ['drums'] }).stems[0].code;
  assert.match(muteKeys, /\.p\('_keys'\)/, 'a .p() name is muted inside its quotes');

  // A name known only at run time cannot be muted, so stems refuse it instead of leaking it into every stem.
  assert.throws(
    () => planStems('const n = "x";\nnote("c3").p(n)', { x: ['x'] }),
    (err) => err.type === 'invalid-input' && /line 2/.test(err.detail),
  );
  assert.throws(
    () => planStems('note("c3").s("sine")', { x: ['x'] }),
    (err) => err.type === 'invalid-input' && /has none/.test(err.detail),
  );
  assert.throws(
    () => planStems(code, { Drums: ['drums'], drums: ['drums'] }),
    (err) => err.type === 'invalid-input' && /differ only by case/.test(err.detail),
  );
});
