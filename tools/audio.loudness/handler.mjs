// audio.loudness: EBU R128 summary from ffmpeg's ebur128 filter, plus an optional K-weighted
// momentary/short-term curve computed in JS.
// This is the TEMPLATE tool: copy its shape (tool.json + handler.mjs) for new node tools.
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { ebur128, loudnessCurve } from '../../src/lib/loudness.mjs';

/**
 * @param {{input: string, curve?: {window: 'momentary'|'short-term', step_s: number}}} input  refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  ctx.progress(0, 'measuring');
  const summary = await ebur128(input.input, { signal: ctx.signal });
  const result = { ...summary };
  if (input.curve) {
    ctx.progress(0.5, 'curve');
    const audio = await decodeAudio(input.input, { sampleRate: 48000, channels: 2, signal: ctx.signal });
    const window_s = input.curve.window === 'short-term' ? 3 : 0.4;
    result.curve = loudnessCurve(audio, { window_s, step_s: input.curve.step_s });
  }
  ctx.progress(1, 'done');
  return { result };
}
