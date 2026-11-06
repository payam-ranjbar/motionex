// Process-tree killing. A job may start browsers and grandchildren; none of them may outlive the job.
import { spawnSync } from 'node:child_process';

/**
 * Kill a process and everything it started.
 * win32: taskkill /T /F. posix: signal the process group (the child is spawned detached), falling back to the pid.
 * @param {number} pid
 * @param {NodeJS.Signals|string} [signal]
 */
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}

/**
 * Kill several process groups (e.g. every pid a tool reported through ctx.trackProcess).
 * @param {number[]} pids
 * @param {NodeJS.Signals|string} [signal]
 */
export function killGroups(pids, signal = 'SIGKILL') {
  for (const pid of pids ?? []) killTree(pid, signal);
}

/**
 * Whether a pid is still running, without throwing.
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
