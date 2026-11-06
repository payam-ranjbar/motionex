// media.frames: one still image per requested time, optionally scaled.
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { parseDuration, runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { mediaTypeOf } from '../../src/lib/media-types.mjs';

/**
 * @param {{video: string, times: number[], format: 'png'|'jpeg', width?: number}} input refs already resolved
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const ext = input.format === 'jpeg' ? 'jpg' : 'png';
  // A time past the end makes ffmpeg fail with an encoder error that hides the real cause (an agent asked for
  // 8–13 s on a 5 s draft). Check the duration first and say it plainly.
  // Use the VIDEO stream's duration: the container's can be longer (a mix 0.1 s longer than the picture), and a
  // time between the two still has no frame. Fall back to the container duration when there is no ffprobe.
  let duration = null;
  const vp = await runFfprobe(
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', input.video],
    { signal: ctx.signal, stdout: 'buffer' },
  ).catch(() => null);
  duration = vp ? Number.parseFloat(vp.stdout.toString('utf8')) : Number.NaN;
  if (!Number.isFinite(duration)) {
    const probe = await runFfmpeg(['-hide_banner', '-i', input.video], { signal: ctx.signal }).catch((e) => ({
      stderr: e.detail ?? '',
    }));
    duration = parseDuration(probe.stderr);
  }
  if (duration != null) {
    const late = input.times.filter((t) => t >= duration);
    if (late.length) {
      throw new ToolError(
        'invalid-input',
        `times past the end of the video (${duration.toFixed(3)} s): ${late.join(', ')}; the last frame is just before ${duration.toFixed(3)} s`,
      );
    }
  }
  const frames = [];
  for (let i = 0; i < input.times.length; i++) {
    const t = input.times[i];
    const name = `frame-${t.toFixed(3).padStart(8, '0')}.${ext}`; // zero-padded: name order = time order
    const args = ['-hide_banner', '-y', '-ss', String(t), '-i', input.video, '-frames:v', '1'];
    if (input.width != null) args.push('-vf', `scale=${input.width}:-2`);
    args.push(path.join(ctx.outDir, name));
    await runFfmpeg(args, { signal: ctx.signal });
    frames.push({ t, name });
    ctx.progress((i + 1) / input.times.length, `${i + 1}/${input.times.length}`);
  }
  return {
    result: { frames },
    outputs: frames.map((f) => ({ name: f.name, media_type: mediaTypeOf(f.name) })),
  };
}
