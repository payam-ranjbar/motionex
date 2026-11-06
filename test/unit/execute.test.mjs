import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { newJobId } from '../../src/lib/ids.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { createExecutor } from '../../src/runner/execute.mjs';
import { isAlive, killTree } from '../../src/runner/kill.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const FAKES = fileURLToPath(new URL('../fixtures/tools', import.meta.url));

async function setup() {
  const ws = await mkTmp('mx-exec-');
  const config = loadConfig({
    ...process.env,
    MX_WORKSPACE: ws,
    MX_TOOLS_DIRS: FAKES,
    MX_EXTENSIONS_DIR: '',
    MX_KILL_GRACE_MS: '500',
  });
  const registry = await loadRegistry({ config });
  return { ws, config, registry };
}

async function start(executor, registry, config, name, input, opts = {}) {
  const entry = registry.get(name);
  assert.ok(entry, `no tool ${name}`);
  const v = registry.validate(name, input);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const id = newJobId();
  const outDir = path.join(config.stateDir, 'jobs', id, 'out');
  const scratchDir = path.join(config.scratchDir, id);
  await mkdir(outDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  const logFile = path.join(config.stateDir, 'jobs', id, 'log.txt');
  const events = [];
  const job = { id, tool: name, tool_version: entry.manifest.version };
  const promise = executor.run({
    job,
    entry,
    input: v.input,
    rawInput: input,
    outDir,
    scratchDir,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onEvent: (e) => events.push(e),
    logFile,
  });
  return { promise, outDir, logFile, events, id };
}

async function waitFor(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${ms} ms`);
}

function deadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
      t.unref?.();
    }),
  ]);
}

test('fake.echo resolves, writes output, emits progress', async () => {
  const { ws, config, registry } = await setup();
  try {
    const executor = createExecutor({ config });
    const { promise, outDir, events } = await start(executor, registry, config, 'fake.echo', { message: 'hi' });
    const out = await promise;
    assert.equal(out.result.message, 'hi');
    assert.ok(existsSync(path.join(outDir, 'echo.json')));
    assert.ok(events.some((e) => e.type === 'progress'));
  } finally {
    await rmTmp(ws);
  }
});

test('fake.fail maps errors and logs stderr', async () => {
  const { ws, config, registry } = await setup();
  try {
    const executor = createExecutor({ config });

    const thrown = await start(executor, registry, config, 'fake.fail', { mode: 'throw' });
    await assert.rejects(thrown.promise, (e) => e.type === 'tool-failed' && /boom/.test(e.detail));
    const log = await readFile(thrown.logFile, 'utf8');
    assert.match(log, /about to fail/);

    const toolError = await start(executor, registry, config, 'fake.fail', { mode: 'tool-error' });
    await assert.rejects(toolError.promise, (e) => e.type === 'invalid-input');

    const exited = await start(executor, registry, config, 'fake.fail', { mode: 'exit' });
    await assert.rejects(exited.promise, (e) => e.type === 'tool-failed' && /code 3/.test(e.detail));
  } finally {
    await rmTmp(ws);
  }
});

test('cancel kills the process tree', async () => {
  const { ws, config, registry } = await setup();
  try {
    const executor = createExecutor({ config });
    const ac = new AbortController();
    const { promise, events } = await start(
      executor,
      registry,
      config,
      'fake.sleep',
      { seconds: 30, spawn_child: true },
      { signal: ac.signal },
    );
    const pid = await waitFor(() => {
      const e = events.find((ev) => ev.type === 'log' && /grandchild (\d+)/.test(ev.message ?? ''));
      return e ? Number(e.message.match(/grandchild (\d+)/)[1]) : null;
    }, 3000);
    setTimeout(() => ac.abort(), 500);
    await assert.rejects(deadline(promise, 3000, 'cancel'), (e) => e.type === 'canceled');
    await waitFor(() => !isAlive(pid), 3000);
  } finally {
    await rmTmp(ws);
  }
});

test('timeout rejects with a retryable timeout', async () => {
  const { ws, config, registry } = await setup();
  try {
    const executor = createExecutor({ config });
    const { promise } = await start(executor, registry, config, 'fake.sleep', { seconds: 30 }, { timeoutMs: 700 });
    await assert.rejects(deadline(promise, 3000, 'timeout'), (e) => e.type === 'timeout' && e.retryable === true);
  } finally {
    await rmTmp(ws);
  }
});

test('grace kill stops a handler that ignores cancel', async () => {
  const { ws, config, registry } = await setup();
  try {
    const executor = createExecutor({ config });
    const ac = new AbortController();
    const { promise } = await start(
      executor,
      registry,
      config,
      'fake.sleep',
      { seconds: 30, ignore_cancel: true },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(deadline(promise, 3000, 'grace kill'), (e) => e.type === 'canceled');
  } finally {
    await rmTmp(ws);
  }
});

test('killTree kills a spawned process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  try {
    await waitFor(() => isAlive(child.pid), 3000);
    killTree(child.pid, 'SIGKILL');
    await waitFor(() => !isAlive(child.pid), 3000);
  } finally {
    try {
      killTree(child.pid, 'SIGKILL');
    } catch {}
  }
});

// Seen live: a job stayed "running" for 30 min after its handler finished. A leftover process that holds the
// child's pipes must not keep the job open: it settles a few seconds after the child exits.
test('a result is delivered even when a leftover grandchild holds the pipes open', async () => {
  const ws = await mkTmp();
  try {
    const config = {
      ...loadConfig({ ...process.env, MX_WORKSPACE: ws, MX_TOOLS_DIRS: FAKES, MX_EXTENSIONS_DIR: '' }),
      killGraceMs: 500,
    };
    const registry = await loadRegistry({ config });
    const entry = registry.get('fake.linger');
    const executor = createExecutor({ config });
    const outDir = path.join(ws, 'out');
    const scratchDir = path.join(ws, 'scratch');
    await mkdir(outDir, { recursive: true });
    await mkdir(scratchDir, { recursive: true });
    const t0 = Date.now();
    const r = await executor.run({
      job: { id: 'job_linger', tool: 'fake.linger', tool_version: '1.0.0' },
      entry,
      input: {},
      rawInput: {},
      outDir,
      scratchDir,
      timeoutMs: 60_000,
      onEvent: () => {},
      logFile: path.join(ws, 'log.txt'),
    });
    assert.deepEqual(r.result, { ok: true });
    assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
  } finally {
    await rmTmp(ws);
  }
});
