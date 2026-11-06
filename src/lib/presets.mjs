// Named presets: JSON files in <presetsDir>/<kind>/<name>.json. Later dirs override earlier ones.
// A preset is deep-merged UNDER the request (the request wins). Arrays and scalars are replaced, not merged.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.mjs';

/** @returns {{name: string, file: string}[]} */
export function listPresets(kind, dirs) {
  const found = new Map();
  for (const d of dirs) {
    const dir = path.join(d, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) found.set(f.slice(0, -5), path.join(dir, f));
  }
  return [...found].map(([name, file]) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name));
}

/** @throws {ToolError} invalid-input when missing or not valid JSON */
export function loadPreset(kind, name, dirs) {
  const hit = listPresets(kind, dirs).find((p) => p.name === name);
  if (!hit) {
    const names =
      listPresets(kind, dirs)
        .map((p) => p.name)
        .join(', ') || '(none)';
    throw new ToolError('invalid-input', `no ${kind} preset "${name}"; available: ${names}`);
  }
  try {
    const value = JSON.parse(readFileSync(hit.file, 'utf8'));
    delete value.$comment;
    delete value.description;
    return value;
  } catch (e) {
    throw new ToolError('invalid-input', `${kind} preset "${name}" is not valid JSON: ${e.message}`);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Deep merge: plain objects merge recursively; everything else in `over` replaces `base`. Returns a new object. */
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return structuredClone(over === undefined ? base : over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Read the optional description of a preset (for listings). */
export function presetDescription(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).description ?? null;
  } catch {
    return null;
  }
}
