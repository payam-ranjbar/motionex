// Node-compat fixes for Strudel's browser-first dependency tree. Import this
// before anything that pulls in @strudel/* (each worker thread needs it too).
//
// 1. Some packages (e.g. @kabelsalat/web) point "main" at a browser IIFE bundle
//    and have no "exports" map. Bundlers use the ESM "module" field instead, so
//    we do the same when that file really is ESM.
// 2. A few CommonJS packages export names Node's static analysis can't see
//    (soundfont2). Those get a tiny ESM shim from ./shims.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const BARE = /^(@[^/]+\/[^/]+|[^./][^/]*)$/;
const ESM_SYNTAX = /^\s*(import\s*[\w{*'"]|export\s+[\w{*])/m;
const SHIMS = {
  soundfont2: new URL('./shims/soundfont2.mjs', import.meta.url).href,
};

const memo = new Map();
// Entry files we redirected; they're ESM even if their package.json says CommonJS.
const esmEntries = new Set();

function moduleEntry(pkgDir) {
  if (memo.has(pkgDir)) return memo.get(pkgDir);
  let entry = null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (!pkg.exports && pkg.module && pkg.main !== pkg.module) {
      const file = path.join(pkgDir, pkg.module);
      if (ESM_SYNTAX.test(readFileSync(file, 'utf8'))) entry = pathToFileURL(file).href;
    }
  } catch {}
  memo.set(pkgDir, entry);
  return entry;
}

function packageDir(fileUrl) {
  let dir = path.dirname(fileURLToPath(fileUrl));
  while (path.basename(dir) !== 'node_modules' && dir !== path.dirname(dir)) {
    try {
      readFileSync(path.join(dir, 'package.json'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (SHIMS[specifier] && context.parentURL !== SHIMS[specifier]) {
      return { url: SHIMS[specifier], format: 'module', shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    if (!BARE.test(specifier) || !result.url.startsWith('file:')) return result;
    const dir = packageDir(result.url);
    const entry = dir && moduleEntry(dir);
    if (!entry) return result;
    esmEntries.add(entry);
    return { ...result, url: entry, format: 'module' };
  },
  load(url, context, nextLoad) {
    return nextLoad(url, esmEntries.has(url) ? { ...context, format: 'module' } : context);
  },
});
