// STUB (owner: P2b). Replace the bodies; keep the exported names and signatures.
// Start a command tool (any language) with the JSONL protocol in src/runner/protocol.mjs.
import { ToolError } from '../lib/errors.mjs';

/**
 * Writes request.json into scratchDir, spawns interpolateCommand(entry.manifest.command) + [requestFile] with cwd = entry.dir,
 * env = commandEnv(...), stdio ['ignore','pipe','pipe'], detached on POSIX (own process group).
 * stdout lines -> parseProtocolLine: progress/log/pid -> onEvent(msg); result/error -> settles `done`; other lines -> onStderr(line).
 * stderr chunks -> onStderr(text).
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<{result: object, outputs?: object[]}>}}
 *   done resolves on exit 0 with a result line; rejects ToolError(error.type, error.detail) for an error line;
 *   otherwise rejects ToolError('tool-failed', 'exited with <code>: <last 4000 chars of stderr>'). */
export function startCommandTool({ job, entry, input, rawInput, outDir, scratchDir, config, onEvent, onStderr }) {
  throw new ToolError('internal', 'not implemented: startCommandTool');
}
