// The one way motionex runs ffmpeg/ffprobe. Resolution: FFMPEG_PATH / FFPROBE_PATH, then the
// ffmpeg-static / ffprobe-static dev packages (host), then PATH.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ToolError } from './errors.mjs';

const require = createRequire(import.meta.url);
const tryRequire = (name) => {
  try {
    const m = require(name);
    return typeof m === 'string' ? m : (m?.path ?? null);
  } catch {
    return null;
  }
};

let ffmpegCached;
/** Absolute path (or bare "ffmpeg" from PATH). */
export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (ffmpegCached === undefined) {
    const p = tryRequire('ffmpeg-static');
    ffmpegCached = p && existsSync(p) ? p : 'ffmpeg';
  }
  return ffmpegCached;
}

let ffprobeCached;
/** Absolute path, "ffprobe" when it runs from PATH, or null when there is no ffprobe. */
export function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (ffprobeCached === undefined) {
    const p = tryRequire('ffprobe-static');
    if (p && existsSync(p)) ffprobeCached = p;
    else ffprobeCached = spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0 ? 'ffprobe' : null;
  }
  return ffprobeCached;
}

const STDERR_CAP = 16 * 1024 * 1024;

function run(bin, args, { signal, cwd, input, stdout = 'buffer', onStderrLine, name = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolError('canceled', `${name} was not started: canceled`));
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', stdout === 'ignore' ? 'ignore' : 'pipe', 'pipe'],
    });
    const out = [];
    let err = '';
    let partial = '';
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      if (err.length < STDERR_CAP) err += d;
      if (onStderrLine) {
        partial += d;
        const lines = partial.split(/\r?\n|\r/);
        partial = lines.pop();
        for (const l of lines) onStderrLine(l);
      }
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new ToolError('tool-failed', `${name} could not start (${bin}): ${e.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new ToolError('canceled', `${name} canceled`));
      if (code !== 0) return reject(new ToolError('tool-failed', `${name} exited with ${code}: ${err.slice(-4000)}`));
      resolve({ stdout: stdout === 'buffer' ? Buffer.concat(out) : null, stderr: err });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // EPIPE when ffmpeg exits early; the exit code tells the story
      child.stdin.end(input);
    }
  });
}

/**
 * Run ffmpeg. Always pass -hide_banner yourself if you parse stderr.
 * @param {string[]} args
 * @param {{signal?: AbortSignal, cwd?: string, input?: Buffer|string, stdout?: 'buffer'|'ignore', onStderrLine?: (line: string) => void}} [opts]
 * @returns {Promise<{stdout: Buffer|null, stderr: string}>}
 * @throws {ToolError} tool-failed (non-zero exit, with the last 4000 chars of stderr) or canceled
 */
export function runFfmpeg(args, opts = {}) {
  return run(ffmpegPath(), args, { ...opts, name: 'ffmpeg' });
}

/** Run ffprobe; throws ToolError('tool-failed') when there is no ffprobe. */
export function runFfprobe(args, opts = {}) {
  const bin = ffprobePath();
  if (!bin) return Promise.reject(new ToolError('tool-failed', 'ffprobe is not available'));
  return run(bin, args, { ...opts, name: 'ffprobe' });
}

let infoCached;
/** @returns {Promise<{path: string, version: string, major: number, filters: Set<string>, encoders: Set<string>}>} */
export async function ffmpegInfo() {
  if (infoCached) return infoCached;
  const v = await runFfmpeg(['-hide_banner', '-version']).catch(() => runFfmpeg(['-version']));
  const text = v.stdout.toString();
  const version = /ffmpeg version (\S+)/.exec(text)?.[1] ?? 'unknown';
  const major = Number(/^n?(\d+)/.exec(version)?.[1] ?? 0);
  const names = async (flag) => {
    const r = await runFfmpeg(['-hide_banner', flag]);
    const set = new Set();
    for (const line of r.stdout.toString().split('\n')) {
      const m = /^\s*[A-Z.|]{2,7}\s+(\S+)\s/.exec(line);
      if (m && m[1] !== '=') set.add(m[1]);
    }
    return set;
  };
  infoCached = {
    path: ffmpegPath(),
    version,
    major,
    filters: await names('-filters'),
    encoders: await names('-encoders'),
  };
  return infoCached;
}

/** Seconds from the first "Duration: HH:MM:SS.xx" in ffmpeg stderr; null when absent or N/A. */
export function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr ?? '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** An atempo chain for any speed factor k > 0, each stage within [0.5, 2]. k = 1 gives "anull". */
export function atempoChain(k) {
  if (!(k > 0)) throw new ToolError('invalid-input', `tempo must be > 0 (got ${k})`);
  if (Math.abs(k - 1) < 1e-9) return 'anull';
  const parts = [];
  let r = k;
  while (r > 2) {
    parts.push(2);
    r /= 2;
  }
  while (r < 0.5) {
    parts.push(0.5);
    r /= 0.5;
  }
  parts.push(r);
  return parts.map((x) => `atempo=${Number(x.toFixed(6))}`).join(',');
}

const FORBIDDEN = /(?:^|[,;\]\s])\s*(a?movie|sendcmd|asendcmd|a?zmq)\s*(?=[=,;[\s]|$)/i;
/**
 * Check an agent-supplied filter chain. Source filters that read files or sockets (movie, amovie, sendcmd, zmq)
 * are refused, because chains run with the service's file access.
 * @returns {string} the chain
 * @throws {ToolError} invalid-input
 */
export function checkChain(chain, what = 'filter chain') {
  if (chain == null || chain === '') return chain;
  if (typeof chain !== 'string') throw new ToolError('invalid-input', `${what} must be a string`);
  const m = FORBIDDEN.exec(chain);
  if (m)
    throw new ToolError(
      'invalid-input',
      `${what}: the "${m[1]}" filter is not allowed in chains (use an input ref instead)`,
    );
  return chain;
}

/**
 * Video encoder arguments.
 * @param {{codec?: string, preset?: string, crf?: number, bitrate_k?: number, maxrate_k?: number, bufsize_k?: number,
 *   profile?: string, level?: string, gop?: number, keyint_min?: number, sc_threshold?: number, closed_gop?: boolean,
 *   pix_fmt?: string, tune?: string, x264_params?: string, threads?: number}} v
 * @returns {string[]}
 */
export function videoArgs(v = {}) {
  const a = ['-c:v', v.codec ?? 'libx264'];
  if (v.preset) a.push('-preset', v.preset);
  if (v.tune) a.push('-tune', v.tune);
  if (v.bitrate_k != null) a.push('-b:v', `${Math.round(v.bitrate_k)}k`);
  else if (v.crf != null) a.push('-crf', String(v.crf));
  if (v.maxrate_k != null) {
    a.push('-maxrate', `${Math.round(v.maxrate_k)}k`, '-bufsize', `${Math.round(v.bufsize_k ?? v.maxrate_k * 2)}k`);
  } else if (v.bufsize_k != null) a.push('-bufsize', `${Math.round(v.bufsize_k)}k`);
  if (v.profile) a.push('-profile:v', v.profile);
  if (v.level) a.push('-level:v', String(v.level));
  if (v.gop != null) a.push('-g', String(v.gop));
  if (v.keyint_min != null) a.push('-keyint_min', String(v.keyint_min));
  if (v.sc_threshold != null) a.push('-sc_threshold', String(v.sc_threshold));
  if (v.closed_gop) a.push('-flags', '+cgop');
  if (v.x264_params) a.push('-x264-params', v.x264_params);
  if (v.threads != null) a.push('-threads', String(v.threads));
  a.push('-pix_fmt', v.pix_fmt ?? 'yuv420p');
  return a;
}

/** Colour tags for an output. 'bt709' -> bt709 primaries/trc/matrix, TV range. null -> []. */
export function colorArgs(space) {
  if (!space) return [];
  return ['-colorspace', space, '-color_primaries', space, '-color_trc', space, '-color_range', 'tv'];
}
