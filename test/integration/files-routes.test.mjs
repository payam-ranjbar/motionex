import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/lib/config.mjs';
import { sha256 } from '../../src/lib/hash.mjs';
import { JobStore } from '../../src/runner/store.mjs';
import { createRouter } from '../../src/server/router.mjs';
import { register } from '../../src/server/routes/files.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

/** A chunked request body of `size` bytes (no Content-Length, so the server streams it). */
function chunkedBody(size) {
  const chunk = new Uint8Array(64 * 1024).fill(9);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.length, size - sent);
      controller.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
      sent += n;
    },
  });
}

/**
 * Start a real HTTP server with the files routes on a fresh temp workspace. `fn` gets the base URL
 * and the workspace root; the store/server/temp folder are torn down afterwards.
 */
async function withServer(fn) {
  const ws = await mkTmp();
  const config = {
    ...loadConfig({ ...process.env, MX_WORKSPACE: ws, MX_STATE_DIR: path.join(ws, '.mx') }),
    maxUploadBytes: 1024 * 1024,
  };
  const store = new JobStore({ stateDir: path.join(ws, '.mx'), workspace: ws });
  await store.open();

  const router = createRouter();
  register(router, { config, store, pins: { get: () => undefined } });
  const server = http.createServer((req, res) => {
    router
      .handle(req, res, { requestId: 'req-test' })
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found' }));
      })
      .catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await fn({ base: `http://127.0.0.1:${port}`, ws, store, config });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    await rmTmp(ws);
  }
}

test('PUT then GET and HEAD round-trip', async () => {
  await withServer(async ({ base }) => {
    const body = Buffer.from('<html>scene</html>', 'utf8');
    const put = await fetch(`${base}/v1/files/films/a/scene.html`, { method: 'PUT', body });
    assert.equal(put.status, 201);
    const created = await put.json();
    assert.equal(created.path, 'films/a/scene.html');
    assert.equal(created.bytes, body.length);
    assert.equal(created.sha256, sha256(body));

    const get = await fetch(`${base}/v1/files/films/a/scene.html`);
    assert.equal(get.status, 200);
    assert.ok(Buffer.from(await get.arrayBuffer()).equals(body));

    const head = await fetch(`${base}/v1/files/films/a/scene.html`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(body.length));
    assert.equal(await head.text(), '');
  });
});

test('Range: bytes=0-3 gives 206', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/v1/files/clip.bin`, { method: 'PUT', body: Buffer.from('0123456789', 'utf8') });
    const res = await fetch(`${base}/v1/files/clip.bin`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(await res.text(), '0123');
  });
});

test('PUT to reserved and escaping paths is rejected', async () => {
  await withServer(async ({ base, ws }) => {
    const reserved = await fetch(`${base}/v1/files/.mx/x`, { method: 'PUT', body: 'x' });
    assert.equal(reserved.status, 403);
    assert.equal((await reserved.json()).type, 'urn:motionex:problem:reserved-path');

    // fetch/URL normalise the literal `../`, so send the parent segment percent-encoded. The two forms below
    // survive URL normalisation (the `%2f` keeps the segment from being recognised as a double-dot segment)
    // and reach the router as `../x`.
    for (const enc of ['%2e%2e%2fx', '..%2fx']) {
      const res = await fetch(`${base}/v1/files/${enc}`, { method: 'PUT', body: 'x' });
      assert.equal(res.status, 422, `${enc} should be rejected`);
      assert.equal((await res.json()).type, 'urn:motionex:problem:path-outside-workspace');
    }

    // `%2e%2e/x` is collapsed to `/v1/x` by the URL parser before it reaches the route: nothing is written.
    const collapsed = await fetch(`${base}/v1/files/%2e%2e/x`, { method: 'PUT', body: 'x' });
    assert.equal(collapsed.status, 404);
    const root = await readdir(ws, { recursive: true });
    assert.ok(!root.some((f) => /(^|[\\/])x$/.test(String(f))));
  });
});

test('upload over the limit gives 413 and leaves no temp file', async () => {
  await withServer(async ({ base, ws }) => {
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const res = await fetch(`${base}/v1/files/big.bin`, { method: 'PUT', body: big });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).type, 'urn:motionex:problem:payload-too-large');

    const files = await readdir(ws, { recursive: true });
    assert.ok(!files.some((f) => String(f).endsWith('.upload')), `temp file left: ${files.join(', ')}`);
    await assert.rejects(() => readFile(path.join(ws, 'big.bin')), /ENOENT/);

    // Same limit without a Content-Length (chunked): the body is streamed to a temp file first, so this
    // exercises the mid-stream cleanup path.
    const streamed = await fetch(`${base}/v1/files/big2.bin`, {
      method: 'PUT',
      body: chunkedBody(2 * 1024 * 1024),
      duplex: 'half',
    });
    assert.equal(streamed.status, 413);
    assert.equal((await streamed.json()).type, 'urn:motionex:problem:payload-too-large');
    const after = await readdir(ws, { recursive: true });
    assert.ok(!after.some((f) => String(f).endsWith('.upload')), `temp file left: ${after.join(', ')}`);
    await assert.rejects(() => readFile(path.join(ws, 'big2.bin')), /ENOENT/);
  });
});

test('listing: prefix/recursive and state hiding', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/v1/files/films/a/scene.html`, { method: 'PUT', body: 'scene' });

    const films = await (await fetch(`${base}/v1/files?prefix=films&recursive=1`)).json();
    const entry = films.files.find((f) => f.path === 'films/a/scene.html');
    assert.ok(entry, `missing entry: ${JSON.stringify(films.files)}`);
    assert.equal(entry.dir, false);
    assert.equal(entry.bytes, 5);
    assert.ok(!Number.isNaN(Date.parse(entry.mtime)));

    const root = await (await fetch(`${base}/v1/files`)).json();
    assert.ok(!root.files.some((f) => f.path === '.mx' || f.path.startsWith('.mx/')));

    const withState = await (await fetch(`${base}/v1/files?include_state=1`)).json();
    assert.ok(withState.files.some((f) => f.path === '.mx' && f.dir === true));

    const missing = await fetch(`${base}/v1/files?prefix=nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).type, 'urn:motionex:problem:file-not-found');
  });
});

test('?from copies a file server-side', async () => {
  await withServer(async ({ base }) => {
    const body = Buffer.from('hello copy', 'utf8');
    const first = await (await fetch(`${base}/v1/files/films/a/scene.html`, { method: 'PUT', body })).json();

    const copyRes = await fetch(`${base}/v1/files/copy/scene.html?from=films/a/scene.html`, { method: 'PUT' });
    assert.equal(copyRes.status, 201);
    const copied = await copyRes.json();
    assert.equal(copied.path, 'copy/scene.html');
    assert.equal(copied.sha256, first.sha256);
    assert.equal(copied.bytes, body.length);

    assert.equal(await (await fetch(`${base}/v1/files/copy/scene.html`)).text(), 'hello copy');
  });
});

test('DELETE removes a file and, recursively, a folder', async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/v1/files/dir/a.txt`, { method: 'PUT', body: 'a' });
    await fetch(`${base}/v1/files/dir/nested/b.txt`, { method: 'PUT', body: 'b' });

    const delFile = await fetch(`${base}/v1/files/dir/a.txt`, { method: 'DELETE' });
    assert.equal(delFile.status, 204);
    assert.equal((await fetch(`${base}/v1/files/dir/a.txt`)).status, 404);

    const delDir = await fetch(`${base}/v1/files/dir`, { method: 'DELETE' });
    assert.equal(delDir.status, 422);
    assert.equal((await delDir.json()).type, 'urn:motionex:problem:invalid-request');

    const delDirRec = await fetch(`${base}/v1/files/dir?recursive=1`, { method: 'DELETE' });
    assert.equal(delDirRec.status, 204);
    assert.equal((await fetch(`${base}/v1/files/dir/nested/b.txt`)).status, 404);

    const delMissing = await fetch(`${base}/v1/files/dir`, { method: 'DELETE' });
    assert.equal(delMissing.status, 404);
    assert.equal((await delMissing.json()).type, 'urn:motionex:problem:file-not-found');

    const delReserved = await fetch(`${base}/v1/files/.mx/lock`, { method: 'DELETE' });
    assert.equal(delReserved.status, 403);
    assert.equal((await delReserved.json()).type, 'urn:motionex:problem:reserved-path');
  });
});
