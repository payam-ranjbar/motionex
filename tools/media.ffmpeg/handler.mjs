// media.ffmpeg: the escape hatch. Run any ffmpeg command on workspace files.
// Placeholders: {in:NAME}, {out:FILE}, {script:NAME}. Paths are confined to the workspace;
// only placeholder-substituted arguments may be absolute. Filter chains are checked for file-reading filters.
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { checkChain, runFfmpeg } from '../../src/lib/ffmpeg.mjs';

const FILTER_FLAGS = new Set(['-vf', '-af', '-filter:v', '-filter:a', '-filter_complex']);
const EXACT_PLACEHOLDER = /^\{(in|out|script):([\w.-]{1,128})\}$/;
const PLACEHOLDER = /\{(in|out|script):([\w.-]{1,128})\}/g;
const OUTPUT_NAME = /^[\w.-]{1,128}$/;
const INPUT_NAME = /^[\w-]{1,64}$/;
const SCRIPT_NAME = /^[\w.-]{1,128}$/;

const nameOk = (name, re) => typeof name === 'string' && re.test(name);
const isAbsolute = (p) => p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p);

/**
 * @param {{args: string[], inputs?: Record<string, string>, outputs: string[], scripts?: Record<string, string>}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const { args, inputs = {}, outputs, scripts = {} } = input;
  const { outDir, scratchDir, signal } = ctx;

  // Declared outputs: safe single-segment names, resolved under outDir.
  const resolvedOutputs = outputs.map((name) => {
    if (!nameOk(name, OUTPUT_NAME)) {
      throw new ToolError('invalid-input', `output name "${name}" must match ^[\\w.-]{1,128}$`);
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
  for (const original of args) {
    if (nextIsFilter) {
      filterIndices.add(resolved.length);
      nextIsFilter = false;
    }
    let didSubstitute = false;
    const value = original.replace(PLACEHOLDER, (_m, kind, name) => {
      didSubstitute = true;
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
    resolved.push({ original, value, didSubstitute });
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

  // Every declared output must exist now.
  const written = [];
  for (const out of resolvedOutputs) {
    let info;
    try {
      info = await stat(out.abs);
    } catch {
      // ffmpeg exits 0 and writes nothing when e.g. -ss is past the end of the input; show its own words.
      const tail = String(run0.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-6)
        .join(' | ')
        .slice(-600);
      throw new ToolError(
        'tool-failed',
        `declared output "${out.name}" was not written by the command (a common cause: -ss past the end of the input). ffmpeg said: ${tail || '(nothing)'}`,
      );
    }
    if (!info.isFile()) throw new ToolError('tool-failed', `declared output "${out.name}" is not a file`);
    written.push({ name: out.name, bytes: info.size });
  }

  return { result: { outputs: written, stderr_tail: String(run0.stderr ?? '').slice(-2000) } };
}
