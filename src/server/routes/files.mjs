// Workspace file routes: list, stream, upload and delete files under the workspace root.
// Agents that do not share the bind-mounted folder use these to move scene pages, songs, recipes and results.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isReserved, relFromWorkspace, toWorkspacePath } from '../../lib/paths.mjs';
import { problem } from '../../lib/problem.mjs';
import { resolveRef } from '../../runner/refs.mjs';
import { streamFile } from '../router.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for `?flag=1` (and true/yes/on); false when absent, empty, 0 or false. */
function flag(value) {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Staging path for an upload of `target`: `<target>.<random>.upload` in the same folder. */
function tempPathFor(target) {
  return path.join(path.dirname(target), `${path.basename(target)}.${randomBytes(8).toString('hex')}.upload`);
}

/**
 * Walk `dir` and push listing rows (path, bytes, mtime, dir). `.mx` and everything under it is skipped
 * unless `includeState`. Unreadable nested folders are skipped.
 * @param {string} root absolute workspace root
 * @param {string} dir absolute folder to read
 * @param {boolean} recursive
 * @param {boolean} includeState
 * @param {{path: string, bytes: number, mtime: string, dir: boolean}[]} out
 */
async function walk(root, dir, recursive, includeState, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relFromWorkspace(root, abs);
    if (!includeState && isReserved(rel)) continue;
    const isDir = entry.isDirectory();
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    out.push({ path: rel, bytes: isDir ? 0 : st.size, mtime: new Date(st.mtimeMs).toISOString(), dir: isDir });
    if (recursive && isDir) await walk(root, abs, recursive, includeState, out);
  }
}

/**
 * Stream the request body into a temp file next to `target`, hashing (sha256) and counting bytes as it goes.
 * Past `max` bytes it drains the request, removes the temp file and rejects with a 413.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} target absolute destination path
 * @param {number} max
 * @returns {Promise<{tmp: string, bytes: number, sha256: string}>}
 */
function writeUpload(req, target, max) {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > max) {
      req.on('error', () => {});
      req.resume();
      return Promise.reject(problem('payload-too-large', `limit ${max} bytes`));
    }
  }

  const tmp = tempPathFor(target);
  const out = createWriteStream(tmp, { flags: 'wx' });
  const hash = createHash('sha256');
  let total = 0;
  let done = false;

  return new Promise((resolve, reject) => {
    const fail = (err) => {
      if (done) return;
      done = true;
      req.on('error', () => {});
      req.resume();
      const cleanup = () => {
        rm(tmp, { force: true })
          .catch(() => {})
          .then(() => reject(err));
      };
      if (out.closed || out.destroyed) cleanup();
      else {
        out.once('close', cleanup);
        out.destroy();
      }
    };

    out.on('error', fail);
    out.on('finish', () => {
      if (done) return;
      done = true;
      resolve({ tmp, bytes: total, sha256: hash.digest('hex') });
    });
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > max) {
        fail(problem('payload-too-large', `limit ${max} bytes`));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (done) return;
      out.end();
    });
    req.on('error', fail);
    req.on('aborted', () => fail(problem('internal', 'request aborted')));
  });
}

/**
 * Rename a staged file over its destination, retrying on Windows sharing violations.
 * After 10 attempts (50 ms apart) it throws 409 `file-locked` and removes the temp file.
 * @param {string} tmp
 * @param {string} target
 * @param {string} rel workspace-relative path, for the error detail
 */
async function renameOver(tmp, target, rel) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const locked = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (locked && attempt < 9) {
        await delay(50);
        continue;
      }
      await rm(tmp, { force: true }).catch(() => {});
      if (locked) throw problem('file-locked', `"${rel}" is open in another program`);
      throw err;
    }
  }
}

/**
 * Register the `/v1/files` routes on a router.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{config: import('../../runner/types.mjs').Config, store: object, pins: {get: (name: string) => object|undefined}}} deps
 */
export function register(router, deps) {
  const { config, store, pins } = deps;

  // Listing: `GET /v1/files` (exact path). Registered before the wildcard so the root listing wins.
  router.add('GET', '/v1/files', async (_req, _res, ctx) => {
    const rawPrefix = ctx.query.get('prefix') ?? '';
    const prefixAbs = rawPrefix === '' ? config.workspace : toWorkspacePath(config.workspace, rawPrefix);
    let st;
    try {
      st = await stat(prefixAbs);
    } catch {
      throw problem('file-not-found', rawPrefix);
    }
    if (!st.isDirectory()) throw problem('file-not-found', rawPrefix);

    const recursive = flag(ctx.query.get('recursive'));
    const includeState = flag(ctx.query.get('include_state'));
    const files = [];
    await walk(config.workspace, prefixAbs, recursive, includeState, files);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files };
  });

  // Stream a file (Range/ETag/HEAD handled by streamFile). Directories are handled by the listing.
  router.add('GET', '/v1/files/*path', async (req, res, ctx) => {
    const abs = toWorkspacePath(config.workspace, ctx.params.path);
    await streamFile(req, res, abs);
  });

  // Upload: raw body, or a server-side copy from a ref.
  router.add('PUT', '/v1/files/*path', async (req, _res, ctx) => {
    const rel = ctx.params.path;
    if (isReserved(rel)) throw problem('reserved-path', rel);
    const abs = toWorkspacePath(config.workspace, rel);
    const outRel = relFromWorkspace(config.workspace, abs);
    await mkdir(path.dirname(abs), { recursive: true });

    const from = ctx.query.get('from');
    if (from !== null) {
      const resolved = await resolveRef(from, {
        workspace: config.workspace,
        store,
        pins,
        blobDir: path.join(config.stateDir, 'blobs'),
      });
      req.resume();
      const tmp = tempPathFor(abs);
      try {
        await copyFile(resolved.abs, tmp);
        await renameOver(tmp, abs, outRel);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return { status: 201, body: { path: outRel, bytes: resolved.bytes, sha256: resolved.sha256 } };
    }

    const { tmp, bytes, sha256 } = await writeUpload(req, abs, config.maxUploadBytes);
    await renameOver(tmp, abs, outRel);
    return { status: 201, body: { path: outRel, bytes, sha256 } };
  });

  // Delete a file, or a whole folder with `?recursive=1`.
  router.add('DELETE', '/v1/files/*path', async (_req, _res, ctx) => {
    const rel = ctx.params.path;
    if (isReserved(rel)) throw problem('reserved-path', rel);
    const abs = toWorkspacePath(config.workspace, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw problem('file-not-found', rel);
    }
    if (st.isDirectory()) {
      if (!flag(ctx.query.get('recursive'))) throw problem('invalid-request', 'directory; pass recursive=1');
      await rm(abs, { recursive: true, force: true });
    } else {
      await rm(abs, { force: true });
    }
    return { status: 204, body: null };
  });
}
