import { spawn } from 'node:child_process';
// A grandchild that inherits this process's stdout/stderr pipes and outlives it (30 s).
export default async function run() {
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
  return { result: { ok: true } };
}
