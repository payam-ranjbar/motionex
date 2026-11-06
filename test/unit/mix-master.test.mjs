import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integratedLufs } from '../../src/lib/loudness.mjs';
import { applyMaster } from '../../src/lib/mix/master.mjs';
import { db, fromDb, mulberry32, peak } from '../../src/lib/signal.mjs';
import { needs } from '../helpers/needs.mjs';

const SR = 48000;

/** Pink-ish noise: white noise from mulberry32 through a one-pole low-pass, per channel. */
function pinkNoise({ seconds = 6, sampleRate = SR, channels = 2, seed = 7, amplitude = 0.05 } = {}) {
  const n = Math.round(seconds * sampleRate);
  return {
    sampleRate,
    channels: Array.from({ length: channels }, (_, c) => {
      const r = mulberry32(seed + c * 101);
      const arr = new Float32Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const white = r() * 2 - 1;
        prev = 0.9 * prev + 0.1 * white;
        arr[i] = prev * amplitude;
      }
      return arr;
    }),
  };
}

/** Noise scaled so its JS integrated loudness is exactly `target` LUFS. */
function noiseAtLufs(target, spec = {}) {
  const audio = pinkNoise(spec);
  const i = integratedLufs(audio);
  assert.ok(i != null, 'fixture loudness is measurable');
  const g = fromDb(target - i);
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((ch) => Float32Array.from(ch, (x) => x * g)),
  };
}

test('gain+limiter hits the target, stays under the true-peak ceiling, keeps its length', needs('ffmpeg'), async () => {
  const input = noiseAtLufs(-30, { seconds: 6, channels: 2, seed: 11 });
  const n = input.channels[0].length;
  const { audio, report } = await applyMaster(input, {
    loudness: { target_lufs: -16, true_peak_db: -1.5, method: 'gain+limiter' },
  });
  assert.equal(audio.channels[0].length, n, 'length unchanged');
  assert.equal(audio.channels.length, 2, 'channel count unchanged');
  assert.equal(audio.sampleRate, SR, 'sample rate unchanged');
  assert.ok(
    Math.abs(report.after.integrated_lufs - -16) <= 0.5,
    `integrated ${report.after.integrated_lufs}, expected -16 +/- 0.5`,
  );
  assert.ok(report.after.true_peak_dbtp <= -1.3, `true peak ${report.after.true_peak_dbtp}, expected <= -1.3`);
});

test('alimiter latency=1 does not shift a 1-sample impulse in time', needs('ffmpeg'), async () => {
  const input = noiseAtLufs(-30, { seconds: 2, channels: 2, seed: 3 });
  const impulseAt = SR; // exactly 1.0 s
  for (const ch of input.channels) ch[impulseAt] = 0.9;
  const { audio } = await applyMaster(input, {
    loudness: { target_lufs: -16, true_peak_db: -1.5, method: 'gain+limiter' },
  });
  let maxAt = 0;
  let max = 0;
  for (let i = 0; i < audio.channels[0].length; i++) {
    const a = Math.abs(audio.channels[0][i]);
    if (a > max) {
      max = a;
      maxAt = i;
    }
  }
  assert.ok(Math.abs(maxAt - impulseAt) <= 1, `peak at sample ${maxAt}, expected ${impulseAt} +/- 1`);
});

test('loudnorm reaches the target at 48 kHz and keeps its length', needs('ffmpeg'), async () => {
  const input = noiseAtLufs(-25, { seconds: 6, channels: 2, seed: 5 });
  const n = input.channels[0].length;
  const { audio, report } = await applyMaster(input, { loudness: { target_lufs: -14, method: 'loudnorm' } });
  assert.equal(audio.channels[0].length, n, 'length unchanged');
  assert.equal(audio.sampleRate, SR, 'sample rate still 48000');
  assert.equal(audio.channels.length, 2, 'channel count unchanged');
  assert.ok(
    Math.abs(report.after.integrated_lufs - -14) <= 1,
    `integrated ${report.after.integrated_lufs}, expected -14 +/- 1`,
  );
});

test('loudnorm keeps a mono input mono', needs('ffmpeg'), async () => {
  const input = noiseAtLufs(-25, { seconds: 6, channels: 1, seed: 9 });
  const n = input.channels[0].length;
  const { audio } = await applyMaster(input, { loudness: { target_lufs: -14, method: 'loudnorm' } });
  assert.equal(audio.channels.length, 1, 'still one channel');
  assert.equal(audio.channels[0].length, n, 'length unchanged');
  assert.equal(audio.sampleRate, SR, 'sample rate still 48000');
});

test('master fx alone applies the chain (volume=-6dB lowers the peak by 6 dB)', needs('ffmpeg'), async () => {
  const input = noiseAtLufs(-20, { seconds: 3, channels: 2, seed: 2 });
  const beforePeak = db(peak(input));
  const { audio } = await applyMaster(input, { fx: 'volume=-6dB' });
  const afterPeak = db(peak(audio));
  assert.ok(Math.abs(afterPeak - beforePeak - -6) <= 0.1, `peak ${beforePeak} -> ${afterPeak}, expected -6 dB`);
  assert.equal(audio.channels[0].length, input.channels[0].length, 'length unchanged');
});

test('master gain_db raises the peak by exactly that many dB, method is null', needs('ffmpeg'), async () => {
  const input = noiseAtLufs(-20, { seconds: 3, channels: 2, seed: 4 });
  const beforePeak = db(peak(input));
  const { audio, report } = await applyMaster(input, { gain_db: 3 });
  const afterPeak = db(peak(audio));
  assert.ok(Math.abs(afterPeak - beforePeak - 3) <= 0.05, `peak ${beforePeak} -> ${afterPeak}, expected +3 dB`);
  assert.equal(report.method, null);
  assert.ok(Math.abs(report.gain_db - 3) <= 0.01, `report.gain_db ${report.gain_db}`);
});

test('silence plus a loudness target does not crash and reports a warning', needs('ffmpeg'), async () => {
  const input = { sampleRate: SR, channels: [new Float32Array(SR * 2), new Float32Array(SR * 2)] };
  const { audio, report } = await applyMaster(input, {
    loudness: { target_lufs: -14, method: 'gain+limiter' },
  });
  assert.equal(audio.channels[0].length, SR * 2);
  assert.ok(report.warning, 'report.warning is set');
});
