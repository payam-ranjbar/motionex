// media.encode: pad (fit inside a frame and fill the rest), video_fx, lut, and the fit-size pass-through.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { colorArgs, runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

/** A short H.264 yuv420p source tagged BT.709, from a lavfi source such as "color=c=white" or "testsrc2". */
async function makeSource(ws, rel, { src = 'testsrc2', size = '512x288', seconds = 0.5, audio = false } = {}) {
  const abs = path.join(ws, rel);
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}s=${size}:r=30`];
  if (audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-map', '0:v:0', '-map', '1:a:0');
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
  }
  args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p');
  args.push(...colorArgs('bt709'), abs);
  await runFfmpeg(args);
  return abs;
}

/** Mean luma of every row of the first frame, decoded to 8-bit gray. */
async function lumaRows(file, width, height) {
  const { stdout } = await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'format=gray',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(stdout.length, width * height, `expected one ${width}x${height} gray frame`);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += stdout[y * width + x];
    rows.push(sum / width);
  }
  return rows;
}

/** Average Y, U and V of frame `n`, as a 1x1 yuv444p sample. */
async function frameYCbCr(file, n) {
  const { stdout } = await runFfmpeg([
    '-hide_banner',
    '-v',
    'error',
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

async function videoStream(file) {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,sample_aspect_ratio',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(stdout.toString()).streams[0];
}

/** Assert every row in [from, to] passes `ok`, naming the first that does not. */
function rowsAre(rows, from, to, ok, what) {
  for (let y = from; y <= to; y++) assert.ok(ok(rows[y]), `row ${y} is not ${what}: mean luma ${rows[y].toFixed(1)}`);
}
const dark = (v) => v < 30;
const bright = (v) => v > 200;

const outAbs = (outputs, name = 'video.mp4') => outputs.find((o) => o.name === name)?.abs;

const failure = (promise) =>
  promise.then(
    () => null,
    (e) => e,
  );

// A 2x2x2 .cube LUT. r varies fastest.
const cube = (map) => {
  const lines = ['LUT_3D_SIZE 2'];
  for (const b of [0, 1]) for (const g of [0, 1]) for (const r of [0, 1]) lines.push(map(r, g, b).join(' '));
  return `${lines.join('\n')}\n`;
};

test('media.encode: pad fits a 16:9 picture into 9:16 with black bars', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeSource(ws, 'src.mp4', { src: 'color=c=white', size: '512x288' });
    const { result, outputs } = await runTool(
      'media.encode',
      { input: 'src.mp4', pad: { width: 288, height: 512 }, video: { preset: 'ultrafast' } },
      { workspace: ws },
    );
    const out = outAbs(outputs);
    assert.deepEqual([result.width, result.height], [288, 512]);
    assert.equal(result.passthrough, false);
    const v = await videoStream(out);
    assert.deepEqual([v.width, v.height], [288, 512]);
    assert.equal(v.sample_aspect_ratio, '1:1');
    // 512x288 fitted to 288 wide is 288x162, centred: bars of about 175 rows above and below.
    const rows = await lumaRows(out, 288, 512);
    rowsAre(rows, 0, 168, dark, 'a black bar');
    rowsAre(rows, 180, 330, bright, 'picture');
    rowsAre(rows, 342, 511, dark, 'a black bar');
  } finally {
    await rmTmp(ws);
  }
});

test('media.encode: pad position top puts the picture at the top', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeSource(ws, 'src.mp4', { src: 'color=c=white', size: '512x288' });
    const { outputs } = await runTool(
      'media.encode',
      { input: 'src.mp4', pad: { width: 288, height: 512, position: 'top' }, video: { preset: 'ultrafast' } },
      { workspace: ws },
    );
    const rows = await lumaRows(outAbs(outputs), 288, 512);
    rowsAre(rows, 0, 155, bright, 'picture');
    rowsAre(rows, 168, 511, dark, 'a black bar');
  } finally {
    await rmTmp(ws);
  }
});

test('media.encode: pad colour and position bottom', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeSource(ws, 'src.mp4', { src: 'color=c=black', size: '512x288' });
    const { outputs } = await runTool(
      'media.encode',
      {
        input: 'src.mp4',
        pad: { width: 288, height: 512, position: 'bottom', color: '#ffffff' },
        video: { preset: 'ultrafast' },
      },
      { workspace: ws },
    );
    const rows = await lumaRows(outAbs(outputs), 288, 512);
    rowsAre(rows, 0, 340, bright, 'a white bar');
    rowsAre(rows, 356, 511, dark, 'picture');
  } finally {
    await rmTmp(ws);
  }
});

test(
  'media.encode: odd pad sizes are refused for yuv420p, allowed for yuv444p',
  needs('ffmpeg', 'ffprobe'),
  async () => {
    const ws = await mkTmp();
    try {
      await makeSource(ws, 'src.mp4', { size: '128x72' });
      const err = await failure(
        runTool('media.encode', { input: 'src.mp4', pad: { width: 1081, height: 1920 } }, { workspace: ws }),
      );
      assert.ok(err, 'expected an error');
      assert.equal(err.type, 'invalid-input');
      assert.match(err.message, /pad: width 1081 must be even for yuv420p/);
      const both = await failure(
        runTool('media.encode', { input: 'src.mp4', pad: { width: 71, height: 129 } }, { workspace: ws }),
      );
      assert.match(both.message, /width 71 and height 129 must be even/);

      const { result } = await runTool(
        'media.encode',
        { input: 'src.mp4', pad: { width: 71, height: 129 }, video: { pix_fmt: 'yuv444p', preset: 'ultrafast' } },
        { workspace: ws },
      );
      assert.deepEqual([result.width, result.height], [71, 129]);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('media.encode: video_fx is applied to the picture', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeSource(ws, 'src.mp4', { src: 'color=c=black', size: '64x64' });
    const { outputs } = await runTool(
      'media.encode',
      { input: 'src.mp4', video_fx: 'negate', video: { preset: 'ultrafast' } },
      { workspace: ws },
    );
    const rows = await lumaRows(outAbs(outputs), 64, 64);
    rowsAre(rows, 0, 63, bright, 'negated (white)');
  } finally {
    await rmTmp(ws);
  }
});

test('media.encode: video_fx refuses filters and options that read files', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    const cases = [
      ['movie=other.mp4,negate', /"movie" filter is not allowed/],
      ['mov\\ie=other.mp4', /"movie" filter is not allowed/],
      ['lut3d=file=grade.cube', /"lut3d" filter reads or writes files.*lut field/],
      ['negate,drawtext=text=hi', /"drawtext" filter/],
      ['deshake=filename=log.txt', /"filename" option names a file/],
      ['hue=/h=secret.txt', /read from a file/],
      ["hue='/h'=secret.txt", /read from a file/],
    ];
    for (const [chain, message] of cases) {
      const err = await failure(runTool('media.encode', { input: 'src.mp4', video_fx: chain }, { workspace: ws }));
      assert.ok(err, `expected ${chain} to be refused`);
      assert.equal(err.type, 'invalid-input', `${chain}: ${err.message}`);
      assert.match(err.message, message, chain);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('media.encode: lut applies a 3D LUT from a workspace file', needs('ffmpeg', 'ffprobe'), async () => {
  const ws = await mkTmp();
  try {
    await makeSource(ws, 'black.mp4', { src: 'color=c=black', size: '64x64' });
    await makeSource(ws, 'bars.mp4', { size: '160x90' });
    // A folder name with every character the filtergraph parsers treat specially.
    const dir = "grades/it's a [grade], v1;x";
    await writeFixture(ws, `${dir}/negate.cube`, { text: cube((r, g, b) => [1 - r, 1 - g, 1 - b]) });
    await writeFixture(ws, `${dir}/identity.cube`, { text: cube((r, g, b) => [r, g, b]) });

    const neg = await runTool(
      'media.encode',
      { input: 'black.mp4', lut: `${dir}/negate.cube`, video: { preset: 'ultrafast' } },
      { workspace: ws },
    );
    rowsAre(await lumaRows(outAbs(neg.outputs), 64, 64), 0, 63, bright, 'negated (white)');

    // An identity LUT must not shift colours: the RGB round trip uses the source's own matrix.
    const same = await runTool(
      'media.encode',
      { input: 'bars.mp4', lut: `${dir}/identity.cube`, video: { crf: 10, preset: 'ultrafast' } },
      { workspace: ws },
    );
    const before = await frameYCbCr(path.join(ws, 'bars.mp4'), 5);
    const after = await frameYCbCr(outAbs(same.outputs), 5);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(before[i] - after[i]) <= 3, `channel ${i} shifted: ${before[i]} -> ${after[i]}`);
  } finally {
    await rmTmp(ws);
  }
});

test(
  'media.encode: an input that already fits the target is returned unchanged',
  needs('ffmpeg', 'ffprobe'),
  async () => {
    const ws = await mkTmp();
    try {
      const src = await makeSource(ws, 'src.mp4', { size: '160x90', seconds: 1, audio: true });
      const srcBytes = await readFile(src);
      assert.ok(srcBytes.length < 1_000_000, `source is ${srcBytes.length} bytes`);

      // telegram-video: 45 MB target, a 1920 cap the source already meets, AAC 128 kbit/s like the source.
      const { result, outputs } = await runTool(
        'media.encode',
        { input: 'src.mp4', preset: 'telegram-video' },
        { workspace: ws },
      );
      assert.equal(result.passthrough, true);
      assert.equal(result.passes, 0);
      assert.equal(result.attempts, 0);
      assert.equal(result.size_bytes, srcBytes.length);
      assert.deepEqual([result.width, result.height], [160, 90]);
      assert.ok(result.audio_bitrate_k > 0, `audio_bitrate_k ${result.audio_bitrate_k}`);
      assert.match(result.warnings.join('\n'), /returned unchanged without encoding/);
      assert.ok((await readFile(outAbs(outputs))).equals(srcBytes), 'the output differs from the input');

      // Anything else asked means an encode.
      const opted = await runTool(
        'media.encode',
        { input: 'src.mp4', target_size_mb: 1, copy_if_fits: false, video: { preset: 'ultrafast' } },
        { workspace: ws },
      );
      assert.equal(opted.result.passthrough, false);
      assert.equal(opted.result.passes, 2);
      assert.deepEqual(opted.result.warnings, []);

      const scaled = await runTool(
        'media.encode',
        { input: 'src.mp4', target_size_mb: 1, scale: { max_long_side: 80 }, video: { preset: 'ultrafast' } },
        { workspace: ws },
      );
      assert.equal(scaled.result.passthrough, false);
      assert.deepEqual([scaled.result.width, scaled.result.height], [80, 46]);
    } finally {
      await rmTmp(ws);
    }
  },
);

test(
  'media.encode: vertical-9x16 letterboxes into 1080x1920 and copies the AAC audio',
  needs('ffmpeg', 'ffprobe'),
  async () => {
    const ws = await mkTmp();
    try {
      const src = await makeSource(ws, 'src.mp4', { src: 'color=c=white', size: '320x180', audio: true });
      const { result, outputs } = await runTool(
        'media.encode',
        { input: 'src.mp4', preset: 'vertical-9x16', video: { preset: 'ultrafast' } },
        { workspace: ws },
      );
      const out = outAbs(outputs);
      assert.deepEqual([result.width, result.height], [1080, 1920]);
      // 320x180 scaled up to 1080x608, centred: bars of 656 rows above and below.
      const rows = await lumaRows(out, 1080, 1920);
      rowsAre(rows, 0, 650, dark, 'a black bar');
      rowsAre(rows, 664, 1256, bright, 'picture');
      rowsAre(rows, 1270, 1919, dark, 'a black bar');
      const audioMd5 = async (file) =>
        (await runFfmpeg(['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-'])).stdout
          .toString()
          .trim();
      assert.equal(await audioMd5(out), await audioMd5(src), 'the audio stream was re-encoded');
    } finally {
      await rmTmp(ws);
    }
  },
);
