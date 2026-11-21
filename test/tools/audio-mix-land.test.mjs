// audio.mix clips placed by the moment their sound is heard (`land_at` with `onset_s`): the onset lands on the
// sample asked for, `duration_s` counts from the onset, a lead-in that does not fit is trimmed, and a mix placed
// with `at` alone is unchanged.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { resolveClipTimes } from '../../src/lib/mix/plan.mjs';
import { encodeWav, readWav } from '../../src/lib/wav.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const SR = 48000;
/** Seconds to a whole sample index. */
const S = (seconds) => Math.round(seconds * SR);

/** Write a stereo f32 WAV fixture in the workspace. */
async function writeWavFile(ws, rel, channels) {
  const abs = path.join(ws, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodeWav({ sampleRate: SR, channels }, { format: 'f32' }));
  return rel;
}

/** A stereo file of `frames` samples of silence with one-sample clicks at the given sample indexes. */
function clicks(frames, at, amp = 0.8) {
  const ch = new Float32Array(frames);
  for (const i of at) ch[i] = amp;
  return [ch, Float32Array.from(ch)];
}

/** A stereo file: `leadS` of silence, then a 1 kHz sine of `toneS`. */
function lateTone(leadS, toneS, amp = 0.5) {
  const lead = Math.round(leadS * SR);
  const len = Math.round(toneS * SR);
  const ch = new Float32Array(lead + len);
  for (let i = 0; i < len; i++) ch[lead + i] = amp * Math.sin((2 * Math.PI * 1000 * (i + 0.5)) / SR);
  return [ch, Float32Array.from(ch)];
}

async function readOutput(run, name = 'mix.wav') {
  const out = run.outputs.find((o) => o.name === name);
  assert.ok(out, `${name} is missing (got ${run.outputs.map((o) => o.name).join(', ')})`);
  return readFile(out.abs);
}

const readMix = async (run) => readWav(await readOutput(run));
const readReport = async (run) => JSON.parse(await readOutput(run, 'report.json'));

/** Sample indexes of the left channel louder than `threshold`, in order. */
function loudSamples(audio, threshold = 0.1) {
  const out = [];
  audio.channels[0].forEach((x, i) => {
    if (Math.abs(x) > threshold) out.push(i);
  });
  return out;
}

/** The first and one-past-the-last sample of the left channel louder than `threshold`. */
function heardSpan(audio, threshold = 0.01) {
  const loud = loudSamples(audio, threshold);
  return { from: loud[0], to: loud[loud.length - 1] + 1 };
}

const sfxMix = (clips, extra = {}) => ({ tracks: [{ name: 'sfx', clips }], ...extra });

async function rejects(promise, pattern, what) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.type, 'invalid-input', `${what}: ${err.message}`);
    assert.match(err.detail ?? err.message, pattern, what);
    return true;
  });
}

test('a click some way into its file lands on the sample asked for', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const onsetFrame = 9611; // about 0.2002 s into the file
    await writeWavFile(ws, 'click.wav', clicks(24000, [onsetFrame]));
    const onset_s = onsetFrame / SR;
    const run = await runTool(
      'audio.mix',
      sfxMix(
        [
          { src: 'click.wav', land_at: 1.2, onset_s }, // frame 36 at 30 fps
          { src: 'click.wav', land_at: 2, onset_s, offset_s: 0.1 }, // a shorter lead-in, read from 0.1 s
        ],
        { duration_s: 3 },
      ),
      { workspace: ws },
    );
    const mix = await readMix(run);
    assert.deepEqual(loudSamples(mix), [S(1.2), S(2)], 'each click is on its landing sample');
    assert.deepEqual(run.result.warnings, []);
  } finally {
    await rmTmp(ws);
  }
});

test('duration_s counts from the onset, and the lead-in is added by the mixer', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'late.wav', lateTone(0.2, 1));
    const landed = await runTool(
      'audio.mix',
      sfxMix([{ src: 'late.wav', land_at: 0.5, onset_s: 0.2, duration_s: 0.3 }]),
      { workspace: ws },
    );
    // Heard from the landing for 0.3 s: the mix ends where the clip does.
    assert.equal(landed.result.samples, S(0.8));
    assert.deepEqual(heardSpan(await readMix(landed)), { from: S(0.5), to: S(0.8) });

    // With `at`, duration_s keeps its meaning (from the first played sample), so the same 0.3 s holds only 0.1 s of sound.
    const placed = await runTool('audio.mix', sfxMix([{ src: 'late.wav', at: 0.3, duration_s: 0.3 }]), {
      workspace: ws,
    });
    assert.equal(placed.result.samples, S(0.6));
    assert.deepEqual(heardSpan(await readMix(placed)), { from: S(0.5), to: S(0.6) });
  } finally {
    await rmTmp(ws);
  }
});

test('a landing too early for the lead-in trims it and still lands', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'click.wav', clicks(24000, [9600])); // onset at 0.2 s, file 0.5 s
    const run = await runTool(
      'audio.mix',
      sfxMix([{ src: 'click.wav', land_at: 0.05, onset_s: 0.2, duration_s: 0.1 }]),
      { workspace: ws },
    );
    const mix = await readMix(run);
    assert.deepEqual(loudSamples(mix), [S(0.05)], 'the onset is on the landing sample');
    assert.equal(run.result.samples, S(0.15), '0.05 s of lead-in plus 0.1 s from the onset');
    assert.equal(run.result.warnings.length, 1);
    assert.match(run.result.warnings[0], /track "sfx" clip 0: .*0\.15 s of it was trimmed.*still lands at 0\.05 s/);

    // Landing at 0 keeps no lead-in at all.
    const atZero = await runTool('audio.mix', sfxMix([{ src: 'click.wav', land_at: 0, onset_s: 0.2 }]), {
      workspace: ws,
    });
    assert.deepEqual(loudSamples(await readMix(atZero)), [0]);
    assert.equal(atZero.result.samples, 24000 - 9600);
    assert.match(atZero.result.warnings[0], /trimmed/);
  } finally {
    await rmTmp(ws);
  }
});

test('an offset after the onset lands the start of the played part and warns', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'two.wav', clicks(48000, [9600, 24000])); // clicks at 0.2 s and 0.5 s
    const run = await runTool('audio.mix', sfxMix([{ src: 'two.wav', land_at: 1, onset_s: 0.2, offset_s: 0.5 }]), {
      workspace: ws,
    });
    assert.deepEqual(loudSamples(await readMix(run)), [SR], 'the first played sample is on the landing');
    assert.equal(run.result.warnings.length, 1);
    assert.match(run.result.warnings[0], /track "sfx" clip 0: offset_s 0\.5 s is after onset_s 0\.2 s/);

    // An offset exactly on the onset is exact and needs no warning.
    const exact = await runTool(
      'audio.mix',
      sfxMix([{ src: 'two.wav', land_at: 1, onset_s: 0.2, offset_s: 0.2, duration_s: 0.1 }]),
      { workspace: ws },
    );
    assert.deepEqual(loudSamples(await readMix(exact)), [SR]);
    assert.deepEqual(exact.result.warnings, []);
  } finally {
    await rmTmp(ws);
  }
});

test('a clip with both at and land_at, or with neither, is rejected', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'click.wav', clicks(4800, [100]));
    const ok = { src: 'click.wav', at: 0 };
    await rejects(
      runTool('audio.mix', sfxMix([ok, { src: 'click.wav', at: 0.5, land_at: 1, onset_s: 0.1 }]), { workspace: ws }),
      /\/tracks\/0\/clips\/1/,
      'both at and land_at',
    );
    await rejects(
      runTool('audio.mix', sfxMix([ok, ok, { src: 'click.wav', onset_s: 0.1 }]), { workspace: ws }),
      /\/tracks\/0\/clips\/2/,
      'neither at nor land_at',
    );
    await rejects(
      runTool('audio.mix', sfxMix([{ src: 'click.wav', land_at: 1, onset_s: -0.1 }]), { workspace: ws }),
      /\/tracks\/0\/clips\/0\/onset_s/,
      'a negative onset_s',
    );
    await rejects(
      runTool('audio.mix', sfxMix([{ src: 'click.wav', land_at: -1 }]), { workspace: ws }),
      /tracks\[0\]\.clips\[0\]\.land_at: negative time/,
      'a negative land_at',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('the planner names the clip when it gets both or neither placement', () => {
  const tracks = (clip) => [{ name: 'sfx', clips: [{ src: 'a.wav', at: 0 }, clip] }];
  assert.throws(
    () => resolveClipTimes(tracks({ src: 'a.wav', at: 1, land_at: 2 }), null, SR),
    (err) =>
      err.type === 'invalid-input' && /tracks\[0\]\.clips\[1\]: give "at" or "land_at", not both/.test(err.detail),
  );
  assert.throws(
    () => resolveClipTimes(tracks({ src: 'a.wav' }), null, SR),
    (err) => err.type === 'invalid-input' && /tracks\[0\]\.clips\[1\]: needs "at".* or "land_at"/.test(err.detail),
  );
});

test('the planner leaves a clip placed with at exactly as before', () => {
  const clip = { src: 'a.wav', at: 1.25, offset_s: 0.1, duration_s: 0.4, gain_db: -3, pan: 0, fade_in_s: 0.01 };
  const warnings = [];
  const [track] = resolveClipTimes([{ name: 'sfx', clips: [clip] }], null, SR, warnings);
  assert.deepEqual(track.clips[0], { ...clip, atS: 1.25, atSample: 60000 });
  assert.deepEqual(warnings, []);

  // land_at: the real start, the landing, and the offset and length that are read.
  const [landed] = resolveClipTimes(
    [{ name: 'sfx', clips: [{ src: 'a.wav', land_at: 1, onset_s: 0.25, offset_s: 0.05, duration_s: 0.5 }] }],
    null,
    SR,
    warnings,
  );
  const placed = landed.clips[0];
  assert.equal(placed.atSample, S(0.8));
  assert.equal(placed.atS, 0.8);
  assert.equal(placed.landSample, SR);
  assert.equal(placed.offset_s, 0.05);
  assert.ok(
    Math.abs(placed.duration_s - 0.7) < 1e-9,
    `0.5 s from the onset plus 0.2 s lead-in, got ${placed.duration_s}`,
  );
  assert.deepEqual(warnings, []);
});

test('a timespec land_at resolves through the timeline', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'click.wav', clicks(24000, [9600]));
    await writeFixture(ws, 'timeline.json', {
      json: {
        grid: { bpm: 120, beats_per_bar: 4, offset_s: 0 },
        scenes: [
          { id: 'intro', start: 0, dur: 1.5, cues: [] },
          { id: 'boom', start: 1.5, dur: 2, cues: [{ at: 1.75, dur: 0.2 }] },
        ],
      },
    });
    const clip = (land_at) => ({ src: 'click.wav', land_at, onset_s: 0.2 });
    const run = await runTool(
      'audio.mix',
      sfxMix([clip('boom'), clip('boom#0'), clip('boom+0.75'), clip('bar:2')], {
        timeline: 'timeline.json',
        duration_s: 5,
      }),
      { workspace: ws },
    );
    assert.deepEqual(loudSamples(await readMix(run)), [S(1.5), S(1.75), S(2.25), S(4)]);
    assert.deepEqual(run.result.warnings, []);

    await rejects(
      runTool('audio.mix', sfxMix([clip('nowhere')], { timeline: 'timeline.json' }), { workspace: ws }),
      /tracks\[0\]\.clips\[0\]\.land_at: unknown scene "nowhere"/,
      'an unknown scene',
    );
    await rejects(
      runTool('audio.mix', sfxMix([clip('boom')]), { workspace: ws }),
      /tracks\[0\]\.clips\[0\]\.land_at: .*needs a timeline/,
      'a timespec without a timeline',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('the cue rows carry the real start and end, and the landing time', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'late.wav', lateTone(0.2, 1));
    await writeFixture(ws, 'bed.wav', { noise: { seconds: 2, amplitude_db: -24 } });
    const input = (window) => ({
      duration_s: 2,
      cues: { reference: 'music', window },
      tracks: [
        { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
        {
          name: 'sfx',
          clips: [
            { src: 'late.wav', land_at: 0.5, onset_s: 0.2, duration_s: 0.3, name: 'landed' },
            { src: 'late.wav', at: 1.1, onset_s: 0.2, duration_s: 0.5, name: 'placed-with-onset' },
            { src: 'late.wav', at: 1.5, duration_s: 0.4, name: 'placed' },
          ],
        },
      ],
    });
    const whole = await runTool('audio.mix', input('clip'), { workspace: ws });
    const [landed, withOnset, placed] = whole.result.cues;
    assert.deepEqual([landed.at, landed.end, landed.land_at], [0.3, 0.8, 0.5], 'the clip starts 0.2 s before it lands');
    assert.deepEqual([withOnset.at, withOnset.end, withOnset.land_at], [1.1, 1.6, 1.3]);
    assert.deepEqual([placed.at, placed.end], [1.5, 1.9]);
    assert.ok(!('land_at' in placed), 'a clip placed with at and no onset_s has the row it always had');
    assert.deepEqual((await readReport(whole)).cues, whole.result.cues);

    const audible = await runTool('audio.mix', input('audible'), { workspace: ws });
    const row = audible.result.cues[0];
    assert.ok(Math.abs(row.at - 0.5) < 0.001, `the audible window starts at the landing, got ${row.at}`);
    assert.ok(Math.abs(row.end - 0.8) < 0.001, `the audible window ends 0.3 s after the landing, got ${row.end}`);
    assert.equal(row.land_at, 0.5);
  } finally {
    await rmTmp(ws);
  }
});

test(
  'a mix placed with at alone is unchanged, and land_at reproduces it sample for sample',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      await writeWavFile(ws, 'late.wav', lateTone(0.2, 1));
      await writeFixture(ws, 'bed.wav', { noise: { seconds: 3, amplitude_db: -24 } });
      const input = (sfxClips) => ({
        duration_s: 3,
        cues: { reference: 'music' },
        output: { stems: true },
        tracks: [
          { name: 'music', gain_db: -6, clips: [{ src: 'bed.wav', at: 0, fade_in_s: 0.1, fade_out_s: 0.2 }] },
          { name: 'sfx', clips: sfxClips },
        ],
      });
      // Placed by hand, the way callers do it today: start = moment - onset, length = heard length + onset.
      const byHand = await runTool(
        'audio.mix',
        input([
          { src: 'late.wav', at: 0.3, duration_s: 0.5, fade_out_s: 0.05, gain_db: -3, name: 'a' },
          { src: 'late.wav', at: 1.5, offset_s: 0.1, duration_s: 0.6, pan: -0.5, name: 'b' },
          { src: 'late.wav', at: 1.75, name: 'c' },
        ]),
        { workspace: ws },
      );
      // The same three clips placed by their moment.
      const landed = await runTool(
        'audio.mix',
        input([
          { src: 'late.wav', land_at: 0.5, onset_s: 0.2, duration_s: 0.3, fade_out_s: 0.05, gain_db: -3, name: 'a' },
          { src: 'late.wav', land_at: 1.6, onset_s: 0.2, offset_s: 0.1, duration_s: 0.5, pan: -0.5, name: 'b' },
          { src: 'late.wav', land_at: 1.75, name: 'c' }, // no onset_s: land_at behaves as at
        ]),
        { workspace: ws },
      );
      for (const name of ['mix.wav', 'stems/sfx.wav', 'stems/music.wav'])
        assert.ok((await readOutput(byHand, name)).equals(await readOutput(landed, name)), `${name} is identical`);
      assert.deepEqual(byHand.result.warnings, []);
      assert.deepEqual(landed.result.warnings, []);
      assert.deepEqual(byHand.result.tracks, landed.result.tracks);

      // The at-only result keeps its shape: the same row keys as before, no landing fields anywhere.
      const rowKeys = ['track', 'clip', 'name', 'at', 'end', 'level_db', 'reference_db', 'ratio_db'];
      for (const row of byHand.result.cues) assert.deepEqual(Object.keys(row), rowKeys);
      assert.ok(!JSON.stringify(await readReport(byHand)).includes('land'));
      // The landed rows differ only by the added landing time.
      assert.deepEqual(
        landed.result.cues.map(({ land_at, ...row }) => row),
        byHand.result.cues,
      );
      assert.deepEqual(
        landed.result.cues.map((row) => row.land_at),
        [0.5, 1.6, 1.75],
      );
    } finally {
      await rmTmp(ws);
    }
  },
);
