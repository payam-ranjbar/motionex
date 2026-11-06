// Job routes: submit, inspect, list, long-poll events, cancel, delete outputs, stream outputs and read logs.
// Thin wrappers over the job service (src/runner/service.mjs); every error is a Problem.
import { readFile } from 'node:fs/promises';
import { toWorkspacePath } from '../../lib/paths.mjs';
import { problem } from '../../lib/problem.mjs';
import { streamFile } from '../router.mjs';

/** The fields a submit envelope may carry. */
const ENVELOPE_FIELDS = new Set(['tool', 'input', 'cache', 'label', 'project', 'note', 'timeout_s']);

/** Accepted cache policies. */
const CACHE_MODES = new Set(['auto', 'reuse', 'off']);

/** The longest a request may block waiting for a terminal state, in seconds. */
const MAX_WAIT_S = 300;

/** True for `?flag=1` (and true/yes/on); false when absent, empty, 0 or false. */
function flag(value) {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Read a numeric query parameter. Absent -> `fallback`; anything that is not a finite number -> 422.
 * @param {{query: URLSearchParams}} ctx
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function queryNumber(ctx, name, fallback) {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw problem('invalid-request', `?${name} must be a number (got ${JSON.stringify(raw)})`, {
      errors: [{ field: `/${name}`, message: 'must be a number' }],
    });
  }
  return n;
}

/**
 * Validate the submit envelope by hand. Unknown fields and wrong types are 422 invalid-request with
 * `errors: [{field, message}]`; the tool's own input is validated later by the service.
 * @param {unknown} body
 * @returns {{tool: string, input: object, cache: 'auto'|'reuse'|'off', label: string|null,
 *   project: string|null, note: string|null, timeout_s: number|null}}
 */
function validateEnvelope(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw problem('invalid-request', 'the request body must be a JSON object', {
      errors: [{ field: '/', message: 'must be an object' }],
    });
  }
  const errors = [];
  for (const key of Object.keys(body)) {
    if (!ENVELOPE_FIELDS.has(key)) errors.push({ field: `/${key}`, message: 'is not a known field' });
  }

  if (typeof body.tool !== 'string' || body.tool === '') {
    errors.push({ field: '/tool', message: 'must be a non-empty string' });
  }

  const input = body.input === undefined ? {} : body.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ field: '/input', message: 'must be an object' });
  }

  const cache = body.cache === undefined ? 'auto' : body.cache;
  if (!CACHE_MODES.has(cache)) {
    errors.push({ field: '/cache', message: 'must be one of "auto", "reuse", "off"' });
  }

  for (const key of ['label', 'project', 'note']) {
    const value = body[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      errors.push({ field: `/${key}`, message: 'must be a string or null' });
    }
  }

  const timeout = body.timeout_s;
  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
      errors.push({ field: '/timeout_s', message: 'must be a number >= 0 or null' });
    }
  }

  if (errors.length > 0) {
    throw problem('invalid-request', 'the job request is not valid', { errors });
  }

  return {
    tool: body.tool,
    input,
    cache,
    label: body.label ?? null,
    project: body.project ?? null,
    note: body.note ?? null,
    timeout_s: timeout ?? null,
  };
}

/**
 * Register the `/v1/jobs` routes on a router.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{config: import('../../runner/types.mjs').Config, store: object, service: object,
 *   registry: object, pins: object}} deps
 */
export function register(router, deps) {
  const { config, store, service } = deps;

  // Submit a job. `?wait=<s>` blocks (bounded) for a terminal state; 200 when terminal, else 202.
  router.add('POST', '/v1/jobs', async (req, _res, ctx) => {
    const body = await ctx.readJson(config.maxJsonBytes);
    const envelope = validateEnvelope(body);
    const headerKey = req.headers['idempotency-key'];
    const idempotencyKey = typeof headerKey === 'string' && headerKey !== '' ? headerKey : null;

    const { job: submitted, replayed } = await service.submit({ ...envelope, idempotencyKey });

    const wait = queryNumber(ctx, 'wait', 0);
    let job = submitted;
    if (wait > 0 && !isTerminal(job)) {
      job = await service.wait(job.id, { timeoutMs: Math.min(wait, MAX_WAIT_S) * 1000 });
    }

    const headers = { Location: `/v1/jobs/${job.id}` };
    if (replayed) headers['idempotent-replay'] = 'true';
    return { status: isTerminal(job) ? 200 : 202, body: job, headers };
  });

  // List jobs, newest first. Without `full=1` the large `request` and `input` members are omitted.
  router.add('GET', '/v1/jobs', (_req, _res, ctx) => {
    const limit = queryNumber(ctx, 'limit', 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw problem('invalid-request', '?limit must be an integer between 1 and 500', {
        errors: [{ field: '/limit', message: 'must be an integer between 1 and 500' }],
      });
    }
    const filters = { limit };
    for (const key of ['tool', 'status', 'label', 'project', 'before']) {
      const value = ctx.query.get(key);
      if (value !== null) filters[key] = value;
    }
    const { jobs, next_before } = service.list(filters);
    const full = flag(ctx.query.get('full'));
    const rows = full
      ? jobs
      : jobs.map((job) => {
          const { request: _request, input: _input, ...rest } = job;
          return rest;
        });
    return { jobs: rows, next_before };
  });

  // One job. `?wait=<s>` blocks (bounded) for a terminal state.
  router.add('GET', '/v1/jobs/:id', async (_req, _res, ctx) => {
    const wait = queryNumber(ctx, 'wait', 0);
    if (wait > 0) return await service.wait(ctx.params.id, { timeoutMs: Math.min(wait, MAX_WAIT_S) * 1000 });
    return service.get(ctx.params.id);
  });

  // Long-poll the event log.
  router.add('GET', '/v1/jobs/:id/events', async (_req, _res, ctx) => {
    const after = queryNumber(ctx, 'after', 0);
    const wait = queryNumber(ctx, 'wait', 0);
    return await service.events(ctx.params.id, {
      after,
      waitMs: wait > 0 ? Math.min(wait, MAX_WAIT_S) * 1000 : 0,
    });
  });

  // Cancel a queued or running job (terminal jobs are returned unchanged).
  router.add('POST', '/v1/jobs/:id/cancel', async (_req, _res, ctx) => {
    return await service.cancel(ctx.params.id);
  });

  // Delete a finished job's outputs and mark it deleted.
  router.add('DELETE', '/v1/jobs/:id', async (_req, _res, ctx) => {
    return await service.deleteOutputs(ctx.params.id);
  });

  // Stream one output file (Range/ETag/HEAD handled by streamFile).
  router.add('GET', '/v1/jobs/:id/outputs/*name', async (req, res, ctx) => {
    const job = service.get(ctx.params.id);
    if (job.deleted_at) throw problem('not-found', `the outputs of job ${job.id} were deleted`);
    const output = (job.outputs ?? []).find((o) => o.name === ctx.params.name);
    if (!output) throw problem('not-found', `job ${job.id} has no output ${JSON.stringify(ctx.params.name)}`);
    const abs = toWorkspacePath(config.workspace, output.path);
    await streamFile(req, res, abs, { mediaType: output.media_type });
  });

  // The job log as plain text (empty when the tool has not written anything yet).
  router.add('GET', '/v1/jobs/:id/log', async (_req, _res, ctx) => {
    const job = service.get(ctx.params.id);
    let text = '';
    try {
      text = await readFile(store.logFile(job.id), 'utf8');
    } catch {
      text = '';
    }
    return { status: 200, body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' } };
  });
}

/** True when a job will never change again. */
function isTerminal(job) {
  return job?.status === 'succeeded' || job?.status === 'failed' || job?.status === 'canceled';
}
