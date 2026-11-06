import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { createRouter } from '../../src/server/router.mjs';
import { register } from '../../src/server/routes/skill.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKES = path.join(ROOT, 'test', 'fixtures', 'tools');
const SKILL_MD = '# motionex skill\n\nMake a video with the tools.\n';

/** A real server on port 0 around the router (unmatched paths answer 404, like the app). */
async function serve(router) {
  const server = http.createServer((req, res) => {
    router
      .handle(req, res, { requestId: 'req-skill', deps: {} })
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found' }));
      })
      .catch(() => {
        res.destroy();
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('skill routes: index, files, live tools.md and path confinement', async () => {
  const tmp = await mkTmp();
  const skillDir = path.join(tmp, 'motionex');
  await mkdir(path.join(skillDir, 'references'), { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  await writeFile(path.join(skillDir, 'references', 'voice.md'), '# voice\n\nSpeak.\n');
  const config = loadConfig({ ...process.env, MX_WORKSPACE: tmp, MX_TOOLS_DIRS: FAKES });
  const registry = await loadRegistry({ config });
  const router = createRouter();
  register(router, { config, registry, skillDir });
  const s = await serve(router);

  try {
    const index = await fetch(`${s.base}/v1/skill`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await index.json(), {
      name: 'motionex',
      files: ['SKILL.md', 'references/tools.md', 'references/voice.md'],
    });

    const skill = await fetch(`${s.base}/v1/skill/SKILL.md`);
    assert.equal(skill.status, 200);
    assert.match(skill.headers.get('content-type'), /^text\/markdown/);
    assert.equal(await skill.text(), SKILL_MD);

    const voice = await fetch(`${s.base}/v1/skill/references/voice.md`);
    assert.equal(voice.status, 200);
    assert.equal(await voice.text(), '# voice\n\nSpeak.\n');

    const tools = await fetch(`${s.base}/v1/skill/references/tools.md`);
    assert.equal(tools.status, 200);
    assert.equal(tools.headers.get('content-type'), 'text/markdown; charset=utf-8');
    const md = await tools.text();
    assert.match(md, /^# motionex tools$/m);
    assert.match(md, /^## fake\.echo$/m); // rendered from the registry, not from disk
    assert.match(md, /`pin:<name>#<output-path>`/);

    for (const bad of [
      '/v1/skill/..%2Fpackage.json',
      '/v1/skill/references/%2E%2E%2F%2E%2E%2Fpackage.json',
      '/v1/skill/%2Fetc%2Fpasswd',
      '/v1/skill/..%5Cpackage.json',
    ]) {
      const res = await fetch(`${s.base}${bad}`);
      assert.equal(res.status, 404, `${bad} must be 404`);
      const body = await res.json();
      assert.equal(body.type, 'urn:motionex:problem:not-found', `${bad} is a not-found problem`);
    }

    const missing = await fetch(`${s.base}/v1/skill/references/nope.md`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).type, 'urn:motionex:problem:not-found');

    const empty = await fetch(`${s.base}/v1/skill/references`);
    assert.equal(empty.status, 404, 'a directory is not a skill file');
  } finally {
    await s.close();
    await rmTmp(tmp);
  }
});

test('skill routes: references/tools.md is served before the skill folder exists', async () => {
  const tmp = await mkTmp();
  const skillDir = path.join(tmp, 'motionex'); // never created
  const config = loadConfig({ ...process.env, MX_WORKSPACE: tmp, MX_TOOLS_DIRS: FAKES });
  const registry = await loadRegistry({ config });
  const router = createRouter();
  register(router, { config, registry, skillDir });
  const s = await serve(router);

  try {
    const index = await fetch(`${s.base}/v1/skill`);
    assert.deepEqual(await index.json(), { name: 'motionex', files: ['references/tools.md'] });

    const tools = await fetch(`${s.base}/v1/skill/references/tools.md`);
    assert.equal(tools.status, 200);
    assert.match(await tools.text(), /^## fake\.sleep$/m);

    const missing = await fetch(`${s.base}/v1/skill/SKILL.md`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).type, 'urn:motionex:problem:not-found');
  } finally {
    await s.close();
    await rmTmp(tmp);
  }
});
