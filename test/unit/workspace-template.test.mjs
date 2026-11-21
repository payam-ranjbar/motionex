// The workspace template (skill/workspace/template) and `mx workspace init`: a new workspace gets every template
// file with its placeholders filled, nothing existing is overwritten, and the template itself carries no setting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fill, initWorkspace, targetName } from '../../src/lib/workspace-template.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(ROOT, 'skill', 'workspace', 'template');
const MX = path.join(ROOT, 'bin', 'mx.mjs');
const BASE = { templateDir: TEMPLATE, name: 'Night Shift', engineUrl: 'http://127.0.0.1:8095', date: '2026-01-02' };

/** Every file under a folder, as POSIX paths relative to it. */
async function tree(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tree(abs, base)));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

test('fill replaces known placeholders and leaves unknown ones', () => {
  assert.equal(fill('# {{name}} on {{date}} {{other}}', { name: 'A', date: 'B' }), '# A on B {{other}}');
});

test('targetName writes the template gitignore as a dot-file', () => {
  assert.equal(targetName('gitignore'), '.gitignore');
  assert.equal(targetName('skills/project/SKILL.md'), 'skills/project/SKILL.md');
});

test('a new workspace gets every template file, with its name, date and engine filled in', async () => {
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'ws');
    const done = await initWorkspace({ ...BASE, target });
    assert.deepEqual(done.kept, []);
    const files = await tree(target);
    assert.deepEqual(files, [...done.created].sort());
    for (const need of [
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      'CHANGES.md',
      'WORKSPACE.md',
      'projects/README.md',
      'projects/_template/brief.md',
      'projects/_template/notes.md',
      'skills/project/SKILL.md',
      'skills/workspace/SKILL.md',
      'tools/README.md',
    ]) {
      assert.ok(files.includes(need), `missing ${need}`);
    }
    const workspace = await readFile(path.join(target, 'WORKSPACE.md'), 'utf8');
    assert.match(workspace, /^# Night Shift$/m);
    assert.match(workspace, /Created 2026-01-02/);
    assert.match(workspace, /http:\/\/127\.0\.0\.1:8095\/readyz/);
    for (const rel of files) {
      const text = await readFile(path.join(target, ...rel.split('/')), 'utf8');
      // (other double braces, such as a docker --format string in a command example, are not placeholders)
      assert.doesNotMatch(text, /\{\{(name|date|engine_url)\}\}/, `${rel} still has a placeholder`);
    }
  } finally {
    await rmTmp(dir);
  }
});

test('the template sets nothing about the films: every output and identity setting is "not set"', async () => {
  const text = await readFile(path.join(TEMPLATE, 'WORKSPACE.md'), 'utf8');
  const rows = text
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Setting') && !line.includes('**'));
  assert.ok(rows.length >= 8, 'the settings table has rows');
  const asking = new Set(['Spend on paid providers', 'Commit or push', 'Restart or re-mount the engine']);
  for (const row of rows) {
    const [, setting, value] = row.split('|').map((cell) => cell.trim());
    assert.equal(value, asking.has(setting) ? 'ask each time' : 'not set', `"${setting}" must not carry a value`);
  }
});

test('a folder with files is refused, and --add writes only what is missing', async () => {
  const dir = await mkTmp();
  try {
    await mkdir(path.join(dir, 'skills', 'project'), { recursive: true });
    await writeFile(path.join(dir, 'skills', 'project', 'SKILL.md'), 'mine\n');
    await assert.rejects(initWorkspace({ ...BASE, target: dir }), { code: 'not-empty' });
    const done = await initWorkspace({ ...BASE, target: dir, add: true });
    assert.deepEqual(done.kept, ['skills/project/SKILL.md']);
    assert.equal(await readFile(path.join(dir, 'skills', 'project', 'SKILL.md'), 'utf8'), 'mine\n');
    assert.ok(done.created.includes('WORKSPACE.md'));
  } finally {
    await rmTmp(dir);
  }
});

test('dry writes nothing', async () => {
  const dir = await mkTmp();
  try {
    const done = await initWorkspace({ ...BASE, target: path.join(dir, 'ws'), dry: true });
    assert.ok(done.created.length > 5);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rmTmp(dir);
  }
});

test('mx workspace init creates the workspace and refuses a second run without --add', async () => {
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'studio');
    const run = (...extra) =>
      spawnSync(process.execPath, [MX, 'workspace', 'init', target, '--no-git', ...extra], { encoding: 'utf8' });
    const first = run('--name', 'Studio One', '--engine', 'http://engine.test:1');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /wrote WORKSPACE\.md/);
    assert.match(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), /^# Studio One: how to work here$/m);
    assert.match(await readFile(path.join(target, 'WORKSPACE.md'), 'utf8'), /http:\/\/engine\.test:1/);
    const second = run();
    assert.equal(second.status, 64);
    assert.match(second.stderr, /already has files/);
    const third = run('--add');
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /kept {2}WORKSPACE\.md/);
  } finally {
    await rmTmp(dir);
  }
});
