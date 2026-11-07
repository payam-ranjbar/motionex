// Provider contracts: loading and conformance in the registry, and routing a contract job to its provider's tool.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { createJobService } from '../../src/runner/service.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ECHO = path.join(REPO, 'test', 'fixtures', 'tools', 'fake.echo');

/** A contract every fake.say-* tool can implement: {provider, message} -> {message (3+ chars)}. */
const SAY = {
  name: 'fake.say',
  version: '1.0.0',
  title: 'Say',
  summary: 'Test contract: say a message with any provider.',
  input_schema: {
    type: 'object',
    required: ['provider', 'message'],
    properties: {
      provider: { type: 'string', description: 'Who says it.' },
      message: { type: 'string', description: 'What to say.' },
    },
  },
  output_schema: {
    type: 'object',
    required: ['message'],
    properties: { message: { type: 'string', minLength: 3 } },
  },
  examples: [{ title: 'say hi', input: { provider: 'a', message: 'hi' } }],
};

/** Write <ext>/<name>/ as a copy of fake.echo with a patched manifest. */
async function writeTool(ext, name, patch = {}) {
  const manifest = JSON.parse(await readFile(path.join(ECHO, 'tool.json'), 'utf8'));
  await mkdir(path.join(ext, name), { recursive: true });
  await writeFile(path.join(ext, name, 'handler.mjs'), await readFile(path.join(ECHO, 'handler.mjs'), 'utf8'));
  await writeFile(path.join(ext, name, 'tool.json'), JSON.stringify({ ...manifest, name, title: name, ...patch }));
}

/** Write <ext>/contracts/<name>.json. */
async function writeContract(ext, contract) {
  await mkdir(path.join(ext, 'contracts'), { recursive: true });
  await writeFile(path.join(ext, 'contracts', `${contract.name}.json`), JSON.stringify(contract));
}

/** A temp workspace whose extension dir holds `contracts` and `tools`; returns config + registry. */
async function world({ contracts = [SAY], tools = [] } = {}) {
  const ws = await mkTmp('mx-contracts-');
  const ext = path.join(ws, 'ext');
  await mkdir(ext, { recursive: true });
  for (const c of contracts) await writeContract(ext, c);
  for (const t of tools) await writeTool(ext, t.name, t.patch);
  const base = loadConfig({
    ...process.env,
    MX_WORKSPACE: ws,
    MX_EXTENSIONS_DIR: '',
    MX_TOOLS_DIRS: ext,
    MX_SECRETS_DIR: path.join(ws, '.secrets'),
  });
  // only the extension dir: no built-in tools or contracts, so the test sees exactly what it wrote
  const config = Object.freeze({
    ...base,
    toolsDirs: base.toolsDirs.filter((d) => d.origin === 'extension'),
    contractsDirs: [],
  });
  const registry = await loadRegistry({ config });
  return { ws, ext, config, registry, cleanup: () => rmTmp(ws) };
}

const provider = (name, p, extra = {}) => ({
  name,
  patch: { implements: [{ contract: 'fake.say', provider: p }], ...extra },
});

/** Errors the registry reported for the folder or file whose path ends with `tail`. */
const invalidFor = (registry, tail) => registry.invalid().find((i) => i.dir.endsWith(tail))?.errors ?? [];

test('registry: loads contracts from extension dirs and indexes their providers', async () => {
  const w = await world({ tools: [provider('fake.say-a', 'a'), provider('fake.say-b', 'b')] });
  try {
    assert.deepEqual(w.registry.invalid(), []);
    const info = w.registry.contractInfo('fake.say');
    assert.equal(info.version, '1.0.0');
    assert.deepEqual(
      info.providers.map((p) => [p.provider, p.tool, p.available]),
      [
        ['a', 'fake.say-a', true],
        ['b', 'fake.say-b', true],
      ],
    );
    assert.deepEqual(
      w.registry.listContracts().map((c) => c.name),
      ['fake.say'],
    );
    assert.deepEqual(w.registry.info('fake.say-b').implements, [{ contract: 'fake.say', provider: 'b' }]);

    const ok = w.registry.resolveContract('fake.say', { provider: 'b', message: 'hey' });
    assert.deepEqual(ok, { ok: true, tool: 'fake.say-b', provider: 'b', input: { message: 'hey' } });
    const unknown = w.registry.resolveContract('fake.say', { provider: 'z', message: 'hey' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.errors[0].message, /no provider "z" \(providers: a, b\)/);
    const missing = w.registry.resolveContract('fake.say', { message: 'hey' });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].field, '/provider');
    assert.match(missing.errors[0].message, /providers: a, b/);
  } finally {
    await w.cleanup();
  }
});

test('registry: tools that do not fit their contract are rejected with the reason', async () => {
  const w = await world({
    tools: [
      provider('fake.say-a', 'a'),
      provider('fake.say-dup', 'a'), // provider name taken
      provider('fake.say-ghost', 'g', { implements: [{ contract: 'fake.nope', provider: 'g' }] }),
      provider('fake.say-thin', 't', {
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', description: 'Not message.' } },
        },
        examples: [{ title: 'x', input: { text: 'x' } }],
      }),
      provider('fake.say-noout', 'n', { output_schema: undefined }),
      { name: 'fake.say', patch: {} }, // a tool may not take a contract's name
    ],
  });
  try {
    assert.match(invalidFor(w.registry, 'fake.say-dup').join(), /provider "a" of fake.say is already fake.say-a/);
    assert.match(invalidFor(w.registry, 'fake.say-ghost').join(), /unknown contract "fake.nope"/);
    assert.match(invalidFor(w.registry, 'fake.say-thin').join(), /input_schema lacks "message"/);
    assert.match(invalidFor(w.registry, 'fake.say-noout').join(), /an output_schema is required/);
    assert.match(invalidFor(w.registry, `${path.sep}fake.say`).join(), /is a contract name/);
    assert.ok(w.registry.get('fake.say-a'));
    assert.equal(w.registry.get('fake.say-dup'), undefined);
    assert.deepEqual(
      w.registry.providersOf('fake.say').map((p) => p.tool),
      ['fake.say-a'],
    );
  } finally {
    await w.cleanup();
  }
});

test('registry: broken contract files are reported and not loaded', async () => {
  const withDefault = structuredClone(SAY);
  withDefault.name = 'fake.defaults';
  withDefault.input_schema.properties.message.default = 'hi';
  const closed = structuredClone(SAY);
  closed.name = 'fake.closed';
  closed.input_schema.additionalProperties = false;
  const noProvider = structuredClone(SAY);
  noProvider.name = 'fake.noprovider';
  delete noProvider.input_schema.properties.provider;
  noProvider.input_schema.required = ['message'];
  noProvider.examples = [{ title: 'x', input: { message: 'x' } }];
  const badExample = structuredClone(SAY);
  badExample.name = 'fake.badexample';
  badExample.examples = [{ title: 'x', input: { provider: 'a' } }];
  const w = await world({ contracts: [SAY, withDefault, closed, noProvider, badExample] });
  try {
    assert.deepEqual(
      w.registry.listContracts().map((c) => c.name),
      ['fake.say'],
    );
    assert.match(invalidFor(w.registry, 'fake.defaults.json').join(), /must not set defaults/);
    assert.match(invalidFor(w.registry, 'fake.closed.json').join(), /additionalProperties: false/);
    assert.match(invalidFor(w.registry, 'fake.noprovider.json').join(), /"provider"/);
    assert.match(invalidFor(w.registry, 'fake.badexample.json').join(), /examples\[0\] is not valid/);
  } finally {
    await w.cleanup();
  }
});

test('the built-in voice contracts load with piper and elevenlabs providers', async () => {
  const registry = await loadRegistry({ config: loadConfig({ ...process.env, MX_EXTENSIONS_DIR: '' }) });
  const bad = registry.invalid();
  assert.deepEqual(bad, [], JSON.stringify(bad));
  const providers = (name) =>
    registry
      .contractInfo(name)
      .providers.map((p) => `${p.provider}:${p.tool}`)
      .sort();
  assert.deepEqual(providers('voice.speak'), ['elevenlabs:voice.elevenlabs', 'piper:voice.piper']);
  assert.deepEqual(providers('voice.list'), ['elevenlabs:voice.elevenlabs-voices', 'piper:voice.piper-voices']);
  // Each contract example must be a valid input for the provider it names.
  for (const c of registry.listContracts()) {
    for (const ex of c.examples) {
      const r = registry.resolveContract(c.name, ex.input);
      assert.ok(r.ok, `${c.name} example "${ex.title}": ${JSON.stringify(r.errors)}`);
      const v = registry.validate(r.tool, r.input);
      assert.ok(v.ok, `${c.name} example "${ex.title}" does not fit ${r.tool}: ${JSON.stringify(v.errors)}`);
    }
  }
});

// ---- the job service ---------------------------------------------------------

/** A service over the world's registry, with an executor that returns `result(input)`. */
async function serviceFor(w, result = (input) => ({ message: input.message })) {
  const calls = [];
  const executor = {
    async run(args) {
      calls.push(args);
      await mkdir(args.outDir, { recursive: true });
      await writeFile(path.join(args.outDir, 'said.txt'), String(args.input.message));
      return { result: result(args.input) };
    },
  };
  const scheduler = {
    enqueue: (job) => setTimeout(() => job.start().catch(() => {}), 0),
    remove: () => false,
    stats: () => ({ running: [], queued: [], usedSlots: 0, totalSlots: 1 }),
  };
  const config = Object.freeze({ ...w.config, scratchDir: path.join(w.ws, '.scratch') });
  const store = new JobStore({ stateDir: config.stateDir, workspace: config.workspace });
  await store.open();
  const pins = { get: () => undefined, list: () => [] };
  const service = createJobService({ config, registry: w.registry, store, pins, executor, scheduler });
  return {
    calls,
    service,
    close: async () => {
      await service.drain();
      await store.close();
    },
  };
}

test('service: a contract job runs as the provider tool, without the provider field', async () => {
  const w = await world({ tools: [provider('fake.say-a', 'a'), provider('fake.say-b', 'b')] });
  const s = await serviceFor(w);
  try {
    const { job } = await s.service.submit({ tool: 'fake.say', input: { provider: 'b', message: 'hello' } });
    assert.equal(job.tool, 'fake.say-b');
    assert.equal(job.contract, 'fake.say');
    assert.equal(job.provider, 'b');
    const done = await s.service.wait(job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.deepEqual(done.result, { message: 'hello' });
    assert.equal(s.calls[0].entry.name, 'fake.say-b');
    assert.equal(s.calls[0].input.provider, undefined);

    // the same input sent straight to the tool shares the cache with the contract job
    const direct = await s.service.submit({ tool: 'fake.say-b', input: { message: 'hello' } });
    assert.equal(direct.job.cached_from, job.id);
    assert.equal(direct.job.contract, null);
    assert.deepEqual(
      s.service.list({ tool: 'fake.say' }).jobs.map((j) => j.id),
      [job.id],
    );
    assert.equal(s.service.list({ tool: 'fake.say-b' }).jobs.length, 2);

    const errors = [
      [{ provider: 'zz', message: 'hello' }, /no provider "zz" \(providers: a, b\)/],
      [{ message: 'hello' }, /provider/],
      [{ provider: 'a' }, /message/],
      [{ provider: 'a', message: 'hi', extra: 1 }, /fake\.say-a \(provider a of fake\.say\).*extra/],
    ];
    for (const [input, re] of errors) {
      await assert.rejects(
        () => s.service.submit({ tool: 'fake.say', input }),
        (err) => {
          assert.equal(err.code, 'invalid-input');
          assert.match(String(err.detail), re);
          return true;
        },
      );
    }
  } finally {
    await s.close();
    await w.cleanup();
  }
});

test('service: a result that fits the tool but not the contract fails as invalid-output', async () => {
  const w = await world({ tools: [provider('fake.say-a', 'a')] });
  const s = await serviceFor(w, () => ({ message: 'ab' })); // the contract wants 3+ characters
  try {
    const { job } = await s.service.submit({ tool: 'fake.say', input: { provider: 'a', message: 'x' } });
    const done = await s.service.wait(job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'failed');
    assert.equal(done.error.type, 'invalid-output');
    assert.match(done.error.detail, /does not fit contract fake\.say/);

    // straight to the tool, only the tool's own schema applies
    const direct = await s.service.submit({ tool: 'fake.say-a', input: { message: 'y' } });
    const ok = await s.service.wait(direct.job.id, { timeoutMs: 10_000 });
    assert.equal(ok.status, 'succeeded');
  } finally {
    await s.close();
    await w.cleanup();
  }
});
