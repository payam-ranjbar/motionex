// GET /v1/skill           -> {name: "motionex", files: [...]}  (every file in the skill folder + references/tools.md)
// GET /v1/skill/*path     -> the file, streamed from skillDir; references/tools.md is rendered from the live registry
// so tools mounted from an extensions folder show up without regenerating anything.
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { mediaTypeOf } from '../../lib/media-types.mjs';
import { problem } from '../../lib/problem.mjs';
import { renderToolDocs } from '../../lib/tool-docs.mjs';
import { streamFile } from '../router.mjs';

const TOOLS_DOC = 'references/tools.md';
const MARKDOWN = 'text/markdown; charset=utf-8';

/** Every regular file under `dir` as POSIX paths relative to `base` ([] when the folder does not exist). */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Resolve a skill-relative POSIX path inside the skill folder.
 * Refuses empty paths, NULs, backslashes, absolute paths, ".." escapes and symlinks that leave the folder,
 * and refuses anything that is not an existing file: all of those are a 404 not-found.
 * @param {string} skillDir absolute skill folder
 * @param {string} rel decoded wildcard path, e.g. "references/voice.md"
 * @returns {Promise<{abs: string, real: string}>}
 * @throws {import('../../lib/problem.mjs').Problem} 404 not-found
 */
async function resolveSkillFile(skillDir, rel) {
  const notFound = () => problem('not-found', `no skill file "${String(rel)}"`);
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) throw notFound();
  if (rel.includes('\\')) throw notFound();
  if (path.isAbsolute(rel) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw notFound();

  const root = path.resolve(skillDir);
  const abs = path.resolve(root, ...rel.split('/'));
  const back = path.relative(root, abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw notFound();

  // A symlink inside the skill folder must not lead outside of it.
  let realRoot;
  let real;
  try {
    realRoot = await realpath(root);
    real = await realpath(abs);
  } catch {
    throw notFound();
  }
  const realBack = path.relative(realRoot, real);
  if (realBack === '' || realBack.startsWith('..') || path.isAbsolute(realBack)) throw notFound();

  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw notFound();
  return { abs, real };
}

/**
 * Register the skill routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{config: import('../../runner/types.mjs').Config, registry: import('../../registry/registry.mjs').Registry, skillDir?: string}} deps
 */
export function register(router, deps) {
  const skillDir = path.resolve(deps.skillDir ?? path.join(deps.config.appRoot, 'skill', 'motionex'));

  router.add('GET', '/v1/skill', async () => {
    const files = new Set(await listFiles(skillDir));
    files.add(TOOLS_DOC); // always listed, even before it has been generated on disk
    return { name: 'motionex', files: [...files].sort() };
  });

  router.add('GET', '/v1/skill/*path', async (req, res, ctx) => {
    const rel = ctx.params.path;
    if (rel === TOOLS_DOC) {
      return {
        status: 200,
        headers: { 'Content-Type': MARKDOWN },
        body: renderToolDocs(deps.registry.list()),
      };
    }
    const file = await resolveSkillFile(skillDir, rel);
    await streamFile(req, res, file.real, { mediaType: mediaTypeOf(file.abs) });
    return undefined;
  });
}
