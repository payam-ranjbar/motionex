import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

/** Encode `seconds` of testsrc2 as h264 yuv420p at 320x180 / 30 fps into the workspace. */
async function makeClip(workspace, rel, seconds) {
  const abs = path.join(workspace, rel);
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30',
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    abs,
  ]);
  return abs;
}

const WAV = { sine: { freq: 440, seconds: 1, amplitude_db: -20 } };

test('media.probe: duration, video stream and WAV sample rate', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeClip(ws, 'clip.mp4', 3);
    await writeFixture(ws, 'tone.wav', WAV);

    const video = await runTool('media.probe', { input: 'clip.mp4' }, { workspace: ws });
    assert.ok(Math.abs(video.result.duration_s - 3) <= 0.05, `duration ${video.result.duration_s}`);
    const v = video.result.streams.find((s) => s.type === 'video');
    assert.equal(v.codec, 'h264');
    assert.equal(v.width, 320);
    assert.equal(v.height, 180);
    assert.equal(v.fps, 30);
    assert.equal(v.pix_fmt, 'yuv420p');

    const audio = await runTool('media.probe', { input: 'tone.wav' }, { workspace: ws });
    const a = audio.result.streams.find((s) => s.type === 'audio');
    assert.equal(a.sample_rate, 48000);
  } finally {
    await rmTmp(ws);
  }
});

test('media.frames: two PNGs, and width scales the frame', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeClip(ws, 'clip.mp4', 3);

    const r = await runTool('media.frames', { video: 'clip.mp4', times: [0.5, 1.5] }, { workspace: ws });
    assert.deepEqual(
      r.result.frames.map((f) => f.t),
      [0.5, 1.5],
    );
    const pngs = r.outputs.filter((o) => o.name.endsWith('.png'));
    assert.equal(pngs.length, 2);
    for (const o of pngs) assert.ok(o.bytes > 0, `${o.name} is empty`);

    const scaled = await runTool('media.frames', { video: 'clip.mp4', times: [1], width: 160 }, { workspace: ws });
    const out = scaled.outputs.find((o) => o.name === 'frame-0001.000.png');
    assert.ok(out, `expected frame-0001.000.png, got ${scaled.outputs.map((o) => o.name).join(', ')}`);
    await copyFile(out.abs, path.join(ws, 'scaled.png'));
    const p = await runTool('media.probe', { input: 'scaled.png' }, { workspace: ws });
    const sv = p.result.streams.find((s) => s.type === 'video');
    assert.equal(sv.width, 160);
  } finally {
    await rmTmp(ws);
  }
});

test('media.mux: video is copied, audio is aac, shortest trims to the video', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeClip(ws, 'clip.mp4', 3);
    await writeFixture(ws, 'tone5.wav', { sine: { freq: 440, seconds: 5, amplitude_db: -20 } });

    const r = await runTool('media.mux', { video: 'clip.mp4', audio: 'tone5.wav', shortest: true }, { workspace: ws });
    assert.equal(r.result.video_codec, 'h264');
    assert.equal(r.result.audio_codec, 'aac');
    assert.ok(Math.abs(r.result.duration_s - 3) <= 0.1, `duration ${r.result.duration_s}`);

    await copyFile(r.outputs[0].abs, path.join(ws, 'muxed.mp4'));
    const p = await runTool('media.probe', { input: 'muxed.mp4' }, { workspace: ws });
    assert.equal(p.result.streams.length, 2);
    assert.equal(p.result.streams.find((s) => s.type === 'video').codec, 'h264');
    assert.equal(p.result.streams.find((s) => s.type === 'audio').codec, 'aac');
  } finally {
    await rmTmp(ws);
  }
});

test('media.concat: copy and reencode join two one-second parts', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeClip(ws, 'part1.mp4', 1);
    await makeClip(ws, 'part2.mp4', 1);

    const copy = await runTool('media.concat', { inputs: ['part1.mp4', 'part2.mp4'] }, { workspace: ws });
    assert.equal(copy.result.mode, 'copy');
    assert.ok(Math.abs(copy.result.duration_s - 2) <= 0.05, `copy duration ${copy.result.duration_s}`);

    const re = await runTool(
      'media.concat',
      { inputs: ['part1.mp4', 'part2.mp4'], mode: 'reencode' },
      { workspace: ws },
    );
    assert.equal(re.result.mode, 'reencode');
    assert.ok(Math.abs(re.result.duration_s - 2) <= 0.05, `reencode duration ${re.result.duration_s}`);
  } finally {
    await rmTmp(ws);
  }
});

// Found by an ON THE ONE episode agent: frames asked for 8–13 s on a 5 s draft died with an mjpeg encoder error.
test('media.frames: times past the end are rejected with a plain message', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    const abs = path.join(ws, 'v.mp4');
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      abs,
    ]);
    await assert.rejects(
      runTool('media.frames', { video: 'v.mp4', times: [1, 3.5], format: 'jpeg', width: 160 }, { workspace: ws }),
      (e) => e.type === 'invalid-input' && /past the end of the video \(2\.0\d\d s\): 3\.5/.test(e.detail),
    );
    const ok = await runTool(
      'media.frames',
      { video: 'v.mp4', times: [1.9], format: 'jpeg', width: 160 },
      { workspace: ws },
    );
    assert.equal(ok.outputs.length, 1);
  } finally {
    await rmTmp(ws);
  }
});

// Found by an ON THE ONE agent: muxing a 3 ms shorter mix onto a copied video with -shortest dropped 3 frames.
test(
  'media.mux: by default the file keeps every video frame (audio padded/trimmed to the video)',
  needs('ffmpeg', 'ffprobe'),
  async () => {
    const ws = await mkTmp();
    try {
      await runFfmpeg([
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path.join(ws, 'v.mp4'),
      ]);
      await writeFixture(ws, 'short.wav', { sine: { freq: 440, seconds: 1.997 } });
      await writeFixture(ws, 'long.wav', { sine: { freq: 440, seconds: 3 } });
      for (const audio of ['short.wav', 'long.wav']) {
        const r = await runTool('media.mux', { video: 'v.mp4', audio }, { workspace: ws });
        const frames = await runTool(
          'media.probe',
          { input: `.mx/jobs/${path.basename(path.dirname(r.outDir))}/out/video.mp4` },
          { workspace: ws },
        );
        const v = frames.result.streams.find((s) => s.type === 'video');
        assert.ok(Math.abs(v.duration_s - 2) < 0.02, `${audio}: video ${v.duration_s}`);
        assert.ok(Math.abs(frames.result.duration_s - 2) < 0.05, `${audio}: file ${frames.result.duration_s}`);
      }
      // a time between the video end (2.0) and a longer container end has no frame: rejected plainly
      const mux = await runTool('media.mux', { video: 'v.mp4', audio: 'long.wav', shortest: false }, { workspace: ws });
      assert.ok(mux.result.duration_s < 2.1);
    } finally {
      await rmTmp(ws);
    }
  },
);
