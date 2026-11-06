import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const TONE = { sine: { freq: 1000, seconds: 3, amplitude_db: -20, channels: 2, sample_rate: 48000 } };

// 0.5 s silence + 1 s tone + 0.5 s silence + 1 s tone + 0.3 s silence = 3.3 s at 48 kHz.
const GAPPED = {
  concat: [
    { silence: { seconds: 0.5, sample_rate: 48000 } },
    { sine: { freq: 1000, seconds: 1, amplitude_db: -20, sample_rate: 48000 } },
    { silence: { seconds: 0.5, sample_rate: 48000 } },
    { sine: { freq: 1000, seconds: 1, amplitude_db: -20, sample_rate: 48000 } },
    { silence: { seconds: 0.3, sample_rate: 48000 } },
  ],
};

test('audio.stats: levels of a 1 kHz -20 dBFS tone', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', TONE);
    const { result } = await runTool('audio.stats', { input: 'tone.wav' }, { workspace: ws });
    assert.ok(Math.abs(result.rmsDb - -23.0) <= 0.2, `rmsDb ${result.rmsDb}`);
    assert.ok(Math.abs(result.peakDb - -20.0) <= 0.2, `peakDb ${result.peakDb}`);
    assert.ok(Math.abs(result.seconds - 3) <= 0.01, `seconds ${result.seconds}`);
  } finally {
    await rmTmp(ws);
  }
});

test('audio.stats: bpm gives a per-cycle breakdown', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', TONE);
    // bpm 120 at 4 beats per cycle -> cps 0.5 -> 2 s cycles -> ceil(3 / 2) = 2 cycles.
    const { result } = await runTool('audio.stats', { input: 'tone.wav', bpm: 120 }, { workspace: ws });
    assert.equal(result.perCycle.length, 2);
    assert.deepEqual(
      result.perCycle.map((c) => c.cycle),
      [0, 1],
    );
  } finally {
    await rmTmp(ws);
  }
});

test('audio.stats: cps and bpm together are rejected', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', TONE);
    await assert.rejects(
      runTool('audio.stats', { input: 'tone.wav', cps: 0.5, bpm: 120 }, { workspace: ws }),
      (e) => e.type === 'invalid-input',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('audio.silence: leading, middle and trailing silences plus speech end', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'clip.wav', GAPPED);
    const { result } = await runTool('audio.silence', { input: 'clip.wav' }, { workspace: ws });
    assert.ok(Math.abs(result.leading_s - 0.5) <= 0.01, `leading_s ${result.leading_s}`);
    assert.ok(Math.abs(result.trailing_s - 0.3) <= 0.01, `trailing_s ${result.trailing_s}`);
    const middle = result.silences.find((s) => Math.abs(s.start - 1.5) <= 0.01 && Math.abs(s.end - 2.0) <= 0.01);
    assert.ok(middle, `no 1.5-2.0 silence in ${JSON.stringify(result.silences)}`);
    // The last tone ends at 3.0 s; speechEnd adds a 30 ms tail.
    assert.ok(Math.abs(result.speech_end_s - 3.0) <= 0.04, `speech_end_s ${result.speech_end_s}`);
  } finally {
    await rmTmp(ws);
  }
});

test('audio.silence: a silence shorter than min_duration_s is not reported', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'clip.wav', {
      concat: [
        { silence: { seconds: 0.5, sample_rate: 48000 } },
        { sine: { freq: 1000, seconds: 0.5, amplitude_db: -20, sample_rate: 48000 } },
        { silence: { seconds: 0.05, sample_rate: 48000 } },
        { sine: { freq: 1000, seconds: 0.5, amplitude_db: -20, sample_rate: 48000 } },
      ],
    });
    const { result } = await runTool('audio.silence', { input: 'clip.wav', min_duration_s: 0.1 }, { workspace: ws });
    assert.deepEqual(
      result.silences.map((s) => [s.start, s.end]),
      [[0, 0.5]],
    );
  } finally {
    await rmTmp(ws);
  }
});
