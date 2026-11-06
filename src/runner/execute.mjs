// Executes ONE job's handler in a child process: streams its events, enforces timeout/cancel, and kills the
// whole process tree (browsers, grandchildren) when the job ends. See src/runner/node-host.mjs for the IPC protocol.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../lib/errors.mjs';
import { startCommandTool } from './command.mjs';
import { killGroups, killTree } from './kill.mjs';

const NODE_HOST = fileURLToPath(new URL('./node-host.mjs', import.meta.url));

/**
 * @param {{config: import('../lib/config.mjs').Config}} opts
 * @returns {{run: (args: {
 *   job: {id: string, tool: string, tool_version: string},
 *   entry: import('./types.mjs').ToolEntry,
 *   input: object, rawInput: object, outDir: string, scratchDir: string,
 *   timeoutMs?: number, signal?: AbortSignal, onEvent?: (msg: object) => void, logFile: string,
 * }) => Promise<{result: object, outputs?: object[]}>}}
 */
export function createExecutor({ config }) {
  return {
    async run({ job, entry, input, rawInput, outDir, scratchDir, timeoutMs = 0, signal, onEvent, logFile }) {
      await mkdir(path.dirname(logFile), { recursive: true });
      const logStream = createWriteStream(logFile, { flags: 'a' });
      logStream.on('error', () => {});
      const appendLog = (text) => {
        if (text) logStream.write(text);
      };
      let stderrTail = '';
      const appendStderr = (text) => {
        if (!text) return;
        stderrTail = (stderrTail + text).slice(-4000);
        appendLog(text);
      };

      const trackedPids = [];
      const track = (pid) => {
        if (Number.isInteger(pid)) trackedPids.push(pid);
      };

      let child = null;
      let donePromise = null;
      let final = null;
      let reason = null;
      let terminated = false;
      let exitResolved = false;
      let timeoutTimer = null;
      let graceTimer = null;
      let abortHandler = null;

      const closeLog = () => new Promise((resolve) => logStream.end(resolve));

      try {
        if (entry.manifest.kind === 'node') {
          const mem = entry.manifest.resources?.memory_mb;
          child = spawn(process.execPath, [...(mem ? [`--max-old-space-size=${mem}`] : []), NODE_HOST], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            detached: process.platform !== 'win32',
            windowsHide: true,
            env: { ...process.env, MX_KILL_GRACE_MS: String(config.killGraceMs) },
          });
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (d) => appendLog(d));
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (d) => appendStderr(d));
          child.on('message', (msg) => {
            if (!msg) return;
            if (msg.type === 'progress' || msg.type === 'log') onEvent?.(msg);
            else if (msg.type === 'pid') track(msg.pid);
            else if (msg.type === 'result' || msg.type === 'error') final = msg;
          });
          try {
            child.send({
              type: 'run',
              handlerPath: path.join(entry.dir, entry.manifest.handler),
              input,
              rawInput,
              ctxInit: {
                job: { id: job.id, tool: job.tool, tool_version: job.tool_version },
                workspace: config.workspace,
                outDir,
                scratchDir,
                toolDir: entry.dir,
                blobDir: path.join(config.stateDir, 'blobs'),
                config,
              },
            });
          } catch {
            // spawn failed; the exit promise below reports it
          }
        } else {
          const started = await startCommandTool({
            job,
            entry,
            input,
            rawInput,
            outDir,
            scratchDir,
            config,
            onEvent: (m) => (m.type === 'pid' ? track(m.pid) : onEvent?.(m)),
            onStderr: (t) => appendLog(t),
          });
          child = started.child;
          donePromise = started.done;
        }

        const exitPromise = new Promise((resolve) => {
          const done = (info) => {
            if (exitResolved) return;
            exitResolved = true;
            resolve(info);
          };
          child.once('close', (code, sig) => done({ code, signal: sig }));
          child.once('error', (err) => done({ code: null, signal: null, error: err }));
          // 'close' waits for the child's stdio to close. A leftover grandchild can hold those pipes open forever
          // after the child itself exited (seen once: a job stayed "running" for 30 min after its handler
          // finished). Settle a few seconds after 'exit' regardless, and kill the child's process group.
          child.once('exit', (code, sig) => {
            const t = setTimeout(() => {
              if (!exitResolved) killTree(child.pid, 'SIGKILL');
              done({ code, signal: sig });
            }, 3000);
            t.unref?.();
          });
        });

        // A node child that delivered its final message but does not exit within 10 s is stuck (e.g. its IPC send
        // callback never fired): kill it; the delivered result still counts.
        let lingerTimer = null;
        if (entry.manifest.kind === 'node') {
          child.on('message', (msg) => {
            if ((msg?.type === 'result' || msg?.type === 'error') && !lingerTimer) {
              lingerTimer = setTimeout(() => {
                if (!exitResolved) killTree(child.pid, 'SIGKILL');
              }, 10_000);
              lingerTimer.unref?.();
            }
          });
        }

        const terminate = (why) => {
          if (terminated) return;
          terminated = true;
          reason = why;
          if (entry.manifest.kind === 'node' && child.connected) {
            try {
              child.send({ type: 'cancel' });
            } catch {}
          }
          try {
            child.kill('SIGTERM');
          } catch {}
          graceTimer = setTimeout(() => {
            if (exitResolved) return;
            killTree(child.pid, 'SIGKILL');
            killGroups(trackedPids);
          }, config.killGraceMs);
          graceTimer.unref?.();
        };

        if (timeoutMs > 0) {
          timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
          timeoutTimer.unref?.();
        }
        if (signal) {
          if (signal.aborted) terminate('canceled');
          else {
            abortHandler = () => terminate('canceled');
            signal.addEventListener('abort', abortHandler, { once: true });
          }
        }

        let commandOutcome = null;
        const doneSettled = donePromise
          ? donePromise.then(
              (value) => {
                commandOutcome = { ok: true, value };
              },
              (error) => {
                commandOutcome = { ok: false, error };
              },
            )
          : Promise.resolve();

        const exitInfo = await exitPromise;
        clearTimeout(timeoutTimer);
        clearTimeout(graceTimer);
        if (abortHandler) signal.removeEventListener('abort', abortHandler);
        killGroups(trackedPids);
        await doneSettled;

        if (reason) {
          const seconds = timeoutMs > 0 ? timeoutMs / 1000 : 0;
          throw new ToolError(
            reason === 'timeout' ? 'timeout' : 'canceled',
            reason === 'timeout' ? `timed out after ${seconds} s` : 'canceled',
          );
        }

        if (entry.manifest.kind === 'node') {
          if (final?.type === 'result') return { result: final.result, outputs: final.outputs };
          if (final?.type === 'error') {
            const e = final.error ?? {};
            throw new ToolError(e.type ?? 'tool-failed', e.detail ?? 'failed', { retryable: e.retryable });
          }
        } else if (commandOutcome) {
          if (commandOutcome.ok) return commandOutcome.value;
          const e = commandOutcome.error;
          if (e instanceof ToolError) throw e;
          throw new ToolError(e?.type ?? 'tool-failed', e?.detail ?? e?.message ?? 'failed', {
            retryable: e?.retryable,
          });
        }

        if (/heap out of memory/i.test(stderrTail)) {
          throw new ToolError('out-of-memory', `out of memory: ${stderrTail}`);
        }
        throw new ToolError(
          'tool-failed',
          `exited with code ${exitInfo.code} (signal ${exitInfo.signal}): ${stderrTail}`,
        );
      } finally {
        clearTimeout(timeoutTimer);
        clearTimeout(graceTimer);
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
        await closeLog();
      }
    },
  };
}
