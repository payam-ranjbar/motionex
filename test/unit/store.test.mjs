import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { newJobId } from '../../src/lib/ids.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

/** Minimal Job-like record used by the store tests. */
function rec(id, extra = {}) {
  return {
    id,
    tool: 'fake.echo',
    status: 'queued',
    created_at: new Date().toISOString(),
    cache_key: null,
    idempotency_key: null,
    request_fingerprint: null,
    deleted_at: null,
    ...extra,
  };
}

/** Open a store in a fresh temp workspace, run fn, then close and remove the workspace. */
async function withStore(fn) {
  const ws = await mkTmp();
  const store = new JobStore({ stateDir: path.join(ws, '.mx'), workspace: ws });
  try {
    return await fn(store, ws);
  } finally {
    await store.close();
    await rmTmp(ws);
  }
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('create, get and update round-trip; job.json matches the in-memory record', async () => {
  await withStore(async (store) => {
    await store.open();
    const id = newJobId();
    const record = rec(id, { label: 'a', tool_version: '1.0.0' });
    const created = await store.create(record);
    assert.deepEqual(created, record);
    assert.deepEqual(store.get(id), record);
    assert.deepEqual(await readJson(path.join(store.jobDir(id), 'job.json')), record);

    const updated = await store.update(id, { status: 'running', started_at: '2024-01-01T00:00:00.000Z' });
    assert.equal(updated.status, 'running');
    assert.equal(updated.id, id);
    assert.equal(updated.label, 'a');
    assert.deepEqual(store.get(id), updated);
    assert.deepEqual(await readJson(path.join(store.jobDir(id), 'job.json')), updated);

    assert.equal(store.get('job_00000000000000000000000000000000'), undefined);
    await assert.rejects(
      () => store.update('job_00000000000000000000000000000000', { status: 'failed' }),
      /unknown job/,
    );
  });
});

test('list: newest first, filters and pagination', async () => {
  await withStore(async (store) => {
    await store.open();
    const ids = Array.from({ length: 5 }, newJobId);
    await store.create(rec(ids[0], { status: 'succeeded', label: 'x', project: 'p1' }));
    await store.create(rec(ids[1], { tool: 'fake.other', status: 'failed', label: 'y', project: 'p2' }));
    await store.create(rec(ids[2], { status: 'queued', label: 'x', project: 'p1' }));
    await store.create(rec(ids[3], { status: 'queued', label: null, project: 'p1' }));
    await store.create(rec(ids[4], { status: 'running', label: 'x', project: 'p2' }));

    const all = store.list();
    assert.deepEqual(
      all.jobs.map((job) => job.id),
      [...ids].sort().reverse(),
    );
    assert.equal(all.next_before, null);

    assert.deepEqual(
      store.list({ tool: 'fake.echo' }).jobs.map((job) => job.id),
      [ids[4], ids[3], ids[2], ids[0]],
    );
    assert.deepEqual(
      store.list({ status: 'queued' }).jobs.map((job) => job.id),
      [ids[3], ids[2]],
    );
    assert.deepEqual(
      store.list({ label: 'x' }).jobs.map((job) => job.id),
      [ids[4], ids[2], ids[0]],
    );
    assert.deepEqual(
      store.list({ project: 'p1' }).jobs.map((job) => job.id),
      [ids[3], ids[2], ids[0]],
    );

    const desc = [...ids].sort().reverse();
    const page1 = store.list({ limit: 2 });
    assert.deepEqual(
      page1.jobs.map((job) => job.id),
      [desc[0], desc[1]],
    );
    assert.equal(page1.next_before, desc[1]);

    const page2 = store.list({ limit: 2, before: page1.next_before });
    assert.deepEqual(
      page2.jobs.map((job) => job.id),
      [desc[2], desc[3]],
    );
    assert.equal(page2.next_before, desc[3]);

    const page3 = store.list({ limit: 2, before: page2.next_before });
    assert.deepEqual(
      page3.jobs.map((job) => job.id),
      [desc[4]],
    );
    assert.equal(page3.next_before, null);
  });
});

test('events: concurrent appends are serialised, queries and subscribers work', async () => {
  await withStore(async (store) => {
    await store.open();
    const id = newJobId();
    await store.create(rec(id));

    const seen = [];
    const unsubscribe = store.subscribe(id, (event) => seen.push(event.seq));

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendEvent(id, { type: 'progress', fraction: i / 20 })),
    );

    const expected = Array.from({ length: 20 }, (_, i) => i + 1);
    const all = await store.events(id);
    assert.deepEqual(
      all.map((event) => event.seq),
      expected,
    );
    assert.deepEqual(seen, expected);

    const tail = await store.events(id, { after: 15 });
    assert.equal(tail.length, 5);
    assert.deepEqual(
      tail.map((event) => event.seq),
      [16, 17, 18, 19, 20],
    );

    const lines = (await readFile(store.eventsFile(id), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).seq),
      expected,
    );

    unsubscribe();
    await store.appendEvent(id, { type: 'log', message: 'after unsubscribe' });
    assert.equal(seen.length, 20);
    assert.equal((await store.events(id)).length, 21);
  });
});

test('recovery: running becomes failed, queued is returned, cache is rebuilt', async () => {
  const ws = await mkTmp();
  const stateDir = path.join(ws, '.mx');
  try {
    const runningId = newJobId();
    const queuedId = newJobId();
    const succeededId = newJobId();

    const first = new JobStore({ stateDir, workspace: ws });
    await first.open();
    await first.create(rec(runningId, { status: 'running', started_at: '2024-01-01T00:00:00.000Z' }));
    await first.create(rec(queuedId, { status: 'queued' }));
    await first.create(rec(succeededId, { status: 'succeeded', cache_key: 'ck-recover' }));
    await first.close();

    const second = new JobStore({ stateDir, workspace: ws });
    const queued = await second.open();
    assert.deepEqual(queued, [queuedId]);

    const running = second.get(runningId);
    assert.equal(running.status, 'failed');
    assert.equal(running.error.type, 'interrupted');
    assert.equal(running.error.retryable, true);
    assert.ok(running.finished_at);

    const events = await second.events(runningId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'state');
    assert.equal(events[0].status, 'failed');

    assert.equal(second.findCached('ck-recover'), succeededId);
    await second.close();
  } finally {
    await rmTmp(ws);
  }
});

test('idempotency: put/find in memory and rebuild from records on reopen', async () => {
  const ws = await mkTmp();
  const stateDir = path.join(ws, '.mx');
  try {
    const first = new JobStore({ stateDir, workspace: ws });
    await first.open();
    const id = newJobId();
    await first.create(rec(id, { idempotency_key: 'idem-record', request_fingerprint: 'fp-record' }));
    await first.putIdempotent('idem-memory', { jobId: id, fingerprint: 'fp-memory' });

    assert.deepEqual(first.findIdempotent('idem-memory'), { jobId: id, fingerprint: 'fp-memory' });
    assert.equal(first.findIdempotent('idem-record'), undefined);
    await first.close();

    const second = new JobStore({ stateDir, workspace: ws });
    await second.open();
    assert.deepEqual(second.findIdempotent('idem-record'), { jobId: id, fingerprint: 'fp-record' });
    assert.equal(second.findIdempotent('idem-memory'), undefined);
    await second.close();
  } finally {
    await rmTmp(ws);
  }
});

test('cache prefers the newest succeeded job and drops deleted ones', async () => {
  await withStore(async (store) => {
    await store.open();
    const olderId = newJobId();
    const newerId = newJobId();
    await store.create(rec(olderId, { cache_key: 'ck' }));
    await store.create(rec(newerId, { cache_key: 'ck' }));
    assert.equal(store.findCached('ck'), undefined);

    await store.update(olderId, { status: 'succeeded' });
    assert.equal(store.findCached('ck'), olderId);
    await store.update(newerId, { status: 'succeeded' });
    assert.equal(store.findCached('ck'), newerId);

    await store.update(newerId, { deleted_at: new Date().toISOString() });
    assert.equal(store.findCached('ck'), olderId);
    await store.update(olderId, { deleted_at: new Date().toISOString() });
    assert.equal(store.findCached('ck'), undefined);
  });
});

test('lock: second writer rejected, released on close, dead pid replaced', async () => {
  const ws = await mkTmp();
  const stateDir = path.join(ws, '.mx');
  const lockFile = path.join(stateDir, 'lock');
  try {
    const first = new JobStore({ stateDir, workspace: ws });
    await first.open();

    const second = new JobStore({ stateDir, workspace: ws });
    await assert.rejects(
      () => second.open(),
      (err) => err.code === 'ELOCKED' && String(err.message).includes('pid'),
    );

    await first.close();
    const third = new JobStore({ stateDir, workspace: ws });
    await third.open();
    await third.close();

    await writeFile(lockFile, JSON.stringify({ pid: 999999, hostname: os.hostname(), started_at: 'x' }), 'utf8');
    const fourth = new JobStore({ stateDir, workspace: ws });
    await fourth.open();
    assert.equal((await readJson(lockFile)).pid, process.pid);
    await fourth.close();
  } finally {
    await rmTmp(ws);
  }
});

test('path accessors are absolute and under stateDir', async () => {
  await withStore(async (store, ws) => {
    await store.open();
    const id = newJobId();
    await store.create(rec(id));
    const stateDir = path.join(ws, '.mx');
    for (const p of [store.jobDir(id), store.outDir(id), store.logFile(id), store.eventsFile(id), store.blobDir()]) {
      assert.ok(path.isAbsolute(p), p);
      assert.ok(p === stateDir || p.startsWith(stateDir + path.sep), p);
    }
    assert.equal(store.jobDir(id), path.join(stateDir, 'jobs', id));
    assert.equal(store.outDir(id), path.join(stateDir, 'jobs', id, 'out'));
    assert.equal(store.logFile(id), path.join(stateDir, 'jobs', id, 'log.txt'));
    assert.equal(store.eventsFile(id), path.join(stateDir, 'jobs', id, 'events.jsonl'));
    assert.equal(store.blobDir(), path.join(stateDir, 'blobs'));
  });
});
