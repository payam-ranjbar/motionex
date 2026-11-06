// Fixed-size pool of render workers with a FIFO queue.
// A job that exceeds its timeout gets its worker terminated and replaced, which is
// the only reliable way to stop runaway user code or a huge offline render.
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);

export class RenderError extends Error {
  constructor(message, { status = 422 } = {}) {
    super(message);
    this.status = status;
  }
}

class Slot {
  constructor(pool) {
    this.pool = pool;
    this.current = null;
    this.spawn();
  }

  spawn() {
    this.busy = true; // until 'ready'
    const worker = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: this.pool.memoryMb },
    });
    this.worker = worker;
    // Events from a worker we've already replaced are ignored.
    worker.on('message', (msg) => worker === this.worker && this.onMessage(msg));
    worker.on('error', (err) => worker === this.worker && this.fail(new RenderError(`worker crashed: ${err.message}`, { status: 500 })));
    worker.on('exit', (code) => {
      if (worker !== this.worker || this.pool.closing) return;
      this.fail(new RenderError(`worker exited (${code})`, { status: 500 }));
      this.spawn();
    });
  }

  onMessage(msg) {
    if (msg.type === 'ready') {
      this.busy = false;
      this.pool.drain();
      return;
    }
    const job = this.current;
    if (!job || job.id !== msg.id) return;
    clearTimeout(job.timer);
    this.current = null;
    this.busy = false;
    if (msg.type === 'done') {
      const audio = msg.audio && { ...msg.audio, bytes: Buffer.from(msg.audio.bytes) };
      job.resolve({ audio, analysis: msg.analysis, meta: msg.meta });
    }
    else job.reject(new RenderError(msg.error.message));
    this.pool.drain();
  }

  run(job) {
    this.busy = true;
    this.current = job;
    job.timer = setTimeout(() => {
      this.current = null;
      job.reject(new RenderError(`render timed out after ${this.pool.timeoutMs} ms`, { status: 504 }));
      const stale = this.worker;
      this.spawn();
      stale.terminate();
    }, this.pool.timeoutMs);
    this.worker.postMessage({ id: job.id, job: job.payload });
  }

  fail(err) {
    const job = this.current;
    if (!job) return;
    clearTimeout(job.timer);
    this.current = null;
    job.reject(err);
  }
}

export class RenderPool {
  constructor({ size, timeoutMs, maxQueue = 100, memoryMb = 512 }) {
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.memoryMb = memoryMb;
    this.queue = [];
    this.nextId = 1;
    this.slots = Array.from({ length: size }, () => new Slot(this));
  }

  render(payload) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new RenderError('render queue is full', { status: 503 }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, payload, resolve, reject });
      this.drain();
    });
  }

  drain() {
    for (const slot of this.slots) {
      if (!this.queue.length) return;
      if (!slot.busy) slot.run(this.queue.shift());
    }
  }

  stats() {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.current).length,
      queued: this.queue.length,
    };
  }

  async close() {
    this.closing = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}
