#!/usr/bin/env node
// mx: the motionex command-line client. A thin HTTP client of the service (bin/mx.mjs),
// plus two offline commands (validate-tools) and one that starts the service in-process (serve).
// Node built-ins only; uses the global fetch.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mediaTypeOf } from '../src/lib/media-types.mjs';

/** Exit codes (sysexits where there is a fit). */
const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  canceled: 2,
  pending: 3,
  usage: 64,
  unreachable: 69,
});

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const CACHE_MODES = new Set(['auto', 'reuse', 'off']);
const MAX_WAIT_S = 300;

const USAGE = `mx: the motionex command-line client

Usage: mx <command> [options]

Commands:
  serve                                   start the motionex HTTP service
  healthcheck                             exit 0 when the service is ready (GET /readyz)
  tools [name] [--json]                   list tools, or show the full JSON of one tool
  run <tool> <input.json|-> [options]     create a job (input from a file or stdin)
  job <id> [--wait[=s]] [--json]          show one job
  jobs [--status S] [--tool T] [--limit N] [--json]
                                          list jobs
  cancel <id>                             cancel a job
  events <id> [--follow] [--after N] [--json]
                                          print a job's events (--follow long-polls until terminal)
  put <local-file> <workspace-path>       upload a file into the workspace
  get <ref> <local-file>                  download a file (path | job:<id>/<out> | pin:<name>[#out])
  pin <name> <ref> [--note N]             pin a job, job output or file
  unpin <name>                            remove a pin
  pins [name] [--history] [--json]        list pins, or show one pin
  skill install <dir>                     install the agent skill into <dir>/motionex
  validate-tools [dir...]                 offline: validate tool manifests in the given folders
  help                                    this text

run/job options:
  --wait[=s]        wait for the job to finish (default ${MAX_WAIT_S} s; the job is polled until it is terminal)
  --label L         a human label for the job (run)
  --project P       a project name for the job (run)
  --cache MODE      auto | reuse | off (run)
  --timeout S       job timeout in seconds (run)
  --key K           Idempotency-Key (run; default: a random UUID)
  --json            print the job as JSON

Environment:
  MX_URL            service base URL (default http://127.0.0.1:\${MX_PORT:-8095})
  MX_PORT           port used when MX_URL is not set (default 8095)
  MX_API_TOKEN_FILE file holding the API token; sent as "Authorization: Bearer <token>"

Exit codes: 0 succeeded, 1 failed or HTTP problem, 2 canceled, 3 queued/running,
            64 usage error, 69 service unreachable (healthcheck always exits 1 on failure)
`;

/** A usage error: printed with the usage text, exit code 64. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The service could not be reached at all (connection refused, DNS, timeout). */
class UnreachableError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UnreachableError';
    this.code = code;
  }
}

/** An HTTP response with a non-2xx status (application/problem+json, or anything else). */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} statusText
   * @param {any} body parsed JSON body, or null
   * @param {string} raw raw response text
   */
  constructor(status, statusText, body, raw) {
    const title = typeof body?.title === 'string' ? body.title : statusText || 'HTTP error';
    const detail = typeof body?.detail === 'string' ? body.detail : raw.trim().slice(0, 500);
    super(detail || title);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.title = title;
    this.detail = detail;
    this.body = body;
  }

  /** @returns {string[]} lines to print to stderr */
  lines() {
    const out = [`${this.status} ${this.title}: ${this.detail}`];
    const errors = Array.isArray(this.body?.errors) ? this.body.errors : [];
    for (const e of errors) {
      if (!e || typeof e !== 'object') continue;
      out.push(`  ${e.field ? `${e.field} ` : ''}${e.message ?? JSON.stringify(e)}`);
    }
    if (this.status === 401) out.push('  hint: set MX_API_TOKEN_FILE to a file holding the API token');
    return out;
  }
}

// --------------------------------------------------------------------------------------------- paths & args

/** Encode every path segment, keeping the "/" separators. */
function encodePath(p) {
  return String(p)
    .replace(/^\/+/, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** Service base URL, without a trailing slash. */
function baseUrl() {
  const url = process.env.MX_URL?.trim();
  if (url) return url.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.MX_PORT || 8095}`;
}

/** The Authorization header value, or null when no token file is configured. */
async function authHeader() {
  const file = process.env.MX_API_TOKEN_FILE;
  if (!file) return null;
  let token;
  try {
    token = (await readFile(file, 'utf8')).trim();
  } catch (e) {
    throw new UsageError(`cannot read MX_API_TOKEN_FILE (${file}): ${e.message}`);
  }
  return token ? `Bearer ${token}` : null;
}

/**
 * Parse "--flag", "--flag=value" and "--flag value" style options.
 * @param {string[]} argv
 * @param {Record<string, 'flag'|'value'|'optional'>} spec
 * @returns {{_: string[], [k: string]: any}}
 */
function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option "--${name}"`);
    if (kind === 'flag') {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      out[name] = true;
    } else if (kind === 'value') {
      if (eq >= 0) {
        out[name] = arg.slice(eq + 1);
      } else {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        out[name] = value;
      }
    } else if (eq >= 0) {
      out[name] = arg.slice(eq + 1) === '' ? true : arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      out[name] = argv[++i];
    } else {
      out[name] = true;
    }
  }
  return out;
}

/**
 * A --wait style value: true means the default, otherwise a number of seconds.
 * @param {true|string|undefined|null} value
 * @param {string} what
 * @returns {number|null} null when the option was not given
 */
function secondsOf(value, what = '--wait') {
  if (value === undefined) return null;
  if (value === true) return MAX_WAIT_S;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${what} needs a number of seconds (got "${value}")`);
  return n;
}

/** @returns {number} a non-negative integer option */
function intOf(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${what} needs a non-negative whole number`);
  return n;
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

/** Exit code for a job status. */
function exitForStatus(status) {
  if (status === 'succeeded') return EXIT.ok;
  if (status === 'failed') return EXIT.failed;
  if (status === 'canceled') return EXIT.canceled;
  return EXIT.pending;
}

function out(text = '') {
  process.stdout.write(`${text}\n`);
}

function err(text = '') {
  process.stderr.write(`${text}\n`);
}

// --------------------------------------------------------------------------------------------- HTTP

/** Find a Node/undici network error code anywhere in the cause chain. */
function networkCode(error) {
  const seen = new Set();
  let found = null;
  const walk = (e) => {
    if (found || !e || typeof e !== 'object' || seen.has(e)) return;
    seen.add(e);
    if (typeof e.code === 'string' && /^(E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/.test(e.code)) found = e.code;
    if (Array.isArray(e.errors)) for (const inner of e.errors) walk(inner);
    if (e.cause) walk(e.cause);
  };
  walk(error);
  return found;
}

/**
 * One HTTP request. Returns the raw Response (2xx or not); throws UnreachableError when the
 * service cannot be reached at all.
 * @param {string} method
 * @param {string} pathAndQuery
 * @param {{body?: string|Uint8Array, headers?: Record<string, string>, timeoutMs?: number}} [opts]
 */
async function request(method, pathAndQuery, opts = {}) {
  const url = `${baseUrl()}${pathAndQuery}`;
  const headers = { accept: 'application/json, application/problem+json', ...opts.headers };
  const token = await authHeader();
  if (token) headers.authorization = token;
  try {
    return await fetch(url, {
      method,
      headers,
      body: opts.body,
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
  } catch (e) {
    const code = networkCode(e);
    if (code) throw new UnreachableError(`cannot reach the motionex service at ${baseUrl()} (${code})`, code);
    if (e?.name === 'TimeoutError') throw new UnreachableError(`request to ${url} timed out`, 'ETIMEDOUT');
    if (e?.name === 'AbortError') throw new UnreachableError(`request to ${url} was aborted`, 'EABORTED');
    throw e;
  }
}

/** Parse a response body as JSON; returns null for an empty or non-JSON body. */
async function parseBody(res) {
  const text = await res.text();
  if (!text) return { body: null, raw: '' };
  try {
    return { body: JSON.parse(text), raw: text };
  } catch {
    return { body: null, raw: text };
  }
}

function toHttpError(res, parsed) {
  return new HttpError(res.status, res.statusText, parsed.body, parsed.raw);
}

/** Request expecting a JSON body; throws HttpError for a non-2xx status. */
async function apiJson(method, pathAndQuery, opts = {}) {
  const res = await request(method, pathAndQuery, opts);
  const parsed = await parseBody(res);
  if (!res.ok) throw toHttpError(res, parsed);
  return parsed.body;
}

/** Request expecting bytes; throws HttpError for a non-2xx status. */
async function apiBytes(method, pathAndQuery, opts = {}) {
  const res = await request(method, pathAndQuery, opts);
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  const parsed = await parseBody(res);
  throw toHttpError(res, parsed);
}

// --------------------------------------------------------------------------------------------- jobs

/** GET one job, optionally long-polling for up to `wait` seconds. */
async function getJob(id, wait) {
  const query = wait && wait > 0 ? `?wait=${Math.min(Math.ceil(wait), MAX_WAIT_S)}` : '';
  return apiJson('GET', `/v1/jobs/${encodeURIComponent(id)}${query}`);
}

/**
 * Poll a job until it is terminal or the wait budget is used up.
 * @param {any} job
 * @param {number} seconds
 */
async function pollJob(job, seconds) {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  let current = job;
  while (!isTerminal(current?.status)) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) break;
    const started = Date.now();
    current = await getJob(current.id, remaining);
    const elapsed = Date.now() - started;
    // A server that answers immediately (an empty long-poll) must not turn this into a busy loop.
    if (!isTerminal(current.status) && elapsed < 250) await sleep(250 - elapsed);
  }
  return current;
}

/** Print a job: a short summary, or its JSON. */
function printJob(job, json) {
  if (json) {
    out(JSON.stringify(job));
    return;
  }
  out(`${job.status} ${job.id} ${job.tool}`);
  for (const o of job.outputs ?? []) out(`  ${o.ref ?? o.name}  ${o.bytes ?? '?'}`);
  if (job.status === 'failed' && job.error) out(`  ${job.error.type}: ${job.error.detail}`);
}

// --------------------------------------------------------------------------------------------- commands

async function cmdServe() {
  let mod;
  try {
    mod = await import('../src/server/main.mjs');
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      err('mx serve: src/server/main.mjs is not available in this build');
      return EXIT.failed;
    }
    throw e;
  }
  if (typeof mod.serve !== 'function') {
    err('mx serve: src/server/main.mjs does not export serve()');
    return EXIT.failed;
  }
  await mod.serve();
  return EXIT.ok;
}

async function cmdHealthcheck() {
  let token = null;
  try {
    token = await authHeader();
  } catch {
    token = null;
  }
  try {
    const res = await fetch(`${baseUrl()}/readyz`, {
      headers: { accept: 'application/json', ...(token ? { authorization: token } : {}) },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      await res.arrayBuffer().catch(() => {});
      return EXIT.ok;
    }
    const parsed = await parseBody(res);
    err(`not ready (${res.status} ${parsed.body?.title ?? res.statusText})`);
    return EXIT.failed;
  } catch (e) {
    const code = networkCode(e);
    err(`not ready: ${code ?? e?.message ?? 'unreachable'}`);
    return EXIT.failed;
  }
}

async function cmdTools(args) {
  const a = parseArgs(args, { json: 'flag' });
  if (a._.length > 1) throw new UsageError('tools takes at most one tool name');
  const name = a._[0];
  const data = await apiJson('GET', name ? `/v1/tools/${encodeURIComponent(name)}` : '/v1/tools');
  if (name) {
    const tool = data?.tool ?? data;
    out(a.json ? JSON.stringify(tool) : JSON.stringify(tool, null, 2));
    return EXIT.ok;
  }
  if (a.json) {
    out(JSON.stringify(data));
    return EXIT.ok;
  }
  for (const t of data?.tools ?? []) {
    const availability = t.available
      ? 'available'
      : `unavailable${t.unavailable_reason ? ` (${t.unavailable_reason})` : ''}`;
    out(`${t.name}  ${availability}  ${t.summary ?? ''}`);
  }
  return EXIT.ok;
}

/** Read a JSON object from a file or stdin ("-"). */
async function readInputObject(where) {
  let text;
  try {
    text = where === '-' ? readFileSync(0, 'utf8') : await readFile(where, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read input ${where === '-' ? 'from stdin' : `file ${where}`}: ${e.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`input ${where === '-' ? 'from stdin' : where} is not valid JSON: ${e.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError(`input ${where === '-' ? 'from stdin' : where} must be a JSON object`);
  }
  return value;
}

async function cmdRun(args) {
  const a = parseArgs(args, {
    wait: 'optional',
    label: 'value',
    project: 'value',
    cache: 'value',
    timeout: 'value',
    key: 'value',
    note: 'value',
    json: 'flag',
  });
  if (a._.length < 2) throw new UsageError('run needs <tool> and <input.json|->');
  if (a._.length > 2) throw new UsageError('run takes exactly <tool> and <input.json|->');
  const [tool, inputArg] = a._;
  const input = await readInputObject(inputArg);

  const body = { tool, input };
  if (a.label !== undefined) body.label = a.label;
  if (a.project !== undefined) body.project = a.project;
  if (a.note !== undefined) body.note = a.note;
  if (a.cache !== undefined) {
    if (!CACHE_MODES.has(a.cache)) throw new UsageError('--cache must be one of auto, reuse, off');
    body.cache = a.cache;
  }
  if (a.timeout !== undefined) body.timeout_s = intOf(a.timeout, '--timeout');
  const key = a.key !== undefined ? String(a.key) : randomUUID();
  if (!key) throw new UsageError('--key must not be empty');

  const waitS = secondsOf(a.wait);
  const postWait = waitS && waitS > 0 ? `?wait=${Math.min(Math.ceil(waitS), MAX_WAIT_S)}` : '';
  let job = await apiJson('POST', `/v1/jobs${postWait}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
  });
  if (waitS !== null) job = await pollJob(job, waitS);
  printJob(job, a.json);
  return exitForStatus(job.status);
}

async function cmdJob(args) {
  const a = parseArgs(args, { wait: 'optional', json: 'flag' });
  const id = a._[0];
  if (!id) throw new UsageError('job needs a job id');
  if (a._.length > 1) throw new UsageError('job takes exactly one job id');
  const waitS = secondsOf(a.wait);
  let job = await getJob(id);
  if (waitS !== null) job = await pollJob(job, waitS);
  printJob(job, a.json);
  return exitForStatus(job.status);
}

async function cmdJobs(args) {
  const a = parseArgs(args, { status: 'value', tool: 'value', limit: 'value', json: 'flag' });
  if (a._.length) throw new UsageError('jobs takes no positional arguments');
  const query = new URLSearchParams();
  if (a.status !== undefined) query.set('status', a.status);
  if (a.tool !== undefined) query.set('tool', a.tool);
  if (a.limit !== undefined) query.set('limit', String(intOf(a.limit, '--limit')));
  const suffix = query.toString() ? `?${query}` : '';
  const data = await apiJson('GET', `/v1/jobs${suffix}`);
  if (a.json) {
    out(JSON.stringify(data));
    return EXIT.ok;
  }
  for (const j of data?.jobs ?? []) out(`${j.status} ${j.id} ${j.tool}${j.label ? `  ${j.label}` : ''}`);
  return EXIT.ok;
}

async function cmdCancel(args) {
  const a = parseArgs(args, { json: 'flag' });
  const id = a._[0];
  if (!id) throw new UsageError('cancel needs a job id');
  if (a._.length > 1) throw new UsageError('cancel takes exactly one job id');
  const job = await apiJson('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`);
  printJob(job, a.json);
  return EXIT.ok;
}

/** One line for a job event. */
function formatEvent(ev) {
  const bits = [String(ev.seq ?? ''), ev.at ?? '', ev.type ?? ''];
  if (ev.status) bits.push(ev.status);
  if (typeof ev.fraction === 'number') bits.push(`${Math.round(ev.fraction * 100)}%`);
  if (ev.name) bits.push(ev.name);
  if (ev.message) bits.push(ev.message);
  return bits.filter((s) => s !== '').join(' ');
}

async function cmdEvents(args) {
  const a = parseArgs(args, { follow: 'flag', after: 'value', json: 'flag' });
  const id = a._[0];
  if (!id) throw new UsageError('events needs a job id');
  if (a._.length > 1) throw new UsageError('events takes exactly one job id');
  let after = a.after !== undefined ? intOf(a.after, '--after') : 0;
  const jobPath = `/v1/jobs/${encodeURIComponent(id)}`;
  for (;;) {
    const query = new URLSearchParams({ after: String(after), wait: a.follow ? '25' : '0' });
    const data = await apiJson('GET', `${jobPath}/events?${query}`);
    const events = data?.events ?? [];
    let terminal = false;
    for (const ev of events) {
      out(a.json ? JSON.stringify(ev) : formatEvent(ev));
      if (typeof ev.seq === 'number') after = Math.max(after, ev.seq);
      if (ev.status && isTerminal(ev.status)) terminal = true;
    }
    if (!a.follow || terminal) break;
    if (typeof data?.next_after === 'number') after = Math.max(after, data.next_after);
    const job = await getJob(id);
    if (isTerminal(job.status) && events.length === 0) break;
  }
  return EXIT.ok;
}

async function cmdPut(args) {
  const a = parseArgs(args, {});
  if (a._.length < 2) throw new UsageError('put needs <local-file> and <workspace-path>');
  if (a._.length > 2) throw new UsageError('put takes exactly <local-file> and <workspace-path>');
  const [localFile, workspacePath] = a._;
  let bytes;
  try {
    bytes = await readFile(localFile);
  } catch (e) {
    throw new UsageError(`cannot read ${localFile}: ${e.message}`);
  }
  const data = await apiJson('PUT', `/v1/files/${encodePath(workspacePath)}`, {
    body: bytes,
    headers: { 'content-type': mediaTypeOf(workspacePath) },
  });
  out(`${data?.path ?? workspacePath}  ${data?.bytes ?? bytes.length}  ${data?.sha256 ?? ''}`.trimEnd());
  return EXIT.ok;
}

/** Map a get ref to the HTTP path that serves its bytes. */
async function resolveGetPath(ref) {
  if (ref.startsWith('job:')) {
    const rest = ref.slice(4);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) throw new UsageError('a job ref looks like job:<id>/<output-name>');
    const id = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    return `/v1/jobs/${encodeURIComponent(id)}/outputs/${encodePath(name)}`;
  }
  if (ref.startsWith('pin:') || ref.startsWith('file:')) {
    const data = await apiJson('GET', `/v1/refs/resolve?ref=${encodeURIComponent(ref)}`);
    const resolved = data?.path;
    if (typeof resolved !== 'string' || resolved === '') {
      throw new UsageError(`cannot resolve ${ref}: the service returned no path`);
    }
    return `/v1/files/${encodePath(resolved)}`;
  }
  return `/v1/files/${encodePath(ref)}`;
}

async function cmdGet(args) {
  const a = parseArgs(args, {});
  if (a._.length < 2) throw new UsageError('get needs <ref> and <local-file>');
  if (a._.length > 2) throw new UsageError('get takes exactly <ref> and <local-file>');
  const [ref, localFile] = a._;
  const bytes = await apiBytes('GET', await resolveGetPath(ref));
  const target = path.resolve(localFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  out(`${target}  ${bytes.length}`);
  return EXIT.ok;
}

async function cmdPin(args) {
  const a = parseArgs(args, { note: 'value' });
  if (a._.length < 2) throw new UsageError('pin needs <name> and <ref>');
  if (a._.length > 2) throw new UsageError('pin takes exactly <name> and <ref>');
  const [name, ref] = a._;
  const body = { ref };
  if (a.note !== undefined) body.note = a.note;
  const data = await apiJson('PUT', `/v1/pins/${encodeURIComponent(name)}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const pinned = data?.pin ?? data ?? {};
  out(`pinned ${pinned.name ?? name} -> ${pinned.ref ?? ref}`);
  return EXIT.ok;
}

async function cmdUnpin(args) {
  const a = parseArgs(args, {});
  const name = a._[0];
  if (!name) throw new UsageError('unpin needs a pin name');
  if (a._.length > 1) throw new UsageError('unpin takes exactly one pin name');
  await apiJson('DELETE', `/v1/pins/${encodeURIComponent(name)}`);
  out(`unpinned ${name}`);
  return EXIT.ok;
}

async function cmdPins(args) {
  const a = parseArgs(args, { history: 'flag', json: 'flag' });
  if (a._.length > 1) throw new UsageError('pins takes at most one pin name');
  const name = a._[0];
  const query = a.history ? '?history=1' : '';
  const data = await apiJson('GET', name ? `/v1/pins/${encodeURIComponent(name)}${query}` : `/v1/pins${query}`);
  if (a.json) {
    out(JSON.stringify(data));
    return EXIT.ok;
  }
  const pins = name ? [data?.pin ?? data] : (data?.pins ?? []);
  for (const p of pins) {
    if (!p || typeof p !== 'object') continue;
    out(`${p.name ?? name ?? '?'}  ${p.ref ?? ''}${p.note ? `  ${p.note}` : ''}`.trimEnd());
  }
  return EXIT.ok;
}

async function cmdSkill(args) {
  const a = parseArgs(args, {});
  if (a._[0] !== 'install' || a._.length < 2) throw new UsageError('skill needs: skill install <dir>');
  if (a._.length > 2) throw new UsageError('skill install takes exactly one directory');
  const root = path.resolve(a._[1]);
  const meta = await apiJson('GET', '/v1/skill');
  const name = typeof meta?.name === 'string' && meta.name ? meta.name : 'motionex';
  const files = Array.isArray(meta?.files) ? meta.files : [];
  const base = path.join(root, name);
  for (const rel of files) {
    const parts = String(rel).split('/');
    if (parts.some((s) => s === '' || s === '.' || s === '..')) {
      throw new UsageError(`the service returned an unsafe skill file path: ${rel}`);
    }
    const bytes = await apiBytes('GET', `/v1/skill/${encodePath(rel)}`);
    const target = path.join(base, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    out(target);
  }
  return EXIT.ok;
}

async function cmdValidateTools(args) {
  const a = parseArgs(args, {});
  const { loadConfig } = await import('../src/lib/config.mjs');
  const { loadRegistry } = await import('../src/registry/registry.mjs');
  const config = loadConfig();
  const dirs = a._.length
    ? a._.map((d) => ({ path: path.resolve(d), origin: 'extension' }))
    : config.toolsDirs.map((d) => ({ ...d }));
  const registry = await loadRegistry({ dirs, config });
  const tools = registry.list();
  for (const t of tools) {
    out(`OK ${t.name}${t.available ? '' : ` (unavailable: ${t.unavailable_reason})`}`);
  }
  const invalid = registry.invalid();
  for (const bad of invalid) err(`INVALID ${bad.dir}: ${bad.errors.join('; ')}`);
  if (!tools.length && !invalid.length) out('no tools found');
  return invalid.length ? EXIT.failed : EXIT.ok;
}

// --------------------------------------------------------------------------------------------- main

/**
 * Run the CLI.
 * @param {string[]} argv arguments after the program name
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? EXIT.usage : EXIT.ok;
  }
  switch (command) {
    case 'serve':
      return cmdServe();
    case 'healthcheck':
      return cmdHealthcheck();
    case 'tools':
      return cmdTools(rest);
    case 'run':
      return cmdRun(rest);
    case 'job':
      return cmdJob(rest);
    case 'jobs':
      return cmdJobs(rest);
    case 'cancel':
      return cmdCancel(rest);
    case 'events':
      return cmdEvents(rest);
    case 'put':
      return cmdPut(rest);
    case 'get':
      return cmdGet(rest);
    case 'pin':
      return cmdPin(rest);
    case 'unpin':
      return cmdUnpin(rest);
    case 'pins':
      return cmdPins(rest);
    case 'skill':
      return cmdSkill(rest);
    case 'validate-tools':
      return cmdValidateTools(rest);
    default:
      err(`mx: unknown command "${command}"`);
      process.stderr.write(USAGE);
      return EXIT.usage;
  }
}

/** @returns {boolean} true when this file is the process entry point */
function isEntryPoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return norm(argv1) === norm(self);
  } catch {
    return false;
  }
}

/** Turn a failure into the lines printed on stderr and an exit code. */
function reportError(e) {
  if (e instanceof UsageError) {
    err(`mx: ${e.message}`);
    process.stderr.write(USAGE);
    return EXIT.usage;
  }
  if (e instanceof HttpError) {
    for (const line of e.lines()) err(line);
    return EXIT.failed;
  }
  if (e instanceof UnreachableError) {
    err(`mx: ${e.message}`);
    return EXIT.unreachable;
  }
  err(`mx: ${e?.stack ?? e}`);
  return EXIT.failed;
}

if (isEntryPoint()) {
  // Never call process.exit() here: `mx serve` must stay alive with the HTTP server it starts.
  // Setting exitCode and letting the (undici-free) event loop drain flushes stdout and exits naturally.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.exitCode = reportError(e);
    },
  );
}
