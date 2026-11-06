// media.mux: copy the video stream and add an audio track, optionally delayed.
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { mediaTypeOf } from '../../src/lib/media-types.mjs';
import { isSafeOutputPath } from '../../src/lib/paths.mjs';

/** A finite number from an ffprobe value, or null. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{video: string, audio: string, audio_codec: 'aac'|'copy'|'libopus'|'libmp3lame',
 *   audio_bitrate_k: number, audio_sample_rate?: number, audio_offset_s: number, shortest: boolean, name: string}} input
 *   refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  if (!isSafeOutputPath(input.name))
    throw new ToolError('invalid-input', `name "${input.name}" is not a safe file name`);
  const out = path.join(ctx.outDir, input.name);

  const args = ['-hide_banner', '-y', '-i', input.video];
  if (input.audio_offset_s) args.push('-itsoffset', String(input.audio_offset_s));
  args.push('-i', input.audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy');
  if (input.audio_codec === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', input.audio_codec, '-b:a', `${input.audio_bitrate_k}k`);
    if (input.audio_sample_rate != null) args.push('-ar', String(input.audio_sample_rate));
  }
  if (input.shortest) args.push('-shortest');
  args.push('-movflags', '+faststart', out);

  ctx.progress(0.1, 'muxing');
  await runFfmpeg(args, { signal: ctx.signal });

  ctx.progress(0.9, 'probing');
  const { stdout } = await runFfprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', out], {
    signal: ctx.signal,
    stdout: 'buffer',
  });
  const probe = JSON.parse(stdout.toString('utf8') || '{}');
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  ctx.progress(1, 'done');
  return {
    result: {
      duration_s: num(probe.format?.duration),
      video_codec: video?.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
    },
    outputs: [{ name: input.name, media_type: mediaTypeOf(input.name) }],
  };
}
