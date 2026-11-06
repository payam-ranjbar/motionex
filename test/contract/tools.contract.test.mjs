// Tool contract suite: every tool folder (built-in or extension) must satisfy AGENTS.md §4.
// The registry already enforces the manifest schema, name == folder, compilable schemas and valid examples;
// this suite adds the schema-authoring rules, availability, example execution, workspace confinement and determinism.
//
//   node scripts/test.mjs contract [tool...]           # tool... -> MX_CONTRACT_TOOLS
//   MX_TOOLS_DIRS=<dir> MX_CONTRACT_TOOLS=a,b node scripts/test.mjs contract
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../../src/lib/config.mjs';
import { isSafeOutputPath } from '../../src/lib/paths.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { writeFixtures } from '../helpers/fixtures.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool, testConfig } from '../helpers/tool-harness.mjs';

const TEST_TIMEOUT = 600_000;
const TIMING_KEY = /(_ms|^render_s|^elapsed_s|^took_s)$/;

/** JSON Pointer escaping (RFC 6901). */
const ptr = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

const MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];
const ARRAY_KEYS = ['prefixItems', 'oneOf', 'anyOf', 'allOf'];
const SINGLE_KEYS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'];
const DEFAULT_UNION_KEYS = new Set(['oneOf', 'anyOf', 'not', 'if', 'then', 'else']);
const REF_UNION_KEYS = new Set(['oneOf', 'anyOf']);
const NO_FLAGS = { inDefault: false, inRef: false };

/**
 * Walk every schema node reachable through the JSON Schema keywords we care about (arrays included) and call
 * `visit(node, pointer, flags)`. `flags.inDefault` marks a node inside oneOf/anyOf/not/if/then/else,
 * `flags.inRef` marks a node inside oneOf/anyOf.
 */
function walkSchema(node, pointer, flags, visit) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkSchema(node[i], `${pointer}/${i}`, flags, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  visit(node, pointer, flags);
  for (const key of MAP_KEYS) {
    const map = node[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, sub] of Object.entries(map)) walkSchema(sub, `${pointer}/${ptr(key)}/${ptr(name)}`, flags, visit);
  }
  for (const key of ARRAY_KEYS) {
    const arr = node[key];
    if (!Array.isArray(arr)) continue;
    const child = {
      inDefault: flags.inDefault || DEFAULT_UNION_KEYS.has(key),
      inRef: flags.inRef || REF_UNION_KEYS.has(key),
    };
    for (let i = 0; i < arr.length; i++) walkSchema(arr[i], `${pointer}/${ptr(key)}/${i}`, child, visit);
  }
  for (const key of SINGLE_KEYS) {
    if (node[key] === undefined) continue;
    const child = {
      inDefault: flags.inDefault || DEFAULT_UNION_KEYS.has(key),
      inRef: flags.inRef || REF_UNION_KEYS.has(key),
    };
    walkSchema(node[key], `${pointer}/${ptr(key)}`, child, visit);
  }
}

/** JSON pointers of every member of a `properties` map without a non-empty string description. */
function offendersMissingDescription(schema) {
  const out = [];
  walkSchema(schema, '', NO_FLAGS, (node, pointer) => {
    const props = node.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) return;
    for (const [name, sub] of Object.entries(props)) {
      const desc = sub && typeof sub === 'object' && !Array.isArray(sub) ? sub.description : undefined;
      if (typeof desc !== 'string' || desc.trim() === '') out.push(`${pointer}/properties/${ptr(name)}`);
    }
  });
  return out;
}

/** JSON pointers of `default` inside oneOf/anyOf/not/if/then/else and `x-mx-ref` inside oneOf/anyOf. */
function offendersDefaultOrRef(schema) {
  const out = [];
  walkSchema(schema, '', NO_FLAGS, (node, pointer, flags) => {
    if (flags.inDefault && Object.hasOwn(node, 'default')) out.push(`${pointer}/default`);
    if (flags.inRef && Object.hasOwn(node, 'x-mx-ref')) out.push(`${pointer}/x-mx-ref`);
  });
  return out;
}

/** JSON pointers of object schemas with `properties` but no closed `additionalProperties`. */
function offendersOpenObject(schema) {
  const out = [];
  walkSchema(schema, '', NO_FLAGS, (node, pointer) => {
    const props = node.properties;
    if (node.type !== 'object' || !props || typeof props !== 'object' || Array.isArray(props)) return;
    const ap = node.additionalProperties;
    if (ap !== false && (!ap || typeof ap !== 'object' || Array.isArray(ap))) out.push(pointer || '/');
  });
  return out;
}

/** Every file in the workspace except the `.mx/` state folder: relative path -> {size, mtimeMs}. */
async function snapshotWorkspace(workspace) {
  const files = new Map();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.mx') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const info = await stat(abs);
      files.set(path.relative(workspace, abs).split(path.sep).join('/'), {
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  }
  await walk(workspace);
  return files;
}

function diffSnapshots(before, after) {
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...before.keys()].filter((k) => {
      const a = after.get(k);
      return a && (a.size !== before.get(k).size || a.mtimeMs !== before.get(k).mtimeMs);
    }),
  };
}

const isRunnable = (example) => example.run !== false;

/** Run one manifest example in a fresh workspace and assert its workspace side effects stay inside out/ and scratch/. */
async function runExample(entry, example, index) {
  const workspace = await mkTmp('mx-contract-');
  try {
    await writeFixtures(workspace, example.fixtures ?? {});
    const before = await snapshotWorkspace(workspace);
    let run;
    try {
      run = await runTool(entry.name, example.input, {
        workspace,
        config: testConfig(workspace),
        timeoutMs: (entry.manifest.timeout_s || 120) * 1000,
      });
    } catch (e) {
      const tail = typeof e.log === 'string' && e.log ? `\n--- log ---\n${e.log.slice(-2000)}` : '';
      assert.fail(`examples[${index}] "${example.title}" threw ${e.type ?? e.name}: ${e.message}${tail}`);
    }
    for (const output of run.outputs) {
      assert.ok(isSafeOutputPath(output.name), `examples[${index}] output "${output.name}" is not a safe output path`);
      const info = await stat(output.abs).catch(() => null);
      assert.ok(info?.isFile(), `examples[${index}] output "${output.name}" is missing at ${output.abs}`);
    }
    const diff = diffSnapshots(before, await snapshotWorkspace(workspace));
    assert.deepStrictEqual(
      diff,
      { added: [], removed: [], changed: [] },
      `examples[${index}] "${example.title}" wrote outside the job's out/ or scratch/ folders:\n${JSON.stringify(diff, null, 2)}`,
    );
    return run;
  } finally {
    await rmTmp(workspace);
  }
}

/** Recursively drop volatile timing keys so two deterministic runs can be compared. */
function stripTiming(value) {
  if (Array.isArray(value)) return value.map(stripTiming);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!TIMING_KEY.test(key)) out[key] = stripTiming(inner);
    }
    return out;
  }
  return value;
}

const config = loadConfig();
const registry = await loadRegistry({ config });
const loadedNames = registry.list({ includeUnavailable: true }).map((t) => t.name);
const invalidEntries = registry.invalid();
const invalidNames = new Set(invalidEntries.map((e) => path.basename(e.dir)));
const filter = (process.env.MX_CONTRACT_TOOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const filterSet = filter.length ? new Set(filter) : null;

const selectedLoaded = filterSet ? loadedNames.filter((n) => filterSet.has(n)) : loadedNames;
const selectedInvalid = filterSet ? invalidEntries.filter((e) => filterSet.has(path.basename(e.dir))) : invalidEntries;
const missing = filterSet ? filter.filter((n) => !registry.get(n) && !invalidNames.has(n)) : [];

for (const name of selectedLoaded) {
  describe(name, () => {
    const entry = registry.get(name);

    test('loaded', { timeout: TEST_TIMEOUT }, () => {
      assert.ok(registry.get(name), `no tool named "${name}"`);
    });

    test('input_schema descriptions', { timeout: TEST_TIMEOUT }, () => {
      const offenders = offendersMissingDescription(entry.manifest.input_schema);
      assert.deepStrictEqual(offenders, [], `properties without a non-empty description:\n${offenders.join('\n')}`);
    });

    test('no defaults or refs in unions', { timeout: TEST_TIMEOUT }, () => {
      const offenders = offendersDefaultOrRef(entry.manifest.input_schema);
      assert.deepStrictEqual(
        offenders,
        [],
        `default inside a union or x-mx-ref inside oneOf/anyOf:\n${offenders.join('\n')}`,
      );
    });

    test('nested objects are closed', { timeout: TEST_TIMEOUT }, () => {
      const offenders = offendersOpenObject(entry.manifest.input_schema);
      assert.deepStrictEqual(
        offenders,
        [],
        `object schemas with properties but open additionalProperties:\n${offenders.join('\n')}`,
      );
    });

    test('summary and title', { timeout: TEST_TIMEOUT }, () => {
      const { title, summary } = entry.manifest;
      assert.ok(typeof title === 'string' && title.trim() !== '', `tool "${name}" has an empty title`);
      assert.ok(
        typeof summary === 'string' && summary.length <= 300,
        `tool "${name}" summary must be a string of at most 300 chars (got ${summary?.length})`,
      );
    });

    test('availability', { timeout: TEST_TIMEOUT }, () => {
      if (entry.available) return;
      const reason = entry.unavailableReason;
      assert.ok(
        typeof reason === 'string' && reason.trim() !== '',
        `unavailable tool "${name}" must explain itself in unavailable_reason`,
      );
    });

    const runnable = entry.manifest.examples
      .map((example, index) => ({ example, index }))
      .filter(({ example }) => {
        return isRunnable(example);
      });

    if (!entry.available) {
      const reason = entry.unavailableReason ?? 'unavailable';
      test('examples run', { skip: reason, timeout: TEST_TIMEOUT }, () => {});
      test('determinism', { skip: reason, timeout: TEST_TIMEOUT }, () => {});
    } else {
      test('examples run', { timeout: TEST_TIMEOUT }, async () => {
        for (const { example, index } of runnable) await runExample(entry, example, index);
      });

      test('determinism', { timeout: TEST_TIMEOUT }, async () => {
        if (!entry.manifest.deterministic || !runnable.length) return;
        const { example, index } = runnable[0];
        const first = await runExample(entry, example, index);
        const second = await runExample(entry, example, index);
        assert.deepStrictEqual(
          stripTiming(first.result),
          stripTiming(second.result),
          `deterministic tool "${name}" returned different results on two runs`,
        );
      });
    }
  });
}

for (const bad of selectedInvalid) {
  const name = path.basename(bad.dir);
  describe(name, () => {
    test('manifest is valid', { timeout: TEST_TIMEOUT }, () => {
      assert.fail(`invalid tool "${name}" (${bad.dir}):\n${bad.errors.join('\n')}`);
    });
  });
}

for (const name of missing) {
  test(`no tool named ${name}`, { timeout: TEST_TIMEOUT }, () => {
    assert.fail(`no tool named "${name}"`);
  });
}

if (!selectedLoaded.length && !selectedInvalid.length && !missing.length) {
  test('no tools selected', { timeout: TEST_TIMEOUT }, () => {});
}
