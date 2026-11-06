// Child process that runs ONE node tool handler, then exits. Spawned with an IPC channel:
//   spawn(process.execPath, ['--max-old-space-size=<mb>', node-host.mjs], {stdio: ['ignore','pipe','pipe','ipc']})
// Parent -> child:  {type:'run', handlerPath, input, rawInput, ctxInit:{job, workspace, outDir, scratchDir, toolDir, blobDir, config}}
//                   {type:'cancel'}
// Child -> parent:  {type:'progress'|'log'|'pid', ...}  then exactly one of
//                   {type:'result', result, outputs?}  |  {type:'error', error:{type,title,detail,retryable}}
// SIGTERM (or 'cancel') aborts ctx.signal; the child exits once the handler settles (or after the grace period).
import { pathToFileURL } from 'node:url';
import { ToolError, toJobError } from '../lib/errors.mjs';
import { makeContext } from './context.mjs';

const ac = new AbortController();
let finished = false;
const GRACE_MS = Number(process.env.MX_KILL_GRACE_MS || 5000);

function send(msg) {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(msg, () => resolve());
  });
}

async function finish(msg, code = 0) {
  if (finished) return;
  finished = true;
  // Never hang after the final message: exit even if the IPC send callback does not fire within 2 s.
  await Promise.race([send(msg), new Promise((resolve) => setTimeout(resolve, 2000))]);
  process.exit(code);
}

function abort() {
  if (!ac.signal.aborted) ac.abort(new ToolError('canceled', 'canceled'));
  setTimeout(
    () =>
      finish(
        { type: 'error', error: new ToolError('canceled', 'canceled (handler did not stop in time)').toJSON() },
        1,
      ),
    GRACE_MS,
  ).unref();
}

process.on('SIGTERM', abort);
process.on('SIGINT', abort);
process.on('disconnect', () => {
  if (!finished) abort();
});
process.on('uncaughtException', (e) => finish({ type: 'error', error: toJobError(e) }, 1));
process.on('unhandledRejection', (e) => finish({ type: 'error', error: toJobError(e) }, 1));

process.on('message', async (msg) => {
  if (msg?.type === 'cancel') return abort();
  if (msg?.type !== 'run') return;
  const { handlerPath, input, rawInput, ctxInit } = msg;
  const ctx = makeContext({ ...ctxInit, rawInput, signal: ac.signal, emit: (ev) => send(ev) });
  try {
    const mod = await import(pathToFileURL(handlerPath).href);
    const run = mod.default ?? mod.run;
    if (typeof run !== 'function') throw new ToolError('internal', `${handlerPath} has no default export function`);
    const out = await run(input, ctx);
    if (ac.signal.aborted) return finish({ type: 'error', error: new ToolError('canceled', 'canceled').toJSON() }, 1);
    await finish({ type: 'result', result: out?.result ?? {}, outputs: out?.outputs });
  } catch (e) {
    const error = ac.signal.aborted ? new ToolError('canceled', 'canceled').toJSON() : toJobError(e);
    await finish({ type: 'error', error }, 1);
  }
});
