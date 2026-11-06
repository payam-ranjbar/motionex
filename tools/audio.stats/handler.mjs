// audio.stats: the Mucavex analysis report for any audio file. It measures; it never changes anything.
//
// The cycle rate comes from cps, or bpm / 60 / beats_per_cycle, or 1 / window_s. At most one of those three
// may be given (checked here, not with oneOf); with none of them the report has no per-cycle breakdown.
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { ToolError } from '../../src/lib/errors.mjs';

/**
 * @param {{input: string, cps?: number, bpm?: number, beats_per_cycle?: number, window_s?: number}} input refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const given = ['cps', 'bpm', 'window_s'].filter((k) => input[k] !== undefined);
  if (given.length > 1) {
    throw new ToolError('invalid-input', `at most one of cps, bpm or window_s may be given (got ${given.join(', ')})`);
  }

  ctx.progress(0, 'decoding');
  const audio = await decodeAudio(input.input, { sampleRate: 48000, channels: 2, signal: ctx.signal });
  const seconds = audio.channels[0].length / audio.sampleRate;

  let cps;
  if (input.cps !== undefined) cps = input.cps;
  else if (input.bpm !== undefined) cps = input.bpm / 60 / (input.beats_per_cycle ?? 4);
  else if (input.window_s !== undefined) cps = 1 / input.window_s;

  ctx.progress(0.5, 'analysing');
  const { analyze } = await import('../../vendor/mucavex/src/analyze.mjs');
  const result = analyze(audio.channels, 48000, { cps, seconds });
  ctx.progress(1, 'done');
  return { result };
}
