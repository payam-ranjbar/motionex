// Human preview routes: the same workspace files and bundled browser libs the capture server serves, so a
// person can open http://127.0.0.1:8095/w/films/a/scene.html in a normal browser.
//   GET /w/<workspace path>[?mx_inject=<ref>|<ref>...][?mx_globals=NAME:<ref>,NAME2:<ref>]
//   GET /_mx/lib/<prefix>/<path>
// HTML pages compose the query fragments and JSON globals; everything else is streamed as-is.
import { readFile } from 'node:fs/promises';
import { toWorkspacePath } from '../../lib/paths.mjs';
import { problem } from '../../lib/problem.mjs';
import { composeHtml } from '../../lib/static.mjs';
import { streamFile } from '../router.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Resolve a workspace-relative POSIX ref, or throw a 404 for the preview. */
function workspacePath(workspace, rel, what) {
  try {
    return toWorkspacePath(workspace, rel);
  } catch {
    throw problem('not-found', `${what} "${rel}" is not a workspace file`);
  }
}

/** Read a file as UTF-8 text, or throw a 404 naming the ref. */
async function readText(abs, what) {
  try {
    return await readFile(abs, 'utf8');
  } catch {
    throw problem('file-not-found', `${what} "${abs}"`);
  }
}

/** `mx_inject=<ref>|<ref>` -> absolute paths of the fragment files, in order. */
async function readFragments(workspace, raw) {
  if (!raw) return [];
  const refs = raw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const texts = [];
  for (const ref of refs)
    texts.push(await readText(workspacePath(workspace, ref, 'inject fragment'), 'inject fragment'));
  return texts;
}

/** `mx_globals=NAME:<ref>,NAME2:<ref>` -> {NAME: parsed JSON}. */
async function readGlobals(workspace, raw) {
  if (!raw) return {};
  const globals = {};
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const at = part.indexOf(':');
    if (at <= 0 || at === part.length - 1) {
      throw problem('invalid-request', `mx_globals entry "${part}" must be NAME:<workspace path>.json`);
    }
    const name = part.slice(0, at).trim();
    const ref = part.slice(at + 1).trim();
    const abs = workspacePath(workspace, ref, 'global');
    const text = await readText(abs, 'global');
    try {
      globals[name] = JSON.parse(text);
    } catch (e) {
      throw problem('invalid-request', `mx_globals "${name}": ${e.message}`);
    }
  }
  return globals;
}

/**
 * Register the preview routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router the service router
 * @param {{config: import('../../runner/types.mjs').Config}} deps service dependencies (`config.libDirs` maps
 *   URL prefix -> absolute lib folder)
 */
export function register(router, deps) {
  const config = deps.config;

  router.add('GET', '/w/*path', async (req, res, ctx) => {
    const rel = ctx.params.path;
    const abs = workspacePath(config.workspace, rel, 'path');
    const html = /\.html?$/i.test(rel);
    const query = ctx.query;
    if (html && (query.get('mx_inject') || query.get('mx_globals'))) {
      const [inject, globals] = await Promise.all([
        readFragments(config.workspace, query.get('mx_inject')),
        readGlobals(config.workspace, query.get('mx_globals')),
      ]);
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE },
        body: composeHtml(await readText(abs, 'page'), { inject, globals }),
      };
    }
    await streamFile(req, res, abs, { headers: NO_STORE });
  });

  router.add('GET', '/_mx/lib/*path', async (req, res, ctx) => {
    const rest = ctx.params.path;
    const slash = rest.indexOf('/');
    if (slash <= 0) throw problem('not-found', 'a lib prefix is required: /_mx/lib/<prefix>/<path>');
    const prefix = rest.slice(0, slash);
    const dir = config.libDirs?.[prefix];
    if (!dir) throw problem('not-found', `no lib directory is served as "${prefix}"`);
    const abs = workspacePath(dir, rest.slice(slash + 1), 'lib path');
    await streamFile(req, res, abs, { headers: NO_STORE });
  });
}
