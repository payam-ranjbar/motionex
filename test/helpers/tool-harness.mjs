// runTool: run one tool exactly the way the service will (validated input, refs resolved to absolute paths,
// a child process per run), without the HTTP server or the job store. Used by tool tests and the contract suite.
//
//   const { result, outputs, outDir } = await runTool('audio.loudness', { input: 'tone.wav' }, { workspace });
//
// Only workspace-path refs are supported here (no job:/pin:). Errors are thrown as ToolError with .type.
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { newJobId } from '../../src/lib/ids.mjs';
import { toWorkspacePath } from '../../src/lib/paths.mjs';
import { getPointer, setPointer } from '../../src/registry/ajv.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { commandEnv, interpolateCommand, parseProtocolLine, writeRequestFile } from '../../src/runner/protocol.mjs';

const NODE_HOST = fileURLToPath(new URL('../../src/runner/node-host.mjs', import.meta.url));
const registries = new Map();

/** Config for a test workspace (env MX_* still applies). */
export function testConfig(workspace, extraEnv = {}) {
  return loadConfig({ ...process.env, MX_WORKSPACE: workspace, ...extraEnv });
}

/** Cached registry per tools-dirs + workspace. */
export async function getRegistry(config) {
  const key = JSON.stringify([config.toolsDirs, config.secretsDir, config.presetsDirs]);
  if (!registries.has(key)) registries.set(key, await loadRegistry({ config }));
  return registries.get(key);
}

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs, base)));
    else out.push({ name: path.relative(base, abs).split(path.sep).join('/'), abs, bytes: (await stat(abs)).size });
  }
  return out;
}

/**
 * @param {string} name tool name
 * @param {object} input tool input (workspace-relative paths for refs)
 * @param {{workspace: string, config?: object, timeoutMs?: number, signal?: AbortSignal, keepScratch?: boolean}} opts
 * @returns {Promise<{result: object, outputs: {name: string, abs: string, bytes: number}[], outDir: string,
 *   events: object[], log: string, input: object}>}
 */
export async function runTool(
  name,
  input,
  { workspace, config, timeoutMs = 120_000, signal, keepScratch = false } = {},
) {
  config ??= testConfig(workspace);
  const registry = await getRegistry(config);
  const entry = registry.get(name);
  if (!entry) {
    const bad = registry.invalid().find((i) => path.basename(i.dir) === name);
    throw new Error(bad ? `tool ${name} is invalid: ${bad.errors.join('; ')}` : `no tool "${name}"`);
  }
  if (!entry.available) throw new Error(`tool ${name} is unavailable: ${entry.unavailableReason}`);
  const v = registry.validate(name, input);
  if (!v.ok)
    throw new ToolError('invalid-input', v.errors.map((e) => `${e.field} ${e.message}`).join('; '), {
      errors: v.errors,
    });
  const resolved = structuredClone(v.input);
  for (const ptr of v.refPointers) {
    const ref = getPointer(v.input, ptr);
    if (/^(job|pin):/.test(ref)) throw new Error(`runTool supports workspace paths only (got ${ref})`);
    setPointer(resolved, ptr, toWorkspacePath(workspace, ref));
  }

  const id = newJobId();
  const outDir = path.join(config.stateDir, 'jobs', id, 'out');
  const scratchDir = path.join(config.scratchDir, id);
  await mkdir(outDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  const job = { id, tool: name, tool_version: entry.manifest.version };
  const events = [];
  let log = '';
  let final = null;

  const child = (() => {
    if (entry.manifest.kind === 'node') {
      const mem = entry.manifest.resources.memory_mb;
      return spawn(process.execPath, [...(mem ? [`--max-old-space-size=${mem}`] : []), NODE_HOST], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    }
    return null;
  })();

  const onMessage = (msg) => {
    if (msg?.type === 'result' || msg?.type === 'error') final = msg;
    else if (msg) events.push(msg);
  };

  let proc = child;
  if (child) {
    child.on('message', onMessage);
    child.send({
      type: 'run',
      handlerPath: path.join(entry.dir, entry.manifest.handler),
      input: resolved,
      rawInput: v.input,
      ctxInit: {
        job,
        workspace,
        outDir,
        scratchDir,
        toolDir: entry.dir,
        blobDir: path.join(config.stateDir, 'blobs'),
        config,
      },
    });
  } else {
    const requestFile = await writeRequestFile(scratchDir, {
      job_id: id,
      tool: name,
      input: resolved,
      raw_input: v.input,
      out_dir: outDir,
      scratch_dir: scratchDir,
      workspace,
      tool_dir: entry.dir,
      secrets_dir: config.secretsDir,
      config,
    });
    const [cmd, ...args] = interpolateCommand(entry.manifest.command, {
      python: config.python,
      node: config.node,
      toolDir: entry.dir,
    });
    proc = spawn(cmd, [...args, requestFile], {
      cwd: entry.dir,
      env: commandEnv({ requestFile, outDir, scratchDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const msg = parseProtocolLine(l);
        if (msg) onMessage(msg);
        else if (l.trim()) log += `${l}\n`;
      }
    });
  }
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    log += d;
  });

  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  const onAbort = () => proc.kill('SIGTERM');
  signal?.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise((resolve) => proc.on('close', resolve));
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  if (!keepScratch) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});

  if (!final) {
    throw new ToolError('tool-failed', `tool ${name} exited with ${code} and no result:\n${log.slice(-4000)}`);
  }
  if (final.type === 'error') {
    const e = final.error ?? {};
    throw Object.assign(new ToolError(e.type ?? 'tool-failed', e.detail ?? 'failed', { retryable: e.retryable }), {
      log,
      events,
    });
  }
  const check = registry.validateResult(name, final.result);
  if (!check.ok) {
    throw new ToolError('invalid-output', check.errors.map((e) => `${e.field} ${e.message}`).join('; '));
  }
  const outputs = await walk(outDir);
  return { result: final.result, outputs, outDir, events, log, input: v.input };
}
