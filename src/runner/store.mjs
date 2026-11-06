// Persistent job store: job records, events, idempotency/cache indexes and a single-writer lock, all on disk.
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @typedef {import('./types.mjs').Job} Job */
/** @typedef {import('./types.mjs').JobEvent} JobEvent */

/** Lock paths currently held by this process (keyed by absolute lock path). */
const HELD = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a pid exists (or we lack permission to signal it, which still means it exists). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** @returns {Error & {code: string}} */
function lockedError(pid) {
  const err = /** @type {Error & {code: string}} */ (
    new Error(`the job store is locked by pid ${pid} on this host; another motionex writer is active`)
  );
  err.code = 'ELOCKED';
  return err;
}

/** Write a temp file then rename over the destination, retrying on Windows sharing violations. */
async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text, 'utf8');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      if ((e?.code === 'EPERM' || e?.code === 'EBUSY') && attempt < 9) {
        await delay(20);
        continue;
      }
      throw e;
    }
  }
}

export class JobStore {
  /**
   * @param {{stateDir: string, workspace: string}} opts
   */
  constructor({ stateDir, workspace }) {
    this.stateDir = path.resolve(stateDir);
    this.workspace = path.resolve(workspace);
    /** @type {string[]} paths of job.json files that could not be read */
    this.corrupt = [];
    /** @type {Map<string, Job>} */
    this._jobs = new Map();
    /** @type {Map<string, number>} last event seq per job */
    this._seq = new Map();
    /** @type {Map<string, Promise<unknown>>} per-job append serialisation */
    this._chains = new Map();
    /** @type {Map<string, Set<(event: JobEvent) => void>>} */
    this._subs = new Map();
    /** @type {Map<string, {jobId: string, fingerprint: string|null}>} */
    this._idem = new Map();
    /** @type {Map<string, string>} cache_key -> newest succeeded job id */
    this._cache = new Map();
  }

  // ---- paths -----------------------------------------------------------------

  /** @param {string} id */
  jobDir(id) {
    return path.join(this.stateDir, 'jobs', id);
  }

  /** @param {string} id */
  outDir(id) {
    return path.join(this.jobDir(id), 'out');
  }

  /** @param {string} id */
  logFile(id) {
    return path.join(this.jobDir(id), 'log.txt');
  }

  /** @param {string} id */
  eventsFile(id) {
    return path.join(this.jobDir(id), 'events.jsonl');
  }

  blobDir() {
    return path.join(this.stateDir, 'blobs');
  }

  /** @param {string} id */
  _jobFile(id) {
    return path.join(this.jobDir(id), 'job.json');
  }

  _lockFile() {
    return path.join(this.stateDir, 'lock');
  }

  // ---- lifecycle -------------------------------------------------------------

  /** @returns {Promise<string[]>} ids of jobs still queued after recovery, oldest first */
  async open() {
    await mkdir(path.join(this.stateDir, 'jobs'), { recursive: true });
    await this._acquireLock();
    await this._load();
    await this._recover();
    this._rebuildIndexes();
    return [...this._jobs.values()]
      .filter((job) => job.status === 'queued')
      .map((job) => job.id)
      .sort();
  }

  async close() {
    const lock = this._lockFile();
    if (!HELD.has(lock)) return;
    try {
      const current = JSON.parse(await readFile(lock, 'utf8'));
      if (current?.pid === process.pid && current?.hostname === os.hostname()) await unlink(lock);
    } catch {
      // lock already gone or unreadable: nothing to release
    }
    HELD.delete(lock);
  }

  async _acquireLock() {
    const lock = this._lockFile();
    let existing = null;
    try {
      existing = JSON.parse(await readFile(lock, 'utf8'));
    } catch {
      existing = null;
    }
    if (existing && Number.isInteger(existing.pid)) {
      const sameHost = existing.hostname === os.hostname();
      const samePid = existing.pid === process.pid;
      const alive = isAlive(existing.pid);
      const heldHere = HELD.has(lock);
      // A live lock from another process, or a lock we already hold here, blocks us.
      // A dead pid, or a same-pid lock left by a previous run (not held in this process), is stale.
      if (sameHost && alive && (!samePid || heldHere)) throw lockedError(existing.pid);
    }
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() }),
      'utf8',
    );
    HELD.add(lock);
  }

  async _load() {
    this._jobs.clear();
    this._seq.clear();
    this.corrupt = [];
    const jobsDir = path.join(this.stateDir, 'jobs');
    let entries = [];
    try {
      entries = await readdir(jobsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(jobsDir, entry.name, 'job.json');
      try {
        const record = JSON.parse(await readFile(file, 'utf8'));
        if (!record || typeof record.id !== 'string') throw new Error('missing id');
        this._jobs.set(record.id, record);
      } catch {
        this.corrupt.push(file);
      }
    }
    for (const id of this._jobs.keys()) {
      let text = '';
      try {
        text = await readFile(this.eventsFile(id), 'utf8');
      } catch {
        text = '';
      }
      this._seq.set(id, text.split('\n').filter((line) => line.trim() !== '').length);
    }
  }

  /** @returns {Promise<string[]>} recovered (failed) job ids */
  async _recover() {
    const now = new Date().toISOString();
    const recovered = [];
    for (const job of [...this._jobs.values()]) {
      if (job.status !== 'running') continue;
      const next = {
        ...job,
        status: 'failed',
        finished_at: now,
        error: {
          type: 'interrupted',
          title: 'The job was interrupted by a restart',
          detail: 'the service stopped while the job was running',
          retryable: true,
        },
      };
      await this._writeJob(next);
      this._jobs.set(next.id, next);
      await this.appendEvent(next.id, { type: 'state', status: 'failed' });
      recovered.push(next.id);
    }
    return recovered;
  }

  _rebuildIndexes() {
    this._idem.clear();
    this._cache.clear();
    // Ascending id order (ids are time-sortable) so newer records win the maps.
    const records = [...this._jobs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const record of records) {
      if (record.idempotency_key) {
        this._idem.set(record.idempotency_key, {
          jobId: record.id,
          fingerprint: record.request_fingerprint ?? null,
        });
      }
      if (record.status === 'succeeded' && record.cache_key && !record.deleted_at) {
        this._cache.set(record.cache_key, record.id);
      }
    }
  }

  // ---- records ---------------------------------------------------------------

  /**
   * @param {Job} record
   * @returns {Promise<Job>}
   */
  async create(record) {
    await mkdir(this.jobDir(record.id), { recursive: true });
    await this._writeJob(record);
    this._jobs.set(record.id, record);
    if (!this._seq.has(record.id)) this._seq.set(record.id, 0);
    return record;
  }

  /** @param {string} id @returns {Job | undefined} */
  get(id) {
    return this._jobs.get(id);
  }

  /**
   * @param {{tool?: string, status?: string, label?: string|null, project?: string|null, limit?: number, before?: string}} [opts]
   * @returns {{jobs: Job[], next_before: string|null}}
   */
  list({ tool, status, label, project, limit = 50, before } = {}) {
    let ids = [...this._jobs.keys()].sort().reverse();
    if (before !== undefined) ids = ids.filter((id) => id < before);
    let jobs = ids.map((id) => /** @type {Job} */ (this._jobs.get(id)));
    if (tool !== undefined) jobs = jobs.filter((job) => job.tool === tool);
    if (status !== undefined) jobs = jobs.filter((job) => job.status === status);
    if (label !== undefined) jobs = jobs.filter((job) => job.label === label);
    if (project !== undefined) jobs = jobs.filter((job) => job.project === project);
    const page = jobs.slice(0, limit);
    const next_before = jobs.length > limit && page.length > 0 ? page[page.length - 1].id : null;
    return { jobs: page, next_before };
  }

  /**
   * @param {string} id
   * @param {Partial<Job>} patch
   * @returns {Promise<Job>}
   */
  async update(id, patch) {
    const old = this._jobs.get(id);
    if (!old) throw new Error(`unknown job: ${id}`);
    const next = /** @type {Job} */ ({ ...old, ...patch });
    await this._writeJob(next);
    this._jobs.set(id, next);
    if (next.status === 'succeeded' && next.cache_key && !next.deleted_at) {
      await this.putCached(next.cache_key, id);
    }
    if (next.deleted_at) {
      for (const [key, jobId] of this._cache) {
        if (jobId !== id) continue;
        let best;
        for (const record of this._jobs.values()) {
          if (record.cache_key !== key || record.status !== 'succeeded' || record.deleted_at) continue;
          if (best === undefined || record.id > best) best = record.id;
        }
        if (best === undefined) this._cache.delete(key);
        else this._cache.set(key, best);
      }
    }
    return next;
  }

  /** @param {Job} record */
  async _writeJob(record) {
    await atomicWrite(this._jobFile(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  // ---- events ----------------------------------------------------------------

  /**
   * @param {string} id
   * @param {Partial<JobEvent>} event
   * @returns {Promise<JobEvent>}
   */
  async appendEvent(id, event) {
    const prev = this._chains.get(id) ?? Promise.resolve();
    const run = prev.then(() => this._appendEvent(id, event));
    this._chains.set(
      id,
      run.catch(() => {}),
    );
    return run;
  }

  /**
   * @param {string} id
   * @param {Partial<JobEvent>} event
   * @returns {Promise<JobEvent>}
   */
  async _appendEvent(id, event) {
    const seq = (this._seq.get(id) ?? 0) + 1;
    const full = /** @type {JobEvent} */ ({ ...event, seq, at: new Date().toISOString() });
    await appendFile(this.eventsFile(id), `${JSON.stringify(full)}\n`, 'utf8');
    this._seq.set(id, seq);
    for (const fn of this._subs.get(id) ?? []) {
      try {
        fn(full);
      } catch {
        // a subscriber must never break the store
      }
    }
    return full;
  }

  /**
   * @param {string} id
   * @param {{after?: number}} [opts]
   * @returns {Promise<JobEvent[]>}
   */
  async events(id, { after = 0 } = {}) {
    let text = '';
    try {
      text = await readFile(this.eventsFile(id), 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line);
        if (typeof event?.seq === 'number' && event.seq > after) out.push(event);
      } catch {
        // skip a corrupt line
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * @param {string} id
   * @param {(event: JobEvent) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(id, fn) {
    let set = this._subs.get(id);
    if (!set) {
      set = new Set();
      this._subs.set(id, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  // ---- indexes ---------------------------------------------------------------

  /** @param {string} key @returns {{jobId: string, fingerprint: string|null} | undefined} */
  findIdempotent(key) {
    return this._idem.get(key);
  }

  /**
   * @param {string} key
   * @param {{jobId: string, fingerprint: string|null}} value
   * @returns {Promise<void>}
   */
  async putIdempotent(key, { jobId, fingerprint }) {
    this._idem.set(key, { jobId, fingerprint: fingerprint ?? null });
  }

  /** @param {string} cacheKey @returns {string | undefined} */
  findCached(cacheKey) {
    return this._cache.get(cacheKey);
  }

  /**
   * @param {string} cacheKey
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async putCached(cacheKey, jobId) {
    this._cache.set(cacheKey, jobId);
  }
}
