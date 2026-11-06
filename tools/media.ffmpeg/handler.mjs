// media.ffmpeg: the escape hatch. Run any ffmpeg command on workspace files.
// Placeholders: {in:NAME}, {out:FILE}, {script:NAME}. Paths are confined to the workspace;
// only placeholder-substituted arguments may be absolute. Filter chains are checked for file-reading filters.
// An output FILE may hold one printf frame counter (%d or %0Nd, N 1-9) to write an image sequence.
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { checkChain, runFfmpeg } from '../../src/lib/ffmpeg.mjs';

const FILTER_FLAGS = new Set(['-vf', '-af', '-filter:v', '-filter:a', '-filter_complex']);
const FRAME_COUNTER = /%(?:0[1-9])?d/;
const FRAME_COUNTER_ALL = /%(?:0[1-9])?d/g;
const PLACEHOLDER = /\{(in|out|script):([^{}]{1,200})\}/g;
const PLACEHOLDER_TOKEN = /^\{(in|out|script):([^{}]*)\}$/;
const PLACEHOLDER_CANDIDATE = /\{(?:in|out|script):[^}]*\}?/g;
const EXACT_PLACEHOLDER = /^\{(in|out|script):[^{}]{1,200}\}$/;
const BARE_BRACE = /\{([\w-]{1,64})\}/g;
const INPUT_NAME = /^[\w-]{1,64}$/;
const SCRIPT_NAME = /^[\w.-]{1,128}$/;
const NAME_PART = /^[\w.-]*$/;

const nameOk = (name, re) => typeof name === 'string' && re.test(name);
const isAbsolute = (p) => p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `name` is a safe output file name with at most one %d or %0Nd frame counter. */
function isOutputName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return false;
  if ((name.match(FRAME_COUNTER_ALL) ?? []).length > 1) return false;
  return name.split(FRAME_COUNTER).every((part) => NAME_PART.test(part));
}

const hasFrameCounter = (name) => FRAME_COUNTER.test(name);

/** True when `name` is a valid placeholder body for `kind`. */
function placeholderNameOk(kind, name) {
  if (kind === 'in') return INPUT_NAME.test(name);
  if (kind === 'script') return SCRIPT_NAME.test(name);
  return isOutputName(name);
}

/**
 * Reject placeholder-looking arguments that do not parse as complete, valid placeholders, before ffmpeg runs.
 * Other braces (ffmpeg expressions, drawtext) are left alone.
 */
function checkPlaceholders(arg, index, inputs) {
  PLACEHOLDER_CANDIDATE.lastIndex = 0;
  for (let m = PLACEHOLDER_CANDIDATE.exec(arg); m !== null; m = PLACEHOLDER_CANDIDATE.exec(arg)) {
    const token = PLACEHOLDER_TOKEN.exec(m[0]);
    if (!token || !placeholderNameOk(token[1], token[2])) {
      throw new ToolError(
        'invalid-input',
        `argument ${index} "${arg}": malformed placeholder; use {in:NAME}, {out:FILE} or {script:NAME} (FILE may hold one %d or %03d frame counter for an image sequence)`,
      );
    }
  }
  BARE_BRACE.lastIndex = 0;
  for (let m = BARE_BRACE.exec(arg); m !== null; m = BARE_BRACE.exec(arg)) {
    if (Object.hasOwn(inputs, m[1])) {
      throw new ToolError('invalid-input', `argument ${index} "${arg}": use {in:NAME} for an input`);
    }
  }
}

/** The tail of ffmpeg's stderr, for a missing-output failure. */
function stderrTail(run) {
  return String(run.stderr ?? '')
    .trim()
    .split('\n')
    .slice(-6)
    .join(' | ')
    .slice(-600);
}

function missingOutput(run, name) {
  const tail = stderrTail(run);
  // ffmpeg exits 0 and writes nothing when e.g. -ss is past the end of the input; show its own words.
  return new ToolError(
    'tool-failed',
    `declared output "${name}" was not written by the command (a common cause: -ss past the end of the input). ffmpeg said: ${tail || '(nothing)'}`,
  );
}

/**
 * @param {{args: string[], inputs?: Record<string, string>, outputs: string[], scripts?: Record<string, string>}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const { args, inputs = {}, outputs, scripts = {} } = input;
  const { outDir, scratchDir, signal } = ctx;

  // Declared outputs: safe single-segment names, resolved under outDir.
  const resolvedOutputs = outputs.map((name) => {
    if (!isOutputName(name)) {
      throw new ToolError(
        'invalid-input',
        `output name "${name}" must match ^[\\w.-]{1,128}$ (optionally with one %d or %0Nd frame counter)`,
      );
    }
    const abs = path.join(outDir, name);
    const rel = path.relative(outDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ToolError('invalid-input', `output "${name}" resolves outside the output directory`);
    }
    return { name, abs };
  });

  // Scripts: written into scratchDir; used by {script:NAME}.
  const scriptPaths = {};
  for (const [name, content] of Object.entries(scripts)) {
    if (!nameOk(name, SCRIPT_NAME)) {
      throw new ToolError('invalid-input', `script name "${name}" must match ^[\\w.-]{1,128}$`);
    }
    const abs = path.join(scratchDir, `${name}.txt`);
    const rel = path.relative(scratchDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ToolError('invalid-input', `script "${name}" resolves outside the scratch directory`);
    }
    await writeFile(abs, String(content), 'utf8');
    scriptPaths[name] = abs;
  }

  // Inputs are already resolved to absolute paths by the runner.
  for (const name of Object.keys(inputs)) {
    if (!nameOk(name, INPUT_NAME)) {
      throw new ToolError('invalid-input', `input name "${name}" must match ^[\\w-]{1,64}$`);
    }
  }

  // Substitute placeholders and remember which arguments are filter chains.
  const resolved = [];
  const filterIndices = new Set();
  let nextIsFilter = false;
  for (let i = 0; i < args.length; i++) {
    const original = args[i];
    checkPlaceholders(original, i, inputs);
    if (nextIsFilter) {
      filterIndices.add(resolved.length);
      nextIsFilter = false;
    }
    const value = original.replace(PLACEHOLDER, (_m, kind, name) => {
      if (kind === 'in') {
        if (!Object.hasOwn(inputs, name)) {
          throw new ToolError('invalid-input', `unknown input placeholder "{in:${name}}"`);
        }
        return inputs[name];
      }
      if (kind === 'out') {
        const out = resolvedOutputs.find((o) => o.name === name);
        if (!out) throw new ToolError('invalid-input', `unknown output placeholder "{out:${name}}"`);
        return out.abs;
      }
      if (!Object.hasOwn(scriptPaths, name)) {
        throw new ToolError('invalid-input', `unknown script placeholder "{script:${name}}"`);
      }
      return scriptPaths[name];
    });
    if (FILTER_FLAGS.has(value)) nextIsFilter = true;
    resolved.push({ original, value });
  }

  // Safety: filter chains are checked; every other argument must stay in the workspace.
  for (const [name, content] of Object.entries(scripts)) {
    checkChain(String(content), `script "${name}"`);
  }
  for (let i = 0; i < resolved.length; i++) {
    const { original, value } = resolved[i];
    if (filterIndices.has(i)) {
      checkChain(value, `filter argument ${i}`);
      continue;
    }
    if (EXACT_PLACEHOLDER.test(original)) continue;
    if (isAbsolute(value) || value.includes('..')) {
      throw new ToolError(
        'invalid-input',
        `argument ${i} "${original}" is an absolute path or contains ".." (use a {in:NAME}, {out:FILE} or {script:NAME} placeholder)`,
      );
    }
  }

  // Run. cwd = scratchDir so relative paths written by scripts land there, not in the workspace.
  const run0 = await runFfmpeg(['-hide_banner', '-nostdin', '-y', ...resolved.map((r) => r.value)], {
    cwd: scratchDir,
    signal,
  });

  // Every declared output must exist now. An image-sequence output is satisfied by at least one frame.
  const written = [];
  for (const out of resolvedOutputs) {
    if (!hasFrameCounter(out.name)) {
      let info;
      try {
        info = await stat(out.abs);
      } catch {
        throw missingOutput(run0, out.name);
      }
      if (!info.isFile()) throw new ToolError('tool-failed', `declared output "${out.name}" is not a file`);
      written.push({ name: out.name, bytes: info.size });
      continue;
    }

    const [prefix, suffix] = out.name.split(FRAME_COUNTER);
    const frameName = new RegExp(`^${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}$`);
    const frames = [];
    for (const entry of await readdir(outDir)) {
      const m = frameName.exec(entry);
      if (!m) continue;
      let info;
      try {
        info = await stat(path.join(outDir, entry));
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      frames.push({ name: entry, bytes: info.size, frame: Number(m[1]) });
    }
    if (frames.length === 0) throw missingOutput(run0, out.name);
    frames.sort((a, b) => a.frame - b.frame || a.name.localeCompare(b.name));
    for (const f of frames) written.push({ name: f.name, bytes: f.bytes });
  }

  return { result: { outputs: written, stderr_tail: String(run0.stderr ?? '').slice(-2000) } };
}
