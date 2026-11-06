// Tool registry: scans tool folders, validates manifests and schemas, checks requirements,
// validates inputs (presets merged, defaults applied) and results.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { browserAvailable } from '../lib/browser.mjs';
import { APP_ROOT } from '../lib/config.mjs';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg.mjs';
import { sha256, sha256Dir } from '../lib/hash.mjs';
import { deepMerge, listPresets, loadPreset } from '../lib/presets.mjs';
import { createAjv, formatErrors, validateCollecting } from './ajv.mjs';

const MANIFEST_SCHEMA = JSON.parse(readFileSync(new URL('./manifest.schema.json', import.meta.url), 'utf8'));

// Shared code that tools run on. Its hash is folded into every tool's hash, so a fix in a shared library (the mix
// master, the Strudel engine, SFX recipes) invalidates cached results instead of serving the old output.
const RUNTIME_DIRS = ['src/lib', 'lib', 'vendor/mucavex/src'];
async function runtimeHash() {
  const parts = [];
  for (const rel of RUNTIME_DIRS) {
    const abs = path.join(APP_ROOT, rel);
    parts.push(`${rel}:${existsSync(abs) ? await sha256Dir(abs) : '-'}`);
  }
  return sha256(parts.join('\n'));
}

const binCache = new Map();
function binaryOk(bin, config) {
  if (binCache.has(`${bin}|${config.python}`)) return binCache.get(`${bin}|${config.python}`);
  let res;
  if (bin === 'ffmpeg') {
    const p = ffmpegPath();
    const ok = existsSync(p) || spawnSync(p, ['-version'], { windowsHide: true }).status === 0;
    res = ok ? null : 'ffmpeg not found (set FFMPEG_PATH)';
  } else if (bin === 'ffprobe') {
    res = ffprobePath() ? null : 'ffprobe not found (set FFPROBE_PATH)';
  } else if (bin === 'python') {
    res = existsSync(config.python) ? null : `python not found at ${config.python} (set MX_PYTHON)`;
  } else if (bin === 'chromium') {
    const b = browserAvailable(config);
    res = b.ok ? null : b.reason;
  } else res = `unknown binary "${bin}"`;
  binCache.set(`${bin}|${config.python}`, res);
  return res;
}

/** Recompute availability (e.g. after a secret file appears). */
export function clearRequirementCache() {
  binCache.clear();
}

export class Registry {
  /** @param {{dirs: {path: string, origin: 'builtin'|'extension'}[], config: import('../runner/types.mjs').Config}} opts */
  constructor({ dirs, config }) {
    this.dirs = dirs;
    this.config = config;
    this.ajv = createAjv();
    this.manifestValidator = createAjv().compile(MANIFEST_SCHEMA);
    /** @type {Map<string, any>} */
    this.tools = new Map();
    this.invalidList = [];
  }

  /** Re-scan every tools folder. @returns {Promise<{loaded: number, invalid: {dir: string, errors: string[]}[]}>} */
  async reload() {
    const tools = new Map();
    const invalid = [];
    this.ajv = createAjv();
    const runtime = await runtimeHash();
    for (const { path: root, origin } of this.dirs) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || !existsSync(path.join(root, d.name, 'tool.json'))) continue;
        const dir = path.join(root, d.name);
        try {
          const entry = await this.#load(dir, origin, runtime);
          const prev = tools.get(entry.name);
          if (prev && !(origin === 'extension' && this.config.allowOverride)) {
            invalid.push({
              dir,
              errors: [
                `a tool named "${entry.name}" already exists (${prev.dir}); set MX_ALLOW_OVERRIDE=1 to replace it`,
              ],
            });
            continue;
          }
          tools.set(entry.name, entry);
        } catch (e) {
          invalid.push({ dir, errors: e.errors ?? [e.message] });
        }
      }
    }
    this.tools = tools;
    this.invalidList = invalid;
    return { loaded: tools.size, invalid };
  }

  async #load(dir, origin, runtime) {
    const fail = (errors) => Object.assign(new Error(errors.join('; ')), { errors });
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'tool.json'), 'utf8'));
    } catch (e) {
      throw fail([`tool.json is not valid JSON: ${e.message}`]);
    }
    if (!this.manifestValidator(manifest)) {
      throw fail(formatErrors(this.manifestValidator.errors).map((e) => `tool.json${e.field}: ${e.message}`));
    }
    const errors = [];
    if (manifest.name !== path.basename(dir))
      errors.push(`name "${manifest.name}" must equal the folder name "${path.basename(dir)}"`);
    if (manifest.cache_default === 'auto' && !manifest.deterministic)
      errors.push('cache_default "auto" requires deterministic: true');
    const s = manifest.input_schema;
    if (s.type !== 'object' || s.additionalProperties !== false)
      errors.push('input_schema must be {"type":"object","additionalProperties":false,...}');
    if (manifest.presets && !s.properties?.preset)
      errors.push('a tool with "presets" must declare a "preset" string property');
    if (manifest.kind === 'node' && !existsSync(path.join(dir, manifest.handler)))
      errors.push(`handler ${manifest.handler} not found`);
    let validateInput;
    let validateOutput = null;
    try {
      validateInput = this.ajv.compile(s);
    } catch (e) {
      errors.push(`input_schema does not compile: ${e.message}`);
    }
    if (manifest.output_schema) {
      try {
        validateOutput = this.ajv.compile(manifest.output_schema);
      } catch (e) {
        errors.push(`output_schema does not compile: ${e.message}`);
      }
    }
    if (validateInput) {
      manifest.examples.forEach((ex, i) => {
        const r = this.#validateWith(manifest, validateInput, ex.input);
        if (!r.ok)
          errors.push(`examples[${i}] is not valid: ${r.errors.map((e) => `${e.field} ${e.message}`).join('; ')}`);
      });
    }
    if (errors.length) throw fail(errors);

    const missing = [];
    for (const b of manifest.requires?.binaries ?? []) {
      const why = binaryOk(b, this.config);
      if (why) missing.push(why);
    }
    for (const sec of manifest.requires?.secrets ?? []) {
      if (!existsSync(path.join(this.config.secretsDir, sec)))
        missing.push(`secret "${sec}" is missing (file ${sec} in the secrets dir)`);
    }
    return {
      name: manifest.name,
      dir,
      origin,
      manifest,
      toolHash: sha256(`${await sha256Dir(dir)}:${runtime}`),
      available: missing.length === 0,
      unavailableReason: missing.length ? missing.join('; ') : null,
      validateInput,
      validateOutput,
    };
  }

  #validateWith(manifest, validate, input) {
    let data = structuredClone(input ?? {});
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, input: data, refPointers: [], errors: [{ field: '/', message: 'input must be an object' }] };
    }
    if (manifest.presets && typeof data.preset === 'string') {
      try {
        const preset = loadPreset(manifest.presets, data.preset, this.config.presetsDirs);
        const { preset: name, ...rest } = data;
        data = { ...deepMerge(preset, rest), preset: name };
      } catch (e) {
        return {
          ok: false,
          input: data,
          refPointers: [],
          errors: [{ field: '/preset', message: e.detail ?? e.message }],
        };
      }
    }
    const r = validateCollecting(validate, data);
    return { ok: r.ok, input: data, refPointers: r.refPointers, errors: r.errors };
  }

  /** @returns {import('../runner/types.mjs').ToolInfo[]} */
  list({ includeUnavailable = true } = {}) {
    return [...this.tools.values()]
      .filter((t) => includeUnavailable || t.available)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => this.info(t.name));
  }

  /** @returns {import('../runner/types.mjs').ToolEntry|undefined} */
  get(name) {
    return this.tools.get(name);
  }

  /** Public description of a tool (manifest minus handler/command). */
  info(name) {
    const t = this.tools.get(name);
    if (!t) return undefined;
    const { handler, command, ...pub } = t.manifest;
    const presets = pub.presets ? listPresets(pub.presets, this.config.presetsDirs).map((p) => p.name) : undefined;
    return {
      ...pub,
      ...(presets ? { preset_names: presets } : {}),
      available: t.available,
      unavailable_reason: t.unavailableReason,
      origin: t.origin,
    };
  }

  /** @returns {{dir: string, errors: string[]}[]} */
  invalid() {
    return this.invalidList;
  }

  /**
   * Validate an input: preset merged under it (when the tool declares `presets`), defaults applied, ref pointers collected.
   * @returns {{ok: true, input: object, refPointers: string[], errors: []} | {ok: false, input: object, refPointers: [], errors: {field: string, message: string}[]}}
   */
  validate(name, input) {
    const t = this.tools.get(name);
    if (!t) return { ok: false, input, refPointers: [], errors: [{ field: '/', message: `unknown tool "${name}"` }] };
    return this.#validateWith(t.manifest, t.validateInput, input);
  }

  /** Validate a handler's result against output_schema (always ok when the tool has none). */
  validateResult(name, result) {
    const t = this.tools.get(name);
    if (!t?.validateOutput) return { ok: true, errors: [] };
    const ok = t.validateOutput(result);
    return { ok, errors: ok ? [] : formatErrors(t.validateOutput.errors) };
  }
}

/**
 * @param {{dirs?: {path: string, origin: 'builtin'|'extension'}[], config: import('../runner/types.mjs').Config}} opts
 * @returns {Promise<Registry>}
 */
export async function loadRegistry({ dirs, config }) {
  const reg = new Registry({ dirs: dirs ?? config.toolsDirs, config });
  await reg.reload();
  return reg;
}
