// Ref parsing and resolution: tool inputs point at files with workspace paths, "job:<id>/<out>" refs or
// "pin:<name>[#<out>]" refs. This module also snapshots small input files into the content-addressed blob store
// and computes the cache key that decides whether a job can be answered from a previous one.
import { copyFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../lib/canonical-json.mjs';
import { sha256, sha256File } from '../lib/hash.mjs';
import { JOB_ID } from '../lib/ids.mjs';
import { isSafeOutputPath, relFromWorkspace, resolveWorkspacePath } from '../lib/paths.mjs';
import { Problem, problem } from '../lib/problem.mjs';
import { getPointer, setPointer } from '../registry/ajv.mjs';

/** A pin name: 1..128 chars, starts with a lowercase letter or digit, may contain "/" but never "#". */
export const PIN_NAME = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

const badRef = (why) => problem('unknown-ref', why);

/**
 * @typedef {{kind: 'path', path: string}
 *   | {kind: 'job', jobId: string, output: string}
 *   | {kind: 'pin', name: string, output: string|null}} ParsedRef
 */

/**
 * Parse a ref string. Paths are returned as-is (resolveRef validates them); malformed job:/pin: refs throw
 * a 422 `unknown-ref` Problem.
 * @param {string} s
 * @returns {ParsedRef}
 */
export function parseRef(s) {
  if (typeof s !== 'string' || s === '') throw badRef(`ref must be a non-empty string, got ${JSON.stringify(s)}`);
  if (s.startsWith('job:')) {
    const rest = s.slice(4);
    const slash = rest.indexOf('/');
    if (slash < 0) throw badRef(`job ref "${s}" needs an output path (job:<id>/<output>)`);
    const jobId = rest.slice(0, slash);
    const output = rest.slice(slash + 1);
    if (!JOB_ID.test(jobId)) throw badRef(`job ref "${s}" has an invalid job id "${jobId}"`);
    if (!isSafeOutputPath(output)) throw badRef(`job ref "${s}" has an invalid output path "${output}"`);
    return { kind: 'job', jobId, output };
  }
  if (s.startsWith('pin:')) {
    const rest = s.slice(4);
    const parts = rest.split('#');
    if (parts.length > 2) throw badRef(`pin ref "${s}" has more than one "#"`);
    const name = parts[0];
    const output = parts.length === 2 ? parts[1] : null;
    if (!PIN_NAME.test(name)) throw badRef(`pin ref "${s}" has an invalid name "${name}"`);
    if (output !== null && !isSafeOutputPath(output)) throw badRef(`pin ref "${s}" has an invalid output path`);
    return { kind: 'pin', name, output };
  }
  return { kind: 'path', path: s };
}

/** @param {string} rel @param {string} detail */
const notFound = (rel, detail) =>
  new Problem(422, 'file-not-found', 'File not found', detail ?? `"${rel}" does not exist`);

/** Stat a resolved file and describe it. */
async function describeFile(abs, workspace, display) {
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw notFound(display);
  }
  if (!st.isFile()) throw notFound(display);
  return { abs, path: relFromWorkspace(workspace, abs), sha256: await sha256File(abs), bytes: st.size };
}

/** Resolve a workspace path ref, requiring an existing regular file. */
async function resolvePath(rel, workspace) {
  const abs = await resolveWorkspacePath(workspace, rel);
  return describeFile(abs, workspace, rel);
}

/**
 * Resolve a job output, following cached_from up to 5 hops (the files live in the original job's out dir).
 * @returns {Promise<{abs: string, path: string, sha256: string, bytes: number, job: string, output: string}>}
 */
async function resolveJob(jobId, output, { workspace, store }) {
  const job = store.get(jobId);
  if (!job || job.deleted_at) throw badRef(`no job "${jobId}"`);
  if (job.status !== 'succeeded') throw badRef(`job ${jobId} is ${job.status}`);
  let source = job;
  for (let hops = 0; hops < 5 && source.cached_from; hops++) {
    const prev = store.get(source.cached_from);
    if (!prev || prev.deleted_at) throw badRef(`cached job "${source.cached_from}" does not exist`);
    source = prev;
  }
  const outs = source.outputs ?? [];
  if (!outs.some((o) => o.name === output)) {
    const names = outs.map((o) => o.name).join(', ');
    throw badRef(`job ${jobId} has no output "${output}"${names ? ` (available: ${names})` : ''}`);
  }
  const abs = path.join(store.outDir(source.id), ...output.split('/'));
  const described = await describeFile(abs, workspace, `job:${jobId}/${output}`);
  return { ...described, job: jobId, output };
}

/** Resolve a pin ref from its target (blob, job+output, whole job, or path). */
async function resolvePin(parsed, { workspace, store, pins, blobDir }) {
  const p = pins.get(parsed.name);
  if (!p) throw badRef(`no pin named "${parsed.name}"`);
  const target = p.target ?? {};
  if (target.blob) {
    if (parsed.output !== null) throw badRef(`pin ${parsed.name} is content-addressed; drop "#${parsed.output}"`);
    const abs = path.join(blobDir, 'sha256', target.blob.slice(0, 2), target.blob);
    const described = await describeFile(abs, workspace, `pin:${parsed.name}`);
    return { ...described, kind: 'pin', output: null };
  }
  if (target.job && target.output) {
    if (parsed.output !== null && parsed.output !== target.output)
      throw badRef(`pin ${parsed.name} is job:${target.job}/${target.output}, not "#${parsed.output}"`);
    const r = await resolveJob(target.job, target.output, { workspace, store });
    return { ...r, kind: 'pin' };
  }
  if (target.job) {
    if (parsed.output === null) throw badRef(`pin ${parsed.name} targets a whole job; use pin:${parsed.name}#<output>`);
    const r = await resolveJob(target.job, parsed.output, { workspace, store });
    return { ...r, kind: 'pin' };
  }
  if (target.path) {
    const r = await resolvePath(target.path, workspace);
    return { ...r, kind: 'pin', output: null };
  }
  throw badRef(`pin ${parsed.name} has no target`);
}

/**
 * Resolve one ref to a concrete existing file.
 * @param {string} s
 * @param {{workspace: string, store: {get: (id: string) => object|undefined, outDir: (id: string) => string},
 *   pins: {get: (name: string) => object|undefined}, blobDir: string}} deps
 * @returns {Promise<{ref: string, kind: string, abs: string, path: string, sha256: string, bytes: number,
 *   job?: string, output?: string|null}>}
 */
export async function resolveRef(s, { workspace, store, pins, blobDir }) {
  const parsed = parseRef(s);
  if (parsed.kind === 'path') {
    const r = await resolvePath(parsed.path, workspace);
    return { ref: s, kind: 'path', ...r };
  }
  if (parsed.kind === 'job') {
    const r = await resolveJob(parsed.jobId, parsed.output, { workspace, store });
    return { ref: s, kind: 'job', ...r };
  }
  const r = await resolvePin(parsed, { workspace, store, pins, blobDir });
  return { ref: s, ...r };
}

/**
 * Copy a resolved file into the content-addressed blob store (idempotent).
 * @returns {Promise<string>} the blob path relative to the workspace, POSIX.
 */
async function snapshotBlob(abs, sha, { blobDir, workspace }) {
  const rel = path.posix.join('sha256', sha.slice(0, 2), sha);
  const dest = path.join(blobDir, ...rel.split('/'));
  try {
    await stat(dest);
  } catch {
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await copyFile(abs, tmp);
    try {
      await rename(tmp, dest);
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
    }
  }
  return relFromWorkspace(workspace, dest);
}

/**
 * Resolve every ref pointer of a validated input on a clone; never mutate `input`. Small workspace-path refs are
 * additionally snapshotted into the blob store. Job and pin refs are immutable already and never snapshotted.
 * @param {object} input validated input (refs still strings)
 * @param {string[]} refPointers JSON pointers collected from `x-mx-ref`
 * @param {{workspace: string, store: object, pins: object, blobDir: string}} deps
 * @param {{snapshotMaxBytes?: number}} [opts]
 * @returns {Promise<{resolvedInput: object, inputs: {pointer: string, ref: string, path: string, sha256: string,
 *   bytes: number, snapshot: string|null}[]}>}
 */
export async function resolveInputRefs(input, refPointers, deps, { snapshotMaxBytes = 5 * 1024 * 1024 } = {}) {
  const resolvedInput = structuredClone(input);
  const inputs = [];
  for (const pointer of refPointers) {
    const ref = getPointer(input, pointer);
    const r = await resolveRef(ref, deps);
    setPointer(resolvedInput, pointer, r.abs);
    let snapshot = null;
    if (r.kind === 'path' && r.bytes <= snapshotMaxBytes) snapshot = await snapshotBlob(r.abs, r.sha256, deps);
    inputs.push({ pointer, ref, path: r.path, sha256: r.sha256, bytes: r.bytes, snapshot });
  }
  return { resolvedInput, inputs };
}

/**
 * Cache key for a job: the tool name, the tool folder hash, the validated input with every ref pointer replaced
 * by the referenced file's sha256. Stable under object-key reordering.
 * @param {string} tool
 * @param {string} toolHash
 * @param {object} input validated input (refs as strings)
 * @param {{pointer: string, sha256: string}[]} inputs
 * @returns {string} sha256 hex
 */
export function cacheKey(tool, toolHash, input, inputs) {
  const withHashes = structuredClone(input);
  for (const i of inputs) setPointer(withHashes, i.pointer, { sha256: i.sha256 });
  return sha256(canonical({ tool, tool_hash: toolHash, input: withHashes }));
}
