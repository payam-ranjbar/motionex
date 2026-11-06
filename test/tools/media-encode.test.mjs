import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

// A 640x360 30 fps testsrc2 with BT.709 tags and a sine audio track. Colour is the point, so the tags matter.
async function makeBt709Testsrc(ws, rel, { seconds = 4 } = {}) {
  const abs = path.join(ws, rel);
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=640x360:r=30:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-shortest',
    '-c:v',
    'libx264',
    '-crf',
    '10',
    '-preset',
    'ultrafast',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    abs,
  ]);
  return abs;
}

// A 10 s 640x360 30 fps temporal-noise source: deliberately hard to compress.
async function makeNoisy(ws, rel, { seconds = 10 } = {}) {
  const abs = path.join(ws, rel);
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=640x360:r=30',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=330:duration=${seconds}`,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-t',
    String(seconds),
    '-vf',
    'noise=alls=100:allf=t+u',
    '-c:v',
    'libx264',
    '-crf',
    '10',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    abs,
  ]);
  return abs;
}

/** Average Y, U and V of frame `n`, as a 1x1 yuv444p sample (3 bytes). */
async function frameYCbCr(file, n) {
  const { stdout } = await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${n}),scale=1:1`,
    '-frames:v',
    '1',
    '-vsync',
    '0',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv444p',
    '-',
  ]);
  assert.ok(stdout && stdout.length >= 3, `no frame ${n} in ${path.basename(file)}`);
  return [stdout[0], stdout[1], stdout[2]];
}

const outAbs = (outputs, name) => outputs.find((o) => o.name === name)?.abs;

test('media.encode: master keeps BT.709 colour', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    const src = await makeBt709Testsrc(ws, 'src.mp4');
    const before = await frameYCbCr(src, 30);
    const { result, outputs } = await runTool(
      'media.encode',
      { input: 'src.mp4', preset: 'master' },
      { workspace: ws },
    );
    const out = outAbs(outputs, 'video.mp4');
    assert.ok(out, `expected video.mp4, got ${outputs.map((o) => o.name).join(', ')}`);
    const after = await frameYCbCr(out, 30);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(before[i] - after[i]) <= 2, `channel ${i} shifted: ${before[i]} -> ${after[i]}`);
    const probe = await runFfprobe([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=color_space',
      '-of',
      'default=nw=1:nk=1',
      out,
    ]);
    assert.equal(probe.stdout.toString().trim(), 'bt709');
    assert.deepEqual([result.width, result.height], [640, 360]);
  } finally {
    await rmTmp(ws);
  }
});

test('media.encode: target_size_mb fits under 1 MB on noisy input', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeNoisy(ws, 'noisy.mp4', { seconds: 10 });
    const { result } = await runTool(
      'media.encode',
      { input: 'noisy.mp4', target_size_mb: 1, video: { preset: 'veryfast' }, audio: { bitrate_k: 128 } },
      { workspace: ws },
    );
    assert.ok(result.size_bytes <= 1_000_000, `size ${result.size_bytes} > 1 MB`);
    assert.ok(result.attempts === 1 || result.attempts === 2, `attempts ${result.attempts}`);
    assert.equal(result.passes, 2);
    assert.ok(result.video_bitrate_k > 0 && result.video_bitrate_k < 1000, `video bitrate ${result.video_bitrate_k}`);
  } finally {
    await rmTmp(ws);
  }
});

test(
  'media.encode: instagram-reel uses a 60-frame closed GOP and 48 kHz audio',
  needs('ffmpeg', 'ffprobe'),
  async () => {
    const ws = await mkTmp();
    try {
      await makeBt709Testsrc(ws, 'src.mp4', { seconds: 4 });
      const { outputs } = await runTool(
        'media.encode',
        { input: 'src.mp4', preset: 'instagram-reel' },
        { workspace: ws },
      );
      const out = outAbs(outputs, 'video.mp4');
      const frames = await runFfprobe([
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_entries',
        'frame=key_frame,pict_type',
        '-of',
        'csv=p=0',
        out,
      ]);
      const rows = frames.stdout.toString().trim().split('\n');
      assert.equal(rows.length, 120, `expected 120 frames, got ${rows.length}`);
      const keyframes = rows
        .map((r, i) => [r.split(',')[0], i])
        .filter(([k]) => k === '1')
        .map(([, i]) => i);
      assert.deepEqual(keyframes, [0, 60]);
      const audio = await runFfprobe([
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=sample_rate',
        '-of',
        'csv=p=0',
        out,
      ]);
      assert.equal(audio.stdout.toString().trim(), '48000');
    } finally {
      await rmTmp(ws);
    }
  },
);

test('media.encode: max_long_side 320 gives 320x180', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeBt709Testsrc(ws, 'src.mp4');
    const { result } = await runTool(
      'media.encode',
      { input: 'src.mp4', scale: { max_long_side: 320 } },
      { workspace: ws },
    );
    assert.deepEqual([result.width, result.height], [320, 180]);
  } finally {
    await rmTmp(ws);
  }
});

test(
  'media.encode: replace_audio uses the replacement duration and sample rate',
  needs('ffmpeg', 'ffprobe'),
  async () => {
    const ws = await mkTmp();
    try {
      await makeBt709Testsrc(ws, 'src.mp4', { seconds: 4 });
      await writeFixture(ws, 'alt.wav', {
        sine: { freq: 660, seconds: 5, amplitude_db: -20, channels: 2, sample_rate: 44100 },
      });
      const { outputs } = await runTool(
        'media.encode',
        { input: 'src.mp4', replace_audio: 'alt.wav' },
        { workspace: ws },
      );
      const out = outAbs(outputs, 'video.mp4');
      const probe = await runFfprobe([
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=sample_rate,duration',
        '-of',
        'json',
        out,
      ]);
      const a = JSON.parse(probe.stdout.toString()).streams[0];
      assert.equal(Number(a.sample_rate), 44100);
      assert.ok(Math.abs(Number(a.duration) - 5) <= 0.1, `audio duration ${a.duration}`);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('media.encode: target too small is invalid-input', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeNoisy(ws, 'noisy.mp4', { seconds: 10 });
    const err = await runTool('media.encode', { input: 'noisy.mp4', target_size_mb: 0.01 }, { workspace: ws }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'expected an error');
    assert.equal(err.type, 'invalid-input');
    assert.match(err.message, /target too small for this duration/);
  } finally {
    await rmTmp(ws);
  }
});
