// audio.mix track gain automation: points {at, gain_db}, a linear ramp in dB between points, the first and last
// values held outside them, timespec times, sorting, and where it sits in the processing order.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { integratedLufs } from '../../src/lib/loudness.mjs';
import { applyAutomation, automationDbAt, resolveAutomation } from '../../src/lib/mix/automation.mjs';
import { rmsDb } from '../../src/lib/signal.mjs';
import { encodeWav, readWav } from '../../src/lib/wav.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const SR = 48000;

/** Write raw channel arrays to a f32 WAV fixture in the workspace. */
async function writeWavFile(ws, rel, channels) {
  const abs = path.join(ws, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodeWav({ sampleRate: SR, channels }, { format: 'f32' }));
  return rel;
}

/** A stereo sine (stereo so the pan law at pan 0 is the identity). */
const sine = (seconds, freq = 1000, amp = 0.5) =>
  Array.from({ length: 2 }, () =>
    Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR)),
  );

async function readOutput(run, name = 'mix.wav') {
  const out = run.outputs.find((o) => o.name === name);
  assert.ok(out, `output "${name}" is missing (got ${run.outputs.map((o) => o.name).join(', ')})`);
  return readWav(await readFile(out.abs));
}

/** RMS in dB of the left channel over [fromS, toS). */
const rmsAt = (audio, fromS, toS) => rmsDb(audio.channels[0], Math.round(fromS * SR), Math.round(toS * SR));

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: expected ${want}, got ${got}`);

test('automationDbAt holds the ends and ramps linearly in dB', () => {
  const points = [
    { atSample: 100, gain_db: 0 },
    { atSample: 200, gain_db: -12 },
    { atSample: 200, gain_db: -20 },
    { atSample: 300, gain_db: -20 },
  ];
  assert.equal(automationDbAt(points, 0), 0, 'before the first point: the first value');
  assert.equal(automationDbAt(points, 100), 0);
  assert.equal(automationDbAt(points, 150), -6, 'half way: half the dB');
  assert.equal(automationDbAt(points, 199), -11.88);
  assert.equal(automationDbAt(points, 200), -20, 'two points at one time make a step to the later one');
  assert.equal(automationDbAt(points, 1000), -20, 'after the last point: the last value');
});

test('resolveAutomation resolves timespecs, sorts and warns; applyAutomation at 0 dB is the identity', () => {
  const timeline = { scenes: [{ id: 'b', start: 1, dur: 1, cues: [] }] };
  const warnings = [];
  const [track] = resolveAutomation(
    [
      {
        name: 'music',
        automation: [
          { at: 'b+0.5', gain_db: -6 },
          { at: 0.25, gain_db: 0 },
        ],
      },
    ],
    timeline,
    SR,
    warnings,
  );
  assert.deepEqual(
    track.automation.map((p) => [p.atS, p.atSample, p.gain_db]),
    [
      [0.25, 12000, 0],
      [1.5, 72000, -6],
    ],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /track "music" automation points were not in time order; they were sorted/);
  const [untouched] = resolveAutomation([{ name: 'x' }], null, SR);
  assert.equal(untouched.automation, undefined, 'no automation stays absent');

  const audio = { sampleRate: SR, channels: sine(0.01) };
  assert.equal(applyAutomation(audio, [{ atSample: 0, gain_db: 0 }]), audio, '0 dB returns the same audio');
  assert.equal(applyAutomation(audio, undefined), audio);
});

test('a ramp from 0 dB at 1 s to -12 dB at 2 s', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sine(3));
    const clips = [{ src: 'tone.wav', at: 0 }];
    const dry = await readOutput(
      await runTool('audio.mix', { duration_s: 3, tracks: [{ name: 'music', clips }] }, { workspace: ws }),
    );
    const run = await runTool(
      'audio.mix',
      {
        duration_s: 3,
        output: { stems: true },
        tracks: [
          {
            name: 'music',
            automation: [
              { at: 1, gain_db: 0 },
              { at: 2, gain_db: -12 },
            ],
            clips,
          },
        ],
      },
      { workspace: ws },
    );
    assert.deepEqual(run.result.warnings, []);
    const wet = await readOutput(run);
    const ref = rmsAt(dry, 0, 3);
    near(rmsAt(wet, 0.1, 0.95) - ref, 0, 0.01, 'before 1 s');
    near(rmsAt(wet, 1.49, 1.51) - ref, -6, 0.1, 'at 1.5 s');
    near(rmsAt(wet, 1.24, 1.26) - ref, -3, 0.1, 'at 1.25 s');
    near(rmsAt(wet, 2.05, 2.95) - ref, -12, 0.01, 'after 2 s');
    // The gain at one sample is exact: -12 dB * (i - 1 s) / 1 s. Sample 72012 (just after 1.5 s) is a peak of the sine.
    const i = 72012;
    const want = (-12 * (i - SR)) / SR;
    near(20 * Math.log10(wet.channels[0][i] / dry.channels[0][i]), want, 1e-4, 'sample gain at 1.5 s');
    // The stem holds the automated track.
    const stem = await readOutput(run, 'stems/music.wav');
    assert.deepEqual(stem.channels[0], wet.channels[0]);
  } finally {
    await rmTmp(ws);
  }
});

test('automation times resolve against the timeline like a clip at', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sine(3));
    await writeFixture(ws, 'timeline.json', {
      json: {
        scenes: [
          { id: 'a', start: 0, dur: 1, cues: [] },
          { id: 'b', start: 1, dur: 2, cues: [{ at: 1.5, dur: 0.25 }] },
        ],
        grid: { bpm: 120, beats_per_bar: 4, offset_s: 0 },
      },
    });
    const input = (automation) => ({
      timeline: 'timeline.json',
      duration_s: 3,
      tracks: [{ name: 'music', automation, clips: [{ src: 'tone.wav', at: 'a' }] }],
    });
    const dry = await readOutput(await runTool('audio.mix', input([{ at: 0, gain_db: 0 }]), { workspace: ws }));
    const ref = rmsAt(dry, 0, 3);
    // From scene b's start (1 s) to the end of its first cue (1.75 s), then hold -12 dB until bar 1 (2 s), then +0.
    const wet = await readOutput(
      await runTool(
        'audio.mix',
        input([
          { at: 'b', gain_db: 0 },
          { at: 'b#0.end', gain_db: -12 },
          { at: 'bar:1', gain_db: -12 },
          { at: 'bar:1+0.0001', gain_db: 0 },
        ]),
        { workspace: ws },
      ),
    );
    near(rmsAt(wet, 0.1, 0.95) - ref, 0, 0.01, 'before scene b');
    near(rmsAt(wet, 1.365, 1.385) - ref, -6, 0.1, 'half way to the cue end');
    near(rmsAt(wet, 1.8, 1.95) - ref, -12, 0.01, 'from the cue end to bar 1');
    near(rmsAt(wet, 2.1, 2.9) - ref, 0, 0.01, 'after bar 1');

    await assert.rejects(
      () => runTool('audio.mix', input([{ at: 'nope', gain_db: -6 }]), { workspace: ws }),
      (e) => e.type === 'invalid-input' && /tracks\[0\]\.automation\[0\]\.at/.test(e.message),
    );
    await assert.rejects(
      () => runTool('audio.mix', input([]), { workspace: ws }),
      (e) => e.type === 'invalid-input',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('one point is a constant gain; unsorted points are sorted with a warning', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sine(1));
    const clips = [{ src: 'tone.wav', at: 0 }];
    const fader = await readOutput(
      await runTool('audio.mix', { tracks: [{ name: 't', gain_db: -6, clips }] }, { workspace: ws }),
    );
    const single = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', automation: [{ at: 0.5, gain_db: -6 }], clips }] },
      { workspace: ws },
    );
    assert.deepEqual(single.result.warnings, []);
    const singleOut = await readOutput(single);
    assert.deepEqual(singleOut.channels[0], fader.channels[0], 'one point at -6 dB is the same as gain_db -6');

    const points = [
      { at: 0.2, gain_db: 0 },
      { at: 0.8, gain_db: -10 },
    ];
    const sorted = await readOutput(
      await runTool('audio.mix', { tracks: [{ name: 't', automation: points, clips }] }, { workspace: ws }),
    );
    const unsortedRun = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', automation: [points[1], points[0]], clips }] },
      { workspace: ws },
    );
    assert.deepEqual((await readOutput(unsortedRun)).channels[0], sorted.channels[0]);
    assert.ok(
      unsortedRun.result.warnings.some((w) => /track "t" automation points were not in time order/.test(w)),
      JSON.stringify(unsortedRun.result.warnings),
    );
  } finally {
    await rmTmp(ws);
  }
});

test('automation sits after gain_db and before level', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sine(2, 1000, 0.1));
    // level is measured after the automation, so the -12 dB dip is undone by the level stage.
    const run = await runTool(
      'audio.mix',
      {
        tracks: [
          {
            name: 't',
            gain_db: -3,
            automation: [{ at: 0, gain_db: -12 }],
            level: { lufs: -20 },
            clips: [{ src: 'tone.wav', at: 0 }],
          },
        ],
      },
      { workspace: ws },
    );
    near(integratedLufs(await readOutput(run)), -20, 0.2, 'integrated loudness after level');
  } finally {
    await rmTmp(ws);
  }
});
