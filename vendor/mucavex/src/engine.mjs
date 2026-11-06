// Strudel code -> rendered audio, using superdough on an OfflineAudioContext.
// Mirrors renderPatternAudio() from @strudel/webaudio, but returns the buffer
// instead of triggering a browser download.
//
// superdough keeps its audio context, sound map and effects in module globals,
// so an engine instance renders one job at a time (we run one per worker thread).
import './env.mjs';
import * as core from '@strudel/core';
import { transpiler } from '@strudel/transpiler';
import {
  initAudio,
  registerSynthSounds,
  registerZZFXSounds,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  superdough,
} from 'superdough';
import { config } from './config.mjs';
import { prebake } from './prebake.mjs';

let ready;

export function initEngine() {
  ready ??= (async () => {
    await core.evalScope(core, import('@strudel/mini'), import('@strudel/tonal'), import('@strudel/webaudio'));
    registerSynthSounds();
    registerZZFXSounds();
    await prebake({ strudelDefaults: config.strudelDefaults, extraSampleMaps: config.preloadSamples });
  })();
  return ready;
}

// Evaluate user code with the same semantics as the Strudel REPL
// ($: blocks, setcps/setcpm, hush, all/each, ...). The scheduler is never started.
async function evaluateCode(code) {
  let evalError;
  const repl = core.repl({
    transpiler,
    getTime: () => 0,
    defaultOutput: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    onEvalError: (err) => (evalError = err),
  });
  const pattern = await repl.evaluate(code, false);
  if (evalError || !pattern) throw evalError ?? new Error('code did not produce a pattern');
  return { pattern, cps: repl.scheduler.cps };
}

/**
 * @param {object} job
 * @param {string} job.code         Strudel source
 * @param {number} [job.cycles]     cycles to render (default 4)
 * @param {number} [job.seconds]    alternative to cycles; wins if both are set
 * @param {number} [job.cps]        override the tempo set by the code
 * @param {number} [job.tail]       extra seconds after the last cycle (reverb/release tails)
 * @param {number} [job.sampleRate]
 */
export async function render(job) {
  await initEngine();
  const sampleRate = job.sampleRate ?? config.defaultSampleRate;
  const { pattern, cps: codeCps } = await evaluateCode(job.code);
  const cps = job.cps ?? codeCps ?? 0.5;

  const cycles = job.seconds != null ? job.seconds * cps : (job.cycles ?? 4);
  const seconds = cycles / cps + (job.tail ?? 0);
  if (!(seconds > 0) || seconds > config.maxSeconds) {
    throw new RangeError(`render length must be in (0, ${config.maxSeconds}] seconds, got ${seconds}`);
  }

  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  setAudioContext(ctx);
  // Don't import SuperdoughAudioController from 'superdough/superdoughoutput.mjs':
  // that's a second copy of superdough with its own audio-context singleton, and
  // its nodes end up in a different context. Clearing the controller makes the
  // bundled copy lazily build one on `ctx`.
  setSuperdoughAudioController(null);
  try {
    await initAudio({ maxPolyphony: config.maxPolyphony, multiChannelOrbits: false });

    // Ascending onset order matters for graph-state controls such as `cut`.
    const haps = pattern
      .queryArc(0, cycles, { _cps: cps })
      .filter((hap) => hap.hasOnset())
      .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

    for (const hap of haps) {
      hap.ensureObjectValue();
      const t = hap.whole.begin.valueOf() / cps;
      try {
        await superdough(hap.value, t, hap.duration / cps, cps, t);
      } catch (err) {
        console.warn(`[engine] event skipped: ${err.message}`);
      }
    }

    const rendered = await ctx.startRendering();
    const channels = Array.from({ length: rendered.numberOfChannels }, (_, c) =>
      Float32Array.from(rendered.getChannelData(c)),
    );
    return { channels, sampleRate, seconds, cps, events: haps.length };
  } finally {
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
  }
}
