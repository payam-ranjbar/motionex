// audio.mix dynamics: clip leveling, relative track levels, sidechain compression, and the two mix presets.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ToolError } from '../../src/lib/errors.mjs';
import { ebur128, integratedLufs, kWeight, windowLufs } from '../../src/lib/loudness.mjs';
import { levelClips, trackLevelGains } from '../../src/lib/mix/dynamics.mjs';
import { fromDb, mono, mulberry32, rmsDb } from '../../src/lib/signal.mjs';
import { encodeWav, readWav } from '../../src/lib/wav.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const SR = 48000;

/** Write raw channel arrays to a f32 WAV fixture in the workspace. */
async function writeWavFile(ws, rel, channels, { sampleRate = SR, format = 'f32' } = {}) {
  const abs = path.join(ws, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodeWav({ sampleRate, channels }, { format }));
  return rel;
}

/** Stereo white noise scaled so its integrated loudness is exactly `lufs`. */
function noiseAtLufs(frames, lufs, seed) {
  const r = mulberry32(seed);
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = r() * 2 - 1;
  const channels = [ch, Float32Array.from(ch)];
  const gain = fromDb(lufs - integratedLufs({ sampleRate: SR, channels }));
  for (const c of channels) for (let i = 0; i < frames; i++) c[i] *= gain;
  return { sampleRate: SR, channels };
}

const sineCh = (len, freq, amp, nch = 1) =>
  Array.from({ length: nch }, () =>
    Float32Array.from({ length: len }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR)),
  );

/** Read a stem output of a run. */
async function readStem(run, name) {
  const out = run.outputs.find((o) => o.name === `stems/${name}.wav`);
  assert.ok(out, `stems/${name}.wav is missing (got ${run.outputs.map((o) => o.name).join(', ')})`);
  return readWav(await readFile(out.abs));
}

const outputFile = (run, name) => {
  const out = run.outputs.find((o) => o.name === name);
  assert.ok(out, `output "${name}" is missing (got ${run.outputs.map((o) => o.name).join(', ')})`);
  return out.abs;
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

test('levelClips targets the median, tolerates small gaps and clamps', () => {
  assert.deepEqual(levelClips([-30, -24, -18]), [6, 0, -6]);
  assert.deepEqual(levelClips([-24, -24.5]), [0, 0]);
  assert.deepEqual(levelClips([-40, -20, -20], { max_db: 6 }), [6, 0, 0]);
  // null (silent) clips are left alone; an explicit numeric target is used as-is.
  assert.deepEqual(levelClips([null, -20, -24], { to: -22 }), [0, -2, 2]);
});

test('trackLevelGains resolves relative levels in dependency order and rejects cycles', () => {
  const tracks = [{ name: 'dialogue' }, { name: 'music', level: { relative_to: 'dialogue', lu: -8.3 } }];
  const gains = trackLevelGains(tracks, { dialogue: -20, music: -15 });
  assert.equal(gains.dialogue, 0);
  assert.ok(Math.abs(gains.music - -13.3) < 1e-9, `expected -13.3, got ${gains.music}`);

  // An absolute target.
  assert.ok(Math.abs(trackLevelGains([{ name: 'vo', level: { lufs: -16 } }], { vo: -23 }).vo - 7) < 1e-9);

  assert.throws(
    () =>
      trackLevelGains(
        [
          { name: 'a', level: { relative_to: 'b', lu: -3 } },
          { name: 'b', level: { relative_to: 'a', lu: -3 } },
        ],
        { a: -20, b: -20 },
      ),
    (e) => e instanceof ToolError && e.type === 'invalid-input',
  );
  assert.throws(
    () => trackLevelGains([{ name: 'a', level: { relative_to: 'ghost', lu: -3 } }], { a: -20 }),
    (e) => e instanceof ToolError && e.type === 'invalid-input',
  );
});

// ---------------------------------------------------------------------------
// Through audio.mix
// ---------------------------------------------------------------------------

test('a relative track level lands the stem at dialogue - 8.3 LU', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'vo.wav', { noise: { seconds: 3, amplitude_db: -18, seed: 3 } });
    await writeFixture(ws, 'bed.wav', { sine: { freq: 220, seconds: 3, amplitude_db: -20 } });
    const run = await runTool(
      'audio.mix',
      {
        output: { stems: true },
        tracks: [
          { name: 'dialogue', clips: [{ src: 'vo.wav', at: 0 }] },
          { name: 'music', level: { relative_to: 'dialogue', lu: -8.3 }, clips: [{ src: 'bed.wav', at: 0 }] },
        ],
      },
      { workspace: ws },
    );
    const dialogue = (await ebur128(outputFile(run, 'stems/dialogue.wav'))).integrated_lufs;
    const music = (await ebur128(outputFile(run, 'stems/music.wav'))).integrated_lufs;
    assert.ok(
      Math.abs(dialogue - music - 8.3) < 0.3,
      `dialogue ${dialogue} LUFS, music ${music} LUFS (gap ${dialogue - music})`,
    );
  } finally {
    await rmTmp(ws);
  }
});

test('clip leveling brings three clips to their median', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const targets = [-30, -24, -18];
    const ats = [0, 1.2, 2.4];
    for (let i = 0; i < 3; i++) {
      const audio = noiseAtLufs(SR, targets[i], i + 1);
      await writeWavFile(ws, `c${i}.wav`, audio.channels);
    }
    const run = await runTool(
      'audio.mix',
      {
        duration_s: 3.4,
        output: { stems: true },
        tracks: [
          {
            name: 'dialogue',
            clip_leveling: { to: 'median' },
            clips: [
              { src: 'c0.wav', at: ats[0] },
              { src: 'c1.wav', at: ats[1] },
              { src: 'c2.wav', at: ats[2] },
            ],
          },
        ],
      },
      { workspace: ws },
    );
    const stem = await readStem(run, 'dialogue');
    const kw = kWeight(stem);
    for (let i = 0; i < 3; i++) {
      const lufs = windowLufs(kw, SR, ats[i] + 0.05, ats[i] + 0.95);
      assert.ok(Math.abs(lufs - -24) <= 0.75, `clip ${i} landed at ${lufs} LUFS, expected the -24 median`);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('sidechain ducks the target under the key and leaves the rest alone', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeWavFile(ws, 'key.wav', sineCh(SR, 1000, 0.5, 2));
    await writeFixture(ws, 'noise.wav', { noise: { seconds: 4, amplitude_db: -18, seed: 7 } });
    const tracks = [
      { name: 'target', clips: [{ src: 'noise.wav', at: 0, fx: 'lowpass=f=4000' }] },
      { name: 'key', clips: [{ src: 'key.wav', at: 1 }] },
    ];
    const base = await runTool('audio.mix', { duration_s: 4, output: { stems: true }, tracks }, { workspace: ws });
    const ducked = await runTool(
      'audio.mix',
      {
        duration_s: 4,
        output: { stems: true },
        tracks,
        sidechain: [
          {
            target: 'target',
            key: 'key',
            threshold: 0.05,
            ratio: 8,
            attack_ms: 5,
            release_ms: 100,
            lookahead_s: 0.05,
          },
        ],
      },
      { workspace: ws },
    );
    const ref = mono(await readStem(base, 'target'));
    const out = mono(await readStem(ducked, 'target'));
    const at = (s) => Math.round(s * SR);
    const drop = rmsDb(ref, at(1.2), at(1.8)) - rmsDb(out, at(1.2), at(1.8));
    assert.ok(drop > 3, `expected a >3 dB duck between 1.2 and 1.8 s, got ${drop.toFixed(2)} dB`);
    for (const [a, b] of [
      [0, 0.8],
      [2.6, 4],
    ]) {
      const delta = Math.abs(rmsDb(ref, at(a), at(b)) - rmsDb(out, at(a), at(b)));
      assert.ok(delta < 0.5, `expected <0.5 dB change outside, got ${delta.toFixed(3)} dB in [${a}, ${b}]`);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('dialogue-anchored preset masters three tracks to -16 LUFS', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'vo.wav', { noise: { seconds: 2.5, amplitude_db: -18, seed: 11 } });
    await writeFixture(ws, 'bed.wav', { sine: { freq: 220, seconds: 2.5, amplitude_db: -20 } });
    await writeFixture(ws, 'hit.wav', { noise: { seconds: 0.1, amplitude_db: -12, seed: 12 } });
    const run = await runTool(
      'audio.mix',
      {
        preset: 'dialogue-anchored',
        duration_s: 2.5,
        tracks: [
          { name: 'dialogue', clips: [{ src: 'vo.wav', at: 0 }] },
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
          { name: 'sfx', clips: [{ src: 'hit.wav', at: 1 }] },
        ],
      },
      { workspace: ws },
    );
    const { integrated_lufs } = await ebur128(outputFile(run, 'mix.wav'));
    assert.ok(Math.abs(integrated_lufs - -16) <= 0.5, `master is ${integrated_lufs} LUFS, expected -16 +/- 0.5`);
  } finally {
    await rmTmp(ws);
  }
});

test('a preset sidechain whose target track is absent is skipped with a warning', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'vo.wav', { noise: { seconds: 2, amplitude_db: -18, seed: 21 } });
    await writeFixture(ws, 'bed.wav', { sine: { freq: 220, seconds: 2, amplitude_db: -20 } });
    const run = await runTool(
      'audio.mix',
      {
        preset: 'dialogue-anchored',
        duration_s: 2,
        tracks: [
          { name: 'dialogue', clips: [{ src: 'vo.wav', at: 0 }] },
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
        ],
      },
      { workspace: ws },
    );
    assert.equal(run.result.samples, 2 * SR);
    assert.match(run.log, /sidechain sfx<-dialogue skipped: no track named sfx/);
  } finally {
    await rmTmp(ws);
  }
});

test('a request merges over a preset (master target -18)', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'vo.wav', { noise: { seconds: 2, amplitude_db: -18, seed: 31 } });
    await writeFixture(ws, 'bed.wav', { sine: { freq: 220, seconds: 2, amplitude_db: -20 } });
    await writeFixture(ws, 'hit.wav', { noise: { seconds: 0.1, amplitude_db: -12, seed: 32 } });
    const run = await runTool(
      'audio.mix',
      {
        preset: 'dialogue-anchored',
        duration_s: 2,
        master: { loudness: { target_lufs: -18 } },
        tracks: [
          { name: 'dialogue', clips: [{ src: 'vo.wav', at: 0 }] },
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
          { name: 'sfx', clips: [{ src: 'hit.wav', at: 1 }] },
        ],
      },
      { workspace: ws },
    );
    const { integrated_lufs } = await ebur128(outputFile(run, 'mix.wav'));
    assert.ok(Math.abs(integrated_lufs - -18) <= 0.5, `master is ${integrated_lufs} LUFS, expected -18 +/- 0.5`);
  } finally {
    await rmTmp(ws);
  }
});

test('ducked-bed preset ducks the music and masters to -14 LUFS', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'vo.wav', { noise: { seconds: 3, amplitude_db: -18, seed: 41 } });
    await writeFixture(ws, 'bed.wav', { sine: { freq: 220, seconds: 3, amplitude_db: -16 } });
    const run = await runTool(
      'audio.mix',
      {
        preset: 'ducked-bed',
        duration_s: 3,
        tracks: [
          { name: 'dialogue', clips: [{ src: 'vo.wav', at: 0 }] },
          { name: 'music', clips: [{ src: 'bed.wav', at: 0 }] },
        ],
      },
      { workspace: ws },
    );
    const { integrated_lufs } = await ebur128(outputFile(run, 'mix.wav'));
    assert.ok(Math.abs(integrated_lufs - -14) <= 0.7, `master is ${integrated_lufs} LUFS, expected -14 +/- 0.7`);
  } finally {
    await rmTmp(ws);
  }
});
