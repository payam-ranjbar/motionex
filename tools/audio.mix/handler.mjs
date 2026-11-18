// audio.mix: a declarative track/bus mixer. Sums clips sample-accurately to an exact length.
// With no options it is a neutral float sum at unity (no ducking, no normalisation, no limiter) written
// as 32-bit float WAV. Every dynamics feature (track_defaults, clip_leveling, automation, level, sidechain,
// master) is opt-in, and so is the per-cue level table (`cues`); the master, dynamics, automation and cue
// stages live in src/lib/mix/.

import { buildTrackBuffers, decodeClips } from '../../src/lib/mix/clips.mjs';
import { attachCues, cueTable } from '../../src/lib/mix/cues.mjs';
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
  const { buffers, n, warnings: clipWarnings, spans } = buildTrackBuffers(plan, decoded);
  const warnings = [...plan.warnings, ...clipWarnings];

  ctx.progress(0.4, 'mixing tracks');
  const { mix: summed, stems, gains } = await buildMix(plan, buffers, n, { signal: ctx.signal });

  ctx.progress(0.7, 'master');
  const { mix: mastered, report: masterReport } = await applyMasterStage(summed, plan.master, { signal: ctx.signal });
  if (masterReport?.warning) warnings.push(`master: ${masterReport.warning}`);
  const mix = fitLength(mastered, n);

  ctx.progress(0.85, 'writing outputs');
  const outputs = await writeOutputs({ outDir: ctx.outDir, output: plan.output, mix, stems }, { signal: ctx.signal });

  const base = await buildReport(
    { plan, n, mix, stems, gains, masterReport, warnings, output: plan.output },
    { signal: ctx.signal },
  );
  if (plan.cues) ctx.progress(0.95, 'measuring cues');
  const { result, report } = attachCues(base, plan.cues ? cueTable(plan, stems, spans) : null);
  outputs.push(await writeReport(ctx.outDir, report, { signal: ctx.signal }));
  ctx.progress(1, 'done');
  return { result, outputs };
}
