import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { ebur128, integratedLufs, loudnessCurve, measureAudio, parseEbur128Summary } from '../../src/lib/loudness.mjs';
import { makeAudio, writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const SAMPLE = `[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -35.0 LUFS
    Threshold: -45.0 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -55.0 LUFS
    LRA low:   -55.0 LUFS
    LRA high:  -35.0 LUFS

  Sample peak:
    Peak:      -35.1 dBFS

  True peak:
    Peak:      -35.0 dBFS
`;

test('parseEbur128Summary: reads the summary block', () => {
  assert.deepEqual(parseEbur128Summary(SAMPLE), {
    integrated_lufs: -35,
    lra_lu: 20,
    sample_peak_dbfs: -35.1,
    true_peak_dbtp: -35,
  });
});

test('parseEbur128Summary: -inf becomes null', () => {
  const stderr = SAMPLE.replace('I:         -35.0 LUFS', 'I:  -inf LUFS');
  assert.equal(parseEbur128Summary(stderr).integrated_lufs, null);
});

test('parseEbur128Summary: no Summary block throws tool-failed', () => {
  assert.throws(
    () => parseEbur128Summary('no summary here'),
    (e) => e.type === 'tool-failed',
  );
});

test('integratedLufs: too-short audio is null', () => {
  const audio = makeAudio({ sine: { freq: 1000, seconds: 0.2, amplitude_db: -20, channels: 2, sample_rate: 48000 } });
  assert.equal(integratedLufs(audio), null);
});

const CASES = [
  {
    name: '1 kHz -20 dBFS stereo 48 kHz',
    spec: { sine: { freq: 1000, seconds: 3, amplitude_db: -20, channels: 2, sample_rate: 48000 } },
  },
  {
    name: '100 Hz -12 dBFS mono 44.1 kHz',
    spec: { sine: { freq: 100, seconds: 3, amplitude_db: -12, channels: 1, sample_rate: 44100 } },
  },
  {
    name: 'white noise -10 dBFS stereo 22.05 kHz',
    spec: { noise: { seconds: 4, amplitude_db: -10, seed: 1, channels: 2, sample_rate: 22050 } },
  },
  {
    name: '2 s silence + 2 s 1 kHz -20 dBFS stereo 48 kHz',
    spec: {
      concat: [
        { silence: { seconds: 2, channels: 2, sample_rate: 48000 } },
        { sine: { freq: 1000, seconds: 2, amplitude_db: -20, channels: 2, sample_rate: 48000 } },
      ],
    },
  },
];

for (const { name, spec } of CASES) {
  test(`JS vs ffmpeg ebur128 (${name})`, needs('ffmpeg'), async () => {
    const ws = await mkTmp();
    try {
      const file = await writeFixture(ws, 'case.wav', spec);
      const reference = await ebur128(file);
      const audio = await decodeAudio(file, { sampleRate: null, channels: null });
      const js = integratedLufs(audio);
      assert.ok(js != null, 'JS integrated loudness is not null');
      assert.ok(
        Math.abs(js - reference.integrated_lufs) <= 0.2,
        `JS ${js} vs ffmpeg ${reference.integrated_lufs} (diff ${Math.abs(js - reference.integrated_lufs)})`,
      );
    } finally {
      await rmTmp(ws);
    }
  });
}

test('1 kHz -20 dBFS reference is about -20 LUFS', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const file = await writeFixture(ws, 'tone.wav', {
      sine: { freq: 1000, seconds: 3, amplitude_db: -20, channels: 2, sample_rate: 48000 },
    });
    const audio = await decodeAudio(file, { sampleRate: null, channels: null });
    const js = integratedLufs(audio);
    assert.ok(Math.abs(js - -20) <= 0.3, `integrated ${js}`);
  } finally {
    await rmTmp(ws);
  }
});

test('measureAudio agrees with ebur128 on the file', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const file = await writeFixture(ws, 'tone.wav', {
      sine: { freq: 1000, seconds: 3, amplitude_db: -20, channels: 2, sample_rate: 48000 },
    });
    const audio = await decodeAudio(file, { sampleRate: null, channels: null });
    const fromMemory = await measureAudio(audio);
    const fromFile = await ebur128(file);
    assert.ok(
      Math.abs(fromMemory.integrated_lufs - fromFile.integrated_lufs) <= 0.1,
      `memory ${fromMemory.integrated_lufs} vs file ${fromFile.integrated_lufs}`,
    );
    assert.ok(Math.abs(fromMemory.duration_s - 3) <= 0.05);
  } finally {
    await rmTmp(ws);
  }
});

test('loudnessCurve: 6 points on a 3 s sine, close to integrated', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const file = await writeFixture(ws, 'tone.wav', {
      sine: { freq: 1000, seconds: 3, amplitude_db: -20, channels: 2, sample_rate: 48000 },
    });
    const audio = await decodeAudio(file, { sampleRate: null, channels: null });
    const reference = integratedLufs(audio);
    const curve = loudnessCurve(audio, { window_s: 0.4, step_s: 0.5 });
    assert.equal(curve.length, 6);
    assert.equal(curve[0].t, 0.4);
    for (const point of curve) {
      assert.ok(point.lufs != null, `point ${point.t} lufs is null`);
      assert.ok(Math.abs(point.lufs - reference) <= 0.3, `point ${point.t}: ${point.lufs} vs ${reference}`);
    }
  } finally {
    await rmTmp(ws);
  }
});
