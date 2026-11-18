// timeline.layout, music first: scenes in beats or bars of the grid, or until a time, the grid report, the
// overrun warning, the invalid inputs, and a snapshot proving voice-first layouts are unchanged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolveTime } from '../../src/lib/timespec.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const readJson = async (outputs, name) => JSON.parse(await readFile(outputs.find((o) => o.name === name).abs, 'utf8'));

/** Run the layout in a fresh workspace. @returns {Promise<{result: object, timeline: object}>} */
async function layout(input) {
  const ws = await mkTmp();
  try {
    const { result, outputs } = await runTool('timeline.layout', input, { workspace: ws });
    return { result, timeline: await readJson(outputs, 'timeline.json') };
  } finally {
    await rmTmp(ws);
  }
}

/** Assert the layout throws invalid-input whose detail matches `re`. */
async function rejects(input, re) {
  const ws = await mkTmp();
  try {
    await assert.rejects(runTool('timeline.layout', input, { workspace: ws }), (err) => {
      assert.equal(err.type, 'invalid-input', `type ${err.type}: ${err.message}`);
      assert.match(err.message, re);
      return true;
    });
  } finally {
    await rmTmp(ws);
  }
}

// 132 bpm, 4/4, bar 0 at 0.25 s: one beat is 60/132 s, so most grid times are not round numbers.
const GRID = { bpm: 132, beats_per_bar: 4, offset_s: 0.25 };

test(
  'timeline.layout: 2 bars, 6 beats and until bar:5 at 132 bpm with an offset land exactly on the grid',
  needs('ffmpeg'),
  async () => {
    const { result, timeline } = await layout({
      grid: GRID,
      scenes: [
        { id: 'pickup', until: 'bar:0' },
        { id: 'a', bars: 2 },
        { id: 'b', beats: 6 },
        { id: 'c', until: 'bar:5' },
      ],
      times: { b_in: 'b', bar_2: 'bar:2', c_in: 'c', beat_14: 'beat:14', end: 'bar:5' },
    });
    assert.deepStrictEqual(
      result.scenes.map((s) => s.start),
      [0, 0.25, 3.8864, 6.6136],
    );
    assert.equal(result.total, 9.3409);
    // start + dur is the next start, as rounded.
    for (let i = 0; i < result.scenes.length; i++) {
      const s = result.scenes[i];
      const next = result.scenes[i + 1]?.start ?? result.total;
      assert.ok(Math.abs(s.start + s.dur - next) < 1e-9, `${s.id}: ${s.start} + ${s.dur} != ${next}`);
    }
    // The scene times are exactly the bar:/beat: times that audio.mix resolves against this timeline.json.
    assert.equal(resolveTime('bar:0', timeline), timeline.scenes[1].start);
    assert.equal(resolveTime('bar:2', timeline), timeline.scenes[2].start);
    assert.equal(resolveTime('beat:8', timeline), timeline.scenes[2].start);
    assert.equal(resolveTime('beat:14', timeline), timeline.scenes[3].start);
    assert.equal(resolveTime('bar:5', timeline), timeline.total);
    assert.equal(timeline.times.b_in, timeline.times.bar_2);
    assert.equal(timeline.times.c_in, timeline.times.beat_14);
    assert.equal(timeline.times.end, timeline.total);
    assert.deepStrictEqual(timeline.grid, GRID);

    assert.deepStrictEqual(result.grid_report, {
      boundaries: [
        { scene: 'pickup', time: 0.25, beat: 0, on_beat: true },
        { scene: 'a', time: 3.8864, beat: 8, on_beat: true },
        { scene: 'b', time: 6.6136, beat: 14, on_beat: true },
        { scene: 'c', time: 9.3409, beat: 20, on_beat: true },
      ],
      off_grid: 0,
    });
    assert.deepStrictEqual(result.warnings, []);
  },
);

test(
  'timeline.layout: duration_s scenes mixed into a music-first layout show as off the grid',
  needs('ffmpeg'),
  async () => {
    const { result } = await layout({
      grid: GRID,
      scenes: [
        { id: 'pickup', until: 'bar:0' },
        { id: 'a', bars: 1 },
        { id: 'b', duration_s: 1 }, // 1 s is 2.2 beats at 132 bpm
        { id: 'c', beats: 4 }, // exact 4 beats, but from an off-grid start
        { id: 'd', until: 'bar:4' }, // back on the grid
      ],
    });
    const report = result.grid_report;
    assert.deepStrictEqual(
      report.boundaries.map((b) => [b.scene, b.beat, b.on_beat]),
      [
        ['pickup', 0, true],
        ['a', 4, true],
        ['b', 6.2, false],
        ['c', 10.2, false],
        ['d', 16, true],
      ],
    );
    assert.equal(report.off_grid, 2);
    assert.equal(result.scenes[2].dur, 1, 'duration_s is used exactly, not snapped');
    assert.ok(Math.abs(result.scenes[3].dur - (4 * 60) / 132) < 2e-4, `c dur ${result.scenes[3].dur}`);
    // One summary warning, not one per boundary.
    assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings));
    assert.match(result.warnings[0], /2 of 5 scene ends are off the beat grid/);
    assert.match(result.warnings[0], /"b", "c"/);
  },
);

test(
  'timeline.layout: lines longer than a beats or until scene warn with the overrun and keep the length',
  needs('ffmpeg'),
  async () => {
    const { result, timeline } = await layout({
      grid: { bpm: 120 }, // a beat is 0.5 s, a bar 2 s
      scenes: [
        { id: 'a', beats: 4, lines: [{ dur_s: 1.5 }, { dur_s: 1 }] }, // needs 2.5 s, has 2 s
        { id: 'b', bars: 1, lines: [{ dur_s: 1 }] }, // fits
        { id: 'c', until: 'bar:3', lines: [{ dur_s: 2.2 }] }, // needs 2.2 s, has 2 s
        { id: 'd', beats: 1 }, // no lines: nothing to overrun
      ],
    });
    assert.deepStrictEqual(result.scenes, [
      { id: 'a', start: 0, dur: 2 },
      { id: 'b', start: 2, dur: 2 },
      { id: 'c', start: 4, dur: 2 },
      { id: 'd', start: 6, dur: 0.5 },
    ]);
    assert.equal(result.total, 6.5);
    // The cues are not moved or cut: the second line of a still starts at 1.5 s and runs 0.5 s into b.
    assert.deepStrictEqual(
      timeline.scenes[0].cues.map((c) => [c.at, c.dur]),
      [
        [0, 1.5],
        [1.5, 1],
      ],
    );
    assert.equal(result.warnings.length, 2, JSON.stringify(result.warnings));
    assert.match(result.warnings[0], /scene "a"/);
    assert.match(result.warnings[0], /4 beats/);
    assert.match(result.warnings[0], /0\.5 s over/);
    assert.match(result.warnings[1], /scene "c"/);
    assert.match(result.warnings[1], /until bar:3/);
    assert.match(result.warnings[1], /0\.2 s over/);
    assert.equal(result.grid_report.off_grid, 0);
  },
);

test(
  'timeline.layout: beats, bars or a grid until without a grid is invalid-input naming the field',
  needs('ffmpeg'),
  async () => {
    await rejects({ scenes: [{ id: 'a', beats: 4 }] }, /scene "a": beats needs a grid/);
    await rejects({ scenes: [{ id: 'a', bars: 2 }] }, /scene "a": bars needs a grid/);
    await rejects({ scenes: [{ id: 'a', until: 'bar:3' }] }, /scene "a": until "bar:3" needs a grid/);
    // until in seconds needs no grid.
    const { result } = await layout({ scenes: [{ id: 'a', until: 2.5 }] });
    assert.deepStrictEqual(result.scenes, [{ id: 'a', start: 0, dur: 2.5 }]);
    assert.equal(result.grid_report, undefined);
  },
);

test('timeline.layout: two length fields on one scene are invalid-input naming both', needs('ffmpeg'), async () => {
  await rejects(
    { grid: { bpm: 120 }, scenes: [{ id: 'a', beats: 4, bars: 1 }] },
    /scene "a": give at most one of duration_s, beats, bars, until \(got beats and bars\)/,
  );
  await rejects(
    {
      grid: { bpm: 120 },
      scenes: [
        { id: 'x', lines: [{ dur_s: 1 }] },
        { id: 'b', duration_s: 2, until: 'bar:2' },
      ],
    },
    /scene "b": .*\(got duration_s and until\)/,
  );
});

test(
  'timeline.layout: until at or before the scene start, or not a time, is invalid-input',
  needs('ffmpeg'),
  async () => {
    const grid = { bpm: 120 };
    await rejects(
      {
        grid,
        scenes: [
          { id: 'a', duration_s: 2 },
          { id: 'b', until: 'beat:2' },
        ],
      }, // beat 2 is 1 s
      /scene "b": until beat:2 is 1 s, at or before the scene's start \(2 s\)/,
    );
    await rejects(
      {
        grid,
        scenes: [
          { id: 'a', duration_s: 2 },
          { id: 'b', until: 2 },
        ],
      },
      /scene "b": until 2 s/,
    );
    // A scene reference is not a time for until (the schema allows only seconds, bar:<n> and beat:<n>).
    await rejects({ grid, scenes: [{ id: 'a', until: 'a' }] }, /\/scenes\/0\/until/);
  },
);

// Snapshots of timeline.json made by timeline.layout 1.0.0 (before beats/bars/until existed).
const NEUTRAL = {
  scenes: [
    {
      id: 'intro',
      lines: [
        { dur_s: 1, text: 'One' },
        { dur_s: 2, text: 'Two' },
      ],
    },
    { id: 'outro', lines: [{ dur_s: 1.5, text: 'Three' }] },
  ],
};
const NEUTRAL_TIMELINE = {
  version: 1,
  total: 4.5,
  beatOffset: 0,
  scenes: [
    {
      id: 'intro',
      start: 0,
      dur: 3,
      cues: [
        { at: 0, dur: 1, text: 'One', who: null, audio: null },
        { at: 1, dur: 2, text: 'Two', who: null, audio: null },
      ],
    },
    { id: 'outro', start: 3, dur: 1.5, cues: [{ at: 3, dur: 1.5, text: 'Three', who: null, audio: null }] },
  ],
  times: {},
  markers: {},
};
const CLASSIC = {
  preset: 'voice-driven-classic',
  grid: { bpm: 132, beats_per_bar: 4, offset_s: 0.25 },
  scenes: [
    {
      id: 'a',
      lines: [
        { dur_s: 1.234, text: 'Hello', who: 'n' },
        { dur_s: 0.8, pause_s: 0.5 },
      ],
    },
    { id: 'b', duration_s: 2.5, lines: [{ dur_s: 1 }] },
    { id: 'c-1', min_s: 3, lines: [{ dur_s: 0.7 }] },
    { id: 'd', snap_beats: null, tail_s: 0, lines: [{ dur_s: 1.1 }] },
    { id: 'e' },
  ],
  markers: { drop: { scene: 'c-1', align: 'bar' }, hit: { scene: 'd', align: 'beat' } },
  align_to: 'drop',
  times: { h: 'c-1#0.end-0.1', b2: 'bar:2', q: 'beat:7+0.05', d: 'd' },
  extra: { name: 'snap', fps: 30 },
};
const CLASSIC_MARKERS = {
  drop: { scene: 'c-1', bar: 4, cycle: 4, music_offset_s: 1.1363 },
  hit: { scene: 'd', bar: 6, cycle: 6, music_offset_s: 1.1363 },
};
const CLASSIC_TIMELINE = {
  version: 1,
  total: 12.0818,
  bpm: 132,
  beatOffset: 1.1363,
  grid: { bpm: 132, beats_per_bar: 4, offset_s: 0.25 },
  scenes: [
    {
      id: 'a',
      start: 0,
      dur: 3.6364,
      cues: [
        { at: 0.3, dur: 1.234, text: 'Hello', who: 'n', audio: null },
        { at: 2.034, dur: 0.8, text: null, who: null, audio: null },
      ],
    },
    { id: 'b', start: 3.6364, dur: 2.5, cues: [{ at: 3.9364, dur: 1, text: null, who: null, audio: null }] },
    { id: 'c-1', start: 6.1364, dur: 3.6364, cues: [{ at: 6.4364, dur: 0.7, text: null, who: null, audio: null }] },
    { id: 'd', start: 9.7727, dur: 1.4, cues: [{ at: 10.0727, dur: 1.1, text: null, who: null, audio: null }] },
    { id: 'e', start: 11.1727, dur: 0.9091, cues: [] },
  ],
  times: { h: 7.0364, b2: 3.8864, q: 3.4818, d: 9.7727 },
  markers: CLASSIC_MARKERS,
  name: 'snap',
  fps: 30,
};

test('timeline.layout: voice-first layouts are unchanged (snapshots from 1.0.0)', needs('ffmpeg'), async () => {
  const neutral = await layout(NEUTRAL);
  assert.deepStrictEqual(neutral.timeline, NEUTRAL_TIMELINE);
  assert.deepStrictEqual(neutral.result, {
    total: 4.5,
    scenes: [
      { id: 'intro', start: 0, dur: 3 },
      { id: 'outro', start: 3, dur: 1.5 },
    ],
    markers: {},
    music_offset_s: 0,
    warnings: [],
  });

  const classic = await layout(CLASSIC);
  assert.deepStrictEqual(classic.timeline, CLASSIC_TIMELINE);
  const { grid_report: report, ...rest } = classic.result;
  assert.deepStrictEqual(rest, {
    total: 12.0818,
    scenes: CLASSIC_TIMELINE.scenes.map(({ id, start, dur }) => ({ id, start, dur })),
    markers: CLASSIC_MARKERS,
    music_offset_s: 1.1363,
    warnings: [], // the grid is only used for snapping and markers here, so off-grid cuts are not warned about
  });
  // The report is still there, as information: snapped lengths from 0 do not sit on a grid whose bar 0 is 0.25 s.
  assert.equal(report.boundaries.length, 5);
  assert.equal(report.off_grid, 5);
});
