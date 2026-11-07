// The HTTP service, end to end: the real serve() on port 0 with a temp workspace, driven with fetch.
// Covers health, the index, capabilities, the tool catalogue, the Origin/Host/token guards, request ids and
// restart recovery. The POST /v1/jobs test needs src/server/routes/jobs.mjs (another piece) and skips without it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { createApp } from '../../src/server/app.mjs';
import { serve } from '../../src/server/main.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JOBS_ROUTES = path.join(ROOT, 'src', 'server', 'routes', 'jobs.mjs');
const HAS_JOBS = existsSync(JOBS_ROUTES);
const FIXTURE_TOOLS = path.join(ROOT, 'test', 'fixtures', 'tools');

/**
 * Config for a throwaway service: temp workspace, ephemeral port, any Host/Origin, the fixture tools mounted
 * next to the builtin ones, no extensions folder and no request logging.
 * @param {string} ws
 * @param {Record<string, string>} [extra]
 */
function configFor(ws, extra = {}) {
  return loadConfig({
    ...process.env,
    MX_WORKSPACE: ws,
    MX_PORT: '0',
    MX_ALLOWED_HOSTS: '*',
    MX_ALLOWED_ORIGINS: '',
    MX_TOOLS_DIRS: FIXTURE_TOOLS,
    MX_EXTENSIONS_DIR: '',
    MX_LOG_LEVEL: 'silent',
    ...extra,
  });
}

/**
 * A raw HTTP GET, for headers fetch refuses to let us set (Host) and for exact control over the request line.
 * @param {{port: number, path?: string, headers?: Record<string, string>}} opts
 * @returns {Promise<{status: number, body: string}>}
 */
function rawGet({ port, path: reqPath = '/', headers = {} }) {
  // HTTP/1.1 needs a Host header; Node answers 400 before our handler runs when it is missing.
  const sent = { Host: '127.0.0.1', ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers: sent, setHost: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Start the real service on a fresh temp workspace, hand `fn` the base URL and the serve() result, then close
 * everything and delete the workspace.
 * @param {(ctx: {base: string, ws: string, srv: any}) => Promise<void>} fn
 * @param {Record<string, string>} [env] extra MX_* env for loadConfig
 */
async function withServer(fn, env = {}) {
  const ws = await mkTmp();
  const srv = await serve(configFor(ws, env));
  try {
    await fn({ base: `http://127.0.0.1:${srv.port}`, ws, srv });
  } finally {
    await srv.close();
    await rmTmp(ws);
  }
}

test('health, index and capabilities describe the service', async () => {
  await withServer(async ({ base, srv, ws }) => {
    const live = await fetch(`${base}/livez`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true });

    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true });

    const index = await fetch(`${base}/v1`);
    assert.equal(index.status, 200);
    const body = await index.json();
    assert.equal(body.name, 'motionex');
    assert.equal(body.workspace, ws);
    for (const key of ['tools', 'jobs', 'files', 'pins', 'capabilities', 'skill', 'listen']) {
      assert.equal(typeof body.links[key], 'string', `links.${key}`);
    }

    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/v1');

    const caps = await fetch(`${base}/v1/capabilities`);
    assert.equal(caps.status, 200);
    const c = await caps.json();
    assert.equal(typeof c.version, 'string');
    assert.equal(typeof c.ffmpeg.version, 'string');
    assert.equal(typeof c.ffmpeg.major, 'number');
    assert.ok(Array.isArray(c.voices), 'voices is an array');
    assert.ok(c.presets && Array.isArray(c.presets.encode), 'preset kinds are listed');
    assert.equal(c.limits.cpu_slots, srv.deps.config.cpuSlots);
    assert.equal(typeof c.python.available, 'boolean');
  });
});

test('the tool catalogue lists fixtures and builtin tools, briefly or in full', async () => {
  await withServer(async ({ base }) => {
    const all = await fetch(`${base}/v1/tools`);
    assert.equal(all.status, 200);
    const { tools } = await all.json();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('fake.echo'), 'fake.echo is listed');
    assert.ok(names.includes('audio.loudness'), 'audio.loudness is listed');
    const echo = tools.find((t) => t.name === 'fake.echo');
    assert.ok(echo.input_schema, 'the full listing carries input_schema');

    const briefRes = await fetch(`${base}/v1/tools?brief=1&invalid=1`);
    assert.equal(briefRes.status, 200);
    const briefBody = await briefRes.json();
    assert.ok(briefBody.tools.length > 0);
    for (const tool of briefBody.tools) {
      assert.equal(tool.input_schema, undefined, `${tool.name} has no input_schema when brief`);
      assert.equal(tool.output_schema, undefined);
      assert.equal(tool.examples, undefined);
      assert.equal(tool.description, undefined);
      assert.equal(typeof tool.available, 'boolean');
    }
    assert.ok(Array.isArray(briefBody.invalid), 'invalid=1 adds the invalid-tool list');

    const one = await fetch(`${base}/v1/tools/fake.echo`);
    assert.equal(one.status, 200);
    assert.equal((await one.json()).name, 'fake.echo');

    const missing = await fetch(`${base}/v1/tools/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).type, 'urn:motionex:problem:unknown-tool');

    const unknownPath = await fetch(`${base}/v1/nothing-here`);
    assert.equal(unknownPath.status, 404);
    assert.equal((await unknownPath.json()).type, 'urn:motionex:problem:not-found');
  });
});

test('POST /v1/jobs runs a job through the real executor', {
  skip: HAS_JOBS ? false : 'routes/jobs.mjs is not in this worktree',
}, async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/v1/jobs?wait=30`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'fake.echo', input: { message: 'hi' } }),
    });
    assert.equal(res.status, 200);
    const job = await res.json();
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.message, 'hi');
    assert.ok(
      job.outputs.some((o) => o.name === 'echo.json'),
      `outputs include echo.json (got ${JSON.stringify(job.outputs.map((o) => o.name))})`,
    );
  });
});

test('a foreign Origin is refused before the body is read, and no job is created', async () => {
  await withServer(async ({ base, srv }) => {
    const before = srv.deps.store.list({ limit: 1000 }).jobs.length;

    const get = await fetch(`${base}/v1/tools`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(get.status, 403);
    assert.equal((await get.json()).type, 'urn:motionex:problem:origin-not-allowed');

    const post = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'fake.echo', input: { message: 'evil' } }),
    });
    assert.equal(post.status, 403);
    assert.equal((await post.json()).type, 'urn:motionex:problem:origin-not-allowed');

    const after = srv.deps.store.list({ limit: 1000 }).jobs.length;
    assert.equal(after, before, 'no job was created');
    assert.equal(srv.deps.scheduler.stats().queued.length, 0, 'nothing was queued');
  });
});

test('a Host that is not allowed is refused (DNS rebinding guard)', async () => {
  const ws = await mkTmp();
  const inner = await serve(configFor(ws));
  // Rebuild the pipeline with a strict Host list, over the same parts.
  const strictConfig = { ...inner.deps.config, allowedHosts: ['good:1'] };
  const handler = await createApp({ ...inner.deps, config: strictConfig });
  const strict = http.createServer(handler);
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const { port } = strict.address();
  try {
    const denied = await rawGet({ port, path: '/v1', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).type, 'urn:motionex:problem:host-not-allowed');

    const ok = await rawGet({ port, path: '/v1', headers: { Host: 'good:1' } });
    assert.equal(ok.status, 200);

    // health probes are exempt (Docker's HEALTHCHECK calls them from inside with Host 127.0.0.1:<MX_PORT>)
    const health = await rawGet({ port, path: '/livez', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
  } finally {
    strict.closeAllConnections?.();
    await new Promise((resolve) => strict.close(resolve));
    await inner.close();
    await rmTmp(ws);
  }
});

test('a token file gates everything but /livez', async () => {
  const ws = await mkTmp();
  const tokenFile = path.join(ws, 'api-token');
  writeFileSync(tokenFile, ' sesame-123 \n', 'utf8');
  try {
    await withServer(
      async ({ base }) => {
        const noHeader = await fetch(`${base}/v1/tools`);
        assert.equal(noHeader.status, 401);
        assert.equal((await noHeader.json()).type, 'urn:motionex:problem:unauthenticated');

        const wrong = await fetch(`${base}/v1/tools`, { headers: { Authorization: 'Bearer nope' } });
        assert.equal(wrong.status, 401);

        const right = await fetch(`${base}/v1/tools`, { headers: { Authorization: 'Bearer sesame-123' } });
        assert.equal(right.status, 200);
        assert.ok(Array.isArray((await right.json()).tools));

        const live = await fetch(`${base}/livez`);
        assert.equal(live.status, 200);

        const ready = await fetch(`${base}/readyz`);
        assert.equal(ready.status, 200);

        const root = await fetch(`${base}/v1`, { headers: { Authorization: 'Bearer sesame-123' } });
        assert.equal(root.status, 200);
      },
      { MX_API_TOKEN_FILE: tokenFile },
    );
  } finally {
    await rmTmp(ws);
  }
});

test('x-request-id is echoed when valid and replaced when not', async () => {
  await withServer(async ({ base }) => {
    const good = 'ctx-1234.abc_DEF';
    const echoed = await fetch(`${base}/livez`, { headers: { 'x-request-id': good } });
    assert.equal(echoed.headers.get('x-request-id'), good);

    const bad = 'bad id with spaces';
    const replaced = await fetch(`${base}/livez`, { headers: { 'x-request-id': bad } });
    const id = replaced.headers.get('x-request-id');
    assert.ok(id, 'a request id is always returned');
    assert.notEqual(id, bad);
    assert.match(id, /^[A-Za-z0-9._-]{1,64}$/);

    const fresh = await fetch(`${base}/livez`);
    assert.match(fresh.headers.get('x-request-id'), /^[A-Za-z0-9._-]{1,64}$/);

    // A 404 problem body carries the same id.
    const missing = await fetch(`${base}/nope`, { headers: { 'x-request-id': good } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).request_id, good);
  });
});

test('one JSON log line per request, and /readyz reports 503 with reasons before startup finishes', async () => {
  const ws = await mkTmp();
  const inner = await serve(configFor(ws));
  const lines = [];
  // A second pipeline over the same parts: still starting up, and logging to a collector instead of stdout.
  const handler = await createApp({
    ...inner.deps,
    config: { ...inner.deps.config, logLevel: 'info' },
    ready: () => ({ ready: false, reasons: ['the registry is still loading'] }),
    log: (line) => lines.push(line),
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const notReady = await rawGet({ port, path: '/readyz' });
    assert.equal(notReady.status, 503);
    assert.deepEqual(JSON.parse(notReady.body), { ready: false, reasons: ['the registry is still loading'] });

    const ok = await rawGet({ port, path: '/v1/tools?brief=1' });
    assert.equal(ok.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 50)); // finish events are emitted after the response
    assert.equal(lines.length, 2, `one line per request (got ${JSON.stringify(lines)})`);
    for (const line of lines) {
      assert.equal(line.level, 'info');
      assert.equal(typeof line.ts, 'string');
      assert.equal(line.method, 'GET');
      assert.equal(typeof line.request_id, 'string');
      assert.equal(typeof line.status, 'number');
      assert.equal(typeof line.ms, 'number');
      assert.ok(!('headers' in line) && !('body' in line), 'bodies and headers are never logged');
    }
    assert.deepEqual(
      lines.map((l) => [l.path, l.status]),
      [
        ['/readyz', 503],
        ['/v1/tools', 200], // no query string in the log
      ],
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await inner.close();
    await rmTmp(ws);
  }
});

test('a job left "running" by a crash comes back as failed/interrupted', async () => {
  // Submitted through the service itself, so this recovery test does not depend on routes/jobs.mjs.
  const ws = await mkTmp();
  const first = await serve(configFor(ws));
  let jobId;
  try {
    const { job } = await first.deps.service.submit({ tool: 'fake.sleep', input: { seconds: 30 } });
    jobId = job.id;
    // Give the job a moment to be picked up, then shut the service down: drain() cancels it.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await first.close();
  }

  try {
    const jobFile = path.join(ws, '.mx', 'jobs', jobId, 'job.json');
    assert.ok(existsSync(jobFile), 'the job record exists');
    // Simulate a crash while the job was running: the process died before writing a terminal status.
    const record = JSON.parse(readFileSync(jobFile, 'utf8'));
    record.status = 'running';
    record.finished_at = null;
    record.error = null;
    writeFileSync(jobFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    const second = await serve(configFor(ws));
    try {
      const recovered = second.deps.store.get(jobId);
      assert.equal(recovered.status, 'failed');
      assert.equal(recovered.error.type, 'interrupted');
      const live = await fetch(`http://127.0.0.1:${second.port}/readyz`);
      assert.equal(live.status, 200);
    } finally {
      await second.close();
    }
  } finally {
    await rmTmp(ws);
  }
});

test(
  'contracts: listed with their providers, and a voice.speak job runs as the provider tool',
  needs('python', 'piper-voice'),
  async () => {
    await withServer(async ({ base }) => {
      const index = await (await fetch(`${base}/v1`)).json();
      assert.equal(index.links.contracts, '/v1/contracts');

      const list = await (await fetch(`${base}/v1/contracts?brief=1`)).json();
      const speak = list.contracts.find((c) => c.name === 'voice.speak');
      assert.ok(speak, 'voice.speak is listed');
      assert.equal(speak.input_schema, undefined, 'brief drops the schemas');
      assert.deepEqual(
        speak.providers.map((p) => p.provider),
        ['elevenlabs', 'piper'],
      );
      const one = await (await fetch(`${base}/v1/contracts/voice.list`)).json();
      assert.equal(one.input_schema.properties.provider.type, 'string');
      assert.equal((await fetch(`${base}/v1/contracts/nope.nope`)).status, 404);

      const caps = await (await fetch(`${base}/v1/capabilities`)).json();
      assert.ok(caps.contracts['voice.speak'].some((p) => p.provider === 'piper' && p.available));

      const post = (body) =>
        fetch(`${base}/v1/jobs?wait=60`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      const res = await post({
        tool: 'voice.speak',
        input: { provider: 'piper', voice: 'en_US-john-medium', lines: [{ text: 'Hello.', name: 'hi' }], speed: 1.1 },
      });
      assert.equal(res.status, 200);
      const job = await res.json();
      assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
      assert.equal(job.tool, 'voice.piper');
      assert.equal(job.contract, 'voice.speak');
      assert.equal(job.provider, 'piper');
      assert.equal(job.result.lines[0].file, 'hi.wav');
      assert.ok(job.outputs.some((o) => o.name === 'hi.wav'));

      const voices = await (await post({ tool: 'voice.list', input: { provider: 'piper', search: 'john' } })).json();
      assert.equal(voices.status, 'succeeded', JSON.stringify(voices.error));
      assert.deepEqual(
        voices.result.voices.map((v) => v.id),
        ['en_US-john-medium'],
      );

      const bad = await post({ tool: 'voice.speak', input: { provider: 'nobody', voice: 'x', lines: ['hi'] } });
      assert.equal(bad.status, 422);
      const problem = await bad.json();
      assert.match(problem.detail, /no provider "nobody" \(providers: elevenlabs, piper\)/);
    });
  },
);
