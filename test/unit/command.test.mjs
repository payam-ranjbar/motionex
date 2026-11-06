// startCommandTool: the command-tool runner (request.json + JSONL protocol over stdout/stderr).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { newJobId } from '../../src/lib/ids.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { startCommandTool } from '../../src/runner/command.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_TOOLS = path.join(ROOT, 'test', 'fixtures', 'tools');

/**
 * Set up a temp workspace with the fake command tool, run `fn({...})`, then clean up.
 * `override` may replace parts of the entry (e.g. a bogus command or another tool dir).
 */
async function withFakeCmd(input, fn, { override } = {}) {
  const ws = await mkTmp();
  try {
    const config = loadConfig({
      ...process.env,
      MX_WORKSPACE: ws,
      MX_TOOLS_DIRS: FIXTURE_TOOLS,
      MX_EXTENSIONS_DIR: '',
    });
    const registry = await loadRegistry({ config });
    const base = registry.get('fake.cmd');
    assert.ok(base, 'fixture tool fake.cmd is registered');
    const entry = override ? await override(base, { config, ws }) : base;

    const v = registry.validate('fake.cmd', input);
    assert.equal(v.ok, true, JSON.stringify(v.errors));

    const outDir = path.join(ws, 'out');
    const scratchDir = path.join(ws, 'scratch');
    await mkdir(outDir, { recursive: true });
    await mkdir(scratchDir, { recursive: true });

    const events = [];
    const stderr = [];
    const job = { id: newJobId(), tool: 'fake.cmd', tool_version: entry.manifest.version };
    const { child, done } = await startCommandTool({
      job,
      entry,
      input: v.input,
      rawInput: v.input,
      outDir,
      scratchDir,
      config,
      onEvent: (msg) => events.push(msg),
      onStderr: (text) => stderr.push(text),
    });

    return await fn({
      child,
      done,
      events,
      stderr: () => stderr.join(''),
      outDir,
      scratchDir,
      ws,
      entry,
      config,
      input: v.input,
    });
  } finally {
    await rmTmp(ws);
  }
}

test('success: result round-trip, UTF-8 file, progress/log events, stderr and plain lines logged', async () => {
  const message = 'hello ünï ʃˈɒp';
  await withFakeCmd({ message }, async ({ done, events, stderr, outDir }) => {
    const { result, outputs } = await done;
    assert.equal(result.message, message);
    assert.equal(result.env_out_dir, true);
    assert.equal(outputs, undefined);

    assert.equal(await readFile(path.join(outDir, 'msg.txt'), 'utf8'), message);

    const progress = events.find((e) => e.type === 'progress');
    assert.deepEqual(progress, { type: 'progress', fraction: 0.1, message: 'starting' });
    assert.equal(events.find((e) => e.type === 'log')?.message, 'wrote msg.txt');

    const log = stderr();
    assert.match(log, /a plain stdout line is logged/);
    assert.match(log, /stderr goes to the job log/);
  });
});

test('a protocol error line rejects with its type and detail', async () => {
  await withFakeCmd({ message: 'x', fail: true }, async ({ done }) => {
    await assert.rejects(done, (err) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.type, 'invalid-input');
      assert.equal(err.detail, 'asked to fail');
      assert.equal(err.retryable, false);
      return true;
    });
  });
});

test('a tool that exits without a result rejects tool-failed with the exit code', async () => {
  await withFakeCmd({ message: 'x', crash: true }, async ({ done }) => {
    await assert.rejects(done, (err) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.type, 'tool-failed');
      assert.match(err.detail, /code 2/);
      return true;
    });
  });
});

test('a command that cannot be spawned rejects tool-failed', async () => {
  const override = (base) => ({
    ...base,
    manifest: { ...base.manifest, command: ['definitely-not-a-binary-xyz'] },
  });
  await withFakeCmd(
    { message: 'x' },
    async ({ done }) => {
      await assert.rejects(done, (err) => {
        assert.ok(err instanceof ToolError, `expected ToolError, got ${err?.name}`);
        assert.equal(err.type, 'tool-failed');
        assert.match(err.detail, /definitely-not-a-binary-xyz/);
        return true;
      });
    },
    { override },
  );
});

/** Run a throwaway command tool script from the temp workspace instead of the fixture's cmd.mjs. */
async function withScript(script, input, fn) {
  return withFakeCmd(input, fn, {
    override: async (base, { config, ws }) => {
      await writeFile(path.join(ws, 'script.mjs'), script, 'utf8');
      return { ...base, dir: ws, manifest: { ...base.manifest, command: [config.node, 'script.mjs'] } };
    },
  });
}

test('a result JSON line split across two stdout writes is parsed as one result', async () => {
  const script = `import { readFileSync } from 'node:fs';
const req = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const line = JSON.stringify({ type: 'result', result: { message: req.input.message } }) + '\\n';
const half = Math.floor(line.length / 2);
process.stdout.write(line.slice(0, half));
setTimeout(() => process.stdout.write(line.slice(half)), 50);
`;
  await withScript(script, { message: 'split in two' }, async ({ done, events }) => {
    const { result } = await done;
    assert.equal(result.message, 'split in two');
    assert.deepEqual(events, []);
  });
});

test('CRLF lines, a trailing result without newline, and duplicate results after the first', async () => {
  const script = `import { readFileSync } from 'node:fs';
const req = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const result = JSON.stringify({ type: 'result', result: { message: req.input.message } });
process.stdout.write(JSON.stringify({ type: 'progress', fraction: 0.5 }) + '\\r\\n');
process.stdout.write('not json\\r\\n');
process.stdout.write(result);
process.stdout.write('\\n');
process.stdout.write(result + '\\n');
`;
  await withScript(script, { message: 'crlf' }, async ({ done, events, stderr }) => {
    const { result } = await done;
    assert.equal(result.message, 'crlf');
    assert.deepEqual(events, [{ type: 'progress', fraction: 0.5 }]);
    const log = stderr();
    assert.match(log, /not json/);
    // the second (duplicate) result line is logged as text, not parsed again
    assert.match(log, /"type":"result"/);
  });
});
