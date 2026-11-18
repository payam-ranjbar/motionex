// audio.mix cue table (`cues`): one row per clip of the cue tracks with its track's level over the clip's window,
// the reference track's level over the same window and their ratio, measured on the stems.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { kWeight, windowLufs } from '../../src/lib/loudness.mjs';
import { clipWindow } from '../../src/lib/mix/cues.mjs';
import { mulberry32 } from '../../src/lib/signal.mjs';
import { encodeWav } from '../../src/lib/wav.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const SR = 48000;

/** Write a stereo f32 WAV fixture in the workspace. */
async function writeWavFile(ws, rel, channels) {
  const abs = path.join(ws, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodeWav({ sampleRate: SR, channels }, { format: 'f32' }));
  return rel;
}

/** Stereo 1 kHz sine of `seconds`, with optional silence before and after it. */
function tone(seconds, amp, { padS = 0 } = {}) {
  const pad = Math.round(padS * SR);
  const len = Math.round(seconds * SR);
  const ch = new Float32Array(len + 2 * pad);
  for (let i = 0; i < len; i++) ch[pad + i] = amp * Math.sin((2 * Math.PI * 1000 * i) / SR);
  return [ch, Float32Array.from(ch)];
}

/** Stereo white noise (independent channels). */
function noise(seconds, amp, seed = 7) {
  const r = mulberry32(seed);
  const len = Math.round(seconds * SR);
  return Array.from({ length: 2 }, () => Float32Array.from({ length: len }, () => amp * (r() * 2 - 1)));
}

async function readReport(run) {
  const out = run.outputs.find((o) => o.name === 'report.json');
  assert.ok(out, `report.json is missing (got ${run.outputs.map((o) => o.name).join(', ')})`);
  return JSON.parse(await readFile(out.abs, 'utf8'));
}

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: expected ${want}, got ${got}`);

const BASE_KEYS = ['duration_s', 'samples', 'sample_rate', 'channels', 'tracks', 'master', 'warnings'];

test('clipWindow trims the quiet ends for "audible" and keeps the heard part for "clip"', () => {
  const ch = new Float32Array(100);
  ch.fill(0.5, 20, 60);
  ch[10] = 0.001; // more than 30 dB under the peak: trimmed
  ch[70] = 0.05; // 20 dB under the peak: kept
  assert.deepEqual(clipWindow([ch], 100, 'audible'), { start: 20, end: 71 });
  assert.deepEqual(clipWindow([ch], 50, 'audible'), { start: 20, end: 50 }, 'cut at the heard length');
  assert.deepEqual(clipWindow([ch], 100, 'clip'), { start: 0, end: 100 });
  assert.deepEqual(clipWindow([new Float32Array(10)], 10, 'audible'), { start: 0, end: 0 }, 'silence is empty');
});

test('a tone clip over a noise reference gives the expected levels and ratio', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const bed = noise(2, 0.1);
    const hit = tone(0.4, 0.3);
    await writeWavFile(ws, 'bed.wav', bed);
    await writeWavFile(ws, 'hit.wav', hit);
    const input = (sfx = {}) => ({
      duration_s: 2,
      cues: { reference: 'music' },
      tracks: [
        { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
        {
          name: 'sfx',
          ...sfx,
          clips: [
            { src: 'hit.wav', at: 0.5, name: 'hit-a' },
            { src: 'hit.wav', at: 1.2, gain_db: -9 },
          ],
        },
      ],
    });
    const run = await runTool('audio.mix', input(), { workspace: ws });
    const rows = run.result.cues;
    assert.equal(rows.length, 2);

    // Expected values straight from the BS.1770 meter on the source signals.
    const hitLevel = windowLufs(kWeight({ sampleRate: SR, channels: hit }), SR, 0, 0.4);
    const kwBed = kWeight({ sampleRate: SR, channels: bed });
    const ref1 = windowLufs(kwBed, SR, 0.5, 0.9);
    const ref2 = windowLufs(kwBed, SR, 1.2, 1.6);
    // A stereo 1 kHz sine of amplitude A reads about 20*log10(A) LUFS (K-weighting adds ~0.69 dB at 1 kHz).
    near(hitLevel, 20 * Math.log10(0.3), 0.1, 'meter sanity');

    const [a, b] = rows;
    assert.equal(a.track, 'sfx');
    assert.equal(a.clip, 0);
    assert.equal(a.name, 'hit-a', 'a named clip carries its name');
    assert.equal(b.clip, 1);
    assert.equal(b.name, null, 'an unnamed clip has name null');
    near(a.at, 0.5, 1e-4, 'row 0 at');
    near(a.end, 0.9, 1e-4, 'row 0 end');
    near(b.at, 1.2, 1e-4, 'row 1 at');
    near(a.level_db, hitLevel, 0.05, 'row 0 level');
    near(a.reference_db, ref1, 0.05, 'row 0 reference');
    near(a.ratio_db, hitLevel - ref1, 0.05, 'row 0 ratio');
    near(b.level_db, hitLevel - 9, 0.05, 'row 1 level follows the clip gain');
    near(b.ratio_db, hitLevel - 9 - ref2, 0.05, 'row 1 ratio');

    const summary = run.result.cues_summary;
    assert.equal(summary.reference, 'music');
    assert.equal(summary.window, 'audible');
    assert.equal(summary.rows, 2);
    assert.deepEqual(Object.keys(summary.tracks), ['sfx']);
    assert.equal(summary.tracks.sfx.clips, 2);
    assert.equal(summary.tracks.sfx.min_ratio_db, b.ratio_db);
    assert.equal(summary.tracks.sfx.max_ratio_db, a.ratio_db);

    const report = await readReport(run);
    assert.deepEqual(report.cues, rows, 'report.json holds the same rows');
    assert.deepEqual(report.cues_summary, summary);

    // Measured on the stems: a track-level automation of -6 dB lowers every ratio by 6 dB.
    const quieter = await runTool('audio.mix', input({ automation: [{ at: 0, gain_db: -6 }] }), { workspace: ws });
    near(quieter.result.cues[0].ratio_db, a.ratio_db - 6, 0.02, 'post-automation ratio');
    near(quieter.result.cues[0].reference_db, a.reference_db, 0.01, 'the reference is unchanged');
  } finally {
    await rmTmp(ws);
  }
});

test('window "audible" skips the silent padding that "clip" includes', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'bed.wav', noise(2, 0.1));
    await writeWavFile(ws, 'hit.wav', tone(0.4, 0.3, { padS: 0.2 }));
    const input = (window) => ({
      duration_s: 2,
      cues: { reference: 'music', window },
      tracks: [
        { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
        { name: 'sfx', clips: [{ src: 'hit.wav', at: 0.5 }] },
      ],
    });
    const [audible] = (await runTool('audio.mix', input('audible'), { workspace: ws })).result.cues;
    const [clip] = (await runTool('audio.mix', input('clip'), { workspace: ws })).result.cues;
    near(audible.at, 0.7, 1e-3, 'audible at');
    near(audible.end, 1.1, 1e-3, 'audible end');
    assert.equal(clip.at, 0.5);
    assert.equal(clip.end, 1.3);
    near(clip.level_db, audible.level_db + 10 * Math.log10(0.4 / 0.8), 0.05, 'half the window is silence');
  } finally {
    await rmTmp(ws);
  }
});

test(
  'cue tracks: all but the reference by default, a list when given, unknown names fail',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      await writeWavFile(ws, 'bed.wav', noise(1, 0.1));
      await writeWavFile(ws, 'hit.wav', tone(0.2, 0.3));
      const input = (cues) => ({
        duration_s: 1,
        cues,
        tracks: [
          { name: 'vo', clips: [{ src: 'hit.wav', at: 0.1 }] },
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
          {
            name: 'sfx',
            clips: [
              { src: 'hit.wav', at: 0.3 },
              { src: 'hit.wav', at: 0.6 },
            ],
          },
        ],
      });
      const all = await runTool('audio.mix', input({ reference: 'music' }), { workspace: ws });
      assert.deepEqual(
        all.result.cues.map((r) => [r.track, r.clip]),
        [
          ['vo', 0],
          ['sfx', 0],
          ['sfx', 1],
        ],
      );
      assert.deepEqual(Object.keys(all.result.cues_summary.tracks), ['vo', 'sfx']);

      const one = await runTool('audio.mix', input({ reference: 'music', tracks: ['sfx'] }), { workspace: ws });
      assert.deepEqual(
        one.result.cues.map((r) => r.track),
        ['sfx', 'sfx'],
      );

      for (const cues of [{ reference: 'nope' }, { reference: 'music', tracks: ['sfx', 'nope'] }]) {
        await assert.rejects(
          () => runTool('audio.mix', input(cues), { workspace: ws }),
          (e) => e.type === 'invalid-input' && /nope/.test(e.message),
        );
      }
    } finally {
      await rmTmp(ws);
    }
  },
);

test('a clip past the mix end gets a row of nulls', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'bed.wav', noise(1, 0.1));
    await writeWavFile(ws, 'hit.wav', tone(0.2, 0.3));
    const run = await runTool(
      'audio.mix',
      {
        duration_s: 1,
        cues: { reference: 'music' },
        tracks: [
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
          { name: 'sfx', clips: [{ src: 'hit.wav', at: 1.5, name: 'late' }] },
        ],
      },
      { workspace: ws },
    );
    assert.deepEqual(run.result.cues, [
      {
        track: 'sfx',
        clip: 0,
        name: 'late',
        at: 1.5,
        end: 1.5,
        level_db: null,
        reference_db: null,
        ratio_db: null,
      },
    ]);
    assert.deepEqual(run.result.cues_summary.tracks.sfx, {
      clips: 1,
      min_ratio_db: null,
      median_ratio_db: null,
      max_ratio_db: null,
    });
  } finally {
    await rmTmp(ws);
  }
});

test('many rows stay in report.json only; the result keeps the summary', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'bed.wav', noise(1.3, 0.1));
    await writeWavFile(ws, 'tick.wav', tone(0.005, 0.3));
    const clips = Array.from({ length: 120 }, (_, i) => ({ src: 'tick.wav', at: i * 0.01 }));
    const run = await runTool(
      'audio.mix',
      {
        duration_s: 1.3,
        cues: { reference: 'music' },
        tracks: [
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
          { name: 'sfx', clips },
        ],
      },
      { workspace: ws },
    );
    assert.equal(run.result.cues, undefined, 'more than 100 rows are not copied into the result');
    assert.equal(run.result.cues_summary.rows, 120);
    const report = await readReport(run);
    assert.equal(report.cues.length, 120);
    assert.deepEqual(report.cues_summary, run.result.cues_summary);
  } finally {
    await rmTmp(ws);
  }
});

test('without cues the result and report.json are unchanged', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'bed.wav', noise(1, 0.1));
    await writeWavFile(ws, 'hit.wav', tone(0.2, 0.3));
    const run = await runTool(
      'audio.mix',
      {
        duration_s: 1,
        tracks: [
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
          { name: 'sfx', clips: [{ src: 'hit.wav', at: 0.3, name: 'x' }] },
        ],
      },
      { workspace: ws },
    );
    assert.deepEqual(Object.keys(run.result), BASE_KEYS);
    assert.deepEqual(await readReport(run), run.result, 'report.json is the result');
  } finally {
    await rmTmp(ws);
  }
});
