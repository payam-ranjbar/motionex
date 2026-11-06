// JSONL protocol for command tools (any language). See AGENTS.md "Command tools".
//  runner -> tool: argv[last] = path of request.json; env MX_REQUEST, MX_OUT_DIR, MX_SCRATCH_DIR
//  tool -> runner (stdout, one JSON object per line):
//    {"type":"progress","fraction":0.5,"message":"..."}
//    {"type":"log","message":"..."}
//    {"type":"pid","pid":1234}                          (optional: a child process group to kill on cancel)
//    {"type":"result","result":{...},"outputs":[...]}   exactly once on success
//    {"type":"error","error":{"type":"invalid-input","detail":"...","retryable":false}}
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROTOCOL_TYPES = new Set(['progress', 'log', 'pid', 'result', 'error']);

/** Parse one stdout line. @returns {object|null} null for non-JSON lines or unknown types (they are logged). */
export function parseProtocolLine(line) {
  const s = String(line).trim();
  if (!s.startsWith('{')) return null;
  try {
    const msg = JSON.parse(s);
    return msg && PROTOCOL_TYPES.has(msg.type) ? msg : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} scratchDir
 * @param {{job_id: string, tool: string, input: object, raw_input: object, out_dir: string, scratch_dir: string,
 *   workspace: string, tool_dir: string, secrets_dir: string, config: object}} request
 * @returns {Promise<string>} absolute path of request.json
 */
export async function writeRequestFile(scratchDir, request) {
  const file = path.join(scratchDir, 'request.json');
  await writeFile(file, JSON.stringify(request, null, 2), 'utf8');
  return file;
}

/** Interpolate ${MX_PYTHON} ${MX_NODE} ${TOOL_DIR} in a manifest command. */
export function interpolateCommand(command, { python, node, toolDir }) {
  const vars = { MX_PYTHON: python, MX_NODE: node, TOOL_DIR: toolDir };
  return command.map((part) => part.replace(/\$\{(MX_PYTHON|MX_NODE|TOOL_DIR)\}/g, (_, k) => vars[k]));
}

/** Environment for a command tool. */
export function commandEnv({ requestFile, outDir, scratchDir }) {
  return {
    ...process.env,
    MX_REQUEST: requestFile,
    MX_OUT_DIR: outDir,
    MX_SCRATCH_DIR: scratchDir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}
