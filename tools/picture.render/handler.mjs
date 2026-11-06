// picture.render: turn an HTML page into a video. The page must expose
//   window.__motion = { ready: true, seek(t) -> void | Promise, duration?, size? }
// Frames are rendered by several browser pages in parallel and streamed IN ORDER into one ffmpeg process'
// stdin (runFfmpeg cannot stream, so this tool spawns ffmpeg itself: AGENTS.md allows it here only).
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCapture, renderFrames, warmUp } from '../../src/lib/capture.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { checkChain, colorArgs, ffmpegPath, videoArgs } from '../../src/lib/ffmpeg.mjs';
import { safeOutputPath, toWorkspacePath } from '../../src/lib/paths.mjs';

const GLOBAL_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const firstLine = (e) => String(e?.message ?? e ?? '').split(/\r?\n/)[0];
const STDERR_TAIL = 8000;

/**
 * window globals: `globals_files` (NAME -> a .json file) first, then inline `globals` (which wins on a clash).
 * @param {{globals?: Record<string, unknown>, globals_files?: Record<string, string>}} input
 * @returns {Promise<Record<string, unknown>>}
 * @throws {ToolError} invalid-input
 */
async function collectGlobals({ globals = {}, globals_files = {} }) {
  const out = {};
  for (const [name, file] of Object.entries(globals_files ?? {})) {
    if (!GLOBAL_NAME.test(name))
      throw new ToolError('invalid-input', `globals_files: "${name}" is not a JS identifier`);
    let text;
    try {
      text = await readFile(String(file), 'utf8');
    } catch (e) {
      throw new ToolError('invalid-input', `globals_files: "${name}": cannot read the JSON file (${firstLine(e)})`);
    }
    try {
      out[name] = JSON.parse(text);
    } catch (e) {
      throw new ToolError('invalid-input', `globals_files: "${name}": not valid JSON (${firstLine(e)})`);
    }
  }
  for (const [name, value] of Object.entries(globals ?? {})) {
    if (!GLOBAL_NAME.test(name)) throw new ToolError('invalid-input', `globals: "${name}" is not a JS identifier`);
    out[name] = value;
  }
  return out;
}

/**
 * The ffmpeg argument list. JPEG frames from the browser are full-range BT.601, PNG frames are RGB, so the
 * scale filter does the range/matrix conversion before `format=<pix_fmt>`.
 * @param {object} o
 * @param {number} o.fps
 * @param {'jpeg'|'png'} o.intermediate
 * @param {object} o.video the video block (codec/preset/crf/pix_fmt/color)
 * @param {string|null} o.audioAbs
 * @param {number} o.fromS audio trim start
 * @param {number} o.seconds output length
 * @param {string} o.audioCodec
 * @param {number} o.audioBitrateK
 * @param {string} o.outFile
 * @returns {string[]}
 */
function encoderArgs({ fps, intermediate, video, audioAbs, fromS, seconds, audioCodec, audioBitrateK, outFile }) {
  const decoder = intermediate === 'png' ? 'png' : 'mjpeg';
  const convert =
    intermediate === 'png'
      ? 'scale=out_color_matrix=bt709:out_range=tv'
      : 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709';
  const vf = checkChain(`${convert},format=${video.pix_fmt}`, 'video filter');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps)];
  args.push('-c:v', decoder, '-i', '-');
  if (audioAbs) args.push('-ss', String(fromS), '-i', audioAbs);
  args.push('-map', '0:v', '-vf', vf);
  if (audioAbs) {
    args.push('-map', '1:a', '-af', 'apad', '-c:a', audioCodec, '-b:a', `${Math.round(audioBitrateK)}k`);
    // apad pads with silence forever: cut at the video length (1 ms past the last frame, so rounding
    // can never drop that frame; the video itself ends when stdin does).
    args.push('-t', (seconds + 0.001).toFixed(6));
  }
  args.push(...videoArgs(video), ...colorArgs(video.color), '-movflags', '+faststart', outFile);
  return args;
}

/**
 * @param {object} input validated input, refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const started = performance.now();
  const name = safeOutputPath(input.name, 'name');
  const fps = input.fps;
  const globals = await collectGlobals(input);
  const outFile = path.join(ctx.outDir, ...name.split('/'));
  const intermediate = input.intermediate;

  /** @type {import('../../src/lib/capture.mjs').Capture|null} */
  let capture = null;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /** @type {(() => void)|null} */
  let onAbort = null;

  try {
    ctx.progress(0, 'starting the browser');
    capture = await openCapture({
      config: ctx.config,
      workspace: ctx.workspace,
      pageAbs: input.page,
      inject: input.inject ?? [],
      globals,
      query: input.query,
      width: input.width,
      height: input.height,
      deviceScaleFactor: input.device_scale_factor,
      offline: input.offline,
      readyTimeoutMs: input.ready_timeout_s * 1000,
      onPid: (pid) => ctx.trackProcess(pid),
    });
    const { width, height } = capture.size;

    const toS = input.to_s ?? capture.duration;
    if (toS == null || !Number.isFinite(toS)) {
      throw new ToolError('invalid-input', 'no to_s and the page set no window.__motion.duration');
    }
    const first = Math.round(input.from_s * fps);
    const count = Math.round(toS * fps) - first;
    if (count < 1) {
      throw new ToolError(
        'invalid-input',
        `from_s ${input.from_s} to_s ${toS} at ${fps} fps gives no frames (rounds to ${count})`,
      );
    }
    const seconds = count / fps;
    ctx.log(
      `render: frames ${first}..${first + count - 1} at ${fps} fps, ${width}x${height}, ${input.workers} page(s)`,
    );

    const args = encoderArgs({
      fps,
      intermediate,
      video: input.video,
      audioAbs: input.audio ?? null,
      fromS: input.from_s,
      seconds,
      audioCodec: input.audio_codec,
      audioBitrateK: input.audio_bitrate_k,
      outFile,
    });

    // ffmpeg reads the frames from stdin; stdout is ignored, stderr is kept for the error message.
    child = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    const enc = child;
    if (!Number.isInteger(enc.pid)) throw new ToolError('tool-failed', `ffmpeg could not start (${ffmpegPath()})`);
    let stderr = '';
    enc.stderr.setEncoding('utf8');
    enc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_TAIL);
    });
    enc.stdin.on('error', () => {}); // EPIPE when ffmpeg exits early: the exit code tells the story
    /** @type {ToolError|null} */
    let dead = null;
    const closed = new Promise((resolve, reject) => {
      enc.on('error', (e) => {
        dead = new ToolError('tool-failed', `ffmpeg could not start (${ffmpegPath()}): ${firstLine(e)}`);
        reject(dead);
      });
      enc.on('close', (code) => {
        if (code !== 0) dead = new ToolError('tool-failed', `ffmpeg exited with ${code}: ${stderr.slice(-4000)}`);
        resolve(code);
      });
    });
    closed.catch(() => {}); // a spawn error is reported by the write() or the await below, never as an unhandled rejection
    onAbort = () => enc.kill('SIGKILL');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    /** Reject (never hang) when ffmpeg dies while its stdin is still busy. */
    const stopped = () => {
      dead ??= new ToolError(
        'tool-failed',
        `ffmpeg stopped before every frame was written${stderr ? `: ${stderr.slice(-2000)}` : ''}`,
      );
      return dead;
    };

    /** Write one frame into ffmpeg's stdin, honouring back-pressure. */
    const write = (buf) =>
      new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        if (enc.stdin.destroyed || enc.exitCode !== null) return reject(stopped());
        if (enc.stdin.write(buf)) return resolve();
        const done = (err) => {
          enc.stdin.off('drain', onDrain);
          enc.stdin.off('close', onStdinClose);
          enc.off('close', onEncClose);
          if (err) reject(err);
          else resolve();
        };
        const onDrain = () => done(null);
        const onStdinClose = () => done(stopped());
        const onEncClose = () => done(stopped());
        enc.stdin.once('drain', onDrain);
        enc.stdin.once('close', onStdinClose);
        enc.once('close', onEncClose);
      });

    /** @type {import('playwright-core').Page[]} */
    const pages = [];
    const { stalls } = await (async () => {
      try {
        const made = await Promise.all(Array.from({ length: input.workers }, () => capture.newPage()));
        pages.push(...made);
        if (input.warmup) {
          ctx.log(`warm-up: ${pages.length} page(s)`);
          await Promise.all(pages.map((p) => warmUp(p)));
        }
        return await renderFrames({
          pages,
          first,
          count,
          fps,
          write,
          frameOpts: {
            type: intermediate === 'png' ? 'png' : 'jpeg',
            quality: input.jpeg_quality,
            timeoutMs: input.frame_timeout_s * 1000,
            retries: input.frame_retries,
            onStall: (t, e) => ctx.log(`frame at ${t.toFixed(3)} s stalled, retrying (${firstLine(e)})`),
          },
          onProgress: (fraction) => ctx.progress(Math.min(0.99, Math.max(0, fraction)), 'rendering frames'),
          signal: ctx.signal,
        });
      } finally {
        for (const page of pages) await page.close().catch(() => {});
      }
    })();

    enc.stdin.end();
    const code = await closed;
    if (code !== 0) {
      throw dead ?? new ToolError('tool-failed', `ffmpeg exited with ${code}: ${stderr.slice(-4000)}`);
    }
    const info = await stat(outFile).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new ToolError('tool-failed', `ffmpeg produced no output${stderr ? `: ${stderr.slice(-2000)}` : ''}`);
    }

    // Provenance: sha256 of every workspace file the page pulled from the static server.
    const files = [];
    for (const rel of [...capture.loaded].sort()) {
      try {
        const snap = await ctx.snapshot(toWorkspacePath(ctx.workspace, rel));
        files.push({ path: rel, sha256: snap.sha256 });
      } catch (e) {
        ctx.log(`page-files: skipped ${rel} (${firstLine(e)})`);
      }
    }
    await writeFile(path.join(ctx.outDir, 'page-files.json'), `${JSON.stringify(files, null, 2)}\n`, 'utf8');

    const renderS = Math.round((performance.now() - started) / 10) / 100;
    // Screenshots are in device pixels: the encoded frame is the viewport times the device scale factor.
    const outWidth = Math.round(width * input.device_scale_factor);
    const outHeight = Math.round(height * input.device_scale_factor);
    ctx.progress(1, 'done');
    ctx.log(`render: ${name} — ${count} frames in ${renderS} s, ${stalls} stalled frame(s)`);
    return {
      result: {
        frames: count,
        fps,
        seconds: Math.round(seconds * 1e6) / 1e6,
        width: outWidth,
        height: outHeight,
        render_s: renderS,
        stalls,
        page_errors: [...new Set(capture.pageErrors)].slice(0, 50),
        audio: Boolean(input.audio),
      },
    };
  } finally {
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL');
      await done;
    }
    await capture?.close().catch(() => {});
  }
}
