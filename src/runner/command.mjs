// Start a command tool (any language) with the JSONL protocol in src/runner/protocol.mjs.
//   const {child, done} = await startCommandTool({...});
//   done.then(({result, outputs}) => ...).catch((err) => ...);   // err is a ToolError
import { spawn } from 'node:child_process';
import { ToolError } from '../lib/errors.mjs';
import { commandEnv, interpolateCommand, parseProtocolLine, writeRequestFile } from './protocol.mjs';

const STDERR_TAIL = 4000;

/**
 * Writes request.json into scratchDir, spawns interpolateCommand(entry.manifest.command) + [requestFile] with cwd = entry.dir,
 * env = commandEnv(...), stdio ['ignore','pipe','pipe'], detached on POSIX (own process group).
 * stdout lines -> parseProtocolLine: progress/log/pid -> onEvent(msg); result/error -> settles `done`; other lines -> onStderr(line).
 * stderr chunks -> onStderr(text).
 *
 * ASYNC: it awaits writing request.json before spawning, so the caller must await it:
 * `const {child, done} = await startCommandTool({...})`.
 *
 * @param {{job: {id: string, tool: string, tool_version?: string}, entry: import('./types.mjs').ToolEntry,
 *   input: object, rawInput: object, outDir: string, scratchDir: string, config: Readonly<import('./types.mjs').Config>,
 *   onEvent?: (msg: object) => void, onStderr?: (text: string) => void}} args
 * @returns {Promise<{child: import('node:child_process').ChildProcess,
 *   done: Promise<{result: object, outputs?: object[]}>}>}
 *   done resolves on exit 0 with a result line; rejects ToolError(error.type, error.detail) for an error line;
 *   a spawn failure rejects ToolError('tool-failed', <spawn message>);
 *   otherwise rejects ToolError('tool-failed', 'exited with code <code> without a result: <last 4000 chars of stderr>').
 */
export async function startCommandTool({ job, entry, input, rawInput, outDir, scratchDir, config, onEvent, onStderr }) {
  const emitEvent = (msg) => onEvent?.(msg);
  const emitLog = (text) => {
    if (text) onStderr?.(text);
  };

  const requestFile = await writeRequestFile(scratchDir, {
    job_id: job.id,
    tool: job.tool,
    input,
    raw_input: rawInput,
    out_dir: outDir,
    scratch_dir: scratchDir,
    workspace: config.workspace,
    tool_dir: entry.dir,
    secrets_dir: config.secretsDir,
    config,
  });

  const [cmd, ...args] = interpolateCommand(entry.manifest.command, {
    python: config.python,
    node: config.node,
    toolDir: entry.dir,
  });

  const child = spawn(cmd, [...args, requestFile], {
    cwd: entry.dir,
    env: commandEnv({ requestFile, outDir, scratchDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
    emitLog(text);
  });

  // The first result/error line wins; anything after it is just log text.
  let final = null;
  const takeLine = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const msg = parseProtocolLine(line);
    if (!msg) {
      if (line.trim()) emitLog(`${line}\n`);
      return;
    }
    if (msg.type === 'result' || msg.type === 'error') {
      if (final) emitLog(`${line}\n`);
      else final = msg;
      return;
    }
    emitEvent(msg);
  };

  // Buffer partial lines across chunks (UTF-8 decoding is handled by setEncoding's StringDecoder).
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) takeLine(line);
  });

  const done = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    // Spawn failures (ENOENT, EACCES, ...) reject here; 'close' may never follow.
    child.on('error', (err) => {
      const why = String(err?.message ?? err);
      settle(reject, new ToolError('tool-failed', `could not start ${cmd}: ${why}`));
    });

    child.on('close', (code) => {
      if (buffer) {
        const last = buffer;
        buffer = '';
        takeLine(last);
      }
      const msg = final;
      if (msg?.type === 'error') {
        const e = msg.error ?? {};
        settle(reject, new ToolError(e.type ?? 'tool-failed', e.detail ?? 'failed', { retryable: e.retryable }));
        return;
      }
      if (msg?.type === 'result' && code === 0) {
        settle(resolve, { result: msg.result ?? {}, outputs: msg.outputs });
        return;
      }
      settle(reject, new ToolError('tool-failed', `exited with code ${code} without a result: ${stderrTail}`));
    });
  });

  return { child, done };
}
