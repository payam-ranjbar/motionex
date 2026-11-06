// Builds the `ctx` object passed to node handlers (see AGENTS.md "Handler contract").
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as audioIo from '../lib/audio-io.mjs';
import * as errors from '../lib/errors.mjs';
import * as ffmpeg from '../lib/ffmpeg.mjs';
import { sha256File } from '../lib/hash.mjs';
import * as loudness from '../lib/loudness.mjs';
import * as paths from '../lib/paths.mjs';
import * as signal from '../lib/signal.mjs';
import * as timespec from '../lib/timespec.mjs';
import * as wav from '../lib/wav.mjs';

/** Shared helpers for extension handlers that cannot import ../../src/lib by relative path. */
export const LIB = Object.freeze({ wav, audioIo, signal, ffmpeg, loudness, timespec, paths, errors });

/**
 * @param {object} o
 * @param {{id: string, tool: string, tool_version: string}} o.job
 * @param {string} o.workspace
 * @param {string} o.outDir
 * @param {string} o.scratchDir
 * @param {string} o.toolDir
 * @param {string} o.blobDir
 * @param {object} o.rawInput
 * @param {import('./types.mjs').Config} o.config
 * @param {AbortSignal} o.signal
 * @param {(event: object) => void} o.emit   receives {type:'progress'|'log'|'pid', ...}
 * @returns {import('./types.mjs').Ctx & {lib: typeof LIB, snapshot: (abs: string) => Promise<{sha256: string, blob: string}>}}
 */
export function makeContext({
  job,
  workspace,
  outDir,
  scratchDir,
  toolDir,
  blobDir,
  rawInput,
  config,
  signal: abortSignal,
  emit,
}) {
  return {
    job,
    rawInput,
    workspace,
    outDir,
    scratchDir,
    toolDir,
    blobDir,
    signal: abortSignal,
    config,
    progress(fraction, message) {
      const f = fraction == null || !Number.isFinite(fraction) ? null : Math.min(1, Math.max(0, fraction));
      emit({ type: 'progress', fraction: f, message: message ?? null });
    },
    log(message) {
      emit({ type: 'log', message: String(message) });
    },
    async secret(name) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new errors.ToolError('internal', `bad secret name "${name}"`);
      try {
        const v = (await readFile(path.join(config.secretsDir, name), 'utf8')).trim();
        return v || null;
      } catch {
        return null;
      }
    },
    trackProcess(pid) {
      if (Number.isInteger(pid) && pid > 0) emit({ type: 'pid', pid });
    },
    /** Copy a file into the content-addressed blob store (provenance). Idempotent. */
    async snapshot(abs) {
      const sha = await sha256File(abs);
      const rel = path.join('sha256', sha.slice(0, 2), sha);
      const dest = path.join(blobDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      try {
        await copyFile(abs, tmp);
        await rename(tmp, dest);
      } catch (e) {
        if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      }
      return { sha256: sha, blob: dest };
    },
    ffmpeg: { path: ffmpeg.ffmpegPath(), probePath: ffmpeg.ffprobePath(), run: ffmpeg.runFfmpeg },
    lib: LIB,
  };
}
