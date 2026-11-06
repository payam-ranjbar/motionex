import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { problem } from '../../src/lib/problem.mjs';
import { createRouter, streamFile } from '../../src/server/router.mjs';

const REQUEST_ID = 'req-test';

/** Start a real HTTP server around a freshly configured router. */
async function serve(configure) {
  const router = createRouter();
  configure(router);
  const server = http.createServer((req, res) => {
    router
      .handle(req, res, { requestId: REQUEST_ID, deps: { here: true } })
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
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('router: params and wildcard decoding', async () => {
  const s = await serve((r) => {
    r.add('GET', '/v1/jobs/:id', (_req, _res, ctx) => ctx.params);
    r.add('GET', '/v1/jobs/:id/outputs/*name', (_req, _res, ctx) => ctx.params);
    r.add('GET', '/w/*path', (_req, _res, ctx) => ctx.params);
  });
  try {
    const a = await fetch(`${s.base}/v1/jobs/abc`);
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { id: 'abc' });

    const b = await fetch(`${s.base}/v1/jobs/abc/outputs/stems/dialogue.wav`);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { id: 'abc', name: 'stems/dialogue.wav' });

    const c = await fetch(`${s.base}/w/films/a%20b/x.html`);
    assert.equal(c.status, 200);
    assert.deepEqual(await c.json(), { path: 'films/a b/x.html' });
  } finally {
    await s.close();
  }
});

test('router: query is parsed and matching ignores it', async () => {
  const s = await serve((r) => {
    r.add('GET', '/x', (_req, _res, ctx) => ({ p: ctx.query.get('p') }));
  });
  try {
    const res = await fetch(`${s.base}/x?p=hello`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { p: 'hello' });
  } finally {
    await s.close();
  }
});

test('router: unmatched path and wrong method', async () => {
  const s = await serve((r) => {
    r.add('GET', '/v1/jobs/:id', () => 'ok');
  });
  try {
    const missing = await fetch(`${s.base}/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not-found' });

    const wrong = await fetch(`${s.base}/v1/jobs/abc`, { method: 'DELETE' });
    assert.equal(wrong.status, 405);
    assert.match(wrong.headers.get('allow') ?? '', /GET/);
    assert.equal(wrong.headers.get('content-type'), 'application/problem+json');
    const body = await wrong.json();
    assert.equal(body.type, 'urn:motionex:problem:method-not-allowed');
    assert.equal(body.status, 405);
  } finally {
    await s.close();
  }
});

test('router: HEAD is allowed on GET routes with no body', async () => {
  const s = await serve((r) => {
    r.add('GET', '/thing', () => ({ ok: true }));
  });
  try {
    const res = await fetch(`${s.base}/thing`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length')) > 0);
    assert.equal(await res.text(), '');
  } finally {
    await s.close();
  }
});

test('router: handler return styles', async () => {
  const s = await serve((r) => {
    r.add('GET', '/obj', () => ({ a: 1 }));
    r.add('GET', '/created', () => ({ status: 201, headers: { x: '1' }, body: { a: 1 } }));
    r.add('GET', '/raw', () => ({ status: 200, body: 'hello' }));
    r.add('GET', '/empty', () => ({ status: 204, body: null }));
    r.add('GET', '/wrote', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('mine');
    });
  });
  try {
    const obj = await fetch(`${s.base}/obj`);
    assert.equal(obj.status, 200);
    assert.deepEqual(await obj.json(), { a: 1 });

    const created = await fetch(`${s.base}/created`);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x'), '1');
    assert.deepEqual(await created.json(), { a: 1 });

    const raw = await fetch(`${s.base}/raw`);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), 'hello');
    assert.equal(raw.headers.get('content-length'), '5');

    const empty = await fetch(`${s.base}/empty`);
    assert.equal(empty.status, 204);

    const wrote = await fetch(`${s.base}/wrote`);
    assert.equal(wrote.status, 200);
    assert.equal(await wrote.text(), 'mine');
  } finally {
    await s.close();
  }
});

test('router: Problem and unexpected errors', async () => {
  const s = await serve((r) => {
    r.add('GET', '/boom', () => {
      throw problem('unknown-tool', 'x');
    });
    r.add('GET', '/crash', () => {
      throw new Error('SECRET STACK TEXT');
    });
  });
  try {
    const boom = await fetch(`${s.base}/boom`);
    assert.equal(boom.status, 404);
    assert.equal(boom.headers.get('content-type'), 'application/problem+json');
    const pb = await boom.json();
    assert.equal(pb.type, 'urn:motionex:problem:unknown-tool');
    assert.equal(pb.title, 'No tool by that name');
    assert.equal(pb.status, 404);
    assert.equal(pb.detail, 'x');
    assert.equal(pb.request_id, REQUEST_ID);
    assert.equal(boom.headers.get('x-request-id'), REQUEST_ID);

    const crash = await fetch(`${s.base}/crash`);
    assert.equal(crash.status, 500);
    const text = await crash.text();
    assert.ok(!text.includes('SECRET'));
    assert.ok(!text.toLowerCase().includes('stack'));
    const cb = JSON.parse(text);
    assert.equal(cb.type, 'urn:motionex:problem:internal');
    assert.equal(cb.status, 500);
  } finally {
    await s.close();
  }
});

test('router: readJson body handling', async () => {
  const s = await serve((r) => {
    r.add('POST', '/echo', (_req, _res, ctx) => ctx.readJson(1000));
    r.add('POST', '/small', (_req, _res, ctx) => ctx.readJson(10));
    r.add('POST', '/multi', (_req, _res, ctx) => ctx.readJson(1000));
  });
  try {
    const form = await fetch(`${s.base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '{"a":1}',
    });
    assert.equal(form.status, 200);
    assert.deepEqual(await form.json(), { a: 1 });

    const empty = await fetch(`${s.base}/echo`, { method: 'POST' });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), {});

    const bad = await fetch(`${s.base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).type, 'urn:motionex:problem:malformed-json');

    const big = await fetch(`${s.base}/small`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(100) }),
    });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).type, 'urn:motionex:problem:payload-too-large');

    const multi = await fetch(`${s.base}/multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=xyz' },
      body: '--xyz--',
    });
    assert.equal(multi.status, 415);
    assert.equal((await multi.json()).type, 'urn:motionex:problem:unsupported-media-type');
  } finally {
    await s.close();
  }
});

test('router: streamFile full, range, etag and head', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mx-router-'));
  const file = path.join(dir, 'data.bin');
  const bytes = Buffer.alloc(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await writeFile(file, bytes);
  const s = await serve((r) => {
    r.add('GET', '/file', (req, res) => streamFile(req, res, file));
    r.add('GET', '/missing', (req, res) => streamFile(req, res, path.join(dir, 'nope.bin')));
    r.add('GET', '/range', (req, res) => streamFile(req, res, file, { mediaType: 'application/octet-stream' }));
  });
  try {
    const full = await fetch(`${s.base}/file`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), '1000');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.ok(full.headers.get('etag'));
    const fullBuf = Buffer.from(await full.arrayBuffer());
    assert.equal(fullBuf.length, 1000);
    assert.ok(fullBuf.equals(bytes));

    const mid = await fetch(`${s.base}/file`, { headers: { Range: 'bytes=10-19' } });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal((await mid.arrayBuffer()).byteLength, 10);

    const tail = await fetch(`${s.base}/file`, { headers: { Range: 'bytes=-5' } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), 'bytes 995-999/1000');
    assert.ok(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(995)));

    const openEnded = await fetch(`${s.base}/file`, { headers: { Range: 'bytes=990-' } });
    assert.equal(openEnded.status, 206);
    assert.equal((await openEnded.arrayBuffer()).byteLength, 10);

    const bad = await fetch(`${s.base}/file`, { headers: { Range: 'bytes=2000-' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */1000');

    const multi = await fetch(`${s.base}/file`, { headers: { Range: 'bytes=0-1,5-6' } });
    assert.equal(multi.status, 200);

    const etag = full.headers.get('etag');
    const cached = await fetch(`${s.base}/file`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);

    const head = await fetch(`${s.base}/file`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '1000');
    assert.equal(await head.text(), '');

    const missing = await fetch(`${s.base}/missing`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).type, 'urn:motionex:problem:file-not-found');
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});
