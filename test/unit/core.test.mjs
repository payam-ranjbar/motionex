import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeAudio, filterAudio } from '../../src/lib/audio-io.mjs';
import { canonical } from '../../src/lib/canonical-json.mjs';
import { loadConfig } from '../../src/lib/config.mjs';
import { atempoChain, checkChain, videoArgs } from '../../src/lib/ffmpeg.mjs';
import { JOB_ID, newJobId } from '../../src/lib/ids.mjs';
import { isReserved, isSafeOutputPath, toWorkspacePath } from '../../src/lib/paths.mjs';
import { deepMerge } from '../../src/lib/presets.mjs';
import { fitLength, speechEnd } from '../../src/lib/signal.mjs';
import { encodeWav, readWav } from '../../src/lib/wav.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool, testConfig } from '../helpers/tool-harness.mjs';

const FAKES = fileURLToPath(new URL('../fixtures/tools', import.meta.url));

test('paths: workspace confinement', () => {
  const ws = path.resolve('/tmp/ws');
  assert.equal(toWorkspacePath(ws, 'films/a.wav'), path.join(ws, 'films', 'a.wav'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'c:x', 'a\\b', 'a\0b', '', '..']) {
    assert.throws(
      () => toWorkspacePath(ws, bad),
      (e) => e.code === 'path-outside-workspace',
      bad,
    );
  }
  assert.ok(isReserved('.mx/jobs/x'));
  assert.ok(isReserved('.mx'));
  assert.ok(!isReserved('mx/x'));
  assert.ok(isSafeOutputPath('stems/dialogue.wav'));
  assert.ok(!isSafeOutputPath('../x.wav'));
  assert.ok(!isSafeOutputPath('a//b'));
});

test('canonical json and ids', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
  const ids = Array.from({ length: 50 }, newJobId);
  assert.ok(ids.every((i) => JOB_ID.test(i)));
  assert.deepEqual([...ids].sort(), ids);
});

test('wav round trip (s16, s24, f32) and pipe-style headers', () => {
  const ch = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.5);
  for (const format of ['s16', 's24', 'f32']) {
    const back = readWav(encodeWav({ sampleRate: 22050, channels: [ch, ch] }, { format }));
    assert.equal(back.sampleRate, 22050);
    assert.equal(back.channels.length, 2);
    const tol = format === 's16' ? 1e-4 : 1e-6;
    for (let i = 0; i < ch.length; i += 97) assert.ok(Math.abs(back.channels[1][i] - ch[i]) < tol, format);
  }
  const buf = encodeWav({ sampleRate: 8000, channels: [ch] }, { format: 'f32' });
  buf.writeUInt32LE(0xffffffff, 40);
  assert.equal(readWav(buf).channels[0].length, 1000);
});

test('deepMerge: request wins, arrays replace', () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2], s: 'p' };
  assert.deepEqual(deepMerge(base, { a: { y: 3 }, list: [9] }), { a: { x: 1, y: 3 }, list: [9], s: 'p' });
  assert.deepEqual(base.a, { x: 1, y: 2 });
});

test('ffmpeg helpers', () => {
  assert.equal(atempoChain(1), 'anull');
  assert.equal(atempoChain(3), 'atempo=2,atempo=1.5');
  assert.equal(atempoChain(0.2), 'atempo=0.5,atempo=0.5,atempo=0.8');
  assert.throws(
    () => checkChain('volume=2,amovie=/run/secrets/x'),
    (e) => e.type === 'invalid-input',
  );
  assert.throws(
    () => checkChain('[a]sendcmd=f=x'),
    (e) => e.type === 'invalid-input',
  );
  assert.equal(checkChain('volume=2dB,aecho=0.8:0.9:40:0.3'), 'volume=2dB,aecho=0.8:0.9:40:0.3');
  const a = videoArgs({ crf: 18, maxrate_k: 9000, gop: 60, keyint_min: 60, sc_threshold: 0, closed_gop: true });
  assert.ok(a.join(' ').includes('-crf 18 -maxrate 9000k -bufsize 18000k'));
  assert.ok(a.join(' ').includes('-g 60 -keyint_min 60 -sc_threshold 0 -flags +cgop'));
});

test('signal: speechEnd and fitLength', () => {
  const sr = 1000;
  const ch = new Float32Array(2000);
  ch.fill(0.5, 0, 1200);
  const audio = { sampleRate: sr, channels: [ch] };
  assert.ok(Math.abs(speechEnd(audio) - 1.229) < 0.002);
  assert.equal(fitLength(audio, 500).channels[0].length, 500);
  assert.equal(fitLength(audio, 2500).channels[0][2400], 0);
});

test('registry: fakes load, defaults applied, refs collected, bad manifests listed', async () => {
  const tmp = await mkTmp();
  try {
    await mkdir(path.join(tmp, 'bad.tool'), { recursive: true });
    await writeFile(path.join(tmp, 'bad.tool', 'tool.json'), JSON.stringify({ name: 'bad.tool' }));
    const config = loadConfig({ ...process.env, MX_WORKSPACE: tmp });
    const reg = await loadRegistry({
      dirs: [
        { path: FAKES, origin: 'builtin' },
        { path: tmp, origin: 'extension' },
      ],
      config,
    });
    assert.deepEqual(
      reg.list().map((t) => t.name),
      ['fake.cmd', 'fake.echo', 'fake.fail', 'fake.linger', 'fake.sleep'],
    );
    assert.equal(reg.invalid().length, 1);
    const v = reg.validate('fake.echo', { message: 'x', file: 'a/b.wav' });
    assert.equal(v.ok, true);
    assert.equal(v.input.delay_ms, 0);
    assert.deepEqual(v.refPointers, ['/file']);
    const bad = reg.validate('fake.echo', { message: 1, nope: true });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.field === '/nope'));
    assert.equal(reg.info('fake.echo').handler, undefined);
  } finally {
    await rmTmp(tmp);
  }
});

test('runTool: node and command tools, errors keep their type', async () => {
  const ws = await mkTmp();
  try {
    const config = testConfig(ws, { MX_TOOLS_DIRS: FAKES, MX_EXTENSIONS_DIR: '' });
    await writeFixture(ws, 'in/x.txt', { text: 'hello' });
    const echo = await runTool('fake.echo', { message: 'hi', file: 'in/x.txt' }, { workspace: ws, config });
    assert.deepEqual(echo.result, { message: 'hi', file_bytes: 5 });
    assert.deepEqual(
      echo.outputs.map((o) => o.name),
      ['echo.json'],
    );
    assert.ok(echo.events.some((e) => e.type === 'progress' && e.fraction === 0.5));

    const cmd = await runTool('fake.cmd', { message: 'ünï ʃˈɒp' }, { workspace: ws, config });
    assert.equal(cmd.result.message, 'ünï ʃˈɒp');
    assert.equal(cmd.result.env_out_dir, true);
    assert.equal(await readFile(path.join(cmd.outDir, 'msg.txt'), 'utf8'), 'ünï ʃˈɒp');
    assert.match(cmd.log, /stderr goes to the job log/);

    await assert.rejects(
      runTool('fake.cmd', { message: 'x', fail: true }, { workspace: ws, config }),
      (e) => e.type === 'invalid-input',
    );
    await assert.rejects(
      runTool('fake.cmd', { message: 'x', crash: true }, { workspace: ws, config }),
      (e) => e.type === 'tool-failed',
    );
    await assert.rejects(
      runTool('fake.fail', { mode: 'tool-error' }, { workspace: ws, config }),
      (e) => e.type === 'invalid-input',
    );
    await assert.rejects(
      runTool('fake.fail', { mode: 'throw' }, { workspace: ws, config }),
      (e) => e.type === 'tool-failed' && /boom/.test(e.detail),
    );
    await assert.rejects(
      runTool('fake.fail', { mode: 'exit' }, { workspace: ws, config }),
      (e) => e.type === 'tool-failed',
    );
    await assert.rejects(
      runTool('fake.fail', { mode: 'bad-output' }, { workspace: ws, config }),
      (e) => e.type === 'invalid-output',
    );
    await assert.rejects(
      runTool('fake.echo', { message: 'x', file: '../etc' }, { workspace: ws, config }),
      (e) => e.code === 'path-outside-workspace',
    );
  } finally {
    await rmTmp(ws);
  }
});

test('audio-io: decode resamples to 48 kHz stereo; filterAudio applies a chain', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const abs = await writeFixture(ws, 'tone.wav', {
      sine: { freq: 440, seconds: 1, sample_rate: 22050, channels: 1, amplitude_db: -6 },
    });
    const a = await decodeAudio(abs);
    assert.equal(a.sampleRate, 48000);
    assert.equal(a.channels.length, 2);
    assert.ok(Math.abs(a.channels[0].length - 48000) <= 2);
    const native = await decodeAudio(abs, { sampleRate: null, channels: null });
    assert.equal(native.sampleRate, 22050);
    assert.equal(native.channels.length, 1);
    const louder = await filterAudio(native, 'volume=6dB');
    const peakOf = (x) => x.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(Math.abs(20 * Math.log10(peakOf(louder) / peakOf(native)) - 6) < 0.1);
  } finally {
    await rmTmp(ws);
  }
});
