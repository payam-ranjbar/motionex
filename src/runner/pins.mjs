// Pins: stable, human-approved names for immutable takes and renders. A pin maps a name to a concrete
// target (a blob, a job output or a whole job). Re-pinning appends history so a rollback is just
// re-setting an older ref. Pinning a workspace path snapshots the file into the content-addressed blob
// store, so later edits to that file never change what the pin points at.
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { problem } from '../lib/problem.mjs';
import { PIN_NAME, parseRef, resolveRef } from './refs.mjs';

/**
 * @typedef {{job: string|null, output: string|null, blob: string|null, path: string|null,
 *   sha256: string|null}} PinTarget
 * @typedef {{name: string, ref: string, target: PinTarget, note: string|null, pinned_at: string}} Pin
 * @typedef {{at: string, action: 'set'|'remove', name: string, ref: string, target: PinTarget,
 *   note: string|null}} HistoryEntry
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Copy a resolved file into the content-addressed blob store, unless the blob already exists. */
async function snapshotBlob(abs, sha, blobDir) {
  const dir = path.join(blobDir, 'sha256', sha.slice(0, 2));
  const dest = path.join(dir, sha);
  try {
    await stat(dest);
    return dest;
  } catch {
    // the blob is not there yet: copy it in
  }
  await mkdir(dir, { recursive: true });
  const tmp = `${dest}.tmp`;
  await copyFile(abs, tmp);
  try {
    await rename(tmp, dest);
  } catch (e) {
    if (e?.code !== 'EEXIST' && e?.code !== 'EPERM') throw e;
  }
  return dest;
}

/**
 * Create a pin store over a state dir.
 * @param {{stateDir: string, workspace: string, store: object, blobDir: string}} opts
 * @returns {{open: () => Promise<void>, list: () => Pin[], get: (name: string) => Pin|undefined,
 *   set: (name: string, body: {ref: string, note?: string|null}) => Promise<Pin>,
 *   remove: (name: string) => Promise<boolean>, history: (name: string) => HistoryEntry[]}}
 */
export function createPinStore({ stateDir, workspace, store, blobDir }) {
  const dir = path.resolve(stateDir);
  const pinsFile = path.join(dir, 'pins.json');
  const historyFile = path.join(dir, 'pins.jsonl');
  /** @type {Map<string, Pin>} */
  const pins = new Map();
  /** @type {HistoryEntry[]} */
  const entries = [];

  const api = {
    /** Load pins.json and the append-only history. A missing file means empty. */
    async open() {
      await mkdir(dir, { recursive: true });
      pins.clear();
      entries.length = 0;
      try {
        const record = JSON.parse(await readFile(pinsFile, 'utf8'));
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          for (const [name, pin] of Object.entries(record)) pins.set(name, pin);
        }
      } catch {
        // no pins yet, or an unreadable file: start empty
      }
      try {
        const text = await readFile(historyFile, 'utf8');
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          try {
            entries.push(JSON.parse(line));
          } catch {
            // skip a corrupt history line
          }
        }
      } catch {
        // no history yet
      }
    },

    /** Every current pin. */
    list() {
      return [...pins.values()];
    },

    /** @param {string} name */
    get(name) {
      return pins.get(name);
    },

    /** @param {string} name */
    history(name) {
      return entries.filter((entry) => entry.name === name);
    },

    /**
     * Pin (or re-pin) a name to an immutable target.
     * @param {string} name
     * @param {{ref: string, note?: string|null}} body
     * @returns {Promise<Pin>}
     */
    async set(name, { ref, note } = {}) {
      if (typeof name !== 'string' || name.includes('#') || !PIN_NAME.test(name)) {
        throw problem('invalid-request', `pin name "${name}" must match ${PIN_NAME} and contain no "#"`);
      }
      if (typeof ref !== 'string' || ref === '') throw problem('invalid-request', 'a pin needs a non-empty "ref"');

      let target;
      if (ref.startsWith('job:') && !ref.slice(4).includes('/')) {
        // A whole-job pin. This form is accepted ONLY here; elsewhere a job ref needs an output.
        const id = ref.slice(4);
        const job = store.get(id);
        if (!job || job.deleted_at) throw problem('unknown-ref', `no job "${id}"`);
        if (job.status !== 'succeeded') throw problem('unknown-ref', `job ${id} is ${job.status}`);
        target = { job: id, output: null, blob: null, path: null, sha256: null };
      } else {
        const parsed = parseRef(ref);
        const resolved = await resolveRef(ref, { workspace, store, pins: api, blobDir });
        if (parsed.kind === 'pin') {
          // Resolve the other pin now and copy its concrete target: no chained indirection.
          const other = pins.get(parsed.name);
          target = structuredClone(other.target);
        } else if (parsed.kind === 'path') {
          await snapshotBlob(resolved.abs, resolved.sha256, blobDir);
          target = {
            job: null,
            output: null,
            blob: resolved.sha256,
            path: resolved.path,
            sha256: resolved.sha256,
          };
        } else {
          target = { job: resolved.job, output: resolved.output, blob: null, path: null, sha256: resolved.sha256 };
        }
      }

      const pinned = { name, ref, target, note: note ?? null, pinned_at: new Date().toISOString() };
      pins.set(name, pinned);
      await atomicWrite(pinsFile, `${JSON.stringify(Object.fromEntries(pins), null, 2)}\n`);
      const entry = { at: pinned.pinned_at, action: 'set', name, ref, target, note: pinned.note };
      await appendFile(historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
      entries.push(entry);
      return pinned;
    },

    /**
     * Remove a pin, keeping it in history for rollback.
     * @param {string} name
     * @returns {Promise<boolean>}
     */
    async remove(name) {
      const old = pins.get(name);
      if (!old) return false;
      pins.delete(name);
      await atomicWrite(pinsFile, `${JSON.stringify(Object.fromEntries(pins), null, 2)}\n`);
      const entry = {
        at: new Date().toISOString(),
        action: 'remove',
        name,
        ref: old.ref,
        target: old.target,
        note: old.note,
      };
      await appendFile(historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
      entries.push(entry);
      return true;
    },
  };

  return api;
}
