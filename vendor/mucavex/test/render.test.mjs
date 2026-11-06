import '../src/resolve-hooks.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { render } = await import('../src/engine.mjs');
const { encodeWav } = await import('../src/wav.mjs');
const { encode } = await import('../src/encode.mjs');
const { analyze } = await import('../src/analyze.mjs');
const { parseJob } = await import('../src/job.mjs');

const peak = (channels) => Math.max(...channels.map((c) => c.reduce((m, s) => Math.max(m, Math.abs(s)), 0)));

test('renders a synth pattern to non-silent stereo audio', async () => {
  const r = await render({ code: 'note("c3 e3 g3").s("sawtooth")', cycles: 2, sampleRate: 22050 });
  assert.equal(r.channels.length, 2);
  assert.equal(r.channels[0].length, Math.ceil(r.seconds * 22050));
  assert.ok(peak(r.channels) > 0.05, 'expected audible output');
});

test('honours setcps and $: blocks', async () => {
  const r = await render({ code: 'setcps(1)\n$: s("square").note("c2")\n$: s("sine").note("c4")', cycles: 2 });
  assert.equal(r.cps, 1);
  assert.equal(r.seconds, 2);
  assert.equal(r.events, 4);
});

test('reverb and delay render without context errors', async () => {
  const r = await render({ code: 'note("c3").s("triangle").room(.5).delay(.5)', cycles: 1 });
  assert.ok(peak(r.channels) > 0.05);
});

test('consecutive renders are independent', async () => {
  const a = await render({ code: 'note("c3").s("sine")', cycles: 1, sampleRate: 8000 });
  const b = await render({ code: 'note("c3").s("sine")', cycles: 1, sampleRate: 8000 });
  assert.deepEqual(a.channels[0], b.channels[0]);
});

test('invalid code rejects', async () => {
  await assert.rejects(render({ code: 'note("c3"', cycles: 1 }));
});

test('wav header is well formed', () => {
  const wav = encodeWav([new Float32Array([0, 1]), new Float32Array([0, -1])], 44100);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.equal(wav.readInt16LE(48), 0x7fff);
  assert.equal(wav.readInt16LE(50), -0x8000);
});

test('parseJob validates input', () => {
  assert.throws(() => parseJob({}), /code/);
  assert.throws(() => parseJob({ code: 'x', cycles: -1 }), /cycles/);
  assert.equal(parseJob({ code: 'x', cycles: '8' }).cycles, 8);
});

test('encodes mp3', async () => {
  const r = await render({ code: 'note("c3").s("sine")', cycles: 1 });
  const { bytes, type } = await encode(r.channels, r.sampleRate, 'mp3');
  assert.equal(type, 'audio/mpeg');
  assert.ok(bytes.length > 1000);
  // MPEG frame sync
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1] & 0xe0, 0xe0);
});

test('analysis flags silence and reports structure', async () => {
  const r = await render({ code: 'note("<c3 ~>").s("sawtooth")', cycles: 2 });
  const a = analyze(r.channels, r.sampleRate, r);
  assert.equal(a.perCycle.length, 2);
  assert.ok(a.perCycle[0].rmsDb > -40);
  assert.ok(a.perCycle[1].rmsDb < -50, `cycle 1 rms ${a.perCycle[1].rmsDb}`);
  assert.ok(a.warnings.some((w) => w.includes('silent cycles: 1')));
});

test('REPL defaults: GM soundfonts, drum machine banks and .piano() render', async () => {
  for (const code of ['note("c4 e4").s("gm_piano")', 's("bd sd").bank("RolandTR808")', 'note("c4 e4").piano()']) {
    const r = await render({ code, cycles: 1 });
    assert.ok(peak(r.channels) > 0.01, `silent: ${code}`);
  }
});

test('visual-only functions are ignored', async () => {
  const r = await render({ code: 'note("c3 e3").s("sine")._pianoroll()._scope()', cycles: 1 });
  assert.ok(peak(r.channels) > 0.01);
});
