// media.frames: one still image per requested time, optionally scaled.
import path from 'node:path';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { mediaTypeOf } from '../../src/lib/media-types.mjs';

/**
 * @param {{video: string, times: number[], format: 'png'|'jpeg', width?: number}} input refs already resolved
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const ext = input.format === 'jpeg' ? 'jpg' : 'png';
  const frames = [];
  for (let i = 0; i < input.times.length; i++) {
    const t = input.times[i];
    const name = `frame-${t.toFixed(3)}.${ext}`;
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
