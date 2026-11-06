import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readWav } from '../../src/lib/wav.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

/** Read an output file written by the tool. */
async function readOutput(outputs, name) {
  const hit = outputs.find((o) => o.name === name);
  assert.ok(hit, `no output named "${name}" (got ${outputs.map((o) => o.name).join(', ')})`);
  return readWav(await readFile(hit.abs));
}

/** Runs of frames (seconds) whose peak over all channels stays below threshold, analysed in windows. */
function silenceRuns(audio, { window_s = 0.005, threshold = 0.01 } = {}) {
  const sr = audio.sampleRate;
  const win = Math.max(1, Math.round(window_s * sr));
  const len = audio.channels[0]?.length ?? 0;
  const runs = [];
  let start = null;
  for (let from = 0; from < len; from += win) {
    const to = Math.min(len, from + win);
    let p = 0;
    for (const ch of audio.channels)
      for (let i = from; i < to; i++) {
        const a = Math.abs(ch[i]);
        if (a > p) p = a;
      }
    const quiet = p < threshold;
    if (quiet && start === null) start = from;
    else if (!quiet && start !== null) {
      runs.push([start / sr, from / sr]);
      start = null;
    }
  }
  if (start !== null) runs.push([start / sr, len / sr]);
  return runs;
}

/** Frequency (Hz) from sign changes of channel 0 between t0 and t1 seconds. */
function freqFromZeroCrossings(audio, t0, t1) {
  const ch = audio.channels[0];
  const a = Math.round(t0 * audio.sampleRate);
  const b = Math.min(ch.length, Math.round(t1 * audio.sampleRate));
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (ch[i - 1] < 0 !== ch[i] < 0) crossings++;
  return crossings / 2 / ((b - a) / audio.sampleRate);
}

/** The [0.3 s silence, 0.5 s tone, 1.2 s silence, 0.5 s tone, 0.3 s silence] test signal at 48 kHz. */
const PAUSES = {
  concat: [
    { silence: { seconds: 0.3, channels: 1, sample_rate: 48000 } },
    { sine: { freq: 440, seconds: 0.5, amplitude_db: -12, channels: 1, sample_rate: 48000 } },
    { silence: { seconds: 1.2, channels: 1, sample_rate: 48000 } },
    { sine: { freq: 440, seconds: 0.5, amplitude_db: -12, channels: 1, sample_rate: 48000 } },
    { silence: { seconds: 0.3, channels: 1, sample_rate: 48000 } },
  ],
};

test(
  'audio.process: pitch_semitones -2.6 keeps the duration and lowers 440 Hz to about 377 Hz',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      await writeFixture(ws, 'sine.wav', {
        sine: { freq: 440, seconds: 2, amplitude_db: -12, channels: 1, sample_rate: 22050 },
      });
      const { result, outputs } = await runTool(
        'audio.process',
        { inputs: ['sine.wav'], steps: [{ pitch_semitones: -2.6 }] },
        { workspace: ws },
      );
      assert.equal(result.files.length, 1);
      const f = result.files[0];
      assert.equal(f.name, 'sine.wav');
      assert.equal(f.sample_rate, 22050);
      assert.equal(f.channels, 1);
      assert.ok(Math.abs(f.seconds - 2) <= 0.02, `duration ${f.seconds}`);
      const audio = await readOutput(outputs, 'sine.wav');
      const freq = freqFromZeroCrossings(audio, 0.5, 1.5);
      assert.ok(Math.abs(freq - 377) <= 4, `frequency ${freq.toFixed(2)} Hz`);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('audio.process: tempo 1.4 divides the duration by 1.4', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'sine.wav', {
      sine: { freq: 440, seconds: 2, amplitude_db: -12, channels: 1, sample_rate: 48000 },
    });
    const { result } = await runTool(
      'audio.process',
      { inputs: ['sine.wav'], steps: [{ tempo: 1.4 }] },
      { workspace: ws },
    );
    const expected = 2 / 1.4;
    assert.ok(
      Math.abs(result.files[0].seconds - expected) <= expected * 0.01,
      `duration ${result.files[0].seconds}, expected ${expected}`,
    );
  } finally {
    await rmTmp(ws);
  }
});

test(
  'audio.process: tighten_pauses cuts a 1.2 s pause to 0.4 s and leaves the edges alone',
  needs('ffmpeg'),
  async () => {
    const ws = await mkTmp();
    try {
      await writeFixture(ws, 'pauses.wav', PAUSES);
      const { result, outputs } = await runTool(
        'audio.process',
        { inputs: ['pauses.wav'], steps: [{ tighten_pauses: { max_pause_s: 0.4 } }] },
        { workspace: ws },
      );
      assert.ok(Math.abs(result.files[0].seconds - 2) <= 0.02, `duration ${result.files[0].seconds}`);
      const audio = await readOutput(outputs, 'pauses.wav');
      const runs = silenceRuns(audio);
      assert.equal(runs.length, 3, `silent runs: ${JSON.stringify(runs)}`);
      const [lead, inner, tail] = runs;
      const total = audio.channels[0].length / audio.sampleRate;
      assert.ok(Math.abs(lead[0]) <= 0.01 && Math.abs(lead[1] - 0.3) <= 0.01, `leading ${JSON.stringify(lead)}`);
      assert.ok(Math.abs(inner[1] - inner[0] - 0.4) <= 0.02, `internal pause ${inner[1] - inner[0]}`);
      assert.ok(Math.abs(total - tail[0] - 0.3) <= 0.01, `trailing ${total - tail[0]}`);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('audio.process: trim_silence removes the leading silence but keeps 0.03 s', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'lead.wav', {
      concat: [
        { silence: { seconds: 0.3, channels: 1, sample_rate: 48000 } },
        { sine: { freq: 440, seconds: 1, amplitude_db: -12, channels: 1, sample_rate: 48000 } },
      ],
    });
    const { outputs } = await runTool(
      'audio.process',
      { inputs: ['lead.wav'], steps: [{ trim_silence: {} }] },
      { workspace: ws },
    );
    const runs = silenceRuns(await readOutput(outputs, 'lead.wav'));
    assert.ok(runs.length >= 1, 'expected a leading silence run');
    const lead = runs[0];
    assert.ok(Math.abs(lead[0]) <= 0.005, `leading silence must start at 0, got ${lead[0]}`);
    assert.ok(lead[1] >= 0.02 && lead[1] <= 0.05, `kept ${lead[1]} s of leading silence, expected 0.03`);
  } finally {
    await rmTmp(ws);
  }
});

test('audio.process: gain_db warns about clipping in wav, not in wav32f', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'loud.wav', {
      sine: { freq: 440, seconds: 1, amplitude_db: -6, channels: 1, sample_rate: 48000 },
    });
    const wav = await runTool(
      'audio.process',
      { inputs: ['loud.wav'], steps: [{ gain_db: 12 }], format: 'wav' },
      { workspace: ws },
    );
    assert.equal(wav.result.warnings.length, 1, `warnings: ${JSON.stringify(wav.result.warnings)}`);
    assert.match(wav.result.warnings[0], /clipped/);
    assert.ok(wav.result.files[0].clipped_samples > 0, 'clipped_samples must be counted');
    assert.ok(
      Math.abs(wav.result.files[0].peak_db - 6) <= 0.1,
      `peak ${wav.result.files[0].peak_db} dBFS, expected +6`,
    );

    const flt = await runTool(
      'audio.process',
      { inputs: ['loud.wav'], steps: [{ gain_db: 12 }], format: 'wav32f' },
      { workspace: ws },
    );
    assert.deepEqual(flt.result.warnings, []);
    assert.equal(flt.result.files[0].clipped_samples, 0);
  } finally {
    await rmTmp(ws);
  }
});

test('audio.process: the deep-hero preset runs the SHAPUR chain', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'take.wav', {
      sine: { freq: 180, seconds: 1, amplitude_db: -14, channels: 1, sample_rate: 22050 },
    });
    const { result, outputs } = await runTool(
      'audio.process',
      { inputs: ['take.wav'], preset: 'deep-hero' },
      { workspace: ws },
    );
    const f = result.files[0];
    assert.equal(f.name, 'take.wav');
    assert.equal(f.chain.length, 2, `chain: ${JSON.stringify(f.chain)}`);
    assert.match(f.chain[0], /asetrate=18963,aresample=22050,atempo=/);
    assert.match(f.chain[1], /^bass=g=5:f=110,aecho=/);
    assert.equal(outputs.length, 1);
    // the pitch step keeps the 1 s duration; the aecho in the preset adds an echo tail
    assert.ok(f.seconds >= 1 && f.seconds < 1.3, `duration ${f.seconds}`);
  } finally {
    await rmTmp(ws);
  }
});

test('audio.process: a filter step with amovie is rejected as invalid-input', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'take.wav', {
      sine: { freq: 180, seconds: 0.5, amplitude_db: -14, channels: 1, sample_rate: 22050 },
    });
    await assert.rejects(
      runTool(
        'audio.process',
        { inputs: ['take.wav'], steps: [{ filter: 'amovie=/etc/passwd,volume=1' }] },
        { workspace: ws },
      ),
      (e) => {
        assert.equal(e.type, 'invalid-input', `error type ${e.type}: ${e.message}`);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});
