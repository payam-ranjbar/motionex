// media.concat: join clips with the concat demuxer (copy) or the concat filter (reencode).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { runFfmpeg, runFfprobe, videoArgs } from '../../src/lib/ffmpeg.mjs';
import { mediaTypeOf } from '../../src/lib/media-types.mjs';
import { isSafeOutputPath } from '../../src/lib/paths.mjs';

/** A finite number from an ffprobe value, or null. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ffprobe streams+format for a file. */
async function probe(file, signal) {
  const { stdout } = await runFfprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    signal,
    stdout: 'buffer',
  });
  return JSON.parse(stdout.toString('utf8') || '{}');
}

/** Escape a path for a concat-demuxer list line: single quote -> '\''. */
const escapeListPath = (p) => p.replace(/'/g, "'\\''");

/**
 * @param {{inputs: string[], mode: 'copy'|'reencode', video?: {codec?: string, preset?: string, crf?: number, pix_fmt?: string},
 *   audio?: {codec: string, bitrate_k: number}, name: string}} input refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  if (!isSafeOutputPath(input.name))
    throw new ToolError('invalid-input', `name "${input.name}" is not a safe file name`);
  const out = path.join(ctx.outDir, input.name);
  const n = input.inputs.length;

  if (input.mode === 'copy') {
    const listPath = path.join(ctx.scratchDir, 'concat.txt');
    const list = `${input.inputs.map((p) => `file '${escapeListPath(p)}'`).join('\n')}\n`;
    await writeFile(listPath, list, 'utf8');
    ctx.progress(0.1, 'concatenating');
    await runFfmpeg(
      [
        '-hide_banner',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        out,
      ],
      { signal: ctx.signal },
    );
  } else {
    let hasAudio = true;
    for (const file of input.inputs) {
      const p = await probe(file, ctx.signal);
      if (!(p.streams ?? []).some((s) => s.codec_type === 'audio')) {
        hasAudio = false;
        break;
      }
    }
    const filter = hasAudio
      ? `${input.inputs.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${n}:v=1:a=1[v][a]`
      : `${input.inputs.map((_, i) => `[${i}:v]`).join('')}concat=n=${n}:v=1:a=0[v]`;
    const maps = hasAudio ? ['-map', '[v]', '-map', '[a]'] : ['-map', '[v]'];
    const audioArgs = hasAudio
      ? ['-c:a', input.audio?.codec ?? 'aac', '-b:a', `${input.audio?.bitrate_k ?? 192}k`]
      : [];
    const args = ['-hide_banner', '-y'];
    for (const file of input.inputs) args.push('-i', file);
    args.push('-filter_complex', filter, ...maps, ...videoArgs(input.video ?? {}), ...audioArgs);
    args.push('-movflags', '+faststart', out);
    ctx.progress(0.1, 'concatenating');
    await runFfmpeg(args, { signal: ctx.signal });
  }

  ctx.progress(0.9, 'probing');
  const p = await probe(out, ctx.signal);
  ctx.progress(1, 'done');
  return {
    result: { duration_s: num(p.format?.duration), mode: input.mode },
    outputs: [{ name: input.name, media_type: mediaTypeOf(input.name) }],
  };
}
