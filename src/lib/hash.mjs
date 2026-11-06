import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** sha256 hex of a string or Buffer. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

const memo = new Map();
/** sha256 hex of a file, memoised by (path, size, mtimeMs). */
export async function sha256File(abs) {
  const st = await stat(abs);
  const key = `${abs}|${st.size}|${st.mtimeMs}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const h = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(abs)
      .on('data', (d) => h.update(d))
      .on('end', resolve)
      .on('error', reject);
  });
  const hex = h.digest('hex');
  if (memo.size > 50_000) memo.clear();
  memo.set(key, hex);
  return hex;
}

/**
 * sha256 over a folder: sorted relative paths and file contents (skips node_modules, __pycache__, dot-folders).
 * Used as tool_hash so that editing a handler or manifest changes cache keys.
 */
export async function sha256Dir(dir) {
  const h = createHash('sha256');
  const walk = async (d) => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '__pycache__' || e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        h.update(`${path.relative(dir, abs).split(path.sep).join('/')}\0`);
        h.update(await readFile(abs));
        h.update('\0');
      }
    }
  };
  await walk(dir);
  return h.digest('hex');
}
