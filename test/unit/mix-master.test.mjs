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

// Found by the headful agent test in Docker: ffmpeg 7.1 prints "[out#0/null …]" and "size=…" lines after the
// loudnorm JSON, which broke pass 1 there while ffmpeg 6.0 on the host passed.
test('loudnorm pass 1 parses ffmpeg 7 output with trailing summary lines', async () => {
  const { parseLoudnormJson } = await import('../../src/lib/mix/master.mjs');
  const stderr = [
    '[Parsed_loudnorm_0 @ 0x7033425e6cc0] ',
    '{',
    '\t"input_i" : "-21.75",',
    '\t"input_tp" : "-18.06",',
    '\t"input_lra" : "0.00",',
    '\t"input_thresh" : "-31.75",',
    '\t"target_offset" : "0.05"',
    '}',
    '[out#0/null @ 0x703344c46700] video:0KiB audio:750KiB subtitle:0KiB other streams:0KiB global headers:0KiB',
    'size=N/A time=00:00:02.00 bitrate=N/A speed= 116x',
  ].join('\n');
  const m = parseLoudnormJson(stderr);
  assert.equal(m.input_i, '-21.75');
  assert.equal(m.target_offset, '0.05');
});

// Found by the headful agent test: on transient-heavy music, one measured gain followed by the limiter landed
// 1.2 LU under the target (-14 asked, -15.2 got). The gain is now corrected until the limited result lands.
test(
  'gain+limiter converges on the target for transient-heavy material (kick-like pulses)',
  needs('ffmpeg'),
  async () => {
    const sr = 48000;
    const n = sr * 8;
    const ch = new Float32Array(n);
    const r = mulberry32(3);
    for (let i = 0; i < n; i++) {
      const tb = (i % (sr / 2)) / sr; // a kick every 0.5 s
      const kick = Math.exp(-tb * 18) * Math.sin(2 * Math.PI * 55 * tb) * 0.9;
      ch[i] = kick + (r() * 2 - 1) * 0.01;
    }
    const audio = { sampleRate: sr, channels: [ch, Float32Array.from(ch)] };
    const { report } = await applyMaster(audio, { loudness: { target_lufs: -11, true_peak_db: -1 } });
    assert.ok(Math.abs(report.after.integrated_lufs + 11) <= 0.5, `I ${report.after.integrated_lufs}`);
    assert.ok(report.after.true_peak_dbtp <= -0.5, `TP ${report.after.true_peak_dbtp}`);
  },
);
