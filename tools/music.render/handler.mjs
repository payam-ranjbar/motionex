// music.render: render a Strudel song to audio with the vendored Mucavex engine (vendor/mucavex/src).
//
// The engine keeps module-global state (audio context, sound map, effects) and reads its `config`
// object at call time, so the vendor modules are imported dynamically INSIDE run(), after the env
// vars and the deterministic Math.random are installed. Each job runs in its own child process, so
// there is exactly one engine per process (AGENTS.md, P8 prompt).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { mulberry32 } from '../../src/lib/signal.mjs';
import { applyMarkers } from '../../src/lib/strudel-markers.mjs';

/** Turn an engine/transpiler throw into a job error without swallowing cancellation. */
function invalidInput(prefix, err) {
  if (err instanceof ToolError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ToolError('invalid-input', `${prefix}: ${detail}`);
}

/**
 * @param {object} input refs already resolved to absolute paths; defaults applied
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  // 1. source: inline code, or a workspace-ref file resolved to an absolute path by the runner.
  const source = input.code != null ? input.code : await readFile(input.file, 'utf8');

  // 2. named section markers (throws invalid-input for an unknown name).
  const { code, applied: markersApplied } = applyMarkers(source, input.markers ?? {});

  // 3. engine environment + determinism. Must happen before any vendor module is imported:
  //    encode.mjs reads FFMPEG_PATH at import, fetch.mjs/config.mjs read the rest at import.
  const offline = Boolean(input.offline || ctx.config.offline);
  process.env.FFMPEG_PATH = ctx.ffmpeg.path;
  process.env.MAX_POLYPHONY = String(input.max_polyphony);
  process.env.SAMPLE_CACHE_DIR = ctx.config.sampleCacheDir;
  process.env.OFFLINE = offline ? '1' : '';
  process.env.MAX_SECONDS = String(ctx.config.musicMaxSeconds);
  // Strudel noise calls Math.random; a seeded PRNG makes the same input byte-identical every time.
  Math.random = mulberry32(input.seed);

  // 4. syntax pre-check before the engine is loaded (a parse error is invalid-input, not tool-failed).
  ctx.progress(0, 'evaluating');
  await import('../../vendor/mucavex/src/resolve-hooks.mjs');
  const { transpiler } = await import('@strudel/transpiler');
  try {
    transpiler(code);
  } catch (err) {
    throw invalidInput('Strudel code does not parse', err);
  }

  // 5. vendor modules, in the order the Mucavex CLI uses. Assign config fields as well, because the
  //    object was created at import time and the engine reads it per call.
  const { config } = await import('../../vendor/mucavex/src/config.mjs');
  config.maxPolyphony = input.max_polyphony;
  config.offline = offline;
  config.sampleCacheDir = ctx.config.sampleCacheDir;
  config.maxSeconds = ctx.config.musicMaxSeconds;
  config.maxCodeBytes = 262144;
  const { render } = await import('../../vendor/mucavex/src/engine.mjs');
  const { encode } = await import('../../vendor/mucavex/src/encode.mjs');
  const { analyze } = await import('../../vendor/mucavex/src/analyze.mjs');

  // 6. tempo: an explicit cps wins; otherwise bpm/beats_per_cycle; otherwise the song's setcps/setcpm.
  const cps = input.cps != null ? input.cps : input.bpm != null ? input.bpm / 60 / input.beats_per_cycle : undefined;

  ctx.progress(0.1, 'rendering');
  const started = performance.now();
  // The engine skips events it cannot play (an unknown sound name, a sample that failed to load) with only a
  // console.warn. An agent cannot hear the missing part, so collect those messages and return them as warnings.
  const skipped = new Map();
  const warn = console.warn;
  console.warn = (...args) => {
    const msg = args.map(String).join(' ');
    const m = /event skipped: (.*)$/.exec(msg);
    if (m) skipped.set(m[1], (skipped.get(m[1]) ?? 0) + 1);
    warn(...args);
  };
  let rendered;
  try {
    rendered = await render({
      code,
      cycles: input.cycles,
      seconds: input.seconds,
      cps,
      sampleRate: input.sample_rate,
      tail: input.tail_s,
    });
  } catch (err) {
    // RangeError (too long / empty) and evaluation errors are the agent's fault, so invalid-input.
    throw invalidInput('Strudel render failed', err);
  } finally {
    console.warn = warn;
  }
  const warnings = [...skipped].map(([why, n]) => `${n} event(s) skipped (silent in the render): ${why}`);
  const renderMs = Math.round(performance.now() - started);

  ctx.progress(0.75, 'encoding');
  const { bytes, ext } = await encode(rendered.channels, rendered.sampleRate, input.format, {
    bitrate: input.bitrate_k,
  });
  // Optional output name (agents reach for one); the extension always follows `format`.
  const base = input.name ? input.name.replace(/\.(wav|wav32|mp3|flac|ogg|opus|m4a)$/i, '') : 'music';
  await writeFile(path.join(ctx.outDir, `${base}.${ext}`), bytes);
  await writeFile(path.join(ctx.outDir, 'song.strudel'), code);

  let analysis = null;
  if (input.analyze) {
    ctx.progress(0.9, 'analyzing');
    const report = analyze(rendered.channels, rendered.sampleRate, {
      cps: rendered.cps,
      seconds: rendered.seconds,
    });
    analysis = {
      peakDb: report.peakDb,
      rmsDb: report.rmsDb,
      crestDb: report.crestDb,
      clippedSamples: report.clippedSamples,
      warnings: report.warnings,
    };
    await writeFile(path.join(ctx.outDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  }

  ctx.progress(1, 'done');
  return {
    result: {
      seconds: rendered.seconds,
      cps: rendered.cps,
      events: rendered.events,
      render_ms: renderMs,
      markers_applied: markersApplied,
      analysis,
      warnings,
    },
  };
}
