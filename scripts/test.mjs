#!/usr/bin/env node
// Test runner by marker (= folder under test/).
//   node scripts/test.mjs unit | tools | contract [tool...] | integration | docker | e2e | live | vendor | default
//   node scripts/test.mjs file <test files...>
// default = unit + tools + contract + integration.  Extra args after "--" go to node --test.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKERS = ['unit', 'tools', 'contract', 'integration', 'docker', 'e2e', 'live'];
const [marker = 'default', ...rest] = process.argv.slice(2);
const dash = rest.indexOf('--');
const args = dash >= 0 ? rest.slice(0, dash) : rest;
const passthrough = dash >= 0 ? rest.slice(dash + 1) : [];

const find = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return find(abs);
    return e.name.endsWith('.test.mjs') ? [abs] : [];
  });
};

const env = { ...process.env };
let files = [];
let setup = true;
if (marker === 'file') files = args.map((f) => path.resolve(f));
else if (marker === 'vendor') {
  files = find(path.join(ROOT, 'vendor', 'mucavex', 'test'));
  setup = false;
} else if (marker === 'default')
  files = ['unit', 'tools', 'contract', 'integration'].flatMap((m) => find(path.join(ROOT, 'test', m)));
else if (MARKERS.includes(marker)) {
  files = find(path.join(ROOT, 'test', marker));
  if (marker === 'contract' && args.length) env.MX_CONTRACT_TOOLS = args.join(',');
  if (marker === 'docker') env.MX_DOCKER_TESTS = '1';
  if (marker === 'live') env.MX_LIVE_TESTS ??= '';
} else {
  console.error(`unknown marker "${marker}". Use: ${[...MARKERS, 'vendor', 'default', 'file'].join(', ')}`);
  process.exit(64);
}
if (!files.length) {
  console.log(`no test files for "${marker}"`);
  process.exit(0);
}
const nodeArgs = [
  ...(setup ? ['--import', './test/helpers/setup.mjs'] : []),
  '--test',
  '--test-reporter=spec',
  ...passthrough,
  ...files,
];
const r = spawnSync(process.execPath, nodeArgs, { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
