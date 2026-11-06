// The mx CLI against a stub service (no real server, no network): argument handling, exit codes,
// the job wait loop, and file transfer. Every test runs bin/mx.mjs as a child process, like an agent would.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'mx.mjs');

/** @type {{jobs: Map<string, any>, posts: {body: any, key: string|undefined, wait: string|null}[], files: Map<string, Buffer>, seq: number}} */
const state = { jobs: new Map(), posts: [], files: new Map(), seq: 0 };
const tools = [
  {
    name: 'fake.echo',
    title: 'fake.echo',
    summary: 'Test tool: returns its message.',
    available: true,
    unavailable_reason: null,
    input_schema: { type: 'object', additionalProperties: false },
    examples: [],
  },
  {
    name: 'fake.fail',
    title: 'fake.fail',
    summary: 'Test tool: fails in a chosen way.',
    available: true,
    unavailable_reason: null,
    input_schema: { type: 'object', additionalProperties: false },
    examples: [],
  },
];

let server;
let base;
let workspace;
let closedPort;

function problem(res, status, code, title, detail) {
  const body = JSON.stringify({ type: `urn:motionex:problem:${code}`, title, status, detail });
  res.writeHead(status, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function publicJob(job) {
  const { gets, ...rest } = job;
  return rest;
}

/** Flip a queued job to its terminal state. */
function finish(job) {
  if (job.status !== 'queued' && job.status !== 'running') return;
  if (job.tool === 'fake.fail') {
    job.status = 'failed';
    job.error = {
      type: 'invalid-input',
      title: 'The input is not valid for this tool',
      detail: 'mode "throw" is not allowed',
      retryable: false,
    };
    return;
  }
  job.status = 'succeeded';
  job.result = { message: job.input?.message ?? null };
  job.outputs = [
    {
      name: 'echo.json',
      ref: `job:${job.id}/echo.json`,
      path: `.mx/jobs/${job.id}/out/echo.json`,
      bytes: 13,
      sha256: createHash('sha256').update(job.id).digest('hex'),
      media_type: 'application/json',
    },
  ];
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/readyz') return json(res, 200, { ok: true });

  if (method === 'GET' && url.pathname === '/v1/tools') return json(res, 200, { tools });

  const toolMatch = /^\/v1\/tools\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && toolMatch) {
    const name = decodeURIComponent(toolMatch[1]);
    const tool = tools.find((t) => t.name === name);
    return tool ? json(res, 200, tool) : problem(res, 404, 'unknown-tool', 'No tool by that name', name);
  }

  if (method === 'POST' && url.pathname === '/v1/jobs') {
    const text = (await readRequestBody(req)).toString('utf8');
    const body = JSON.parse(text);
    state.posts.push({ body, key: req.headers['idempotency-key'], wait: url.searchParams.get('wait') });
    const id = `job_test${++state.seq}`;
    const job = {
      id,
      tool: body.tool,
      status: 'queued',
      input: body.input,
      progress: { fraction: null, message: null },
      result: null,
      outputs: [],
      error: null,
      gets: 0,
    };
    state.jobs.set(id, job);
    return json(res, 202, publicJob(job));
  }

  const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && jobMatch) {
    const job = state.jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) return problem(res, 404, 'not-found', 'Not found', 'no such job');
    job.gets += 1;
    await sleep(5); // a long-poll would hold here
    if (job.gets >= 2) finish(job);
    return json(res, 200, publicJob(job));
  }

  const outputMatch = /^\/v1\/jobs\/([^/]+)\/outputs\/(.+)$/.exec(url.pathname);
  if (method === 'GET' && outputMatch) {
    const job = state.jobs.get(decodeURIComponent(outputMatch[1]));
    if (!job) return problem(res, 404, 'not-found', 'Not found', 'no such job');
    const name = decodeURIComponent(outputMatch[2]);
    const bytes = Buffer.from(JSON.stringify({ job: job.id, name }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    return res.end(bytes);
  }

  const fileMatch = /^\/v1\/files\/(.+)$/.exec(url.pathname);
  if (fileMatch) {
    const name = fileMatch[1]
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
    if (method === 'PUT') {
      const body = await readRequestBody(req);
      state.files.set(name, body);
      return json(res, 201, {
        path: name,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
    if (method === 'GET') {
      const body = state.files.get(name);
      if (!body) return problem(res, 404, 'file-not-found', 'File not found', name);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      return res.end(body);
    }
  }

  return problem(res, 404, 'not-found', 'Not found', `${method} ${url.pathname}`);
}

before(async () => {
  // Grab a port that is guaranteed to be closed (a connection-refused stub).
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  server = createServer((req, res) => {
    handle(req, res).catch((e) => problem(res, 500, 'internal', 'Internal error', e.message));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  workspace = await mkTmp('mx-cli-');
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (workspace) await rmTmp(workspace);
});

/**
 * Run the CLI against the stub. Async on purpose: the stub server lives in this process, so the
 * event loop must stay free while the child runs (spawnSync would deadlock both).
 * @param {string[]} args
 * @param {{env?: Record<string, string>, cwd?: string}} [opts]
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, signal: string|null}>}
 */
function cli(args, opts = {}) {
  const env = { ...process.env, MX_URL: base, ...opts.env };
  delete env.MX_API_TOKEN_FILE;
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 60000);
  return new Promise((resolve) => {
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr, signal });
    });
  });
}

/** Write a JSON input file inside the temp workspace. */
async function inputFile(name, value) {
  const file = path.join(workspace, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

test('healthcheck exits 0 against a ready service, printing nothing', async () => {
  const r = await cli(['healthcheck']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('healthcheck exits 1 (not 69) when the service is unreachable', async () => {
  const r = await cli(['healthcheck'], { env: { MX_URL: `http://127.0.0.1:${closedPort}` } });
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
});

test('run --wait sends the input file and a generated idempotency key', async () => {
  const input = await inputFile('echo.json', { message: 'hi' });
  const r = await cli(['run', 'fake.echo', input, '--wait']);
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /^succeeded job_test\d+ fake\.echo$/m);
  assert.match(r.stdout, /job:job_test\d+\/echo\.json/);

  const post = state.posts.at(-1);
  assert.equal(post.body.tool, 'fake.echo');
  assert.deepEqual(post.body.input, { message: 'hi' });
  assert.equal(typeof post.key, 'string');
  assert.ok(post.key.length > 0, 'the CLI must send an Idempotency-Key');
  assert.equal(post.wait, '300', '--wait without a number waits 300 s');
});

test('run --key sends the given idempotency key', async () => {
  const input = await inputFile('echo-key.json', { message: 'keyed' });
  const r = await cli(['run', 'fake.echo', input, '--wait', '--key', 'abc']);
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(state.posts.at(-1).key, 'abc');
});

test('run --wait exits 1 and prints the error type for a failed job', async () => {
  const input = await inputFile('fail.json', { mode: 'throw' });
  const r = await cli(['run', 'fake.fail', input, '--wait=10']);
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /^failed job_test\d+ fake\.fail$/m);
  assert.match(r.stdout, /invalid-input/);
});

test('run without --wait exits 3 for a queued job', async () => {
  const input = await inputFile('nowait.json', { message: 'quick' });
  const r = await cli(['run', 'fake.echo', input]);
  assert.equal(r.status, 3, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /^queued job_test\d+ fake\.echo$/m);
  assert.equal(state.posts.at(-1).wait, null);
});

test('run with a malformed JSON input exits 64 with a message', async () => {
  const file = path.join(workspace, 'broken.json');
  await writeFile(file, '{ "message": ');
  const r = await cli(['run', 'fake.echo', file, '--wait']);
  assert.equal(r.status, 64, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /not valid JSON/);
});

test('tools prints the tool names', async () => {
  const r = await cli(['tools']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^fake\.echo {2}available {2}/m);
  assert.match(r.stdout, /^fake\.fail {2}available {2}/m);
});

test('tools <name> --json prints the tool JSON', async () => {
  const r = await cli(['tools', 'fake.echo', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.name, 'fake.echo');
});

test('validate-tools accepts the fixtures folder and reports fake.echo', async () => {
  const r = await cli(['validate-tools', 'test/fixtures/tools']);
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /^OK fake\.echo/m);
});

test('validate-tools exits 1 for a folder with a broken tool.json', async () => {
  const dir = await mkTmp('mx-cli-bad-');
  try {
    await mkdir(path.join(dir, 'broken.tool'), { recursive: true });
    await writeFile(path.join(dir, 'broken.tool', 'tool.json'), '{ "name": ');
    const r = await cli(['validate-tools', dir]);
    assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /INVALID/);
  } finally {
    await rmTmp(dir);
  }
});

test('put then get round-trips bytes through encoded path segments', async () => {
  const local = path.join(workspace, 'source wav.wav');
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
  await writeFile(local, bytes);

  const put = await cli(['put', local, 'media/a b.wav']);
  assert.equal(put.status, 0, `stdout=${put.stdout} stderr=${put.stderr}`);
  assert.match(put.stdout, /media\/a b\.wav {2}6 {2}/);

  const target = path.join(workspace, 'nested', 'out.wav');
  const got = await cli(['get', 'media/a b.wav', target]);
  assert.equal(got.status, 0, `stdout=${got.stdout} stderr=${got.stderr}`);
  assert.deepEqual(await readFile(target), bytes);
});

test('get accepts a job output ref', async () => {
  const input = await inputFile('echo-get.json', { message: 'ref' });
  const run = await cli(['run', 'fake.echo', input, '--wait']);
  assert.equal(run.status, 0, run.stderr);
  const jobId = /job_test\d+/.exec(run.stdout)?.[0];
  assert.ok(jobId, 'the run printed a job id');

  const target = path.join(workspace, 'echo.json');
  const r = await cli(['get', `job:${jobId}/echo.json`, target]);
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { job: jobId, name: 'echo.json' });
});

test('an unknown command exits 64 and prints the usage', async () => {
  const r = await cli(['nosuchcommand']);
  assert.equal(r.status, 64, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unknown command/);
  assert.match(r.stderr, /Usage: mx <command>/);
});
