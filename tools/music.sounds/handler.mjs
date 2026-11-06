// music.sounds: list the sounds the vendored Mucavex engine knows, so an agent can look a name up before
// calling music.render (instead of guessing `tabla`, `perc`, ... one render at a time).
//
// The engine keeps its sound map in the *bundled* superdough instance that engine.mjs imports. Import the
// same bare `superdough` specifier so we read that instance, not the standalone superdough/superdough.mjs
// copy (which has its own empty map). The engine and the vendor modules read env/config at import/call time,
// so everything below is set up before the dynamic imports.
import { ToolError } from '../../src/lib/errors.mjs';

/**
 * Classify a registered sound: soundfonts are the GM names, synthesizers are oscillators/noise, and
 * everything else is a sampler bank.
 * @param {string} name
 * @param {{type?: string, samples?: string[], fonts?: string[]}} data
 * @returns {'synth'|'sample'|'soundfont'}
 */
function kindOf(name, data) {
  if (data?.type === 'soundfont' || name.startsWith('gm_')) return 'soundfont';
  if (data?.type === 'synth') return 'synth';
  return 'sample';
}

/**
 * Build a name matcher from `filter`: a case-insensitive substring, or a case-insensitive regular
 * expression when it starts and ends with `/`.
 * @param {string} [filter]
 * @returns {(name: string) => boolean}
 */
function nameMatcher(filter) {
  if (filter == null || filter === '') return () => true;
  if (filter.length >= 2 && filter.startsWith('/') && filter.endsWith('/')) {
    let re;
    try {
      re = new RegExp(filter.slice(1, -1), 'i');
    } catch (err) {
      throw new ToolError('invalid-input', `invalid filter regex: ${err instanceof Error ? err.message : err}`);
    }
    return (name) => re.test(name);
  }
  const needle = filter.toLowerCase();
  return (name) => name.toLowerCase().includes(needle);
}

/**
 * @param {{filter?: string, kind?: 'synth'|'sample'|'soundfont'|'all', offline?: boolean}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const offline = Boolean(input.offline || ctx.config.offline);

  // Same engine environment as music.render, installed before any vendor module is imported.
  process.env.FFMPEG_PATH = ctx.ffmpeg.path;
  process.env.SAMPLE_CACHE_DIR = ctx.config.sampleCacheDir;
  process.env.OFFLINE = offline ? '1' : '';
  process.env.MAX_SECONDS = String(ctx.config.musicMaxSeconds);
  process.env.MAX_POLYPHONY = '4096';

  ctx.progress(0, 'loading engine');
  await import('../../vendor/mucavex/src/resolve-hooks.mjs');
  const { config } = await import('../../vendor/mucavex/src/config.mjs');
  config.sampleCacheDir = ctx.config.sampleCacheDir;
  config.offline = offline;
  config.maxSeconds = ctx.config.musicMaxSeconds;
  config.maxPolyphony = 4096;

  // initEngine() registers synth/ZZFX sounds and runs the REPL prebake (sample maps, GM soundfonts and
  // the drum-machine bank aliases), all into the bundled superdough instance.
  const { initEngine } = await import('../../vendor/mucavex/src/engine.mjs');
  await initEngine();

  const { soundMap } = await import('superdough');
  const map = soundMap.get();

  ctx.progress(0.8, 'listing sounds');
  const matches = nameMatcher(input.filter);
  const kind = input.kind ?? 'all';
  const sounds = [];
  const banks = new Set();
  for (const [name, entry] of Object.entries(map)) {
    const data = entry?.data ?? {};
    const soundKind = kindOf(name, data);
    // Bank names come from sampler keys of the form `<bank>_<variant>` (drum machines and their aliases);
    // the full set is reported regardless of `filter`/`kind` so it works as a lookup table.
    if (soundKind === 'sample') {
      const sep = name.indexOf('_');
      if (sep > 0) banks.add(name.slice(0, sep));
    }
    if (kind !== 'all' && soundKind !== kind) continue;
    if (!matches(name)) continue;
    const variants = soundKind === 'sample' && Array.isArray(data.samples) ? data.samples.length : null;
    sounds.push({ name, kind: soundKind, variants });
  }
  sounds.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  ctx.progress(1, 'done');
  return {
    result: {
      count: sounds.length,
      sounds,
      banks: [...banks].sort(),
    },
  };
}
