// music.sounds: lists the sounds the Strudel engine knows. Gated on the warm sample cache because the
// prebake registers the sample maps and drum-machine bank aliases before the map can be read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

const TIMEOUT_MS = 300_000;

test('music.sounds: lists synths, samples and soundfonts sorted by name', needs('samples'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool('music.sounds', {}, { workspace: ws, timeoutMs: TIMEOUT_MS });
    assert.ok(result.count > 1000, `expected a large registry, got ${result.count}`);
    assert.equal(result.count, result.sounds.length);
    const byName = new Map(result.sounds.map((s) => [s.name, s]));
    assert.equal(byName.get('sawtooth')?.kind, 'synth');
    assert.equal(byName.get('gm_epiano1')?.kind, 'soundfont');
    assert.equal(byName.get('bd')?.kind, 'sample');
    // Sorted ascending by name.
    const names = result.sounds.map((s) => s.name);
    assert.deepEqual(names, [...names].sort());
    // variants is the bank size for samples and null for synths/soundfonts.
    assert.ok(Number.isInteger(byName.get('bd').variants) && byName.get('bd').variants > 0, 'bd has variants');
    assert.equal(byName.get('sawtooth').variants, null);
    assert.equal(byName.get('gm_epiano1').variants, null);
    // Drum-machine bank aliases are listed (case-insensitive lookups make them usable with .bank()).
    assert.ok(result.banks.includes('rolandtr909'), 'rolandtr909 bank is listed');
  } finally {
    await rmTmp(ws);
  }
});

test('music.sounds: filter is a case-insensitive substring', needs('samples'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool('music.sounds', { filter: 'GM_DULC' }, { workspace: ws, timeoutMs: TIMEOUT_MS });
    assert.ok(result.count >= 1, 'expected at least one gm_dulc* sound');
    assert.ok(
      result.sounds.some((s) => s.name === 'gm_dulcimer'),
      `expected gm_dulcimer, got ${result.sounds.map((s) => s.name).join(', ')}`,
    );
    assert.ok(
      result.sounds.every((s) => s.name.toLowerCase().includes('gm_dulc')),
      'every result matches the filter',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('music.sounds: kind synth returns only synths', needs('samples'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool('music.sounds', { kind: 'synth' }, { workspace: ws, timeoutMs: TIMEOUT_MS });
    assert.ok(result.count > 0, 'expected some synths');
    assert.ok(
      result.sounds.every((s) => s.kind === 'synth'),
      'only synth entries',
    );
    assert.ok(result.sounds.some((s) => s.name === 'sawtooth'));
    assert.ok(!result.sounds.some((s) => s.name === 'bd'), 'no sample entries');
  } finally {
    await rmTmp(ws);
  }
});

test('music.sounds: a /regex/ filter matches by pattern', needs('samples'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool(
      'music.sounds',
      { filter: '/^gm_dulc/' },
      { workspace: ws, timeoutMs: TIMEOUT_MS },
    );
    const names = result.sounds.map((s) => s.name);
    assert.ok(names.includes('gm_dulcimer'), `expected gm_dulcimer, got ${names.join(', ')}`);
    assert.ok(
      names.every((n) => /^gm_dulc/.test(n)),
      'every result matches the regex',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('music.sounds: an invalid regex filter is invalid-input', needs('samples'), async () => {
  const ws = await mkTmp();
  try {
    await assert.rejects(
      runTool('music.sounds', { filter: '/(/' }, { workspace: ws, timeoutMs: TIMEOUT_MS }),
      (err) => {
        assert.equal(err.type, 'invalid-input');
        assert.match(err.detail, /invalid filter regex/i);
        return true;
      },
    );
  } finally {
    await rmTmp(ws);
  }
});
