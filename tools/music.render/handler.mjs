// music.render: render a Strudel song to audio with the vendored Mucavex engine (vendor/mucavex/src).
//
// The engine keeps module-global state (audio context, sound map, effects) and reads its `config`
// object at call time, so the vendor modules are imported dynamically INSIDE run(), after the env
// vars and the deterministic Math.random are installed. Each job runs in its own child process, so
// there is exactly one engine per process (AGENTS.md, P8 prompt). Stems are further renders of the
// song with the other parts muted, each in a fresh engine of its own (see stems.mjs).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { fromDb, mono, mulberry32, rmsDb } from '../../src/lib/signal.mjs';
import { applyMarkers, markerForm } from '../../src/lib/strudel-markers.mjs';
import { invalidInput, planStems, renderInFreshEngine, renderOnce } from './stems.mjs';

/** Formats whose encoder keeps float samples, so a peak above 0 dBFS is preserved instead of clamped. */
const FLOAT_FORMATS = new Set(['wav32']);
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** `levels` holds at most this many rows; a longer song gets rows of several whole cycles each. */
const LEVEL_ROWS_MAX = 256;
/** The flat-level warning needs at least this many rows: fewer say too little about a song. */
const FLAT_MIN_ROWS = 8;
/** ...and at least this share of all rows inside one band of FLAT_BAND_DB. */
const FLAT_SHARE = 0.75;
const FLAT_BAND_DB = 1;
/** Rows below this are silent (the analyzer's "silent cycles" threshold) and never count as a flat level. */
const FLAT_FLOOR_DB = -50;
/** Slack for cycle counts that come out of a division (6 s at 1/3 cps is 2 cycles, not 1.9999999999999998). */
const CYCLE_EPS = 1e-9;

/**
 * Sample peak of the float render plus how many samples are at or past full scale (the same 0.999
 * threshold the analyzer uses), in one pass over every channel.
 * @param {Float32Array[]} channels @returns {{peak: number, clipped: number}}
 */
function renderPeak(channels) {
  let peak = 0;
  let clipped = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
    }
  }
  return { peak, clipped };
}

/**
 * Drop analyzer "silent cycles" entries that only cover the render tail. A cycle starts at `cycle / cps`, so a
 * cycle at or after the song's own end (before `tail_s`) is silent tail, not a gap in the song. Cycles inside the
 * song stay, and the warning disappears entirely when nothing is left.
 * @param {string[]} warnings
 * @param {number} songCycles number of cycles the song itself renders
 * @returns {string[]}
 */
function withoutTailSilence(warnings, songCycles) {
  if (!(songCycles > 0)) return warnings;
  const out = [];
  for (const warning of warnings) {
    const m = /^silent cycles: ([\d, ]+)$/.exec(warning);
    if (!m) {
      out.push(warning);
      continue;
    }
    const kept = m[1]
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((cycle) => Number.isFinite(cycle) && cycle < songCycles);
    if (kept.length) out.push(`silent cycles: ${kept.join(', ')}`);
  }
  return out;
}

/**
 * The mono sum the levels are measured on: the render as the file holds it. An encoder that clamps at ±1.0 is
 * followed, so an over-hot render reads the level it has on disk (a lossy codec changes it a little more).
 * @param {Float32Array[]} channels the render, after any peak_db gain
 * @param {number} sampleRate
 * @param {boolean} clamps the format clamps and the render has overs
 * @returns {Float32Array}
 */
function writtenMono(channels, sampleRate, clamps) {
  const written = clamps ? channels.map((ch) => ch.map((s) => Math.max(-1, Math.min(1, s)))) : channels;
  return mono({ sampleRate, channels: written });
}

/** RMS in dBFS of mono samples [from, to), two decimals, or null for digital silence. */
function levelDb(samples, from, to) {
  const value = rmsDb(samples, from, to);
  return Number.isFinite(value) ? round2(value) : null;
}

/**
 * The level of each cycle of the song (the tail is left out). Past LEVEL_ROWS_MAX cycles a row covers `step` whole
 * cycles, the smallest number that keeps the rows within the limit, so a long render stays readable in a result.
 * A song that ends inside a cycle gets a shorter last row.
 * @param {Float32Array} samples mono sum of the written render
 * @param {number} sampleRate
 * @param {number} cps cycles per second of the render
 * @param {number} songCycles cycles the song itself renders (may be fractional)
 * @returns {{rows: {cycle: number, at_s: number, to_s: number, rms_db: number|null}[], step: number}}
 */
function cycleLevels(samples, sampleRate, cps, songCycles) {
  const rows = [];
  if (!(cps > 0) || !(songCycles > 0)) return { rows, step: 1 };
  const perCycle = sampleRate / cps;
  const end = Math.min(samples.length, Math.round(songCycles * perCycle));
  const count = Math.ceil(songCycles - CYCLE_EPS);
  const step = Math.max(1, Math.ceil(count / LEVEL_ROWS_MAX));
  for (let cycle = 0; cycle < count; cycle += step) {
    const from = Math.round(cycle * perCycle);
    const to = Math.min(end, Math.round((cycle + step) * perCycle));
    if (to <= from) break;
    rows.push({
      cycle,
      at_s: round3(cycle / cps),
      to_s: round3(Math.min(songCycles, cycle + step) / cps),
      rms_db: levelDb(samples, from, to),
    });
  }
  return { rows, step };
}

/**
 * Give every marker that lands inside the song the level from it to the next marker in time (or to the end of the
 * song). A marker outside the song, or one without a numeric value, has nothing to measure and gets no `rms_db`.
 * @param {{value: number|string, rms_db?: number|null}[]} markers markers_found entries, changed in place
 * @param {Float32Array} samples mono sum of the written render
 * @param {number} sampleRate
 * @param {number} cps cycles per second of the render
 * @param {number} songCycles cycles the song itself renders
 */
function addMarkerLevels(markers, samples, sampleRate, cps, songCycles) {
  if (!(cps > 0) || !(songCycles > 0)) return;
  const perCycle = sampleRate / cps;
  const end = Math.min(samples.length, Math.round(songCycles * perCycle));
  const starts = markers.map((m) => m.value).filter((v) => typeof v === 'number');
  for (const marker of markers) {
    const at = marker.value;
    if (typeof at !== 'number' || at < 0 || at >= songCycles - CYCLE_EPS) continue;
    const next = Math.min(songCycles, ...starts.filter((v) => v > at));
    const from = Math.round(at * perCycle);
    const to = Math.min(end, Math.round(next * perCycle));
    if (to > from) marker.rms_db = levelDb(samples, from, to);
  }
}

/**
 * The warning for a render whose rows mostly sit at one level, or null. A stuck note renders as a job that
 * succeeded, with every marker and the peak it was asked for; only the levels show it. The rule: at least
 * FLAT_MIN_ROWS rows, and at least FLAT_SHARE of all rows audible (FLAT_FLOOR_DB or louder) inside one band
 * FLAT_BAND_DB wide. Silent rows count against the share, since silence has warnings of its own.
 * @param {{rms_db: number|null}[]} rows
 * @param {number} step cycles per row
 * @returns {string|null}
 */
function flatWarning(rows, step) {
  if (rows.length < FLAT_MIN_ROWS) return null;
  const audible = rows
    .map((row) => row.rms_db)
    .filter((v) => v != null && v >= FLAT_FLOOR_DB)
    .sort((a, b) => a - b);
  // The largest group of levels that fits in the band: a sliding window over the sorted levels.
  let size = 0;
  let first = 0;
  for (let lo = 0, hi = 0; hi < audible.length; hi++) {
    while (audible[hi] - audible[lo] > FLAT_BAND_DB + CYCLE_EPS) lo++;
    if (hi - lo + 1 > size) {
      size = hi - lo + 1;
      first = lo;
    }
  }
  if (size < FLAT_SHARE * rows.length) return null;
  const level = audible[first + Math.floor(size / 2)];
  const what = step > 1 ? `windows of ${step} cycles` : 'cycles';
  return (
    `${size} of ${rows.length} ${what} sit within ${FLAT_BAND_DB} dB of each other, around ${level.toFixed(1)} dBFS: ` +
    'that is what a stuck note looks like (a drone or a loop that never changes reads the same). Check the render ' +
    'before using it: `levels` has the level of each row'
  );
}

/** The warning for an over-hot render in a format that clamps at ±1.0 (audible distortion), or null. */
function clampWarning(peakDb, clipped, format) {
  if (peakDb == null || peakDb <= 0 || FLOAT_FORMATS.has(format)) return null;
  return (
    `the render peaks at +${peakDb.toFixed(1)} dBFS; ${clipped} samples clip in ${format}: ` +
    'lower .gain()/.postgain(), or set peak_db (or use format wav32, which keeps overs)'
  );
}

/** Check the inputs that only make sense together, before minutes of rendering. */
function checkStemOptions(input) {
  if (input.stems_only && !input.stems) {
    throw new ToolError('invalid-input', 'stems_only needs stems: name the stems to render, or drop stems_only');
  }
  if (input.stems_only && input.peak_db != null) {
    throw new ToolError(
      'invalid-input',
      'peak_db scales by the peak of the full mix, which stems_only does not render: drop stems_only or peak_db',
    );
  }
}

/**
 * @param {object} input refs already resolved to absolute paths; defaults applied
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  checkStemOptions(input);
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
  // Stems are checked against the song's parts now, so an unknown label fails before any render.
  const plan = input.stems ? planStems(code, input.stems) : null;

  // 5. vendor modules, in the order the Mucavex CLI uses. Assign config fields as well, because the
  //    object was created at import time and the engine reads it per call.
  const engine = {
    maxPolyphony: input.max_polyphony,
    offline,
    sampleCacheDir: ctx.config.sampleCacheDir,
    maxSeconds: ctx.config.musicMaxSeconds,
    maxCodeBytes: 262144,
  };
  const { config } = await import('../../vendor/mucavex/src/config.mjs');
  Object.assign(config, engine);
  const { render } = await import('../../vendor/mucavex/src/engine.mjs');
  const { encode } = await import('../../vendor/mucavex/src/encode.mjs');
  const { analyze } = await import('../../vendor/mucavex/src/analyze.mjs');

  // 6. tempo: an explicit cps wins; otherwise bpm/beats_per_cycle; otherwise the song's setcps/setcpm.
  const cps = input.cps != null ? input.cps : input.bpm != null ? input.bpm / 60 / input.beats_per_cycle : undefined;
  const job = { cycles: input.cycles, seconds: input.seconds, cps, sampleRate: input.sample_rate, tail: input.tail_s };
  const renders = (input.stems_only ? 0 : 1) + (plan?.stems.length ?? 0);
  const stepProgress = (done, message) => ctx.progress(0.1 + (0.85 * done) / renders, message);
  // With stems the progress is split per render; without them it is what it always was.
  const mainProgress = (fraction, message) => {
    if (!plan) ctx.progress(fraction, message);
  };

  const warnings = [];
  let renderMs = 0;
  let timing = null; // {seconds, cps} of the renders (every render of the song shares them)
  let events = 0;
  let peakDb = null;
  let gainDbApplied = null;
  let gain = 1;
  let analysis = null;
  let levels = null; // level rows of the full mix; stays null when stems_only skips the mix
  let markersFound = null; // the form with each marker's level, measured on the same mix

  if (!input.stems_only) {
    mainProgress(0.1, 'rendering');
    if (plan) stepProgress(0, `rendering the full mix (1/${renders})`);
    const main = await renderOnce(render, { code, ...job }, ctx.signal);
    const { rendered } = main;
    warnings.push(...main.warnings);
    renderMs += main.ms;
    timing = { seconds: rendered.seconds, cps: rendered.cps };
    events = rendered.events;

    // 7. Sample peak of the float render (one pass). Measured always, because an agent cannot hear overs and an
    //    integer encoder clamps them silently; `peak_db` then scales the whole render before encoding.
    let { peak, clipped } = renderPeak(rendered.channels);
    if (input.peak_db != null) {
      if (peak > 0) {
        gain = fromDb(input.peak_db) / peak;
        for (const ch of rendered.channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
        gainDbApplied = round2(20 * Math.log10(gain));
        peak *= gain;
        clipped = 0;
      } else {
        warnings.push(`the render is silent, so peak_db (${input.peak_db}) was not applied`);
      }
    }
    peakDb = peak > 0 ? round2(20 * Math.log10(peak)) : null;
    // Only the float format keeps overs; every other encoder clamps at ±1.0, which is audible distortion.
    const clamp = clampWarning(peakDb, clipped, input.format);
    if (clamp) warnings.push(clamp);

    // 7b. The level of each cycle of the song and of each marker's section. A render can succeed, carry every
    //     marker and hit its peak, and still be one stuck tone; the levels are where that shows, so they are
    //     always measured (one more pass over a mono sum).
    const songCycles = input.seconds != null ? input.seconds * rendered.cps : (input.cycles ?? 4);
    const samples = writtenMono(rendered.channels, rendered.sampleRate, clamp != null);
    const measured = cycleLevels(samples, rendered.sampleRate, rendered.cps, songCycles);
    levels = measured.rows;
    const flat = flatWarning(measured.rows, measured.step);
    if (flat) warnings.push(flat);
    markersFound = markerForm(code, rendered.cps);
    addMarkerLevels(markersFound, samples, rendered.sampleRate, rendered.cps, songCycles);

    mainProgress(0.75, 'encoding');
    const { bytes, ext } = await encode(rendered.channels, rendered.sampleRate, input.format, {
      bitrate: input.bitrate_k,
    });
    // Optional output name (agents reach for one); the extension always follows `format`.
    const base = input.name ? input.name.replace(/\.(wav|wav32|mp3|flac|ogg|opus|m4a)$/i, '') : 'music';
    await writeFile(path.join(ctx.outDir, `${base}.${ext}`), bytes);

    if (input.analyze) {
      mainProgress(0.9, 'analyzing');
      const report = analyze(rendered.channels, rendered.sampleRate, {
        cps: rendered.cps,
        seconds: rendered.seconds,
      });
      // The analyzer counts the silent tail as silent cycles; report only gaps inside the song itself.
      analysis = {
        peakDb: report.peakDb,
        rmsDb: report.rmsDb,
        crestDb: report.crestDb,
        clippedSamples: report.clippedSamples,
        warnings: withoutTailSilence(report.warnings, songCycles),
      };
      await writeFile(path.join(ctx.outDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    }
  }
  await writeFile(path.join(ctx.outDir, 'song.strudel'), code);

  // 8. Stems: the same song once per stem, every part outside the stem muted, each in a fresh engine (a worker
  //    thread, see stems.mjs) seeded like the mix. The mix's gain (from peak_db) is applied to every stem as well,
  //    so the stems keep the balance they have in the mix.
  let stems;
  if (plan) {
    if (plan.solo.length > 0) {
      const solo = plan.solo.map((p) => `${p.label} (line ${p.line})`).join(', ');
      warnings.push(
        `the song solos parts: ${solo}. Strudel plays only soloed parts when there are any (a label of two or more ` +
          'characters that starts with S solos), so the full mix and every stem that keeps a soloed part leave the ' +
          'other parts out',
      );
    }
    await mkdir(path.join(ctx.outDir, 'stems'), { recursive: true });
    stems = [];
    for (const stem of plan.stems) {
      if (ctx.signal.aborted) throw new ToolError('canceled', 'music.render canceled between stems');
      const done = renders - plan.stems.length + stems.length;
      stepProgress(done, `rendering stem ${stem.name} (${done + 1}/${renders})`);
      // Wall clock around the whole worker, so render_ms includes starting the fresh engine (its real cost).
      const started = performance.now();
      const pass = await renderInFreshEngine({ code: stem.code, job, seed: input.seed, engine, signal: ctx.signal });
      const { rendered } = pass;
      const stemMs = Math.round(performance.now() - started);
      renderMs += stemMs;
      timing ??= { seconds: rendered.seconds, cps: rendered.cps };
      if (input.stems_only) events += rendered.events;
      if (gain !== 1) for (const ch of rendered.channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
      const { peak, clipped } = renderPeak(rendered.channels);
      const stemPeakDb = peak > 0 ? round2(20 * Math.log10(peak)) : null;
      const clamp = clampWarning(stemPeakDb, clipped, input.format);
      for (const w of clamp ? [...pass.warnings, clamp] : pass.warnings) warnings.push(`stem "${stem.name}": ${w}`);
      const { bytes, ext } = await encode(rendered.channels, rendered.sampleRate, input.format, {
        bitrate: input.bitrate_k,
      });
      const file = `stems/${stem.name}.${ext}`;
      await writeFile(path.join(ctx.outDir, file), bytes);
      await writeFile(path.join(ctx.outDir, 'stems', `${stem.name}.strudel`), stem.code);
      stems.push({
        name: stem.name,
        file,
        parts: stem.parts,
        lines: stem.lines,
        peak_db: stemPeakDb,
        render_ms: stemMs,
      });
    }
  }

  ctx.progress(1, 'done');
  return {
    result: {
      seconds: timing.seconds,
      cps: timing.cps,
      events,
      render_ms: renderMs,
      markers_applied: markersApplied,
      markers_found: markersFound ?? markerForm(code, timing.cps),
      levels,
      peak_db: peakDb,
      gain_db_applied: gainDbApplied,
      analysis,
      warnings,
      ...(stems ? { stems } : {}),
    },
  };
}
