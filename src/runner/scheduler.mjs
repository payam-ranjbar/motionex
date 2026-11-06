// CPU-slot scheduler with per-class concurrency limits. No I/O.
import { problem } from '../lib/problem.mjs';

/** @typedef {{id: string, cls: string, slots: number, start: () => Promise<unknown>}} QueuedJob */

export class Scheduler {
  /** @param {{totalSlots: number, limits: Record<string, number>, maxQueued?: number}} opts */
  constructor({ totalSlots, limits, maxQueued = 1000 }) {
    this.totalSlots = totalSlots;
    this.limits = limits ?? {};
    this.maxQueued = maxQueued;
    /** @type {QueuedJob[]} */
    this.queue = [];
    /** @type {Map<string, QueuedJob>} */
    this.running = new Map();
    this.usedSlots = 0;
  }

  /** The concurrency limit for a class: its entry, else limits.default, else 2.
   * @param {string} cls
   * @returns {number} */
  limitFor(cls) {
    const limit = this.limits[cls];
    if (typeof limit === 'number') return limit;
    return typeof this.limits.default === 'number' ? this.limits.default : 2;
  }

  /** Queue a job. start() is called when it may run; its settled promise frees the slots.
   * @param {{id: string, cls: string, slots: number, start: () => Promise<unknown>}} job
   * @throws {import('../lib/problem.mjs').Problem} queue-full */
  enqueue({ id, cls, slots, start }) {
    if (this.queue.length >= this.maxQueued) {
      throw problem('queue-full', `the scheduler queue already holds ${this.maxQueued} jobs`);
    }
    const effective = Math.min(Math.max(0, slots ?? 1), this.totalSlots);
    this.queue.push({ id, cls, slots: effective, start });
    this.pump();
  }

  /** Remove a queued job that has not started. @returns {boolean} */
  remove(id) {
    const index = this.queue.findIndex((job) => job.id === id);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this.pump();
    return true;
  }

  /** @returns {{running: {id: string, cls: string, slots: number}[], queued: {id: string, cls: string, slots: number}[], usedSlots: number, totalSlots: number}} */
  stats() {
    const pick = (job) => ({ id: job.id, cls: job.cls, slots: job.slots });
    return {
      running: [...this.running.values()].map(pick),
      queued: this.queue.map(pick),
      usedSlots: this.usedSlots,
      totalSlots: this.totalSlots,
    };
  }

  /** Start a job: reserve its slots, run start() in a microtask, free on settle.
   * @param {QueuedJob} job */
  start(job) {
    this.running.set(job.id, job);
    this.usedSlots += job.slots;
    Promise.resolve()
      .then(job.start)
      .then(
        () => this.finish(job),
        () => this.finish(job),
      )
      .catch(() => {});
  }

  /** Release a finished job's slots and pump. start() errors are ignored.
   * @param {QueuedJob} job */
  finish(job) {
    this.running.delete(job.id);
    this.usedSlots -= job.slots;
    this.pump();
  }

  /** Start every queued job that may run, honouring FIFO, class limits and slot reservations. */
  pump() {
    if (!this.queue.length) return;
    const counts = new Map();
    for (const job of this.running.values()) counts.set(job.cls, (counts.get(job.cls) ?? 0) + 1);
    const remaining = [];
    let reserved = false;
    for (const job of this.queue) {
      // A job waiting on slots reserves them: no later job with slots may jump ahead.
      if (reserved && job.slots > 0) {
        remaining.push(job);
        continue;
      }
      const classOk = (counts.get(job.cls) ?? 0) < this.limitFor(job.cls);
      const slotsOk = this.usedSlots + job.slots <= this.totalSlots;
      if (classOk && slotsOk) {
        this.start(job);
        counts.set(job.cls, (counts.get(job.cls) ?? 0) + 1);
      } else {
        if (classOk && !slotsOk) reserved = true;
        remaining.push(job);
      }
    }
    this.queue = remaining;
  }
}
