// Stems for music.render: find the named parts of a Strudel song, build one muted copy of the song per stem, and
// render each copy in a fresh engine.
//
// Strudel's transpiler turns a labelled statement `drums: s("bd*4")` into `s("bd*4").p('drums')`, and the REPL plays
// every `.p()` part together. A label that starts or ends with `_` is muted (`.p()` returns silence), a label that
// contains `$` is anonymous (`$:` lines), and a label longer than one character that starts with `S` solos.
// A stem is the song with every part outside the stem muted with that same `_` prefix, so it is exactly what the
// REPL plays with those parts muted. Parts are found with a real parse (acorn, the parser the transpiler itself
// uses), so an object key such as `{ gain: 1 }`, a `name:` inside a string or a comment, or a loop label is never
// taken for a part.
//
// Each stem renders in its own worker thread. superdough keeps audio nodes in module-global pools (filters,
// compressors, worklet voices) that outlive the OfflineAudioContext they were made on, so a second render in the
// same engine fails events with "Attempting to connect nodes from different contexts". A worker has its own copy
// of every module, so a stem renders exactly as a fresh job would render the muted song.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { parse } from 'acorn';
import { installAudioDecodeFallback } from '../../src/lib/audio-decode-fallback.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { mulberry32 } from '../../src/lib/signal.mjs';

/** Same options as @strudel/transpiler, so whatever the transpiler accepts parses here too. */
const PARSE_OPTIONS = { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true };
const ANON_SELECTOR = /^\$([1-9]\d*)$/;
const WORKER_KIND = 'music.render:stem';

/** Turn an engine/transpiler throw into a job error without swallowing cancellation. */
export function invalidInput(prefix, err) {
  if (err instanceof ToolError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ToolError('invalid-input', `${prefix}: ${detail}`);
}

/**
 * Render one version of the song. The engine skips events it cannot play (an unknown sound name, a sample that
 * failed to load) with only a console.warn; an agent cannot hear the missing part, so those messages come back as
 * warnings. Some sample files in the banks use a WAV shape node-web-audio-api refuses; they are routed through
 * ffmpeg and named, instead of rendering their events silent with no hint of the file.
 * @param {(job: object) => Promise<object>} render the engine's render()
 * @param {object} job engine job: {code, cycles, seconds, cps, sampleRate, tail}
 * @param {AbortSignal} [signal]
 * @returns {Promise<{rendered: {channels: Float32Array[], sampleRate: number, seconds: number, cps: number,
 *   events: number}, warnings: string[], ms: number}>}
 */
export async function renderOnce(render, job, signal) {
  const started = performance.now();
  const skipped = new Map();
  const warn = console.warn;
  const decodeFallback = installAudioDecodeFallback({ signal });
  console.warn = (...args) => {
    const msg = args.map(String).join(' ');
    const m = /event skipped: (.*)$/.exec(msg);
    if (m) skipped.set(m[1], (skipped.get(m[1]) ?? 0) + 1);
    warn(...args);
  };
  let rendered;
  try {
    rendered = await render(job);
  } catch (err) {
    // RangeError (too long / empty) and evaluation errors are the agent's fault, so invalid-input.
    throw invalidInput('Strudel render failed', err);
  } finally {
    console.warn = warn;
    decodeFallback.uninstall();
  }
  const warnings = [...skipped].map(([why, n]) => `${n} event(s) skipped (silent in the render): ${why}`);
  if (decodeFallback.transcoded.size > 0) {
    const files = [...decodeFallback.transcoded].join(', ');
    warnings.push(`${decodeFallback.transcoded.size} sample file(s) were decoded through ffmpeg: ${files}`);
  }
  return { rendered, warnings, ms: Math.round(performance.now() - started) };
}

/**
 * @typedef {object} Part
 * @property {string} label the label (or the `.p('...')` name) as written
 * @property {number} line 1-based line of the statement
 * @property {number} at offset where a `_` mutes the part (the label itself, or just inside the quote of `.p('x')`)
 * @property {boolean} anonymous the label contains `$`, so it is selected as `$1`, `$2`, ... by order
 * @property {number} [index] 1-based order among the anonymous parts
 * @property {boolean} muted the song already mutes it (`_x` or `x_`)
 * @property {boolean} solo Strudel plays only soloed parts when there are any (a label of 2+ chars starting with S)
 */

/** Visit every AST node (acorn nodes are plain objects with a string `type`). */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

function makePart(label, line, at) {
  const muted = label.startsWith('_') || label.endsWith('_');
  return {
    label,
    line,
    at,
    anonymous: label.includes('$'),
    muted,
    solo: !muted && label.length > 1 && label.startsWith('S'),
  };
}

/**
 * Every part of the song in source order: labelled expression statements (`drums: ...`, `$: ...`) and explicit
 * `.p('name')` calls. `dynamic` lists `.p(<expression>)` calls whose name is only known at run time.
 * @param {string} code Strudel source
 * @returns {{parts: Part[], dynamic: {line: number}[]}}
 */
export function findParts(code) {
  let ast;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch (err) {
    throw invalidInput('Strudel code does not parse', err);
  }
  const parts = [];
  const dynamic = [];
  walk(ast, (node) => {
    // A label on an expression is a Strudel part; a label on a loop or block is plain JavaScript (`break outer`).
    if (node.type === 'LabeledStatement' && node.body?.type === 'ExpressionStatement') {
      parts.push(makePart(node.label.name, node.loc.start.line, node.label.start));
      return;
    }
    const callee = node.type === 'CallExpression' ? node.callee : null;
    if (callee?.type !== 'MemberExpression' || callee.computed || callee.property?.name !== 'p') return;
    const arg = node.arguments[0];
    if (!arg) return;
    // Only a single-quoted literal reaches .p() as a string: the transpiler turns "..." and `...` into patterns.
    if (arg.type === 'Literal' && typeof arg.value === 'string' && arg.raw.startsWith("'")) {
      parts.push(makePart(arg.value, node.loc.start.line, arg.start + 1));
    } else {
      dynamic.push({ line: node.loc.start.line });
    }
  });
  parts.sort((a, b) => a.at - b.at);
  let index = 0;
  for (const part of parts) if (part.anonymous) part.index = ++index;
  return { parts, dynamic };
}

/** The selectors an agent can use, for error messages: named labels, then `$N (line L)`. */
function describeParts(parts) {
  const live = parts.filter((p) => !p.muted);
  const named = [...new Set(live.filter((p) => !p.anonymous).map((p) => p.label))];
  const anon = live.filter((p) => p.anonymous).map((p) => `$${p.index} (line ${p.line})`);
  const muted = [...new Set(parts.filter((p) => p.muted).map((p) => (p.anonymous ? `$${p.index}` : p.label)))];
  const list = [...named, ...anon].join(', ') || '(none)';
  return `parts in this song: ${list}${muted.length ? `; muted in the song: ${muted.join(', ')}` : ''}`;
}

/** The parts one selector names: a label (every statement with it), or `$N`, the N-th anonymous part. */
function select(parts, selector) {
  const anon = ANON_SELECTOR.exec(selector);
  if (anon) return parts.filter((p) => p.anonymous && p.index === Number(anon[1]));
  return parts.filter((p) => !p.anonymous && p.label === selector);
}

/**
 * Check the stems against the song and build one muted copy of the song per stem.
 * Throws invalid-input for an unknown or muted part, a song without parts, a part named at run time, or two stem
 * names that differ only by case (they would be the same file on Windows and macOS).
 * @param {string} code the song as it will be rendered (markers applied)
 * @param {Record<string, string[]>} stems `{stemName: [selector, ...]}`
 * @returns {{stems: {name: string, parts: string[], lines: number[], code: string}[], solo: Part[]}}
 */
export function planStems(code, stems) {
  const { parts, dynamic } = findParts(code);
  if (dynamic.length > 0) {
    const lines = dynamic.map((d) => d.line).join(', ');
    throw new ToolError(
      'invalid-input',
      `stems cannot mute a part whose name is only known at run time (.p(<expression>) on line ${lines}); ` +
        'label it instead (drums: s("bd*4")) or name it with a quoted string (.p(\'drums\'))',
    );
  }
  if (parts.length === 0) {
    throw new ToolError(
      'invalid-input',
      'stems need named parts, and this song has none: label each part (drums: s("bd*4")) or write it as a $: line, ' +
        'then select it by its label or as $1, $2, ... in song order',
    );
  }
  const seen = new Map();
  for (const name of Object.keys(stems)) {
    const other = seen.get(name.toLowerCase());
    if (other) throw new ToolError('invalid-input', `stem names "${other}" and "${name}" differ only by case`);
    seen.set(name.toLowerCase(), name);
  }

  const out = [];
  for (const [name, selectors] of Object.entries(stems)) {
    const keep = new Set();
    for (const selector of selectors) {
      const found = select(parts, selector);
      if (found.length === 0) {
        throw new ToolError('invalid-input', `stem "${name}": part "${selector}" not found; ${describeParts(parts)}`);
      }
      const live = found.filter((p) => !p.muted);
      if (live.length === 0) {
        throw new ToolError(
          'invalid-input',
          `stem "${name}": part "${selector}" is muted in the song (a label that starts or ends with _ is silent); ` +
            describeParts(parts),
        );
      }
      for (const p of live) keep.add(p);
    }
    // Mute every other live part by putting `_` in front of its name, from the end so earlier offsets stay valid.
    let stemCode = code;
    const mute = parts.filter((p) => !p.muted && !keep.has(p)).sort((a, b) => b.at - a.at);
    for (const p of mute) stemCode = `${stemCode.slice(0, p.at)}_${stemCode.slice(p.at)}`;
    const lines = [...new Set([...keep].map((p) => p.line))].sort((a, b) => a - b);
    out.push({ name, parts: [...selectors], lines, code: stemCode });
  }
  return { stems: out, solo: parts.filter((p) => p.solo) };
}

/**
 * Render a song in a fresh engine (a worker thread with its own module state), the same way the handler renders
 * the full mix: seeded Math.random first, then the vendor modules, then one render.
 * @param {{code: string, job: object, seed: number, engine: object, signal: AbortSignal}} opts `job` holds the
 *   render length/tempo fields; `engine` the Mucavex config fields to set
 * @returns {Promise<{rendered: object, warnings: string[], ms: number}>}
 */
export function renderInFreshEngine({ code, job, seed, engine, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError('canceled', 'music.render canceled'));
      return;
    }
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: WORKER_KIND, code, job, seed, engine } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const onAbort = () => finish(reject, new ToolError('canceled', 'music.render canceled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg) => {
      if (msg?.type === 'done') {
        finish(resolve, { rendered: msg.rendered, warnings: msg.warnings, ms: msg.ms });
      } else {
        finish(reject, new ToolError(msg?.error?.type ?? 'tool-failed', msg?.error?.detail ?? 'stem render failed'));
      }
    });
    worker.once('error', (err) => finish(reject, new ToolError('tool-failed', `stem render failed: ${err?.stack}`)));
    worker.once('exit', (exitCode) =>
      finish(reject, new ToolError('tool-failed', `stem render worker exited with ${exitCode} and no result`)),
    );
  });
}

/** Worker side of renderInFreshEngine: mirrors the handler's order (PRNG, hooks, transpiler, config, engine). */
async function workerMain({ code, job, seed, engine }) {
  Math.random = mulberry32(seed);
  await import('../../vendor/mucavex/src/resolve-hooks.mjs');
  const { transpiler } = await import('@strudel/transpiler');
  try {
    transpiler(code);
  } catch (err) {
    throw invalidInput('Strudel code does not parse', err);
  }
  const { config } = await import('../../vendor/mucavex/src/config.mjs');
  Object.assign(config, engine);
  const { render } = await import('../../vendor/mucavex/src/engine.mjs');
  return renderOnce(render, { code, ...job });
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  workerMain(workerData).then(
    ({ rendered, warnings, ms }) =>
      parentPort.postMessage(
        { type: 'done', rendered, warnings, ms },
        rendered.channels.map((ch) => ch.buffer),
      ),
    (err) => {
      const error =
        err instanceof ToolError
          ? { type: err.type, detail: err.detail }
          : { type: 'tool-failed', detail: String(err?.stack ?? err) };
      parentPort.postMessage({ type: 'error', error });
    },
  );
}
