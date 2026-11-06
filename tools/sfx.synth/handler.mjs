// sfx.synth: run an SFX recipe module (the agent's own workspace .mjs or the built-in `generic` recipes) and
// synthesize each named sound with the shared DSP kit. Every sound is finished (DC block, trim, fades, peak
// normalisation), written to out/<name>.wav and measured (seconds, peak, RMS, momentary/integrated loudness).
//
// A recipe module exports:
//   export const sounds = { name(kit, params) { ... return [L, R]; } ...
//   export const finish = { name: { peak_db: -3 } } // optional per-sound finish overrides
//   export const describe = { name: 'one-line description' } // optional
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeAudio, writeAudio } from '../../src/lib/audio-io.mjs';
import { createKit } from '../../src/lib/dsp/kit.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { integratedLufs, loudnessCurve } from '../../src/lib/loudness.mjs';
import { db } from '../../src/lib/signal.mjs';
import { framesOf } from '../../src/lib/wav.mjs';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** @param {number[]} chs */
function peakAt(channels, sampleRate) {
  let pk = 0;
  let at = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > pk) {
        pk = a;
        at = i;
      }
    }
  return { peak_db: db(pk), peak_at_s: sampleRate ? at / sampleRate : 0 };
}

/** @param {Float32Array[]} channels */
function rms(channels) {
  let sum = 0;
  let n = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      sum += ch[i] * ch[i];
      n++;
    }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * @param {{recipe?: string, builtin?: 'generic', sounds?: string[], params?: Record<string, object>,
 *   palette?: Record<string, string>, finish?: object, format?: 'wav'|'wav24'|'wav32f', seed?: number}} input
 *   refs (`recipe`, `palette.*`) already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  // 1. Decode the palette (name -> audio) at 48 kHz stereo.
  const palette = {};
  for (const [name, abs] of Object.entries(input.palette ?? {})) {
    palette[name] = await decodeAudio(abs, { sampleRate: 48000, channels: 2, signal: ctx.signal });
  }

  // 2. The DSP kit.
  const kit = createKit({ palette, seed: input.seed });

  // 3. Load the recipe module.
  ctx.progress(0, 'loading recipe');
  let mod;
  try {
    const recipeAbs = input.recipe ?? path.resolve(ctx.toolDir, '../../lib/sfx/recipes/generic.mjs');
    mod = await import(pathToFileURL(recipeAbs).href);
  } catch (e) {
    throw new ToolError('invalid-input', `could not load recipe: ${e.message}`);
  }
  const sounds = mod.sounds;
  if (!sounds || typeof sounds !== 'object') {
    throw new ToolError('invalid-input', 'recipe does not export a `sounds` object');
  }
  const available = Object.keys(sounds);
  const names = input.sounds ?? available;
  for (const name of names) {
    if (!Object.hasOwn(sounds, name) || typeof sounds[name] !== 'function') {
      throw new ToolError('invalid-input', `unknown sound "${name}"; available: ${available.join(', ') || '(none)'}`);
    }
    if (!SAFE_NAME.test(name)) {
      throw new ToolError('invalid-input', `sound name "${name}" is not a safe output file name`);
    }
  }

  // 4. Render, finish, write and measure every sound.
  const results = [];
  const warnings = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    ctx.progress(names.length ? i / names.length : 1, name);
    const params = input.params?.[name] ?? {};
    const accepted = mod.params?.[name];
    if (accepted) {
      const unknown = Object.keys(params).filter((k) => !Object.hasOwn(accepted, k));
      if (unknown.length) {
        warnings.push(
          `${name}: unknown params ${unknown.join(', ')} were ignored (accepted: ${Object.keys(accepted).join(', ') || 'none'})`,
        );
      }
    }
    const buffer = await sounds[name](kit, params);
    if (
      !Array.isArray(buffer) ||
      buffer.length !== 2 ||
      !(buffer[0] instanceof Float32Array) ||
      !(buffer[1] instanceof Float32Array) ||
      buffer[0].length === 0 ||
      buffer[0].length !== buffer[1].length
    ) {
      throw new ToolError(
        'tool-failed',
        `sound "${name}" did not return [Float32Array, Float32Array] of equal non-zero length`,
      );
    }
    for (const ch of buffer)
      for (let s = 0; s < ch.length; s++) {
        if (!Number.isFinite(ch[s])) throw new ToolError('tool-failed', `sound "${name}" returned non-finite samples`);
      }

    const finishOpts = { ...(mod.finish?.[name] ?? {}), ...(input.finish ?? {}) };
    const channels = kit.finish(buffer, finishOpts);
    const audio = { sampleRate: kit.SR, channels };
    const file = `${name}.wav`;
    await writeAudio(path.join(ctx.outDir, file), audio, { format: input.format, signal: ctx.signal });

    const curve = loudnessCurve(audio, { window_s: 0.4, step_s: 0.05 });
    let momentary_max_lufs = null;
    for (const p of curve)
      if (p.lufs != null && (momentary_max_lufs == null || p.lufs > momentary_max_lufs)) momentary_max_lufs = p.lufs;
    const { peak_db, peak_at_s } = peakAt(channels, kit.SR);

    const result = {
      name,
      file,
      seconds: framesOf(audio) / audio.sampleRate,
      peak_db,
      rms_db: db(rms(channels)),
      peak_at_s,
      momentary_max_lufs,
      integrated_lufs: integratedLufs(audio),
    };
    if (mod.describe?.[name]) result.description = mod.describe[name];
    results.push(result);
  }

  // 5. A manifest of everything that was rendered.
  await writeFile(path.join(ctx.outDir, 'sounds.json'), JSON.stringify(results, null, 2), 'utf8');
  ctx.progress(1, 'done');
  return { result: { sounds: results, warnings } };
}
