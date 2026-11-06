// Workspace path confinement. Every path an agent sends is a workspace-relative POSIX path.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.mjs';
import { problem } from './problem.mjs';

const outside = (rel, why) => problem('path-outside-workspace', `"${rel}": ${why}`);

/**
 * Lexically resolve a workspace-relative POSIX path to an absolute path.
 * Refuses: non-strings, empty, NUL, backslashes, absolute paths (/x, C:x, //x), and anything that leaves the workspace.
 * @param {string} workspace absolute workspace root
 * @param {string} rel e.g. "films/a/song.strudel"
 * @returns {string} absolute path
 * @throws {import('./problem.mjs').Problem} 422 path-outside-workspace
 */
export function toWorkspacePath(workspace, rel) {
  if (typeof rel !== 'string' || rel === '') throw outside(String(rel), 'empty path');
  if (rel.includes('\0')) throw outside(rel, 'contains NUL');
  if (rel.includes('\\')) throw outside(rel, 'use forward slashes');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw outside(rel, 'absolute paths are not allowed');
  const norm = path.posix.normalize(rel);
  if (norm === '..' || norm.startsWith('../')) throw outside(rel, 'leaves the workspace');
  const root = path.resolve(workspace);
  const abs = norm === '.' ? root : path.resolve(root, ...norm.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw outside(rel, 'leaves the workspace');
  return abs;
}

/**
 * Like toWorkspacePath, then also refuses symlinks that point outside the workspace.
 * The nearest existing ancestor is resolved with realpath.
 */
export async function resolveWorkspacePath(workspace, rel) {
  const abs = toWorkspacePath(workspace, rel);
  const root = await realpath(path.resolve(workspace));
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== root && !real.startsWith(root + path.sep)) throw outside(rel, 'a symlink leaves the workspace');
      return abs;
    } catch (e) {
      if (e?.name === 'Problem') throw e;
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      probe = parent;
    }
  }
}

/** Absolute path -> workspace-relative POSIX path ('' for the root). */
export function relFromWorkspace(workspace, abs) {
  return path.relative(path.resolve(workspace), abs).split(path.sep).join('/');
}

/** True for motionex state: ".mx" and everything under it. */
export function isReserved(rel) {
  const norm = path.posix.normalize(String(rel)).replace(/^\.\//, '');
  return norm === '.mx' || norm.startsWith('.mx/');
}

const NAME = /^[\w.-]{1,128}$/;
/** A single path segment: letters, digits, _ . - ; 1..128 chars; not "." or "..". */
export function isSafeName(name) {
  return typeof name === 'string' && NAME.test(name) && name !== '.' && name !== '..';
}
/** @throws {ToolError} invalid-input */
export function safeName(name, what = 'name') {
  if (!isSafeName(name)) throw new ToolError('invalid-input', `${what} "${name}" must match ^[\\w.-]{1,128}$`);
  return name;
}

/** An output path inside a job's out/ folder: relative POSIX segments, e.g. "stems/dialogue.wav". */
export function isSafeOutputPath(p) {
  return typeof p === 'string' && p.length <= 512 && p.split('/').every(isSafeName);
}
/** @throws {ToolError} invalid-input */
export function safeOutputPath(p, what = 'output') {
  if (!isSafeOutputPath(p))
    throw new ToolError('invalid-input', `${what} "${p}" must be a relative path of [\\w.-] segments`);
  return p;
}
