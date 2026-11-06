import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { sha256 } from '../../src/lib/hash.mjs';
import { newJobId } from '../../src/lib/ids.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { createJobService, TERMINAL } from '../../src/runner/service.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_TOOLS = path.join(REPO, 'test', 'fixtures', 'tools');

// ---- fakes -------------------------------------------------------------------

/** Sleep that rejects with ToolError('canceled') when the signal aborts. */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError('canceled', 'aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolError('canceled', 'aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A fake executor: writes out/result.txt, emits one progress event, resolves with {message}.
 * Options: delayMs, reject {type, detail}, result (a fixed, possibly invalid, result).
 */
function fakeExecutor(options = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (options.delayMs) await sleepAbortable(options.delayMs, args.signal);
    if (options.reject) throw new ToolError(options.reject.type, options.reject.detail ?? 'fake failure');
    await mkdir(args.outDir, { recursive: true });
    await writeFile(path.join(args.outDir, 'result.txt'), `${args.input.message ?? 'x'}\n`, 'utf8');
    args.onEvent({ type: 'progress', fraction: 0.5, message: 'halfway' });
    const result = options.result !== undefined ? options.result : { message: args.input.message };
    return { result };
  };
  return { calls, run };
}

/** A fake scheduler. `hold: true` keeps every job queued until release()/releaseAll() is called. */
function fakeScheduler({ hold = false } = {}) {
  const queue = new Map();
  const removed = [];
  const enqueued = [];
  const scheduler = {
    queue,
    removed,
    enqueued,
    enqueue(job) {
      enqueued.push({ id: job.id, cls: job.cls, slots: job.slots });
      queue.set(job.id, job);
      if (!hold) setTimeout(() => scheduler.release(job.id), 0);
    },
    remove(id) {
      removed.push(id);
      return queue.delete(id);
    },
    release(id) {
      const job = queue.get(id);
      if (!job) return false;
      queue.delete(id);
      job.start().catch(() => {});
      return true;
    },
    releaseAll() {
      for (const id of [...queue.keys()]) scheduler.release(id);
    },
    stats() {
      return {
        running: [],
        queued: [...queue.values()].map(({ id, cls, slots }) => ({ id, cls, slots })),
        usedSlots: 0,
        totalSlots: 1,
      };
    },
  };
  return scheduler;
}

/** A pins stub with a mutable entry list. */
function fakePins(entries = []) {
  return {
    entries,
    get: (name) => entries.find((p) => p.name === name),
    list: () => entries,
  };
}

/** Copy the fake.echo tool into <dir>/<name> with a patched manifest. */
async function writeTool(dir, name, patch) {
  const handler = await readFile(path.join(FIXTURE_TOOLS, 'fake.echo', 'handler.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_TOOLS, 'fake.echo', 'tool.json'), 'utf8'));
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, 'handler.mjs'), handler, 'utf8');
  await writeFile(path.join(dir, name, 'tool.json'), `${JSON.stringify({ ...manifest, name, ...patch }, null, 2)}\n`);
}

/**
 * A temp workspace with a real store + registry, a fake scheduler/executor and the service.
 * @param {{hold?: boolean, executor?: object, pins?: object, tools?: {name: string, patch: object}[]}} [opts]
 */
async function setup({ hold = false, executor = fakeExecutor(), pins, tools = [] } = {}) {
  const ws = await mkTmp('mx-service-');
  const secretsDir = path.join(ws, '.secrets');
  await mkdir(secretsDir, { recursive: true });
  const toolsDirs = [FIXTURE_TOOLS];
  if (tools.length) {
    const extDir = path.join(ws, 'ext-tools');
    for (const t of tools) await writeTool(extDir, t.name, t.patch);
    toolsDirs.push(extDir);
  }
  const base = loadConfig({
    ...process.env,
    MX_WORKSPACE: ws,
    MX_EXTENSIONS_DIR: '',
    MX_TOOLS_DIRS: toolsDirs.join(path.delimiter),
    MX_SECRETS_DIR: secretsDir,
  });
  // config is frozen and loadConfig derives stateDir/scratchDir from the workspace; keep the scratch dir inside it.
  const config = Object.freeze({ ...base, scratchDir: path.join(ws, '.scratch') });
  const store = new JobStore({ stateDir: config.stateDir, workspace: config.workspace });
  await store.open();
  const registry = await loadRegistry({ config });
  const scheduler = fakeScheduler({ hold });
  const pinStore = pins ?? fakePins();
  const service = createJobService({ config, registry, store, pins: pinStore, executor, scheduler });
  return {
    ws,
    config,
    store,
    registry,
    scheduler,
    pins: pinStore,
    executor,
    service,
    async cleanup() {
      await service.drain();
      await store.close();
      await rmTmp(ws);
    },
  };
}

/** Poll until fn() is truthy (or throw). */
async function until(fn, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const isProblem = (code, status) => (err) => {
  assert.equal(err.name, 'Problem', `expected a Problem, got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, code);
  assert.equal(err.status, status);
  return true;
};

// ---- tests -------------------------------------------------------------------

test('submit runs a job, records outputs and emits queued/running/progress/succeeded events', async () => {
  const s = await setup();
  try {
    const { job, replayed } = await s.service.submit({ tool: 'fake.echo', input: { message: 'hello' } });
    assert.equal(replayed, false);
    assert.equal(job.status, 'queued');
    assert.equal(job.tool, 'fake.echo');
    assert.equal(job.tool_version, '1.0.0');
    assert.equal(job.cached_from, null);
    assert.deepEqual(job.request.cache, 'auto');
    assert.equal(job.links.self, `/v1/jobs/${job.id}`);
    assert.equal(job.links.events, `/v1/jobs/${job.id}/events`);
    assert.equal(job.links.log, `/v1/jobs/${job.id}/log`);
    assert.equal(job.links.dir, `.mx/jobs/${job.id}`);
    // the scheduler saw a light job with no slots
    assert.deepEqual(s.scheduler.enqueued, [{ id: job.id, cls: 'light', slots: 0 }]);

    const done = await s.service.wait(job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'succeeded');
    assert.ok(TERMINAL.has(done.status));
    assert.ok(done.started_at);
    assert.ok(done.finished_at);
    assert.deepEqual(done.result, { message: 'hello' });
    assert.deepEqual(done.progress, { fraction: 1, message: 'halfway' });
    assert.equal(done.error, null);

    assert.equal(done.outputs.length, 1);
    const out = done.outputs[0];
    assert.equal(out.name, 'result.txt');
    assert.match(out.sha256, /^[0-9a-f]{64}$/);
    assert.equal(out.sha256, sha256('hello\n'));
    assert.equal(out.bytes, 6);
    assert.equal(out.media_type, 'text/plain; charset=utf-8');
    assert.equal(out.ref, `job:${job.id}/result.txt`);
    assert.equal(out.path, `.mx/jobs/${job.id}/out/result.txt`);
    // the recorded path really points at the file the executor wrote
    assert.equal((await stat(path.join(s.ws, ...out.path.split('/')))).size, out.bytes);
    // the executor ran with the job's folders and the resolved input
    assert.equal(s.executor.calls.length, 1);
    assert.equal(s.executor.calls[0].outDir, path.join(s.ws, '.mx', 'jobs', job.id, 'out'));
    assert.equal(s.executor.calls[0].timeoutMs, 60_000);
    assert.equal(s.executor.calls[0].logFile, path.join(s.ws, '.mx', 'jobs', job.id, 'log.txt'));
    // the scratch dir is removed once the job is finalized (right after the state event)
    const scratchDir = path.join(s.config.scratchDir, job.id);
    await until(
      async () =>
        !(await stat(scratchDir).then(
          () => true,
          () => false,
        )),
    );
    await assert.rejects(stat(scratchDir));

    const { events, next_after } = await s.service.events(job.id, {});
    assert.deepEqual(
      events.map((e) => e.type),
      ['state', 'state', 'progress', 'state'],
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'state').map((e) => e.status),
      ['queued', 'running', 'succeeded'],
    );
    assert.equal(events[2].fraction, 0.5);
    assert.equal(events[2].message, 'halfway');
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2, 3, 4],
    );
    assert.equal(next_after, 4);
    assert.equal(s.service.get(job.id).status, 'succeeded');
    assert.equal(s.service.list({ tool: 'fake.echo' }).jobs.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('submit rejects unknown tools, invalid input and unavailable tools', async () => {
  const s = await setup({
    tools: [
      {
        name: 'fake.secret',
        patch: {
          title: 'fake.secret',
          summary: 'Test tool: requires a secret file that does not exist.',
          requires: { secrets: ['nope'] },
        },
      },
    ],
  });
  try {
    await assert.rejects(() => s.service.submit({ tool: 'no.such', input: {} }), isProblem('unknown-tool', 404));

    await assert.rejects(
      () => s.service.submit({ tool: 'fake.echo', input: {} }),
      (err) => {
        isProblem('invalid-input', 422)(err);
        assert.ok(Array.isArray(err.extras.errors));
        assert.ok(err.extras.errors.length > 0);
        assert.match(String(err.detail), /fake\.echo/);
        return true;
      },
    );

    await assert.rejects(
      () => s.service.submit({ tool: 'fake.secret', input: { message: 'x' } }),
      (err) => {
        isProblem('tool-unavailable', 422)(err);
        assert.match(String(err.detail), /nope/);
        return true;
      },
    );
    assert.equal(s.service.list({}).jobs.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('idempotency: replay, fingerprint mismatch and invalid keys', async () => {
  const s = await setup({ hold: true });
  try {
    const first = await s.service.submit({
      tool: 'fake.echo',
      input: { message: 'a' },
      idempotencyKey: 'key-1',
    });
    assert.equal(first.replayed, false);

    const again = await s.service.submit({ tool: 'fake.echo', input: { message: 'a' }, idempotencyKey: 'key-1' });
    assert.equal(again.replayed, true);
    assert.equal(again.job.id, first.job.id);
    assert.equal(s.store.list({}).jobs.length, 1);

    await assert.rejects(
      () => s.service.submit({ tool: 'fake.echo', input: { message: 'b' }, idempotencyKey: 'key-1' }),
      (err) => {
        isProblem('idempotency-key-reused', 422)(err);
        assert.equal(err.extras.job_id, first.job.id);
        return true;
      },
    );

    await assert.rejects(
      () => s.service.submit({ tool: 'fake.echo', input: { message: 'a' }, idempotencyKey: 'has space' }),
      isProblem('idempotency-key-invalid', 400),
    );
    await assert.rejects(
      () => s.service.submit({ tool: 'fake.echo', input: { message: 'a' }, idempotencyKey: 'x'.repeat(256) }),
      isProblem('idempotency-key-invalid', 400),
    );

    // a different body with a different key is a different job
    const other = await s.service.submit({ tool: 'fake.echo', input: { message: 'a' }, idempotencyKey: 'key-2' });
    assert.equal(other.replayed, false);
    assert.notEqual(other.job.id, first.job.id);
  } finally {
    await s.cleanup();
  }
});

test('cache: repeats are answered from the previous job, cache off runs again, non-cacheable tools never cache', async () => {
  const s = await setup();
  try {
    const first = await s.service.submit({ tool: 'fake.echo', input: { message: 'cached' } });
    await s.service.wait(first.job.id, { timeoutMs: 10_000 });

    const second = await s.service.submit({ tool: 'fake.echo', input: { message: 'cached' } });
    assert.notEqual(second.job.id, first.job.id);
    assert.equal(second.job.status, 'succeeded');
    assert.equal(second.job.cached_from, first.job.id);
    assert.deepEqual(second.job.result, { message: 'cached' });
    assert.equal(second.job.outputs.length, 1);
    assert.equal(second.job.outputs[0].ref, `job:${second.job.id}/result.txt`);
    // the file still lives in the source job's out dir
    assert.equal(second.job.outputs[0].path, `.mx/jobs/${first.job.id}/out/result.txt`);
    assert.equal(s.executor.calls.length, 1, 'a cache hit must not run the executor');
    const cachedEvents = await s.service.events(second.job.id, {});
    assert.deepEqual(
      cachedEvents.events.map((e) => e.status),
      ['succeeded'],
    );

    const off = await s.service.submit({ tool: 'fake.echo', input: { message: 'cached' }, cache: 'off' });
    assert.equal(off.job.status, 'queued');
    assert.equal(off.job.cached_from, null);
    await s.service.wait(off.job.id, { timeoutMs: 10_000 });
    assert.equal(s.executor.calls.length, 2);

    // fake.sleep is cache_default "off": an identical repeat always runs
    const sleep1 = await s.service.submit({ tool: 'fake.sleep', input: {} });
    await s.service.wait(sleep1.job.id, { timeoutMs: 10_000 });
    const sleep2 = await s.service.submit({ tool: 'fake.sleep', input: {} });
    assert.equal(sleep2.job.cached_from, null);
    assert.equal(sleep2.job.status, 'queued');
    await s.service.wait(sleep2.job.id, { timeoutMs: 10_000 });
  } finally {
    await s.cleanup();
  }
});

test('refs: inputs are recorded at submit and re-resolved when the job starts', async () => {
  const s = await setup({ hold: true });
  try {
    await writeFixture(s.ws, 'in/a.txt', { text: 'one' });
    const first = await s.service.submit({ tool: 'fake.echo', input: { message: 'm', file: 'in/a.txt' } });
    assert.equal(first.job.inputs.length, 1);
    assert.equal(first.job.inputs[0].pointer, '/file');
    assert.equal(first.job.inputs[0].ref, 'in/a.txt');
    assert.equal(first.job.inputs[0].path, 'in/a.txt');
    assert.equal(first.job.inputs[0].sha256, sha256('one'));
    assert.match(first.job.inputs[0].snapshot, /^\.mx\/blobs\/sha256\//);
    // the record keeps the ref string; the executor gets an absolute path
    assert.equal(first.job.input.file, 'in/a.txt');

    await writeFixture(s.ws, 'in/a.txt', { text: 'two — changed' });
    assert.equal(s.scheduler.release(first.job.id), true);
    const done = await s.service.wait(first.job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'succeeded');
    assert.equal(done.inputs[0].sha256, sha256('two — changed'));
    assert.equal(s.executor.calls[0].input.file, path.join(s.ws, 'in', 'a.txt'));
    assert.equal(s.executor.calls[0].rawInput.file, 'in/a.txt');

    await writeFixture(s.ws, 'in/b.txt', { text: 'bye' });
    const second = await s.service.submit({ tool: 'fake.echo', input: { message: 'm', file: 'in/b.txt' } });
    assert.equal(second.job.inputs[0].sha256, sha256('bye'));
    await rm(path.join(s.ws, 'in', 'b.txt'));
    s.scheduler.release(second.job.id);
    const failed = await s.service.wait(second.job.id, { timeoutMs: 10_000 });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.type, 'input-unreadable');
    assert.match(failed.error.detail, /b\.txt/);
    assert.equal(failed.error.retryable, false);
  } finally {
    await s.cleanup();
  }
});

test('cancel: queued jobs stop at once, running jobs are aborted, terminal jobs are untouched', async () => {
  const held = await setup({ hold: true });
  try {
    const { job } = await held.service.submit({ tool: 'fake.echo', input: { message: 'q' } });
    const canceled = await held.service.cancel(job.id);
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.error.type, 'canceled');
    assert.ok(canceled.finished_at);
    assert.deepEqual(held.scheduler.removed, [job.id]);
    assert.equal(held.executor.calls.length, 0);
    const events = await held.service.events(job.id, {});
    assert.deepEqual(
      events.events.map((e) => [e.type, e.status]),
      [
        ['state', 'queued'],
        ['state', 'canceled'],
      ],
    );
    // a terminal job is returned unchanged
    const again = await held.service.cancel(job.id);
    assert.equal(again.status, 'canceled');
    assert.equal(again.finished_at, canceled.finished_at);

    // cancel wins even when the scheduler had already handed the job to start()
    const raced = await held.service.submit({ tool: 'fake.echo', input: { message: 'race' } });
    const starting = held.scheduler.queue.get(raced.job.id);
    held.scheduler.queue.delete(raced.job.id); // the scheduler dequeued it and will call start()
    const racedCancel = await held.service.cancel(raced.job.id);
    assert.equal(racedCancel.status, 'canceled');
    await starting.start();
    assert.equal(held.service.get(raced.job.id).status, 'canceled');
    assert.equal(held.executor.calls.length, 0);
  } finally {
    await held.cleanup();
  }

  const running = await setup({ executor: fakeExecutor({ delayMs: 5000 }) });
  try {
    const { job } = await running.service.submit({ tool: 'fake.echo', input: { message: 'r' } });
    await until(() => running.service.get(job.id).status === 'running');
    const acked = await running.service.cancel(job.id);
    assert.ok(['running', 'canceled'].includes(acked.status));
    const done = await running.service.wait(job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'canceled');
    assert.equal(done.error.type, 'canceled');
    assert.ok(done.finished_at);
  } finally {
    await running.cleanup();
  }
});

test('failures: tool errors become failed jobs, a bad result becomes invalid-output', async () => {
  const timed = await setup({ executor: fakeExecutor({ reject: { type: 'timeout' } }) });
  try {
    const { job } = await timed.service.submit({ tool: 'fake.echo', input: { message: 't' } });
    const done = await timed.service.wait(job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'failed');
    assert.equal(done.error.type, 'timeout');
    assert.equal(done.error.retryable, true);
    assert.ok(done.finished_at);
    assert.deepEqual(done.outputs, []);
    assert.equal(done.result, null);
  } finally {
    await timed.cleanup();
  }

  const bad = await setup({ executor: fakeExecutor({ result: {} }) });
  try {
    const { job } = await bad.service.submit({ tool: 'fake.echo', input: { message: 'b' } });
    const done = await bad.service.wait(job.id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'failed');
    assert.equal(done.error.type, 'invalid-output');
    assert.equal(done.error.retryable, false);
    assert.match(done.error.detail, /message/);
  } finally {
    await bad.cleanup();
  }
});

test('events long-polls for the next event instead of sleeping out waitMs', async () => {
  const s = await setup({ hold: true });
  try {
    const { job } = await s.service.submit({ tool: 'fake.echo', input: { message: 'e' } });
    const immediate = await s.service.events(job.id, { after: 1, waitMs: 50 });
    assert.deepEqual(immediate.events, []);

    const started = Date.now();
    setTimeout(() => s.scheduler.release(job.id), 100);
    const { events, next_after } = await s.service.events(job.id, { after: 2, waitMs: 2000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `events() waited ${elapsed}ms`);
    assert.ok(events.length > 0, 'expected a new event');
    assert.ok(events.every((e) => e.seq > 2));
    assert.equal(next_after, events[events.length - 1].seq);
    assert.equal(await s.service.wait(job.id, { timeoutMs: 10_000 }).then((j) => j.status), 'succeeded');
  } finally {
    await s.cleanup();
  }
});

test('deleteOutputs refuses busy and pinned jobs, then removes the files and marks cached copies', async () => {
  const busy = await setup({ executor: fakeExecutor({ delayMs: 5000 }) });
  try {
    const { job } = await busy.service.submit({ tool: 'fake.echo', input: { message: 'b' } });
    await until(() => busy.service.get(job.id).status === 'running');
    await assert.rejects(() => busy.service.deleteOutputs(job.id), isProblem('job-busy', 409));
    await busy.service.cancel(job.id);
    await busy.service.wait(job.id, { timeoutMs: 10_000 });
  } finally {
    await busy.cleanup();
  }

  const pins = fakePins();
  const s = await setup({ pins });
  try {
    const first = await s.service.submit({ tool: 'fake.echo', input: { message: 'keep' } });
    await s.service.wait(first.job.id, { timeoutMs: 10_000 });
    const copy = await s.service.submit({ tool: 'fake.echo', input: { message: 'keep' } });
    assert.equal(copy.job.cached_from, first.job.id);

    pins.entries.push({ name: 'take', target: { job: first.job.id, output: 'result.txt' } });
    await assert.rejects(() => s.service.deleteOutputs(first.job.id), isProblem('pinned', 409));
    assert.equal((await stat(s.store.outDir(first.job.id))).isDirectory(), true);

    pins.entries.push({ name: 'copy', target: { job: copy.job.id, output: 'result.txt' } });
    await assert.rejects(() => s.service.deleteOutputs(first.job.id), isProblem('pinned', 409));
    pins.entries.length = 0;

    const deleted = await s.service.deleteOutputs(first.job.id);
    assert.ok(deleted.deleted_at);
    await assert.rejects(stat(s.store.outDir(first.job.id)));
    const dependent = s.service.get(copy.job.id);
    assert.ok(dependent.deleted_at, 'a job cached from it is marked deleted too');
    assert.equal(s.service.get(first.job.id).deleted_at, deleted.deleted_at);
  } finally {
    await s.cleanup();
  }
});

test('recover re-enqueues a job left queued by a restart', async () => {
  const s = await setup();
  try {
    const entry = s.registry.get('fake.echo');
    const id = newJobId();
    const at = new Date().toISOString();
    await s.store.create({
      id,
      tool: 'fake.echo',
      tool_version: entry.manifest.version,
      tool_hash: entry.toolHash,
      status: 'queued',
      label: null,
      project: null,
      note: null,
      created_at: at,
      started_at: null,
      finished_at: null,
      progress: { fraction: null, message: null },
      request: { input: { message: 'recovered' }, cache: 'auto', timeout_s: null },
      request_fingerprint: null,
      input: { message: 'recovered' },
      inputs: [],
      cache_key: null,
      cached_from: null,
      result: null,
      outputs: [],
      error: null,
      idempotency_key: null,
      deleted_at: null,
      links: {
        self: `/v1/jobs/${id}`,
        events: `/v1/jobs/${id}/events`,
        log: `/v1/jobs/${id}/log`,
        dir: `.mx/jobs/${id}`,
      },
    });

    s.service.recover([id]);
    assert.deepEqual(
      s.scheduler.enqueued.map((e) => e.id),
      [id],
    );
    const done = await s.service.wait(id, { timeoutMs: 10_000 });
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.result, { message: 'recovered' });
    assert.equal(done.outputs[0].name, 'result.txt');
  } finally {
    await s.cleanup();
  }
});
