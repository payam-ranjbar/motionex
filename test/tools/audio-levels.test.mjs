// audio.levels / audio.speech-ratio: windowed level measurement and speech-to-background ratio.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { highpass } from '../../src/lib/biquad.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

let ws;

before(async () => {
  ws = await mkTmp('mx-levels-');
});

after(async () => {
  await rmTmp(ws);
});

// --- biquad ---------------------------------------------------------------

test('biquad: a 300 Hz high-pass attenuates 100 Hz and passes 1 kHz', needs('ffmpeg'), () => {
  const sr = 48000;
  const n = sr; // 1 s
  const rmsAfter = (samples, from) => {
    let sum = 0;
    for (let i = from; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (samples.length - from));
  };
  const attenuationDb = (freq) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / sr);
    const y = highpass(x, sr, 300);
    const from = Math.round(0.1 * sr);
    return 20 * Math.log10(rmsAfter(y, from) / rmsAfter(x, from));
  };
  const low = attenuationDb(100);
  const mid = attenuationDb(1000);
  assert.ok(Math.abs(low - -19) <= 1.5, `100 Hz attenuation should be -19 +/- 1.5 dB, got ${low.toFixed(2)}`);
  assert.ok(mid > -0.5, `1 kHz attenuation should be under 0.5 dB, got ${mid.toFixed(2)}`);
});

// --- audio.levels ---------------------------------------------------------

test('audio.levels: step_s 1 on 3 s gives 3 rows with sine levels', needs('ffmpeg'), async () => {
  await writeFixture(ws, 'tone3.wav', { sine: { freq: 1000, seconds: 3, amplitude_db: -20 } });
  const { result } = await runTool('audio.levels', { input: 'tone3.wav', step_s: 1 }, { workspace: ws });
  assert.equal(result.rows.length, 3);
  assert.ok(Math.abs(result.rows[0].rms_db - -23.0) <= 0.1, `rms_db ${result.rows[0].rms_db}`);
  assert.ok(Math.abs(result.rows[0].peak_db - -20) <= 0.1, `peak_db ${result.rows[0].peak_db}`);
});

test('audio.levels: grid per beat gives ceil(3 / 0.5) = 6 rows', needs('ffmpeg'), async () => {
  const { result } = await runTool(
    'audio.levels',
    { input: 'tone3.wav', grid: { bpm: 120, per: 'beat' } },
    { workspace: ws },
  );
  assert.equal(result.rows.length, 6);
});

test('audio.levels: string windows resolve against a timeline', needs('ffmpeg'), async () => {
  await writeFixture(ws, 'timeline.json', {
    json: { scenes: [{ id: 'a', start: 0.5, dur: 1, cues: [] }] },
  });
  const { result } = await runTool(
    'audio.levels',
    {
      input: 'tone3.wav',
      timeline: 'timeline.json',
      windows: [{ name: 'scene-a', from: 'a', to: 'a+1' }],
    },
    { workspace: ws },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].from, 0.5);
  assert.equal(result.rows[0].to, 1.5);
  assert.equal(result.rows[0].name, 'scene-a');
});

test('audio.levels: step_s and grid together are rejected', needs('ffmpeg'), async () => {
  await assert.rejects(
    runTool('audio.levels', { input: 'tone3.wav', step_s: 1, grid: { bpm: 120 } }, { workspace: ws }),
    (e) => e.type === 'invalid-input',
  );
});

// --- audio.speech-ratio ---------------------------------------------------

test('audio.speech-ratio: 1 kHz voice over a 100 Hz bed is ~19 dB', needs('ffmpeg'), async () => {
  await writeFixture(ws, 'voice1k.wav', {
    sine: { freq: 1000, seconds: 2, amplitude_db: -20, channels: 1 },
  });
  await writeFixture(ws, 'bed100.wav', { sine: { freq: 100, seconds: 2, amplitude_db: -20, channels: 1 } });
  const { result } = await runTool(
    'audio.speech-ratio',
    { voice: 'voice1k.wav', background: 'bed100.wav', windows: [{ from: 0, to: 2 }] },
    { workspace: ws },
  );
  const ratio = result.rows[0].ratio_db;
  assert.ok(ratio >= 17 && ratio <= 21, `ratio_db should be 17..21, got ${ratio}`);
});

test('audio.speech-ratio: 1 kHz voice over a 1 kHz bed is ~0 dB', needs('ffmpeg'), async () => {
  await writeFixture(ws, 'bed1k.wav', { sine: { freq: 1000, seconds: 2, amplitude_db: -20, channels: 1 } });
  const { result } = await runTool(
    'audio.speech-ratio',
    { voice: 'voice1k.wav', background: 'bed1k.wav', windows: [{ from: 0, to: 2 }] },
    { workspace: ws },
  );
  const ratio = result.rows[0].ratio_db;
  assert.ok(Math.abs(ratio) <= 1, `ratio_db should be 0 +/- 1, got ${ratio}`);
});

test('audio.speech-ratio: automatic windows split on a long gap', needs('ffmpeg'), async () => {
  await writeFixture(ws, 'lines.wav', {
    concat: [
      { sine: { freq: 1000, seconds: 1, amplitude_db: -20, channels: 1 } },
      { silence: { seconds: 0.5, channels: 1 } },
      { sine: { freq: 1000, seconds: 1, amplitude_db: -20, channels: 1 } },
    ],
  });
  const { result } = await runTool(
    'audio.speech-ratio',
    { voice: 'lines.wav', background: 'bed100.wav' },
    { workspace: ws },
  );
  assert.deepEqual(
    result.rows.map((r) => r.name),
    ['line-1', 'line-2'],
  );
});

test('audio.speech-ratio: a short gap merges into one window', needs('ffmpeg'), async () => {
  await writeFixture(ws, 'lines2.wav', {
    concat: [
      { sine: { freq: 1000, seconds: 1, amplitude_db: -20, channels: 1 } },
      { silence: { seconds: 0.1, channels: 1 } },
      { sine: { freq: 1000, seconds: 1, amplitude_db: -20, channels: 1 } },
    ],
  });
  const { result } = await runTool(
    'audio.speech-ratio',
    { voice: 'lines2.wav', background: 'bed100.wav' },
    { workspace: ws },
  );
  assert.equal(result.rows.length, 1);
});
