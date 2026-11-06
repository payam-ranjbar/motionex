import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
export default async function run(input, ctx) {
  let child = null;
  if (input.spawn_child) {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    ctx.trackProcess(child.pid);
    ctx.log('grandchild ' + child.pid);
  }
  const ms = input.seconds * 1000;
  if (input.ignore_cancel) await sleep(ms);
  else await sleep(ms, null, { signal: ctx.signal });
  child?.kill();
  return { result: { slept: input.seconds, child_pid: child?.pid ?? null } };
}
