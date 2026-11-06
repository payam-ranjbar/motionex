// picture.stills: still frames of an HTML page that exposes
//   window.__motion = { ready: true, seek(t) -> void | Promise, duration?, size? }
// One page, one seek per time, one image per time: the cheap way to look at a frame while building a scene.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { frameAt, openCapture, warmUp } from '../../src/lib/capture.mjs';
import { ToolError } from '../../src/lib/errors.mjs';

const GLOBAL_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const firstLine = (e) => String(e?.message ?? e ?? '').split(/\r?\n/)[0];

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
 * @param {object} input validated input, refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const globals = await collectGlobals(input);
  const ext = input.format === 'jpeg' ? 'jpg' : 'png';
  const times = input.times;

  /** @type {import('../../src/lib/capture.mjs').Capture|null} */
  let capture = null;
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

    const page = await capture.newPage();
    const stills = [];
    try {
      if (input.warmup) await warmUp(page);
      for (const t of times) {
        if (ctx.signal.aborted) throw new ToolError('canceled', 'stills canceled');
        const buf = await frameAt(page, t, {
          type: input.format,
          quality: input.quality,
          timeoutMs: input.frame_timeout_s * 1000,
          retries: input.frame_retries,
          onStall: (at, e) => ctx.log(`still at ${at.toFixed(3)} s stalled, retrying (${firstLine(e)})`),
        });
        const name = `still-${t.toFixed(3).padStart(8, '0')}.${ext}`; // zero-padded: name order = time order
        await writeFile(path.join(ctx.outDir, name), buf);
        stills.push({ t, name });
        ctx.progress(stills.length / times.length, `still ${stills.length}/${times.length} at ${t.toFixed(3)} s`);
      }
    } finally {
      await page.close().catch(() => {});
    }

    ctx.progress(1, 'done');
    // Screenshots are in device pixels: the image is the viewport times the device scale factor.
    return {
      result: {
        stills,
        width: Math.round(width * input.device_scale_factor),
        height: Math.round(height * input.device_scale_factor),
        page_errors: [...new Set(capture.pageErrors)].slice(0, 50),
      },
    };
  } finally {
    await capture?.close().catch(() => {});
  }
}
