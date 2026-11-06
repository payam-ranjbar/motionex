import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { APP_ROOT, loadConfig } from '../../src/lib/config.mjs';
import { sha256, sha256Dir } from '../../src/lib/hash.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

test('tool_hash covers the shared runtime code, not only the tool folder', async () => {
  const ws = await mkTmp();
  try {
    const config = loadConfig({ ...process.env, MX_WORKSPACE: ws, MX_EXTENSIONS_DIR: '' });
    const a = (await loadRegistry({ config })).get('audio.mix');
    const b = (await loadRegistry({ config })).get('audio.mix');
    assert.ok(a, 'audio.mix is registered');
    assert.equal(a.toolHash, b.toolHash, 'stable across reloads');
    const dirOnly = await sha256Dir(a.dir);
    assert.notEqual(
      a.toolHash,
      dirOnly,
      'a fix in src/lib must change the cache key, so the hash is not the folder alone',
    );
    const runtime = [];
    for (const rel of ['src/lib', 'lib', 'vendor/mucavex/src'])
      runtime.push(`${rel}:${await sha256Dir(path.join(APP_ROOT, rel))}`);
    assert.equal(a.toolHash, sha256(`${dirOnly}:${sha256(runtime.join('\n'))}`));
  } finally {
    await rmTmp(ws);
  }
});
