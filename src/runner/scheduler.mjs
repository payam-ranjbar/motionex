// STUB (owner: P1a). Replace the bodies; keep the exported names and signatures.
// CPU-slot scheduler with per-class concurrency limits. No I/O.
import { ToolError } from '../lib/errors.mjs';

export class Scheduler {
  /** @param {{totalSlots: number, limits: Record<string, number>, maxQueued?: number}} opts */
  constructor({ totalSlots, limits, maxQueued = 1000 }) {
    throw new ToolError('internal', 'not implemented: Scheduler');
  }
  /** Queue a job. start() is called when it may run; its settled promise frees the slots.
   * @param {{id: string, cls: string, slots: number, start: () => Promise<unknown>}} job
   * @throws {import('../lib/problem.mjs').Problem} queue-full */
  enqueue(job) {}
  /** Remove a queued job that has not started. @returns {boolean} */
  remove(id) {}
  /** @returns {{running: {id: string, cls: string, slots: number}[], queued: {id: string, cls: string, slots: number}[], usedSlots: number, totalSlots: number}} */
  stats() {}
}
