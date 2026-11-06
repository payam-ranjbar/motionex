// audio.mix: a declarative track/bus mixer. Sums clips sample-accurately to an exact length.
// With no options it is a neutral float sum at unity (no ducking, no normalisation, no limiter) written
// as 32-bit float WAV. Every dynamics feature (track_defaults, clip_leveling, level, sidechain, master)
// is opt-in; the master and dynamics stages live in ./master.mjs and ./dynamics.mjs.

import { buildTrackBuffers, decodeClips } from '../../src/lib/mix/clips.mjs';
import { buildPlan } from '../../src/lib/mix/plan.mjs';
import { applyMasterStage, buildMix, buildReport, writeOutputs, writeReport } from '../../src/lib/mix/render.mjs';
import { fitLength } from '../../src/lib/signal.mjs';

/**
 * @param {object} input validated audio.mix input (refs already resolved to absolute paths)
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  ctx.progress(0, 'planning');
  const plan = await buildPlan(input, { signal: ctx.signal });

  ctx.progress(0.1, 'decoding clips');
  const decoded = await decodeClips(plan, { signal: ctx.signal });
  const { buffers, n, warnings } = buildTrackBuffers(plan, decoded);

  ctx.progress(0.4, 'mixing tracks');
  const { mix: summed, stems, gains } = await buildMix(plan, buffers, n, { signal: ctx.signal });

  ctx.progress(0.7, 'master');
  const { mix: mastered, report: masterReport } = await applyMasterStage(summed, plan.master, { signal: ctx.signal });
  if (masterReport?.warning) warnings.push(`master: ${masterReport.warning}`);
  const mix = fitLength(mastered, n);

  ctx.progress(0.85, 'writing outputs');
  const outputs = await writeOutputs({ outDir: ctx.outDir, output: plan.output, mix, stems }, { signal: ctx.signal });

  const result = await buildReport(
    { plan, n, mix, stems, gains, masterReport, warnings, output: plan.output },
    { signal: ctx.signal },
  );
  outputs.push(await writeReport(ctx.outDir, result, { signal: ctx.signal }));
  ctx.progress(1, 'done');
  return { result, outputs };
}
