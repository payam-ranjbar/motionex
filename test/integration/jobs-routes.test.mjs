import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { createExecutor } from '../../src/runner/execute.mjs';
import { createPinStore } from '../../src/runner/pins.mjs';
import { Scheduler } from '../../src/runner/scheduler.mjs';
import { createJobService } from '../../src/runner/service.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { createRouter } from '../../src/server/router.mjs';
import { register } from '../../src/server/routes/jobs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_TOOLS = path.join(REPO, 'test', 'fixtures', 'tools');

/**
 * Build the real stack (store, registry, pins, executor, scheduler, service) on a fresh temp workspace
 * and serve the jobs routes over HTTP. `fn` gets the base URL and the stack; everything is torn down after.
 */
async function withServer(fn) {
  const ws = await mkTmp('mx-jobs-routes-');
  const config = {
    ...loadConfig({
      ...process.env,
      MX_WORKSPACE: ws,
      MX_TOOLS_DIRS: FIXTURE_TOOLS,
      MX_EXTENSIONS_DIR: '',
    }),
    killGraceMs: 1000,
  };
  const store = new JobStore({ stateDir: config.stateDir, workspace: config.workspace });
  await store.open();
  const registry = await loadRegistry({ config });
  const pins = createPinStore({
    stateDir: config.stateDir,
    workspace: config.workspace,
    store,
    blobDir: store.blobDir(),
  });
  await pins.open();
  const executor = createExecutor({ config });
  const scheduler = new Scheduler({ totalSlots: 4, limits: config.limits });
  const service = createJobService({ config, registry, store, pins, executor, scheduler });

  const router = createRouter();
  register(router, { config, store, service, registry, pins });
  const server = http.createServer((req, res) => {
    router
      .handle(req, res, { requestId: 'req-jobs', deps: { config, store, service, registry, pins } })
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found' }));
      })
      .catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await fn({ base, ws, config, store, registry, pins, service });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await service.drain();
    await store.close();
    await rmTmp(ws);
  }
}

/** POST a JSON body to /v1/jobs. */
function postJob(base, body, { wait, headers = {} } = {}) {
  const url = wait === undefined ? `${base}/v1/jobs` : `${base}/v1/jobs?wait=${wait}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST ?wait=30 runs a job to success; without wait it is 202 and GET ?wait=30 finishes it', async () => {
  await withServer(async ({ base }) => {
    const waited = await postJob(base, { tool: 'fake.echo', input: { message: 'hello' } }, { wait: 30 });
    assert.equal(waited.status, 200);
    const job = await waited.json();
    assert.equal(job.status, 'succeeded');
    assert.equal(job.tool, 'fake.echo');
    assert.equal(waited.headers.get('location'), `/v1/jobs/${job.id}`);
    assert.ok(Array.isArray(job.outputs) && job.outputs.length >= 1);
    assert.ok(job.outputs.some((o) => o.name === 'echo.json'));

    const queued = await postJob(base, { tool: 'fake.echo', input: { message: 'later' } });
    assert.equal(queued.status, 202);
    const pending = await queued.json();
    assert.ok(['queued', 'running'].includes(pending.status), `unexpected status ${pending.status}`);

    const done = await fetch(`${base}/v1/jobs/${pending.id}?wait=30`);
    assert.equal(done.status, 200);
    const finished = await done.json();
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.result.message, 'later');
  });
});

test('Idempotency-Key replays the same job and sets idempotent-replay', async () => {
  await withServer(async ({ base }) => {
    const body = { tool: 'fake.echo', input: { message: 'idem' } };
    const first = await postJob(base, body, { wait: 30, headers: { 'Idempotency-Key': 'key-1' } });
    assert.equal(first.status, 200);
    const a = await first.json();
    assert.equal(first.headers.get('idempotent-replay'), null);

    const second = await postJob(base, body, { wait: 30, headers: { 'Idempotency-Key': 'key-1' } });
    assert.equal(second.status, 200);
    const b = await second.json();
    assert.equal(b.id, a.id);
    assert.equal(second.headers.get('idempotent-replay'), 'true');
  });
});

test('invalid input, unknown envelope fields and non-JSON bodies are rejected', async () => {
  await withServer(async ({ base }) => {
    const invalid = await postJob(base, { tool: 'fake.echo', input: {} });
    assert.equal(invalid.status, 422);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.type, 'urn:motionex:problem:invalid-input');
    assert.ok(Array.isArray(invalidBody.errors));
    assert.ok(
      invalidBody.errors.some((e) => e.field === '/message'),
      JSON.stringify(invalidBody.errors),
    );

    const unknown = await postJob(base, { tool: 'fake.echo', input: { message: 'x' }, bogus: 1 });
    assert.equal(unknown.status, 422);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.type, 'urn:motionex:problem:invalid-request');
    assert.ok(unknownBody.errors.some((e) => e.field === '/bogus'));

    const badJson = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).type, 'urn:motionex:problem:malformed-json');
  });
});

test('outputs stream with their media type; unknown outputs are 404', async () => {
  await withServer(async ({ base }) => {
    const res = await postJob(base, { tool: 'fake.echo', input: { message: 'bytes' } }, { wait: 30 });
    const job = await res.json();
    assert.equal(job.status, 'succeeded');

    const out = await fetch(`${base}/v1/jobs/${job.id}/outputs/echo.json`);
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('content-type'), 'application/json');
    const parsed = JSON.parse(await out.text());
    assert.equal(parsed.message, 'bytes');

    const missing = await fetch(`${base}/v1/jobs/${job.id}/outputs/nope.json`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).type, 'urn:motionex:problem:not-found');
  });
});

test('events are returned in seq order and include the terminal state', async () => {
  await withServer(async ({ base }) => {
    const res = await postJob(base, { tool: 'fake.echo', input: { message: 'events' } }, { wait: 30 });
    const job = await res.json();

    const eventsRes = await fetch(`${base}/v1/jobs/${job.id}/events?after=0`);
    assert.equal(eventsRes.status, 200);
    const { events, next_after } = await eventsRes.json();
    assert.ok(events.length >= 2);
    for (let i = 1; i < events.length; i += 1) assert.ok(events[i].seq > events[i - 1].seq);
    assert.ok(events.some((e) => e.type === 'state' && e.status === 'succeeded'));
    assert.equal(next_after, events[events.length - 1].seq);
  });
});

test('cancel stops a running job', async () => {
  await withServer(async ({ base }) => {
    const res = await postJob(base, { tool: 'fake.sleep', input: { seconds: 30 } });
    assert.equal(res.status, 202);
    const job = await res.json();

    const canceled = await fetch(`${base}/v1/jobs/${job.id}/cancel`, { method: 'POST' });
    assert.equal(canceled.status, 200);

    const done = await fetch(`${base}/v1/jobs/${job.id}?wait=10`);
    assert.equal(done.status, 200);
    assert.equal((await done.json()).status, 'canceled');
  });
});

test('list omits request/input unless full=1', async () => {
  await withServer(async ({ base }) => {
    await postJob(base, { tool: 'fake.echo', input: { message: 'one' } }, { wait: 30 });
    await postJob(base, { tool: 'fake.echo', input: { message: 'two' } }, { wait: 30 });

    const shallow = await fetch(`${base}/v1/jobs?tool=fake.echo`);
    assert.equal(shallow.status, 200);
    const shallowBody = await shallow.json();
    assert.equal(shallowBody.jobs.length, 2);
    for (const job of shallowBody.jobs) {
      assert.equal(job.tool, 'fake.echo');
      assert.equal('request' in job, false);
      assert.equal('input' in job, false);
    }

    const full = await fetch(`${base}/v1/jobs?tool=fake.echo&full=1`);
    assert.equal(full.status, 200);
    const fullBody = await full.json();
    assert.equal(fullBody.jobs.length, 2);
    for (const job of fullBody.jobs) {
      assert.ok(job.request && typeof job.request === 'object');
      assert.ok(job.input && typeof job.input === 'object');
    }
  });
});

test('DELETE marks a finished job deleted and its outputs become 404', async () => {
  await withServer(async ({ base }) => {
    const res = await postJob(base, { tool: 'fake.echo', input: { message: 'delete-me' } }, { wait: 30 });
    const job = await res.json();
    assert.equal(job.status, 'succeeded');

    const del = await fetch(`${base}/v1/jobs/${job.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const deleted = await del.json();
    assert.equal(typeof deleted.deleted_at, 'string');

    const out = await fetch(`${base}/v1/jobs/${job.id}/outputs/echo.json`);
    assert.equal(out.status, 404);
  });
});

test('the log of a failed job contains the tool stderr', async () => {
  await withServer(async ({ base }) => {
    const res = await postJob(base, { tool: 'fake.fail', input: { mode: 'throw' } }, { wait: 30 });
    assert.equal(res.status, 200);
    const job = await res.json();
    assert.equal(job.status, 'failed');

    const log = await fetch(`${base}/v1/jobs/${job.id}/log`);
    assert.equal(log.status, 200);
    assert.match(log.headers.get('content-type'), /^text\/plain/);
    assert.match(await log.text(), /about to fail/);
  });
});

test('a repeated deterministic job is answered from the cache', async () => {
  await withServer(async ({ base }) => {
    const body = { tool: 'fake.echo', input: { message: 'cache-me' } };
    const first = await postJob(base, body, { wait: 30 });
    assert.equal(first.status, 200);
    const a = await first.json();
    assert.equal(a.cached_from, null);

    const second = await postJob(base, body, { wait: 30 });
    assert.equal(second.status, 200);
    const b = await second.json();
    assert.equal(b.cached_from, a.id);
    assert.notEqual(b.id, a.id);
  });
});
