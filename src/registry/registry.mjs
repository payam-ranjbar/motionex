// Tool registry: scans tool folders, validates manifests and schemas, checks requirements,
// validates inputs (presets merged, defaults applied) and results. It also loads provider contracts
// (contracts/<name>.json): the shared shape of one capability, implemented by several tools (its providers).
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
const CONTRACT_SCHEMA = JSON.parse(readFileSync(new URL('./contract.schema.json', import.meta.url), 'utf8'));

/** True when a schema (at any depth) sets a `default` keyword; property NAMES called "default" do not count. */
function hasDefault(schema, inProperties = false) {
  if (Array.isArray(schema)) return schema.some((s) => hasDefault(s));
  if (!schema || typeof schema !== 'object') return false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'default' && !inProperties) return true;
    if (hasDefault(value, key === 'properties')) return true;
  }
  return false;
}

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
    this.contractValidator = createAjv().compile(CONTRACT_SCHEMA);
    /** @type {Map<string, any>} */
    this.tools = new Map();
    /** @type {Map<string, any>} contract name -> {name, file, manifest, validateInput, validateOutput} */
    this.contracts = new Map();
    /** @type {Map<string, Map<string, string>>} contract name -> provider -> tool name */
    this.providers = new Map();
    this.invalidList = [];
  }

  /** Folders holding contract files: the configured ones, then <extension tools dir>/contracts. */
  #contractDirs() {
    const dirs = [...(this.config.contractsDirs ?? [])];
    for (const d of this.dirs) if (d.origin === 'extension') dirs.push(path.join(d.path, 'contracts'));
    return dirs;
  }

  /** Load every contract file; broken or duplicate ones go to `invalid`. */
  #loadContracts(invalid) {
    const contracts = new Map();
    for (const root of this.#contractDirs()) {
      if (!existsSync(root)) continue;
      for (const f of readdirSync(root).sort()) {
        if (!f.endsWith('.json')) continue;
        const file = path.join(root, f);
        try {
          const c = this.#loadContract(file);
          const prev = contracts.get(c.name);
          if (prev) {
            invalid.push({ dir: file, errors: [`a contract named "${c.name}" already exists (${prev.file})`] });
            continue;
          }
          contracts.set(c.name, c);
        } catch (e) {
          invalid.push({ dir: file, errors: e.errors ?? [e.message] });
        }
      }
    }
    return contracts;
  }

  #loadContract(file) {
    const fail = (errors) => Object.assign(new Error(errors.join('; ')), { errors });
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw fail([`contract is not valid JSON: ${e.message}`]);
    }
    if (!this.contractValidator(manifest)) {
      throw fail(
        formatErrors(this.contractValidator.errors).map((e) => `${path.basename(file)}${e.field}: ${e.message}`),
      );
    }
    const errors = [];
    if (manifest.name !== path.basename(file, '.json'))
      errors.push(`name "${manifest.name}" must equal the file name "${path.basename(file)}" without .json`);
    const s = manifest.input_schema;
    if (s.type !== 'object') errors.push('input_schema must be {"type":"object",...}');
    if (s.additionalProperties === false)
      errors.push('input_schema must not set additionalProperties: false (providers add their own fields)');
    if (s.properties?.provider?.type !== 'string')
      errors.push('input_schema must declare a string "provider" property');
    if (!s.required?.includes('provider')) errors.push('input_schema must require "provider"');
    if (hasDefault(s)) errors.push('input_schema must not set defaults (each provider applies its own)');
    let validateInput;
    let validateOutput;
    try {
      validateInput = this.ajv.compile(s);
    } catch (e) {
      errors.push(`input_schema does not compile: ${e.message}`);
    }
    try {
      validateOutput = this.ajv.compile(manifest.output_schema);
    } catch (e) {
      errors.push(`output_schema does not compile: ${e.message}`);
    }
    if (validateInput) {
      manifest.examples.forEach((ex, i) => {
        if (validateInput(structuredClone(ex.input))) return;
        const why = formatErrors(validateInput.errors).map((e) => `${e.field} ${e.message}`);
        errors.push(`examples[${i}] is not valid: ${why.join('; ')}`);
      });
    }
    if (errors.length) throw fail(errors);
    return { name: manifest.name, file, manifest, validateInput, validateOutput };
  }

  /**
   * Does a tool fit the contracts it claims? It must accept every contract field (except provider, which the
   * service removes) and its output_schema must declare every field the contract's result requires.
   * @returns {string[]} problems, empty when it conforms
   */
  #conformance(entry, contracts) {
    const errors = [];
    const m = entry.manifest;
    const props = m.input_schema.properties ?? {};
    const outProps = m.output_schema?.properties ?? {};
    for (const { contract: name } of m.implements ?? []) {
      const c = contracts.get(name);
      if (!c) {
        errors.push(`implements unknown contract "${name}" (known: ${[...contracts.keys()].join(', ') || 'none'})`);
        continue;
      }
      if (props.provider) errors.push(`implements ${name}: input_schema must not declare "provider" (it is removed)`);
      for (const field of Object.keys(c.manifest.input_schema.properties ?? {})) {
        if (field !== 'provider' && !props[field]) errors.push(`implements ${name}: input_schema lacks "${field}"`);
      }
      if (!m.output_schema) {
        errors.push(`implements ${name}: an output_schema is required`);
        continue;
      }
      for (const field of c.manifest.output_schema.required ?? []) {
        if (!outProps[field]) errors.push(`implements ${name}: output_schema lacks "${field}"`);
      }
    }
    return errors;
  }

  /** Re-scan every tools folder. @returns {Promise<{loaded: number, invalid: {dir: string, errors: string[]}[]}>} */
  async reload() {
    const tools = new Map();
    const invalid = [];
    this.ajv = createAjv();
    const contracts = this.#loadContracts(invalid);
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
    // Contracts and their providers: a tool may not take a contract's name, must fit what it implements, and a
    // provider name belongs to one tool per contract (the first tool loaded keeps it).
    const providers = new Map([...contracts.keys()].map((name) => [name, new Map()]));
    for (const [name, entry] of tools) {
      const errors = contracts.has(name) ? [`"${name}" is a contract name; a tool cannot use it`] : [];
      errors.push(...this.#conformance(entry, contracts));
      for (const { contract, provider } of entry.manifest.implements ?? []) {
        const owner = providers.get(contract)?.get(provider);
        if (owner) errors.push(`provider "${provider}" of ${contract} is already ${owner}`);
      }
      if (errors.length) {
        invalid.push({ dir: entry.dir, errors });
        tools.delete(name);
        continue;
      }
      for (const { contract, provider } of entry.manifest.implements ?? [])
        providers.get(contract)?.set(provider, name);
    }
    this.tools = tools;
    this.contracts = contracts;
    this.providers = providers;
    this.invalidList = invalid;
    return { loaded: tools.size, contracts: contracts.size, invalid };
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

  /** @returns {object|undefined} the loaded contract, when `name` is one */
  contract(name) {
    return this.contracts.get(name);
  }

  /** A contract's providers, sorted: [{provider, tool, tool_version, available, unavailable_reason}]. */
  providersOf(name) {
    return [...(this.providers.get(name) ?? new Map()).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, toolName]) => {
        const t = this.tools.get(toolName);
        return {
          provider,
          tool: toolName,
          tool_version: t?.manifest.version ?? null,
          available: Boolean(t?.available),
          unavailable_reason: t?.unavailableReason ?? null,
        };
      });
  }

  /** Public description of a contract: the contract file plus its providers. */
  contractInfo(name) {
    const c = this.contracts.get(name);
    if (!c) return undefined;
    const { $comment, ...pub } = c.manifest;
    return { ...pub, providers: this.providersOf(name) };
  }

  /** Every contract, sorted by name. */
  listContracts() {
    return [...this.contracts.keys()].sort().map((name) => this.contractInfo(name));
  }

  /**
   * Route a contract request to its provider's tool: check the contract's fields, find the tool named by
   * input.provider and return the input without `provider` (the tool's own schema then checks the rest).
   * @returns {{ok: true, tool: string, provider: string, input: object} | {ok: false, errors: {field: string, message: string}[]}}
   */
  resolveContract(name, input) {
    const c = this.contracts.get(name);
    if (!c) return { ok: false, errors: [{ field: '/', message: `unknown contract "${name}"` }] };
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      return { ok: false, errors: [{ field: '/', message: 'input must be an object' }] };
    const names = this.providersOf(name).map((p) => p.provider);
    const options = `providers: ${names.length ? names.join(', ') : 'none installed'}`;
    if (!c.validateInput(structuredClone(input))) {
      const errors = formatErrors(c.validateInput.errors);
      for (const e of errors) if (e.field === '/provider') e.message += ` (${options})`;
      return { ok: false, errors };
    }
    const tool = this.providers.get(name)?.get(input.provider);
    if (!tool)
      return { ok: false, errors: [{ field: '/provider', message: `no provider "${input.provider}" (${options})` }] };
    const { provider, ...rest } = structuredClone(input);
    return { ok: true, tool, provider, input: rest };
  }

  /** Validate a result against a contract's output_schema (ok when there is no such contract). */
  validateContractResult(name, result) {
    const c = this.contracts.get(name);
    if (!c) return { ok: true, errors: [] };
    const ok = c.validateOutput(result);
    return { ok, errors: ok ? [] : formatErrors(c.validateOutput.errors) };
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
