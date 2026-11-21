// Creates a workspace from the template in skill/workspace/template: a folder of its own that holds the user's
// settings, the skills an agent follows there and its projects. The template decides nothing about the films; it is
// copied as it is, with the workspace's name, the date and the engine's address filled in.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Template file names that are written under another name (a dot-file would be dropped by packaging tools). */
const RENAME = Object.freeze({ gitignore: '.gitignore' });

/** Entries a folder may already hold and still count as empty for a new workspace. */
const IGNORED_IN_TARGET = new Set(['.git']);

/**
 * Every regular file under `dir`, as POSIX paths relative to it, sorted.
 * @param {string} dir
 * @param {string} [base]
 * @returns {Promise<string[]>}
 */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * The path a template file gets in the workspace.
 * @param {string} rel template-relative POSIX path
 * @returns {string}
 */
export function targetName(rel) {
  const parts = rel.split('/');
  const last = parts.pop();
  return [...parts, RENAME[last] ?? last].join('/');
}

/**
 * Fill `{{name}}`, `{{date}}` and `{{engine_url}}` in a template text. Unknown placeholders are left as they are.
 * @param {string} text
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => (Object.hasOwn(values, key) ? values[key] : whole));
}

/**
 * Copy the workspace template into `target`. Nothing that exists is overwritten.
 * @param {object} options
 * @param {string} options.templateDir absolute folder of the template
 * @param {string} options.target absolute folder of the new workspace (created when missing)
 * @param {string} options.name the workspace's name, as the user gave it
 * @param {string} options.engineUrl the engine's base URL, written into the workspace's files
 * @param {string} options.date the date written into the files (YYYY-MM-DD)
 * @param {boolean} [options.add] allow a folder that already has files, and add only what is missing
 * @param {boolean} [options.dry] report what would be written and write nothing
 * @returns {Promise<{created: string[], kept: string[]}>} workspace-relative POSIX paths
 * @throws {Error} with `code: 'not-empty'` when the folder has files and `add` is not set
 */
export async function initWorkspace({ templateDir, target, name, engineUrl, date, add = false, dry = false }) {
  const existing = await readdir(target).catch(() => []);
  if (!add && existing.some((entry) => !IGNORED_IN_TARGET.has(entry))) {
    const error = new Error(`${target} already has files; use --add to add only the template files that are missing`);
    error.code = 'not-empty';
    throw error;
  }
  const values = { name, date, engine_url: engineUrl };
  const created = [];
  const kept = [];
  for (const rel of await listFiles(templateDir)) {
    const out = targetName(rel);
    const abs = path.join(target, ...out.split('/'));
    if (await stat(abs).catch(() => null)) {
      kept.push(out);
      continue;
    }
    created.push(out);
    if (dry) continue;
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, fill(await readFile(path.join(templateDir, ...rel.split('/')), 'utf8'), values));
  }
  return { created, kept };
}
