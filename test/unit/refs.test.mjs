import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../../src/lib/hash.mjs';
import { cacheKey, PIN_NAME, parseRef, resolveInputRefs, resolveRef } from '../../src/runner/refs.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const JOB_A = `job_${'a'.repeat(32)}`;
const JOB_B = `job_${'b'.repeat(32)}`;

const fakeStore = (ws, jobs) => ({
  get: (id) => jobs[id],
  outDir: (id) => path.join(ws, '.mx', 'jobs', id, 'out'),
});
const fakePins = (map) => ({ get: (name) => map.get(name) });

/** Build deps for a temp workspace. */
const deps = (ws, { jobs = {}, pins = new Map() } = {}) => ({
  workspace: ws,
  store: fakeStore(ws, jobs),
  pins: fakePins(pins),
  blobDir: path.join(ws, '.mx', 'blobs'),
});

test('parseRef: paths, jobs and pins', () => {
  assert.deepEqual(parseRef('films/a/song.strudel'), { kind: 'path', path: 'films/a/song.strudel' });
  assert.deepEqual(parseRef(`job:${JOB_A}/stems/dialogue.wav`), {
    kind: 'job',
    jobId: JOB_A,
    output: 'stems/dialogue.wav',
  });
  assert.deepEqual(parseRef('pin:shapur/voice/who-0#take.wav'), {
    kind: 'pin',
    name: 'shapur/voice/who-0',
    output: 'take.wav',
  });
  assert.deepEqual(parseRef('pin:theme'), { kind: 'pin', name: 'theme', output: null });
  assert.ok(PIN_NAME.test('shapur/voice/who-0'));
  assert.ok(!PIN_NAME.test('Bad'));
  for (const bad of ['job:x/y', `job:${JOB_A}`, 'pin:Bad#x', 'pin:a#b#c', 'pin:', 'job:']) {
    assert.throws(
      () => parseRef(bad),
      (e) => e.code === 'unknown-ref',
      bad,
    );
  }
});

test('resolveRef path: resolves, missing 422 file-not-found, escapes rejected', async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'films/a/song.strudel', { text: 'hello' });
    const d = deps(ws);
    const r = await resolveRef('films/a/song.strudel', d);
    assert.equal(r.kind, 'path');
    assert.equal(r.abs, path.join(ws, 'films', 'a', 'song.strudel'));
    assert.equal(r.path, 'films/a/song.strudel');
    assert.equal(r.sha256, sha256('hello'));
    assert.equal(r.bytes, 5);

    await assert.rejects(resolveRef('missing.txt', d), (e) => e.status === 422 && e.code === 'file-not-found');
    await assert.rejects(resolveRef(ws, d), (e) => e.code === 'path-outside-workspace');
    await assert.rejects(resolveRef('../x', d), (e) => e.code === 'path-outside-workspace');
    await writeFixture(ws, 'a-dir/keep.txt', { text: 'x' });
    await assert.rejects(resolveRef('a-dir', d), (e) => e.status === 422 && e.code === 'file-not-found');
  } finally {
    await rmTmp(ws);
  }
});

test('resolveRef job: outputs, status, missing output, cached_from', async () => {
  const ws = await mkTmp();
  try {
    const outputs = [
      { name: 'mix.wav', sha256: 'x', bytes: 1 },
      { name: 'stems/a.wav', sha256: 'y', bytes: 1 },
    ];
    await writeFixture(ws, `.mx/jobs/${JOB_A}/out/mix.wav`, { text: 'A-mix' });
    await writeFixture(ws, `.mx/jobs/${JOB_A}/out/stems/a.wav`, { text: 'A-stem' });
    const succeeded = { id: JOB_A, status: 'succeeded', outputs, cached_from: null, deleted_at: null };
    const d = deps(ws, {
      jobs: {
        [JOB_A]: succeeded,
        [JOB_B]: { id: JOB_B, status: 'succeeded', outputs, cached_from: JOB_A, deleted_at: null },
        job_run: { id: 'job_run', status: 'running', outputs, deleted_at: null },
        job_del: { id: 'job_del', status: 'succeeded', outputs, deleted_at: '2020-01-01' },
      },
    });

    const nested = await resolveRef(`job:${JOB_A}/stems/a.wav`, d);
    assert.equal(nested.kind, 'job');
    assert.equal(nested.job, JOB_A);
    assert.equal(nested.output, 'stems/a.wav');
    assert.equal(nested.abs, path.join(ws, '.mx', 'jobs', JOB_A, 'out', 'stems', 'a.wav'));
    assert.equal(nested.path, `.mx/jobs/${JOB_A}/out/stems/a.wav`);
    assert.equal(nested.sha256, sha256('A-stem'));

    const cached = await resolveRef(`job:${JOB_B}/mix.wav`, d);
    assert.equal(cached.job, JOB_B);
    assert.equal(cached.abs, path.join(ws, '.mx', 'jobs', JOB_A, 'out', 'mix.wav'));

    for (const id of ['job_run', 'job_del', 'job_unknown']) {
      await assert.rejects(resolveRef(`job:${id}/mix.wav`, d), (e) => e.code === 'unknown-ref', id);
    }

    await assert.rejects(resolveRef(`job:${JOB_A}/nope.wav`, d), (e) => {
      assert.equal(e.code, 'unknown-ref');
      assert.match(e.detail, /mix\.wav/);
      assert.match(e.detail, /stems\/a\.wav/);
      return true;
    });
  } finally {
    await rmTmp(ws);
  }
});

test('resolveRef pin: blob, job+output, whole job and path targets', async () => {
  const ws = await mkTmp();
  try {
    const blobText = 'blob-content';
    const blobSha = sha256(blobText);
    await writeFixture(ws, `.mx/blobs/sha256/${blobSha.slice(0, 2)}/${blobSha}`, { text: blobText });
    await writeFixture(ws, `.mx/jobs/${JOB_A}/out/mix.wav`, { text: 'A-mix' });
    await writeFixture(ws, `.mx/jobs/${JOB_A}/out/stems/a.wav`, { text: 'A-stem' });
    await writeFixture(ws, 'films/a/song.strudel', { text: 'hello' });
    const outputs = [
      { name: 'mix.wav', sha256: 'x', bytes: 1 },
      { name: 'stems/a.wav', sha256: 'y', bytes: 1 },
    ];
    const pins = new Map([
      ['blobpin', { name: 'blobpin', target: { blob: blobSha, job: null, output: null, path: null } }],
      ['jp', { name: 'jp', target: { job: JOB_A, output: 'mix.wav', blob: null, path: null } }],
      ['whole', { name: 'whole', target: { job: JOB_A, output: null, blob: null, path: null } }],
      ['pp', { name: 'pp', target: { path: 'films/a/song.strudel', job: null } }],
    ]);
    const d = deps(ws, {
      jobs: { [JOB_A]: { id: JOB_A, status: 'succeeded', outputs, cached_from: null, deleted_at: null } },
      pins,
    });

    const blob = await resolveRef('pin:blobpin', d);
    assert.equal(blob.kind, 'pin');
    assert.equal(blob.abs, path.join(ws, '.mx', 'blobs', 'sha256', blobSha.slice(0, 2), blobSha));
    assert.equal(blob.sha256, blobSha);
    assert.equal(blob.output, null);
    await assert.rejects(resolveRef('pin:blobpin#x.wav', d), (e) => e.code === 'unknown-ref');

    const jp = await resolveRef('pin:jp#mix.wav', d);
    assert.equal(jp.abs, path.join(ws, '.mx', 'jobs', JOB_A, 'out', 'mix.wav'));
    assert.equal(jp.job, JOB_A);
    assert.equal(jp.output, 'mix.wav');
    await assert.rejects(resolveRef('pin:jp#other.wav', d), (e) => e.code === 'unknown-ref');

    const whole = await resolveRef('pin:whole#stems/a.wav', d);
    assert.equal(whole.abs, path.join(ws, '.mx', 'jobs', JOB_A, 'out', 'stems', 'a.wav'));
    await assert.rejects(resolveRef('pin:whole', d), (e) => e.code === 'unknown-ref');

    const pp = await resolveRef('pin:pp', d);
    assert.equal(pp.abs, path.join(ws, 'films', 'a', 'song.strudel'));
    assert.equal(pp.kind, 'pin');

    await assert.rejects(resolveRef('pin:nope', d), (e) => e.code === 'unknown-ref');
  } finally {
    await rmTmp(ws);
  }
});

test('resolveInputRefs: clone with abs paths, snapshot small files, never mutates input', async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'small/a.txt', { text: 'x'.repeat(1024) });
    await writeFixture(ws, 'small/b.txt', { text: 'y'.repeat(50) });
    const input = { a: 'small/a.txt', tracks: [{ src: 'small/b.txt' }] };
    const d = deps(ws);
    const pointers = ['/a', '/tracks/0/src'];
    const { resolvedInput, inputs } = await resolveInputRefs(input, pointers, d);

    assert.deepEqual(input, { a: 'small/a.txt', tracks: [{ src: 'small/b.txt' }] });
    assert.equal(resolvedInput.a, path.join(ws, 'small', 'a.txt'));
    assert.equal(resolvedInput.tracks[0].src, path.join(ws, 'small', 'b.txt'));
    assert.deepEqual(
      inputs.map((i) => i.pointer),
      ['/a', '/tracks/0/src'],
    );
    assert.ok(inputs[0].snapshot.startsWith('.mx/blobs/sha256/'));
    assert.ok(inputs[1].snapshot.startsWith('.mx/blobs/sha256/'));
    await stat(path.join(ws, inputs[0].snapshot));

    const tiny = await resolveInputRefs(input, pointers, d, { snapshotMaxBytes: 10 });
    assert.equal(tiny.inputs[0].snapshot, null);
    assert.equal(tiny.inputs[1].snapshot, null);
  } finally {
    await rmTmp(ws);
  }
});

test('cacheKey: stable under key order, changes with file content and tool hash', async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'in/a.txt', { text: 'one' });
    const d = deps(ws);
    const pointers = ['/a'];
    const input = { a: 'in/a.txt', z: 1 };
    const resolved = await resolveInputRefs(input, pointers, d);
    const k1 = cacheKey('fake.echo', 'hash-1', input, resolved.inputs);
    const reordered = cacheKey('fake.echo', 'hash-1', { z: 1, a: 'in/a.txt' }, resolved.inputs);
    assert.equal(reordered, k1);

    await writeFixture(ws, 'in/a.txt', { text: 'a much longer content value' });
    const again = await resolveInputRefs(input, pointers, d);
    const k2 = cacheKey('fake.echo', 'hash-1', input, again.inputs);
    assert.notEqual(k1, k2);

    const k3 = cacheKey('fake.echo', 'hash-2', input, again.inputs);
    assert.notEqual(k2, k3);
  } finally {
    await rmTmp(ws);
  }
});
