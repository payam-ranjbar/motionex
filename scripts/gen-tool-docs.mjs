#!/usr/bin/env node
// Generate the tool reference of the agent skill from the live tool registry.
//   node scripts/gen-tool-docs.mjs                 # writes skill/motionex/references/tools.md
//   node scripts/gen-tool-docs.mjs /path/tools.md  # writes that file instead
// The service renders the same markdown on every GET /v1/skill/references/tools.md, so this file is only a snapshot
// for readers who have no server (or for the skill tarball); rerun it after adding tools.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/lib/config.mjs';
import { renderToolDocs } from '../src/lib/tool-docs.mjs';
import { loadRegistry } from '../src/registry/registry.mjs';

const config = loadConfig();
const registry = await loadRegistry({ config });
const out = path.resolve(process.argv[2] ?? path.join(config.appRoot, 'skill', 'motionex', 'references', 'tools.md'));

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, renderToolDocs(registry.list(), { contracts: registry.listContracts() }), 'utf8');
console.log(out);
