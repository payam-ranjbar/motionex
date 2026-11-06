// The job service: validation, refs, idempotency, cache, records, scheduling, execution, outputs and recovery.
// Every API error is a Problem (src/lib/problem.mjs); every job error is a ToolError (src/lib/errors.mjs).
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../lib/canonical-json.mjs';
import { ToolError, toJobError } from '../lib/errors.mjs';
import { sha256, sha256File } from '../lib/hash.mjs';
import { newJobId } from '../lib/ids.mjs';
import { mediaTypeOf } from '../lib/media-types.mjs';
import { relFromWorkspace } from '../lib/paths.mjs';
import { problem } from '../lib/problem.mjs';
import { cacheKey, resolveInputRefs } from './refs.mjs';

/** @typedef {import('./types.mjs').Job} Job */
/** @typedef {import('./types.mjs').JobEvent} JobEvent */
/** @typedef {import('./types.mjs').JobOutput} JobOutput */
/** @typedef {import('./types.mjs').JobInput} JobInput */

/** A job in one of these states never changes again. */
export const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** Printable ASCII only (no spaces, no control characters), 1..255 chars. */
const IDEM_KEY = /^[\x21-\x7e]{1,255}$/;

/** Accepted cache policies. */
const CACHE_MODES = new Set(['auto', 'reuse', 'off']);

const PROGRESS_INTERVAL_MS = 250;

const nowIso = () => new Date().toISOString();

/** Public links of a job record. @param {string} id */
const linksFor = (id) => ({
  self: `/v1/jobs/${id}`,
  events: `/v1/jobs/${id}/events`,
  log: `/v1/jobs/${id}/log`,
  dir: `.mx/jobs/${id}`,
});

/**
 * How many scheduler slots a job needs: a number as-is, {from_input, default} read from the validated input,
 * otherwise 0 for class "light" and 1 for everything else.
 * @param {import('./types.mjs').ToolManifest} manifest
 * @param {object} input validated input
 */
function slotsOf(manifest, input) {
  const slots = manifest.resources?.slots;
  if (typeof slots === 'number') return slots;
  if (slots && typeof slots === 'object') {
    const value = input?.[slots.from_input];
    if (typeof value === 'number') return value;
    return slots.default ?? 1;
  }
  return manifest.resources?.class === 'light' ? 0 : 1;
}

/** True when two resolved-ref lists describe the same files (pointer + digest + size). */
function sameRefs(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].pointer !== b[i].pointer) return false;
    if (a[i].sha256 !== b[i].sha256) return false;
    if (a[i].bytes !== b[i].bytes) return false;
  }
  return true;
}

/**
 * Every regular file under `dir`, as POSIX paths relative to it, sorted by name.
 * @param {string} dir
 * @returns {Promise<{name: string, abs: string}[]>}
 */
async function walkFiles(dir) {
  const out = [];
  const walk = async (current, base) => {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs, base);
      else if (entry.isFile()) out.push({ name: path.relative(base, abs).split(path.sep).join('/'), abs });
    }
  };
  await walk(dir, dir);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * @param {object} opts
 * @param {Readonly<import('./types.mjs').Config>} opts.config
 * @param {import('../registry/registry.mjs').Registry} opts.registry
 * @param {import('./store.mjs').JobStore} opts.store
 * @param {{get: (name: string) => object|undefined, list: () => {name: string, target: object}[]}} opts.pins
 * @param {{run: (args: object) => Promise<{result: object, outputs?: {name: string, media_type?: string}[]}>}} opts.executor
 * @param {{enqueue: (job: object) => void, remove: (id: string) => boolean}} opts.scheduler
 */
export function createJobService({ config, registry, store, pins, executor, scheduler }) {
  /** @type {Map<string, AbortController>} running jobs only */
  const controllers = new Map();
  /** @type {Map<string, Promise<void>>} running jobs -> settled when finalized */
  const pending = new Map();
  /**
   * Jobs whose start had already left the scheduler queue when cancel() ran.
   * runJob checks this so a cancel can never be overtaken by a job that just started.
   * @type {Set<string>}
   */
  const cancelRequested = new Set();

  /** The error a job carries when it is canceled before or while it starts. */
  const canceledError = () => new ToolError('canceled', 'the job was canceled before it started').toJSON();

  const blobs = () => ({ workspace: config.workspace, store, pins, blobDir: store.blobDir() });
  const snapshotOpts = () => ({ snapshotMaxBytes: config.snapshotMaxBytes });

  /** Resolve the refs of a validated input. @param {object} input @param {string[]} refPointers */
  const resolveRefs = (input, refPointers) => resolveInputRefs(input, refPointers, blobs(), snapshotOpts());

  /**
   * Run a job now. Never rejects: every outcome is recorded on the job.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function runJob(id) {
    const initial = store.get(id);
    if (initial?.status !== 'queued' || cancelRequested.has(id)) {
      cancelRequested.delete(id);
      return;
    }

    const controller = new AbortController();
    controllers.set(id, controller);
    /** @type {string|null} */
    let scratchDir = null;
    try {
      await store.update(id, { status: 'running', started_at: nowIso() });
      await store.appendEvent(id, { type: 'state', status: 'running' });
      if (cancelRequested.has(id)) {
        // cancel() ran while we were writing "running": cancel wins.
        cancelRequested.delete(id);
        if (store.get(id)?.status !== 'canceled') {
          await store.update(id, { status: 'canceled', finished_at: nowIso(), error: canceledError() });
          await store.appendEvent(id, { type: 'state', status: 'canceled' });
        }
        return;
      }

      const entry = registry.get(initial.tool);
      if (!entry) throw new ToolError('internal', `tool no longer exists: ${initial.tool}`);

      // ---- re-resolve refs: the workspace may have changed since submission ----
      /** @type {object} */
      let resolvedInput = initial.input;
      let inputs = initial.inputs ?? [];
      let key = initial.cache_key;
      let validated = initial.input;
      try {
        const v = registry.validate(initial.tool, initial.input);
        if (!v.ok) {
          throw new ToolError(
            'invalid-input',
            v.errors.map((e) => `${e.field} ${e.message}`).join('; ') || 'input does not match the tool schema',
          );
        }
        validated = v.input;
        const resolved = await resolveRefs(v.input, v.refPointers);
        resolvedInput = resolved.resolvedInput;
        if (!sameRefs(inputs, resolved.inputs)) {
          inputs = resolved.inputs;
          key = cacheKey(initial.tool, entry.toolHash, v.input, resolved.inputs);
        }
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError('input-unreadable', err?.detail || err?.message || 'an input could not be read');
      }

      // ---- folders, timeout, executor ----
      const outDir = store.outDir(id);
      scratchDir = path.join(config.scratchDir, id);
      await mkdir(outDir, { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      const timeoutS = initial.request?.timeout_s ?? entry.manifest.timeout_s ?? 0;
      const timeoutMs = timeoutS > 0 ? timeoutS * 1000 : 0;

      /** Serialise progress writes so a late one can never overwrite the final status. */
      let progressChain = Promise.resolve();
      let lastProgressAt = 0;
      /** @type {{fraction: number|null, message: string|null}|null} */
      let pendingProgress = null;
      /** @type {string|null} the last message the tool reported */
      let lastProgressMessage = null;

      /** @param {{fraction: number|null, message: string|null}} progress */
      const writeProgress = (progress) => {
        lastProgressAt = Date.now();
        pendingProgress = null;
        progressChain = progressChain.then(() => store.update(id, { progress })).catch(() => {});
        return progressChain;
      };

      /** Wait for queued progress writes and flush the pending one. */
      const settleProgress = async () => {
        await progressChain;
        if (pendingProgress) await writeProgress(pendingProgress);
      };

      /** @param {Partial<JobEvent> & {type?: string}} event */
      const onEvent = (event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'progress') {
          const progress = {
            fraction: typeof event.fraction === 'number' ? event.fraction : null,
            message: typeof event.message === 'string' ? event.message : null,
          };
          pendingProgress = progress;
          if (progress.message !== null) lastProgressMessage = progress.message;
          void store
            .appendEvent(id, {
              type: 'progress',
              fraction: progress.fraction,
              ...(progress.message !== null ? { message: progress.message } : {}),
            })
            .catch(() => {});
          if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) writeProgress(progress);
          return;
        }
        if (event.type === 'log') {
          void store.appendEvent(id, { type: 'log', message: String(event.message ?? '') }).catch(() => {});
        }
      };

      const job = store.get(id) ?? initial;
      let outcome;
      try {
        outcome = await executor.run({
          job,
          entry,
          input: resolvedInput,
          rawInput: validated,
          outDir,
          scratchDir,
          timeoutMs,
          signal: controller.signal,
          onEvent,
          logFile: store.logFile(id),
        });
      } finally {
        await settleProgress();
      }

      // ---- success ----
      const result = outcome?.result ?? null;
      const check = registry.validateResult(initial.tool, result);
      if (!check.ok) {
        throw new ToolError(
          'invalid-output',
          check.errors.map((e) => `${e.field} ${e.message}`).join('; ') ||
            'the result does not match the output schema',
        );
      }
      const declared = new Map();
      for (const o of outcome?.outputs ?? []) {
        if (o && typeof o.name === 'string') declared.set(o.name, o.media_type);
      }
      /** @type {JobOutput[]} */
      const outputs = [];
      for (const file of await walkFiles(outDir)) {
        outputs.push({
          name: file.name,
          ref: `job:${id}/${file.name}`,
          path: relFromWorkspace(config.workspace, file.abs),
          sha256: await sha256File(file.abs),
          bytes: (await stat(file.abs)).size,
          media_type: declared.get(file.name) ?? mediaTypeOf(file.name),
        });
      }

      await store.update(id, {
        status: 'succeeded',
        finished_at: nowIso(),
        inputs,
        cache_key: key,
        result,
        outputs,
        progress: { fraction: 1, message: lastProgressMessage },
        error: null,
      });
      await store.appendEvent(id, { type: 'state', status: 'succeeded' });
    } catch (err) {
      // ---- failure ----
      const jobError = toJobError(err);
      const canceled = jobError.type === 'canceled' || controller.signal.aborted;
      const status = canceled ? 'canceled' : 'failed';
      const error =
        canceled && jobError.type !== 'canceled'
          ? new ToolError('canceled', jobError.detail || 'the job was canceled').toJSON()
          : jobError;
      const current = store.get(id);
      if (current && current.status !== 'succeeded') {
        try {
          await store.update(id, { status, finished_at: nowIso(), error });
          await store.appendEvent(id, { type: 'state', status });
        } catch {
          // the record could not be written (disk full, unreadable state dir); nothing more we can do here
        }
      }
    } finally {
      controllers.delete(id);
      cancelRequested.delete(id);
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /**
   * Start a job and track its promise so drain() can wait for it.
   * @param {string} id
   * @returns {Promise<void>}
   */
  function startJob(id) {
    const run = runJob(id);
    pending.set(id, run);
    run.then(
      () => pending.delete(id),
      () => pending.delete(id),
    );
    return run;
  }

  /**
   * Schedule a queued job record through the scheduler.
   * @param {Job} job
   * @param {import('./types.mjs').ToolManifest} manifest
   */
  function enqueue(job, manifest) {
    scheduler.enqueue({
      id: job.id,
      cls: manifest.resources.class,
      slots: slotsOf(manifest, job.input),
      start: () => startJob(job.id),
    });
  }

  /**
   * Look up a job or throw 404 not-found.
   * @param {string} id
   * @returns {Job}
   */
  function getJob(id) {
    const job = store.get(id);
    if (!job) throw problem('not-found', `no job ${JSON.stringify(id)}`);
    return job;
  }

  return {
    /**
     * Validate, resolve, cache-check and queue (or answer from the cache) one job.
     * @param {{tool: string, input?: object, cache?: string, label?: string|null, project?: string|null,
     *   note?: string|null, timeout_s?: number|null, idempotencyKey?: string|null}} request
     * @returns {Promise<{job: Job, replayed: boolean}>}
     */
    async submit(request = {}) {
      const {
        tool,
        input,
        cache = 'auto',
        label = null,
        project = null,
        note = null,
        timeout_s = null,
        idempotencyKey = null,
      } = request;
      const mode = cache ?? 'auto';
      if (!CACHE_MODES.has(mode)) {
        throw problem('invalid-request', `cache must be one of "auto", "reuse", "off" (got ${JSON.stringify(cache)})`);
      }
      if (idempotencyKey !== null && idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || !IDEM_KEY.test(idempotencyKey)) {
          throw problem(
            'idempotency-key-invalid',
            'the Idempotency-Key must be 1..255 printable ASCII characters with no spaces',
          );
        }
      }
      const idemKey = idempotencyKey ?? null;
      const fingerprint =
        idemKey === null ? null : sha256(canonical({ tool, input, cache: mode, label, project, note, timeout_s }));

      if (idemKey !== null) {
        const hit = store.findIdempotent(idemKey);
        const previous = hit ? store.get(hit.jobId) : undefined;
        if (previous) {
          if (hit.fingerprint === fingerprint) return { job: previous, replayed: true };
          throw problem(
            'idempotency-key-reused',
            `the Idempotency-Key "${idemKey}" was already used for job ${previous.id} with a different request`,
            { job_id: previous.id },
          );
        }
      }

      const entry = registry.get(tool);
      if (!entry) throw problem('unknown-tool', `no tool named ${JSON.stringify(tool)}`);
      if (!entry.available) {
        throw problem('tool-unavailable', entry.unavailableReason ?? `tool ${tool} cannot run here`);
      }

      const v = registry.validate(tool, input);
      if (!v.ok) throw problem('invalid-input', `input does not match ${tool}`, { errors: v.errors });

      // Problems (unknown ref, file not found, path outside the workspace) propagate unchanged.
      const resolved = await resolveRefs(v.input, v.refPointers);
      const key = cacheKey(tool, entry.toolHash, v.input, resolved.inputs);
      const manifest = entry.manifest;

      // ---- cache lookup ----
      const lookup = mode === 'reuse' || (mode === 'auto' && manifest.cache_default !== 'off');
      if (lookup) {
        const sourceId = store.findCached(key);
        const src = sourceId ? store.get(sourceId) : undefined;
        if (src && src.status === 'succeeded' && !src.deleted_at) {
          const id = newJobId();
          const at = nowIso();
          /** @type {Job} */
          const job = {
            id,
            tool,
            tool_version: manifest.version,
            tool_hash: entry.toolHash,
            status: 'succeeded',
            label,
            project,
            note,
            created_at: at,
            started_at: at,
            finished_at: at,
            progress: { fraction: 1, message: null },
            request: { input: v.input, cache: mode, timeout_s },
            request_fingerprint: fingerprint,
            input: v.input,
            inputs: resolved.inputs,
            cache_key: key,
            cached_from: src.id,
            result: src.result,
            outputs: (src.outputs ?? []).map((o) => ({ ...o, ref: `job:${id}/${o.name}` })),
            error: null,
            idempotency_key: idemKey,
            deleted_at: null,
            links: linksFor(id),
          };
          await store.create(job);
          await store.appendEvent(id, { type: 'state', status: 'succeeded' });
          if (idemKey !== null) await store.putIdempotent(idemKey, { jobId: id, fingerprint });
          return { job: store.get(id) ?? job, replayed: false };
        }
      }

      // ---- a fresh queued job ----
      const id = newJobId();
      /** @type {Job} */
      const job = {
        id,
        tool,
        tool_version: manifest.version,
        tool_hash: entry.toolHash,
        status: 'queued',
        label,
        project,
        note,
        created_at: nowIso(),
        started_at: null,
        finished_at: null,
        progress: { fraction: null, message: null },
        request: { input: v.input, cache: mode, timeout_s },
        request_fingerprint: fingerprint,
        input: v.input,
        inputs: resolved.inputs,
        cache_key: key,
        cached_from: null,
        result: null,
        outputs: [],
        error: null,
        idempotency_key: idemKey,
        deleted_at: null,
        links: linksFor(id),
      };
      await store.create(job);
      await store.appendEvent(id, { type: 'state', status: 'queued' });
      if (idemKey !== null) await store.putIdempotent(idemKey, { jobId: id, fingerprint });
      enqueue(job, manifest);
      return { job: store.get(id) ?? job, replayed: false };
    },

    get: getJob,

    /** @param {object} [filters] */
    list(filters) {
      return store.list(filters);
    },

    /**
     * Cancel a queued or running job. Terminal jobs are returned unchanged.
     * @param {string} id
     * @returns {Promise<Job>}
     */
    async cancel(id) {
      const job = getJob(id);
      if (TERMINAL.has(job.status)) return job;
      if (job.status === 'queued') {
        // remove() is false when the scheduler already handed the job to start(); runJob then sees the request.
        if (!scheduler.remove(id)) cancelRequested.add(id);
        const next = await store.update(id, {
          status: 'canceled',
          finished_at: nowIso(),
          error: canceledError(),
          progress: job.progress ?? { fraction: null, message: null },
        });
        await store.appendEvent(id, { type: 'state', status: 'canceled' });
        return next;
      }
      controllers.get(id)?.abort();
      return store.get(id) ?? job;
    },

    /**
     * Wait until the job is terminal or `timeoutMs` elapses (0 = wait indefinitely); returns the current job.
     * @param {string} id
     * @param {{timeoutMs?: number}} [opts]
     * @returns {Promise<Job>}
     */
    async wait(id, { timeoutMs = 0 } = {}) {
      const job = getJob(id);
      if (TERMINAL.has(job.status)) return job;
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        let unsubscribe = () => {};
        const finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
          if (timer) clearTimeout(timer);
          resolve(store.get(id) ?? job);
        };
        unsubscribe = store.subscribe(id, (event) => {
          if (event?.type === 'state' && TERMINAL.has(event.status)) finish();
        });
        const current = store.get(id);
        if (current && TERMINAL.has(current.status)) finish();
        else if (timeoutMs > 0) timer = setTimeout(finish, timeoutMs);
      });
    },

    /**
     * Long-poll the event log: events after `after`, waiting up to `waitMs` for a newer one.
     * @param {string} id
     * @param {{after?: number, waitMs?: number}} [opts]
     * @returns {Promise<{events: JobEvent[], next_after: number}>}
     */
    async events(id, { after = 0, waitMs = 0 } = {}) {
      getJob(id);
      const first = await store.events(id, { after });
      if (first.length > 0 || !(waitMs > 0)) {
        return { events: first, next_after: first.length ? first[first.length - 1].seq : after };
      }
      await new Promise((resolve) => {
        let done = false;
        let timer = null;
        let unsubscribe = () => {};
        const finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
          if (timer) clearTimeout(timer);
          resolve(undefined);
        };
        unsubscribe = store.subscribe(id, (event) => {
          if (typeof event?.seq === 'number' && event.seq > after) finish();
        });
        timer = setTimeout(finish, waitMs);
      });
      const later = await store.events(id, { after });
      return { events: later, next_after: later.length ? later[later.length - 1].seq : after };
    },

    /**
     * Delete a finished job's outputs (and mark jobs that cached from it as deleted too).
     * @param {string} id
     * @returns {Promise<Job>}
     */
    async deleteOutputs(id) {
      const job = getJob(id);
      if (!TERMINAL.has(job.status)) throw problem('job-busy', `job ${id} is ${job.status}`);
      const dependents = store
        .list({ limit: 1e9 })
        .jobs.filter((other) => other.cached_from === id && !other.deleted_at);
      const owned = new Set([id, ...dependents.map((d) => d.id)]);
      for (const pin of pins.list() ?? []) {
        const target = pin?.target ?? {};
        if (target.job && owned.has(target.job)) {
          throw problem('pinned', `pin "${pin.name}" uses the outputs of job ${target.job}`);
        }
      }
      await rm(store.outDir(id), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      const at = nowIso();
      const next = await store.update(id, { deleted_at: at });
      for (const dependent of dependents) await store.update(dependent.id, { deleted_at: at });
      return next;
    },

    /**
     * Re-enqueue jobs that were still queued at startup.
     * @param {string[]} queuedIds
     */
    recover(queuedIds) {
      for (const id of queuedIds ?? []) {
        const job = store.get(id);
        if (job?.status !== 'queued') continue;
        const entry = registry.get(job.tool);
        if (!entry) {
          const error = new ToolError('internal', `tool no longer exists: ${job.tool}`).toJSON();
          void store
            .update(id, { status: 'failed', finished_at: nowIso(), error })
            .then(() => store.appendEvent(id, { type: 'state', status: 'failed' }))
            .catch(() => {});
          continue;
        }
        try {
          enqueue(job, entry.manifest);
        } catch {
          // a full queue leaves the job queued; the next start re-enqueues it
        }
      }
    },

    /** Abort every running job and wait (bounded) until they reach a terminal state. */
    async drain() {
      const ids = [...controllers.keys()];
      for (const controller of controllers.values()) controller.abort();
      const waits = ids.map((id) => pending.get(id)).filter((p) => p !== undefined);
      if (waits.length === 0) return;
      let timer = null;
      const budget = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, config.killGraceMs) + 2000);
      });
      await Promise.race([Promise.allSettled(waits), budget]);
      if (timer) clearTimeout(timer);
    },
  };
}
