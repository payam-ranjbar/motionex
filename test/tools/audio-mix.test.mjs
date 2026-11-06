// audio.mix: sample-accurate placement, exact length, pan law, neutral sum, buses/mute, timespecs,
// decode cache speed, extra outputs and errors.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { integratedLufs } from '../../src/lib/loudness.mjs';
import { mixInto, panGains } from '../../src/lib/mix/clips.mjs';
import { db, peak } from '../../src/lib/signal.mjs';
import { encodeWav, readWav } from '../../src/lib/wav.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const SR = 48000;

/** Write raw channel arrays to a WAV fixture in the workspace. */
async function writeWavFile(ws, rel, channels, { sampleRate = SR, format = 'f32' } = {}) {
  const abs = path.join(ws, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodeWav({ sampleRate, channels }, { format }));
  return rel;
}

const sineCh = (len, freq, amp, nch = 1) =>
  Array.from({ length: nch }, () =>
    Float32Array.from({ length: len }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR)),
  );
const cosineCh = (len, freq, amp, nch = 1) =>
  Array.from({ length: nch }, () =>
    Float32Array.from({ length: len }, (_, i) => amp * Math.cos((2 * Math.PI * freq * i) / SR)),
  );

/** An N-sample stereo impulse turned on from index `at` for `len` samples. */
function impulseCh(total, at, value = 0.5, len = 10) {
  return Array.from({ length: 2 }, () => {
    const ch = new Float32Array(total);
    for (let i = at; i < Math.min(total, at + len); i++) ch[i] = value;
    return ch;
  });
}

/** Read a named output of a run. */
async function readOutput(run, name = 'mix.wav') {
  const out = run.outputs.find((o) => o.name === name);
  assert.ok(out, `output "${name}" is missing (got ${run.outputs.map((o) => o.name).join(', ')})`);
  return readWav(await readFile(out.abs));
}

const names = (run) => run.outputs.map((o) => o.name);

test('panGains and mixInto are pure and obey the laws', () => {
  const q = Math.cos(Math.PI / 4);
  const g = panGains(0, 1, 2);
  assert.ok(Math.abs(g[0][0] - q) < 1e-12);
  assert.ok(Math.abs(g[1][0] - Math.sin(Math.PI / 4)) < 1e-12);
  assert.deepEqual(panGains(0, 2, 2), [
    [1, 0],
    [0, 1],
  ]);
  assert.deepEqual(panGains(-1, 1, 2), [[1], [0]]);
  assert.deepEqual(panGains(0, 2, 1), [[0.5, 0.5]]);
  const dst = [new Float32Array(4), new Float32Array(4)];
  mixInto(dst, [Float32Array.from([1, 2])], 1);
  assert.deepEqual(dst[0], Float32Array.from([0, 1, 2, 0]));
});

test('places clips at exact sample indices', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'imp.wav', impulseCh(10, 0));
    const run = await runTool(
      'audio.mix',
      {
        tracks: [
          {
            name: 't',
            clips: [
              { src: 'imp.wav', at: 0.5 },
              { src: 'imp.wav', at: 1.25 },
            ],
          },
        ],
      },
      { workspace: ws },
    );
    const out = await readOutput(run);
    assert.equal(out.channels.length, 2);
    const L = out.channels[0];
    assert.equal(L.length, 60010, 'length is the latest clip end');
    assert.equal(run.result.samples, 60010);
    assert.equal(L[23999], 0);
    assert.equal(L[24000], 0.5);
    assert.equal(L[24009], 0.5);
    assert.equal(L[24010], 0);
    assert.equal(L[60000], 0.5);
    assert.equal(L[60009], 0.5);
  } finally {
    await rmTmp(ws);
  }
});

test('fixes the output length exactly', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'imp.wav', impulseCh(10, 0));
    const fixed = await runTool(
      'audio.mix',
      { duration_s: 2.5, tracks: [{ name: 't', clips: [{ src: 'imp.wav', at: 0.1 }] }] },
      { workspace: ws },
    );
    const outFixed = await readOutput(fixed);
    assert.equal(outFixed.channels[0].length, 120000);
    assert.equal(fixed.result.samples, 120000);
    assert.equal(fixed.result.duration_s, 2.5);

    const auto = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', clips: [{ src: 'imp.wav', at: 0.1 }] }] },
      { workspace: ws },
    );
    assert.equal(auto.result.samples, Math.round(0.1 * SR) + 10);
  } finally {
    await rmTmp(ws);
  }
});

test('honours offset_s/duration_s and linear fades', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    // 3 s stereo file with a 0.6 marker at 0.5 s.
    const src = [new Float32Array(3 * SR), new Float32Array(3 * SR)];
    for (const ch of src) ch[Math.round(0.5 * SR)] = 0.6;
    await writeWavFile(ws, 'marker.wav', src);
    const cut = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', clips: [{ src: 'marker.wav', at: 0, offset_s: 0.5, duration_s: 1 }] }] },
      { workspace: ws },
    );
    const cutOut = await readOutput(cut);
    assert.equal(cutOut.channels[0].length, SR, 'one second of source');
    assert.ok(Math.abs(cutOut.channels[0][0] - Math.fround(0.6)) < 1e-6, 'marker at source 0.5 s starts the clip');
    assert.equal(cutOut.channels[0][24000], 0, 'offset was applied, marker not repeated at 0.5 s');

    await writeWavFile(ws, 'tone.wav', cosineCh(SR * 0.2, 1000, 0.5, 2));
    const faded = await runTool(
      'audio.mix',
      {
        tracks: [{ name: 't', clips: [{ src: 'tone.wav', at: 0, fade_in_s: 0.001, fade_out_s: 0.001 }] }],
      },
      { workspace: ws },
    );
    const fadedOut = await readOutput(faded);
    const len = fadedOut.channels[0].length;
    assert.equal(fadedOut.channels[0][0], 0, 'fade-in starts at 0');
    assert.equal(fadedOut.channels[0][len - 1], 0, 'fade-out ends at 0');
    assert.ok(Math.abs(fadedOut.channels[0][Math.floor(len / 2)]) > 0.3, 'middle is not faded');
  } finally {
    await rmTmp(ws);
  }
});

// Found in a real episode: a music clip longer than the mix had fade_out_s 0.35, but the fade sat at the
// clip's own end, which the mix cut off, so the audible end was a hard cut.
const peakBetween = (ch, fromS, toS, sr = SR) => {
  let p = 0;
  for (let i = Math.round(fromS * sr); i < Math.min(ch.length, Math.round(toS * sr)); i++) {
    p = Math.max(p, Math.abs(ch[i]));
  }
  return p;
};

test('a fade-out ends at the mix cut when duration_s truncates the clip', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    // 2 s of a 100 Hz stereo sine at 0.5 into a mix that is only 1.5 s long (stereo so the pan law is the
    // identity at pan 0 and the level is the raw amplitude).
    await writeWavFile(ws, 'bed.wav', sineCh(SR * 2, 100, 0.5, 2));
    const faded = await runTool(
      'audio.mix',
      { duration_s: 1.5, tracks: [{ name: 'music', clips: [{ src: 'bed.wav', at: 0, fade_out_s: 0.5 }] }] },
      { workspace: ws },
    );
    const ch = (await readOutput(faded)).channels[0];
    assert.equal(ch.length, Math.round(1.5 * SR), 'the mix length is duration_s');
    const full = peakBetween(ch, 0.8, 1.0);
    assert.ok(Math.abs(full - 0.5) < 0.01, `0.9 s should still be full level, got ${full}`);
    const last = peakBetween(ch, 1.49, 1.5);
    assert.ok(last < 0.02, `the last samples should be near silent, got ${last}`);
    assert.equal(ch[ch.length - 1], 0, 'the fade-out ends on the last audible sample');
    const ramp = [peakBetween(ch, 1.0, 1.1), peakBetween(ch, 1.2, 1.3), peakBetween(ch, 1.4, 1.5)];
    assert.ok(ramp[0] > ramp[1] && ramp[1] > ramp[2], `the fade should fall over 1.0-1.5 s, got ${ramp.join(', ')}`);
    assert.ok(
      faded.result.warnings.some((w) => /clip 0 extends past the mix length and was truncated/.test(w)),
      JSON.stringify(faded.result.warnings),
    );
    assert.ok(
      faded.result.warnings.some((w) => /its 0\.5 s fade-out was applied at the cut/.test(w)),
      JSON.stringify(faded.result.warnings),
    );

    // No fade requested: the same cut stays a hard cut (no fade is added behind the agent's back).
    const hard = await runTool(
      'audio.mix',
      { duration_s: 1.5, tracks: [{ name: 'music', clips: [{ src: 'bed.wav', at: 0 }] }] },
      { workspace: ws },
    );
    const hardCh = (await readOutput(hard)).channels[0];
    const hardLast = peakBetween(hardCh, 1.45, 1.5);
    assert.ok(hardLast > 0.49, `fade_out_s 0 still ends at full level, got ${hardLast}`);
    assert.notEqual(hardCh[hardCh.length - 1], 0, 'the last sample is untouched (no fade was added)');
    assert.ok(
      hard.result.warnings.every((w) => !/fade-out was applied/.test(w)),
      JSON.stringify(hard.result.warnings),
    );
  } finally {
    await rmTmp(ws);
  }
});

test('pan law: stereo identity, mono equal-power, hard left', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    // Stereo identity at pan 0.
    const stereo = sineCh(SR * 0.5, 440, 0.5, 2);
    await writeWavFile(ws, 'stereo.wav', stereo);
    const ident = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', clips: [{ src: 'stereo.wav', at: 0, pan: 0 }] }] },
      { workspace: ws },
    );
    const identOut = await readOutput(ident);
    assert.deepEqual(identOut.channels[0], stereo[0]);
    assert.deepEqual(identOut.channels[1], stereo[1]);

    // Mono at pan 0: equal-power -> -23.01 dBFS per channel and the same LUFS as the mono source.
    const mono = sineCh(SR * 0.5, 440, 0.1, 1);
    await writeWavFile(ws, 'mono.wav', mono);
    const monoRun = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', clips: [{ src: 'mono.wav', at: 0 }] }] },
      { workspace: ws },
    );
    const monoOut = await readOutput(monoRun);
    for (const ch of monoOut.channels)
      assert.ok(Math.abs(db(peak({ sampleRate: SR, channels: [ch] })) - -23.01) < 0.05);
    assert.ok(Math.abs(integratedLufs(monoOut) - integratedLufs({ sampleRate: SR, channels: mono })) < 0.2);

    // Hard left: all energy on L.
    const leftRun = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', clips: [{ src: 'mono.wav', at: 0, pan: -1 }] }] },
      { workspace: ws },
    );
    const leftOut = await readOutput(leftRun);
    assert.ok(peak({ sampleRate: SR, channels: [leftOut.channels[0]] }) > 0.09);
    assert.ok(peak({ sampleRate: SR, channels: [leftOut.channels[1]] }) < 1e-6);
  } finally {
    await rmTmp(ws);
  }
});

test('track fx volume=6dB adds 6 dB', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sineCh(SR * 0.5, 440, 0.1, 1));
    const dry = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', clips: [{ src: 'tone.wav', at: 0 }] }] },
      { workspace: ws },
    );
    const wet = await runTool(
      'audio.mix',
      { tracks: [{ name: 't', fx: 'volume=6dB', clips: [{ src: 'tone.wav', at: 0 }] }] },
      { workspace: ws },
    );
    const p1 = peak(await readOutput(dry));
    const p2 = peak(await readOutput(wet));
    assert.ok(Math.abs(db(p2) - db(p1) - 6) < 0.1, `expected +6 dB, got ${db(p2) - db(p1)}`);
  } finally {
    await rmTmp(ws);
  }
});

test('default is a plain float sum (no clipping, no master)', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const loud = sineCh(SR * 0.5, 440, 0.8, 2);
    await writeWavFile(ws, 'loud.wav', loud);
    const run = await runTool(
      'audio.mix',
      {
        tracks: [
          { name: 'a', clips: [{ src: 'loud.wav', at: 0 }] },
          { name: 'b', clips: [{ src: 'loud.wav', at: 0 }] },
        ],
      },
      { workspace: ws },
    );
    const out = await readOutput(run);
    assert.ok(Math.abs(peak(out) - 1.6) < 0.01, `expected a 1.6 float peak, got ${peak(out)}`);
    assert.equal(run.result.master, null);
    assert.deepEqual(run.result.warnings, []);
  } finally {
    await rmTmp(ws);
  }
});

test('mono output has one channel', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sineCh(SR * 0.3, 440, 0.5, 2));
    const run = await runTool(
      'audio.mix',
      { channels: 1, tracks: [{ name: 't', clips: [{ src: 'tone.wav', at: 0 }] }] },
      { workspace: ws },
    );
    const out = await readOutput(run);
    assert.equal(out.channels.length, 1);
    assert.equal(run.result.channels, 1);
  } finally {
    await rmTmp(ws);
  }
});

test('buses apply their gain, mute contributes nothing', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'a.wav', sineCh(SR * 0.3, 300, 0.1, 2));
    await writeWavFile(ws, 'b.wav', sineCh(SR * 0.3, 500, 0.1, 2));
    await writeWavFile(ws, 'loud.wav', sineCh(SR * 0.3, 700, 0.5, 2));
    const tracks = [
      { name: 'a', bus: 'b', clips: [{ src: 'a.wav', at: 0 }] },
      { name: 'b', bus: 'b', clips: [{ src: 'b.wav', at: 0 }] },
    ];
    const dry = await runTool('audio.mix', { buses: [{ name: 'b' }], tracks }, { workspace: ws });
    const wet = await runTool(
      'audio.mix',
      {
        buses: [{ name: 'b', gain_db: -6 }],
        tracks: [...tracks, { name: 'm', mute: true, clips: [{ src: 'loud.wav', at: 0 }] }],
      },
      { workspace: ws },
    );
    const p1 = peak(await readOutput(dry));
    const p2 = peak(await readOutput(wet));
    assert.ok(Math.abs(db(p2) - db(p1) + 6) < 0.1, `expected -6 dB, got ${db(p2) - db(p1)}`);
  } finally {
    await rmTmp(ws);
  }
});

test('track_defaults apply under the track (the request wins)', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sineCh(SR * 0.2, 440, 0.5, 1));
    const clip = { src: 'tone.wav', at: 0 };
    const base = await runTool('audio.mix', { tracks: [{ name: 't', clips: [clip] }] }, { workspace: ws });
    const withDefault = await runTool(
      'audio.mix',
      { track_defaults: { t: { gain_db: -6 } }, tracks: [{ name: 't', clips: [clip] }] },
      { workspace: ws },
    );
    const override = await runTool(
      'audio.mix',
      { track_defaults: { t: { gain_db: -6 } }, tracks: [{ name: 't', gain_db: -12, clips: [clip] }] },
      { workspace: ws },
    );
    const p0 = peak(await readOutput(base));
    const p1 = peak(await readOutput(withDefault));
    const p2 = peak(await readOutput(override));
    assert.ok(Math.abs(db(p1) - db(p0) + 6) < 0.05, 'track_defaults gain is applied');
    assert.ok(Math.abs(db(p2) - db(p0) + 12) < 0.05, 'the request track wins over track_defaults');
  } finally {
    await rmTmp(ws);
  }
});

test('resolves a string timespec through a timeline', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'imp.wav', impulseCh(10, 0));
    await writeFixture(ws, 'timeline.json', { json: { scenes: [{ id: 'b', start: 1, dur: 1, cues: [] }] } });
    const run = await runTool(
      'audio.mix',
      { timeline: 'timeline.json', tracks: [{ name: 't', clips: [{ src: 'imp.wav', at: 'b' }] }] },
      { workspace: ws },
    );
    const out = await readOutput(run);
    assert.equal(out.channels[0].length, 48010);
    assert.equal(out.channels[0][47999], 0);
    assert.equal(out.channels[0][48000], 0.5);
    assert.equal(out.channels[0][48009], 0.5);
  } finally {
    await rmTmp(ws);
  }
});

test('decode cache mixes 300 clips quickly', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'small.wav', sineCh(Math.round(SR * 0.005), 1000, 0.2, 2));
    const clips = [];
    for (let i = 0; i < 300; i++) clips.push({ src: 'small.wav', at: i * 0.001 });
    const started = Date.now();
    const run = await runTool(
      'audio.mix',
      { duration_s: 0.5, tracks: [{ name: 't', clips }] },
      { workspace: ws, timeoutMs: 60000 },
    );
    const elapsed = Date.now() - started;
    assert.equal(run.result.samples, 24000);
    assert.ok(elapsed < 20000, `300 cached clips took ${elapsed} ms`);
  } finally {
    await rmTmp(ws);
  }
});

test('rejects an unknown bus and a forbidden fx chain', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'imp.wav', impulseCh(10, 0));
    await assert.rejects(
      () =>
        runTool(
          'audio.mix',
          { tracks: [{ name: 't', bus: 'nope', clips: [{ src: 'imp.wav', at: 0 }] }] },
          { workspace: ws },
        ),
      (e) => {
        assert.equal(e.type, 'invalid-input');
        return true;
      },
    );
    await assert.rejects(
      () =>
        runTool(
          'audio.mix',
          { tracks: [{ name: 't', clips: [{ src: 'imp.wav', at: 0, fx: 'amovie=x' }] }] },
          { workspace: ws },
        ),
      (e) => {
        assert.equal(e.type, 'invalid-input');
        return true;
      },
    );
    await assert.rejects(
      () => runTool('audio.mix', { tracks: [{ name: 't' }] }, { workspace: ws }),
      (e) => {
        assert.equal(e.type, 'invalid-input');
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});

test('writes stems and a preview mp3', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'tone.wav', sineCh(SR * 0.3, 440, 0.3, 2));
    const run = await runTool(
      'audio.mix',
      {
        output: { stems: true, preview_mp3: true },
        tracks: [{ name: 't', clips: [{ src: 'tone.wav', at: 0 }] }],
      },
      { workspace: ws },
    );
    const got = names(run);
    assert.ok(got.includes('mix.wav'), got.join(', '));
    assert.ok(got.includes('stems/t.wav'), got.join(', '));
    assert.ok(got.includes('preview.mp3'), got.join(', '));
    assert.ok(got.includes('report.json'), got.join(', '));
    const reportFile = JSON.parse(await readFile(run.outputs.find((o) => o.name === 'report.json').abs, 'utf8'));
    assert.equal(reportFile.samples, run.result.samples);
  } finally {
    await rmTmp(ws);
  }
});
