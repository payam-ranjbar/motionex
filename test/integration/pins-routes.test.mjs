import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../../src/lib/hash.mjs';
import { createPinStore } from '../../src/runner/pins.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { createRouter } from '../../src/server/router.mjs';
import { register } from '../../src/server/routes/pins.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

/** Start a real HTTP server around the pin routes with a 404 fallback. */
async function withServer(fn) {
  const ws = await mkTmp();
  const stateDir = path.join(ws, '.mx');
  const store = new JobStore({ stateDir, workspace: ws });
  await store.open();
  const pins = createPinStore({ stateDir, workspace: ws, store, blobDir: store.blobDir() });
  await pins.open();
  const config = { workspace: ws, maxJsonBytes: 4 * 1024 * 1024 };
  const router = createRouter();
  register(router, { config, store, pins });
  const server = http.createServer((req, res) => {
    router
      .handle(req, res, { requestId: 'req-pins', deps: { config, store, pins } })
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found' }));
      })
      .catch(() => {
        res.destroy();
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ ws, base, store, pins });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rmTmp(ws);
  }
}

const putJson = (url, body) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('pins routes: PUT, GET, history, list, delete and refs/resolve', async () => {
  await withServer(async ({ ws, base }) => {
    await writeFixture(ws, 'films/a.txt', { text: 'hello' });

    const put = await putJson(`${base}/v1/pins/take/a`, { ref: 'films/a.txt', note: 'first' });
    assert.equal(put.status, 200);
    const pin = await put.json();
    assert.equal(pin.name, 'take/a');
    assert.equal(pin.note, 'first');
    assert.equal(pin.target.blob, sha256('hello'));

    const got = await fetch(`${base}/v1/pins/take/a`);
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), pin);

    const hist = await fetch(`${base}/v1/pins/take/a?history=1`);
    assert.equal(hist.status, 200);
    const histBody = await hist.json();
    assert.equal(histBody.pin.name, 'take/a');
    assert.equal(histBody.history.length, 1);
    assert.equal(histBody.history[0].action, 'set');

    const list = await fetch(`${base}/v1/pins`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      (await list.json()).pins.map((p) => p.name),
      ['take/a'],
    );

    const resolve = await fetch(`${base}/v1/refs/resolve?ref=${encodeURIComponent('films/a.txt')}`);
    assert.equal(resolve.status, 200);
    const resolved = await resolve.json();
    assert.equal(resolved.ref, 'films/a.txt');
    assert.equal(resolved.kind, 'path');
    assert.equal(resolved.path, 'films/a.txt');
    assert.equal(resolved.sha256, sha256('hello'));
    assert.equal(resolved.bytes, 5);
    assert.equal('abs' in resolved, false);

    const del = await fetch(`${base}/v1/pins/take/a`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const gone = await fetch(`${base}/v1/pins/take/a`);
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).type, 'urn:motionex:problem:not-found');

    const goneHist = await fetch(`${base}/v1/pins/take/a?history=1`);
    assert.equal(goneHist.status, 200);
    const goneBody = await goneHist.json();
    assert.equal(goneBody.pin, null);
    assert.equal(goneBody.history.length, 2);
  });
});

test('pin names with slashes round-trip over HTTP', async () => {
  await withServer(async ({ ws, base }) => {
    await writeFixture(ws, 'films/a.txt', { text: 'x' });

    const put = await putJson(`${base}/v1/pins/shapur/voice/who-0`, { ref: 'films/a.txt' });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).name, 'shapur/voice/who-0');

    const got = await fetch(`${base}/v1/pins/shapur/voice/who-0`);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).name, 'shapur/voice/who-0');

    const list = await fetch(`${base}/v1/pins`);
    assert.deepEqual(
      (await list.json()).pins.map((p) => p.name),
      ['shapur/voice/who-0'],
    );

    const del = await fetch(`${base}/v1/pins/shapur/voice/who-0`, { method: 'DELETE' });
    assert.equal(del.status, 204);
  });
});

test('pins routes: validation and error responses', async () => {
  await withServer(async ({ base }) => {
    const noRef = await putJson(`${base}/v1/pins/take/a`, { note: 'x' });
    assert.equal(noRef.status, 422);
    assert.equal((await noRef.json()).type, 'urn:motionex:problem:invalid-request');

    const badName = await putJson(`${base}/v1/pins/Bad%20Name`, { ref: 'a.txt' });
    assert.equal(badName.status, 422);
    assert.equal((await badName.json()).type, 'urn:motionex:problem:invalid-request');

    const badJob = await putJson(`${base}/v1/pins/ok`, { ref: `job:${`job_${'0'.repeat(32)}`}/x.wav` });
    assert.equal(badJob.status, 422);
    assert.equal((await badJob.json()).type, 'urn:motionex:problem:unknown-ref');

    const missingFile = await putJson(`${base}/v1/pins/ok`, { ref: 'missing.txt' });
    assert.equal(missingFile.status, 422);
    assert.equal((await missingFile.json()).type, 'urn:motionex:problem:file-not-found');

    const delMissing = await fetch(`${base}/v1/pins/nope`, { method: 'DELETE' });
    assert.equal(delMissing.status, 404);

    const noQuery = await fetch(`${base}/v1/refs/resolve`);
    assert.equal(noQuery.status, 422);
    assert.equal((await noQuery.json()).type, 'urn:motionex:problem:invalid-request');
  });
});
