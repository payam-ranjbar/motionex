// PICTURE CAPTURE: picture.render (page -> video, streamed into ffmpeg) and picture.stills (review stills),
// driven by the page contract window.__motion = {ready, seek(t), duration?, size?}.
// The pages come from test/fixtures/pages and are copied into a temp workspace like any other input.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const PAGES = fileURLToPath(new URL('../fixtures/pages/', import.meta.url));
const TEST_TIMEOUT = 240_000;
const GATE = needs('chromium', 'ffmpeg', 'ffprobe');

/** Copy one fixture page into the workspace. */
const page = (ws, name, rel = `pages/${name}`) => writeFixture(ws, rel, { copy: path.join(PAGES, name) });

/** One frame of a video as one RGB pixel; the whole frame is a flat colour in these fixtures. */
async function pixelAt(videoAbs, t) {
  const { stdout } = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoAbs,
    '-ss',
    String(t),
    '-frames:v',
    '1',
    '-vf',
    'format=rgb24,scale=1:1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  assert.ok(stdout.length >= 3, `no frame at ${t} s`);
  return [stdout[0], stdout[1], stdout[2]];
}

/** The first video/audio stream of a file. */
async function probe(fileAbs) {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    fileAbs,
  ]);
  const data = JSON.parse(stdout.toString() || '{}');
  const streams = Array.isArray(data.streams) ? data.streams : [];
  return {
    format: data.format ?? {},
    video: streams.find((s) => s.codec_type === 'video') ?? null,
    audio: streams.find((s) => s.codec_type === 'audio') ?? null,
  };
}

/** A page that refuses to load unless its globals arrived. */
const GLOBALS_PAGE = `<!doctype html>
<html><head><link rel="icon" href="data:," /></head><body style="margin:0;background:#000"><script>
if (!window.T || window.T.x !== 1) throw new Error('window.T is missing');
window.__motion = { ready: true, duration: 0.3, size: { width: 32, height: 32 }, seek() {} };
</script></body></html>`;

/** A page that tries to pull a script from the internet (blocked when offline is true). */
const OFFLINE_PAGE = `<!doctype html>
<html><head><link rel="icon" href="data:," /></head><body style="margin:0;background:#000"><script>
fetch('https://example.com/x.js').catch(function () {});
window.__motion = { ready: true, duration: 0.3, size: { width: 32, height: 32 }, seek() {} };
</script></body></html>`;

test('picture.render: plain.html gives 60 frames of 2 s, colour exact, bt709', {
  ...GATE,
  timeout: TEST_TIMEOUT,
}, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'plain.html');
    const run = await runTool(
      'picture.render',
      { page: 'pages/plain.html', width: 320, height: 180, fps: 30, to_s: 2, workers: 4 },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    const r = run.result;
    assert.equal(r.frames, 60);
    assert.equal(r.fps, 30);
    assert.equal(r.seconds, 2);
    assert.equal(r.width, 320);
    assert.equal(r.height, 180);
    assert.equal(r.stalls, 0);
    assert.equal(r.audio, false);
    assert.deepEqual(r.page_errors, []);

    const video = run.outputs.find((o) => o.name === 'video.mp4');
    assert.ok(video && video.bytes > 0, 'no video.mp4 output');

    // t = 0.5 s is frame 15: the page sets rgb(64, 0, 191) there.
    const px = await pixelAt(video.abs, 0.5);
    for (const [i, want] of [64, 0, 191].entries()) {
      assert.ok(Math.abs(px[i] - want) <= 8, `frame at 0.5 s is rgb(${px}) , expected rgb(64, 0, 191) ± 8`);
    }

    const info = await probe(video.abs);
    assert.equal(Number(info.video.nb_frames), 60);
    assert.ok(Math.abs(Number(info.format.duration) - 2) <= 0.02, `duration ${info.format.duration}`);
    assert.equal(info.video.width, 320);
    assert.equal(info.video.height, 180);
    assert.equal(info.video.color_space, 'bt709');
    assert.equal(info.video.color_range, 'tv');
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: a page whose seek() returns a Promise renders correctly', {
  ...GATE,
  timeout: TEST_TIMEOUT,
}, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'async-seek.html');
    const run = await runTool(
      'picture.render',
      { page: 'pages/async-seek.html', width: 320, height: 180, fps: 10, to_s: 2, workers: 1 },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(run.result.frames, 20);
    assert.equal(run.result.stalls, 0);
    assert.deepEqual(run.result.page_errors, []);
    const video = run.outputs.find((o) => o.name === 'video.mp4');
    // rAF-deferred seek: at t = 1.0 s the page is rgb(128, 0, 127), not the colour of an earlier frame.
    const px = await pixelAt(video.abs, 1);
    for (const [i, want] of [128, 0, 127].entries()) {
      assert.ok(Math.abs(px[i] - want) <= 10, `frame at 1 s is rgb(${px}), expected rgb(128, 0, 127) ± 10`);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: gsap.html renders, so /_mx/lib/gsap is served', { ...GATE, timeout: TEST_TIMEOUT }, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'gsap.html');
    const run = await runTool(
      'picture.render',
      { page: 'pages/gsap.html', width: 320, height: 180, fps: 10, to_s: 1, workers: 1 },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    // The page only sets ready:true when window.gsap exists, so a render that got here proves the lib was served.
    assert.equal(run.result.frames, 10);
    assert.deepEqual(run.result.page_errors, []);
    const video = run.outputs.find((o) => o.name === 'video.mp4');
    const [r, g, b] = await pixelAt(video.abs, 0.5);
    assert.ok(
      Math.abs(r - g) <= 4 && Math.abs(g - b) <= 4,
      `the white box should be grey at 50% opacity, got rgb(${[r, g, b]})`,
    );
    assert.ok(r > 90 && r < 180, `opacity 0.5 of white over black should be about 128, got ${r}`);
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: globals and globals_files reach the page', { ...GATE, timeout: TEST_TIMEOUT }, async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'pages/globals.html', { text: GLOBALS_PAGE });
    // globals_files maps a NAME to a file that holds that global's value.
    await writeFixture(ws, 'data/globals.json', { json: { x: 1 } });

    const inline = await runTool(
      'picture.render',
      { page: 'pages/globals.html', width: 32, height: 32, fps: 10, to_s: 0.3, workers: 1, globals: { T: { x: 1 } } },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(inline.result.frames, 3);
    assert.deepEqual(inline.result.page_errors, []);

    const fromFile = await runTool(
      'picture.render',
      {
        page: 'pages/globals.html',
        width: 32,
        height: 32,
        fps: 10,
        to_s: 0.1,
        workers: 1,
        globals_files: { T: 'data/globals.json' },
      },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(fromFile.result.frames, 1);
    assert.deepEqual(fromFile.result.page_errors, []);
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: from_s/to_s renders just that section', { ...GATE, timeout: TEST_TIMEOUT }, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'plain.html');
    const run = await runTool(
      'picture.render',
      { page: 'pages/plain.html', width: 320, height: 180, fps: 30, from_s: 0.5, to_s: 1, workers: 2 },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(run.result.frames, 15);
    assert.equal(run.result.seconds, 0.5);
    const video = run.outputs.find((o) => o.name === 'video.mp4');
    const info = await probe(video.abs);
    assert.equal(Number(info.video.nb_frames), 15);
    // The section starts at t = 0.5 s of the page, where plain.html is rgb(64, 0, 191).
    const px = await pixelAt(video.abs, 0);
    for (const [i, want] of [64, 0, 191].entries()) {
      assert.ok(Math.abs(px[i] - want) <= 8, `first section frame is rgb(${px}), expected rgb(64, 0, 191) ± 8`);
    }
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: audio is muxed and trimmed to the video length', { ...GATE, timeout: TEST_TIMEOUT }, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'plain.html');
    // 3 s of tone, but only 2 s of video: the audio must be cut (or padded) to the video length.
    await writeFixture(ws, 'tone.wav', { sine: { freq: 440, seconds: 3, amplitude_db: -20 } });
    const run = await runTool(
      'picture.render',
      {
        page: 'pages/plain.html',
        width: 160,
        height: 90,
        fps: 10,
        to_s: 2,
        workers: 2,
        audio: 'tone.wav',
        video: { preset: 'ultrafast' },
      },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(run.result.audio, true);
    assert.equal(run.result.frames, 20);
    const video = run.outputs.find((o) => o.name === 'video.mp4');
    const info = await probe(video.abs);
    assert.ok(info.audio, 'the output has no audio stream');
    assert.ok(
      Math.abs(Number(info.audio.duration) - 2) <= 0.05,
      `audio stream lasts ${info.audio.duration} s, expected 2.0 ± 0.05`,
    );
    assert.equal(Number(info.video.nb_frames), 20);
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: offline blocks outside requests and still renders', {
  ...GATE,
  timeout: TEST_TIMEOUT,
}, async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'pages/offline.html', { text: OFFLINE_PAGE });
    const run = await runTool(
      'picture.render',
      { page: 'pages/offline.html', width: 32, height: 32, fps: 10, to_s: 0.2, workers: 1, offline: true },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(run.result.frames, 2);
    assert.ok(
      run.result.page_errors.some((e) => e.includes('blocked:') && e.includes('example.com')),
      `page_errors should record the blocked request, got ${JSON.stringify(run.result.page_errors)}`,
    );
  } finally {
    await rmTmp(ws);
  }
});

test('picture.render: page-files.json lists the page and its files', { ...GATE, timeout: TEST_TIMEOUT }, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'plain.html');
    const run = await runTool(
      'picture.render',
      { page: 'pages/plain.html', width: 64, height: 36, fps: 10, to_s: 0.3, workers: 1 },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    const listing = run.outputs.find((o) => o.name === 'page-files.json');
    assert.ok(listing, 'no page-files.json output');
    const files = JSON.parse(await readFile(listing.abs, 'utf8'));
    const self = files.find((f) => f.path === 'pages/plain.html');
    assert.ok(self, `page-files.json does not list the page: ${JSON.stringify(files)}`);
    assert.match(self.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rmTmp(ws);
  }
});

test('picture.stills: two PNGs of the page size at the requested times', {
  ...GATE,
  timeout: TEST_TIMEOUT,
}, async () => {
  const ws = await mkTmp();
  try {
    await page(ws, 'plain.html');
    const run = await runTool(
      'picture.stills',
      { page: 'pages/plain.html', width: 320, height: 180, times: [0.25, 1.5] },
      { workspace: ws, timeoutMs: TEST_TIMEOUT },
    );
    assert.equal(run.result.stills.length, 2);
    assert.equal(run.result.width, 320);
    assert.equal(run.result.height, 180);
    assert.deepEqual(
      run.result.stills.map((s) => s.name),
      ['still-0.250.png', 'still-1.500.png'],
    );
    const pngs = run.outputs.filter((o) => o.name.endsWith('.png'));
    assert.equal(pngs.length, 2);
    for (const still of pngs) {
      const head = await readFile(still.abs);
      assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${still.name} is not a PNG`);
      assert.equal(head.readUInt32BE(16), 320, `${still.name} width`);
      assert.equal(head.readUInt32BE(20), 180, `${still.name} height`);
    }
  } finally {
    await rmTmp(ws);
  }
});
