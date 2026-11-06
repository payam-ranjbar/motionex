import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const TONE = { sine: { freq: 1000, seconds: 3, amplitude_db: -20, channels: 2, sample_rate: 48000 } };

test('audio.loudness: summary of a 1 kHz -20 dBFS tone', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', TONE);
    const { result } = await runTool('audio.loudness', { input: 'tone.wav' }, { workspace: ws });
    assert.ok(Math.abs(result.integrated_lufs - -20) <= 0.3, `integrated ${result.integrated_lufs}`);
    assert.ok(Math.abs(result.sample_peak_dbfs - -20) <= 0.1, `sample peak ${result.sample_peak_dbfs}`);
    assert.ok(Math.abs(result.duration_s - 3) <= 0.05, `duration ${result.duration_s}`);
  } finally {
    await rmTmp(ws);
  }
});

test('audio.loudness: momentary curve every 0.5 s', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'tone.wav', TONE);
    const { result } = await runTool(
      'audio.loudness',
      { input: 'tone.wav', curve: { step_s: 0.5 } },
      {
        workspace: ws,
      },
    );
    assert.ok(Array.isArray(result.curve));
    assert.equal(result.curve.length, 6);
    assert.equal(result.curve[0].t, 0.4);
  } finally {
    await rmTmp(ws);
  }
});
