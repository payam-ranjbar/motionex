import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../../src/lib/hash.mjs';
import { newJobId } from '../../src/lib/ids.mjs';
import { createPinStore } from '../../src/runner/pins.mjs';
import { resolveRef } from '../../src/runner/refs.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

/** Open a real job store + pin store in a fresh temp workspace, run fn, then clean up. */
async function withPins(fn) {
  const ws = await mkTmp();
  const stateDir = path.join(ws, '.mx');
  const blobDir = path.join(stateDir, 'blobs');
  const store = new JobStore({ stateDir, workspace: ws });
  await store.open();
  const pins = createPinStore({ stateDir, workspace: ws, store, blobDir });
  await pins.open();
  try {
    return await fn({ ws, stateDir, blobDir, store, pins });
  } finally {
    await store.close();
    await rmTmp(ws);
  }
}

/** Create a succeeded job with real output files and return its id. */
async function makeJob(store, outputNames = ['take.wav']) {
  const id = newJobId();
  await store.create({
    id,
    tool: 'fake.capture',
    tool_version: '1.0.0',
    status: 'queued',
    created_at: new Date().toISOString(),
    cache_key: null,
    idempotency_key: null,
    request_fingerprint: null,
    deleted_at: null,
  });
  const outputs = [];
  for (const name of outputNames) {
    const abs = path.join(store.outDir(id), ...name.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `content of ${name}`, 'utf8');
    outputs.push({ name, sha256: sha256(`content of ${name}`), bytes: 0 });
  }
  await store.update(id, { status: 'succeeded', outputs, finished_at: new Date().toISOString() });
  return id;
}

test('path pin copies the file into the blob store and freezes its content', async () => {
  await withPins(async ({ ws, blobDir, store, pins }) => {
    await writeFixture(ws, 'films/a.txt', { text: 'v1' });
    const pin = await pins.set('take/a', { ref: 'films/a.txt' });

    const v1 = sha256('v1');
    assert.equal(pin.name, 'take/a');
    assert.equal(pin.ref, 'films/a.txt');
    assert.equal(pin.note, null);
    assert.equal(pin.target.job, null);
    assert.equal(pin.target.output, null);
    assert.equal(pin.target.blob, v1);
    assert.equal(pin.target.path, 'films/a.txt');
    assert.equal(pin.target.sha256, v1);
    assert.ok(pin.pinned_at);

    const blobAbs = path.join(blobDir, 'sha256', v1.slice(0, 2), v1);
    await stat(blobAbs);
    assert.equal(await readFile(blobAbs, 'utf8'), 'v1');

    // later edits to the source never change the pin
    await writeFixture(ws, 'films/a.txt', { text: 'v2' });
    const resolved = await resolveRef('pin:take/a', { workspace: ws, store, pins, blobDir });
    assert.equal(resolved.kind, 'pin');
    assert.equal(resolved.sha256, v1);
  });
});

test('job output pin stores the job id and output path', async () => {
  await withPins(async ({ ws, blobDir, store, pins }) => {
    const id = await makeJob(store);
    const pin = await pins.set('voice/who-0', { ref: `job:${id}/take.wav`, note: 'approved' });
    assert.equal(pin.target.job, id);
    assert.equal(pin.target.output, 'take.wav');
    assert.equal(pin.target.blob, null);
    assert.equal(pin.target.path, null);
    assert.equal(pin.target.sha256, sha256('content of take.wav'));
    assert.equal(pin.note, 'approved');

    const resolved = await resolveRef('pin:voice/who-0#take.wav', { workspace: ws, store, pins, blobDir });
    assert.equal(resolved.job, id);
    assert.equal(resolved.output, 'take.wav');
  });
});

test('whole-job pin resolves through refs and needs an output', async () => {
  await withPins(async ({ ws, blobDir, store, pins }) => {
    const id = await makeJob(store, ['take.wav', 'meta.json']);
    const pin = await pins.set('the-job', { ref: `job:${id}` });
    assert.equal(pin.target.job, id);
    assert.equal(pin.target.output, null);
    assert.equal(pin.target.sha256, null);

    const resolved = await resolveRef('pin:the-job#take.wav', { workspace: ws, store, pins, blobDir });
    assert.equal(resolved.job, id);
    assert.equal(resolved.output, 'take.wav');

    await assert.rejects(
      resolveRef('pin:the-job', { workspace: ws, store, pins, blobDir }),
      (e) => e.code === 'unknown-ref',
    );
  });
});

test('pin-to-pin copies the other pin concrete target', async () => {
  await withPins(async ({ pins, store }) => {
    const id = await makeJob(store);
    await pins.set('base', { ref: `job:${id}/take.wav` });
    const alias = await pins.set('alias', { ref: 'pin:base#take.wav' });
    assert.equal(alias.ref, 'pin:base#take.wav');
    assert.deepEqual(alias.target, pins.get('base').target);
  });
});

test('history records set, re-pin and remove in order; rollback re-sets an old ref', async () => {
  await withPins(async ({ ws, pins }) => {
    await writeFixture(ws, 'films/a.txt', { text: 'v1' });
    await writeFixture(ws, 'films/b.txt', { text: 'v2' });
    await pins.set('take/a', { ref: 'films/a.txt' });
    await pins.set('take/a', { ref: 'films/b.txt' });
    assert.equal(await pins.remove('take/a'), true);

    const entries = pins.history('take/a');
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => e.action),
      ['set', 'set', 'remove'],
    );
    assert.equal(entries[0].ref, 'films/a.txt');
    assert.equal(entries[1].ref, 'films/b.txt');
    assert.equal(entries[2].ref, 'films/b.txt');
    assert.equal(entries[2].target.blob, sha256('v2'));

    // rollback: re-setting the first entry's ref restores what it pointed at
    const rolled = await pins.set('take/a', { ref: entries[0].ref });
    assert.equal(rolled.target.blob, sha256('v1'));
    assert.equal(pins.history('take/a').length, 4);
    assert.equal(await pins.remove('missing'), false);
  });
});

test('errors: bad names are invalid-request, unknown jobs are unknown-ref', async () => {
  await withPins(async ({ pins }) => {
    const badNames = ['Bad Name', 'Bad', 'a#b', '', '../x'];
    for (const name of badNames) {
      await assert.rejects(
        pins.set(name, { ref: 'whatever.txt' }),
        (e) => e.status === 422 && e.code === 'invalid-request',
        name,
      );
    }
    await assert.rejects(pins.set('ok', { ref: `job:${`job_${'0'.repeat(32)}`}` }), (e) => e.code === 'unknown-ref');
    await assert.rejects(pins.set('ok', {}), (e) => e.status === 422 && e.code === 'invalid-request');
  });
});

test('a new pin store over the same stateDir sees the pins after open()', async () => {
  await withPins(async ({ ws, stateDir, blobDir, store, pins }) => {
    await writeFixture(ws, 'films/a.txt', { text: 'v1' });
    const first = await pins.set('take/a', { ref: 'films/a.txt' });

    const second = createPinStore({ stateDir, workspace: ws, store, blobDir });
    await second.open();
    assert.deepEqual(second.get('take/a'), first);
    assert.deepEqual(
      second.list().map((p) => p.name),
      ['take/a'],
    );
    assert.equal(second.history('take/a').length, 1);
    assert.equal(second.history('take/a')[0].action, 'set');
  });
});
