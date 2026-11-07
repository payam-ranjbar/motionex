import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listVoices } from '../../src/lib/voices.mjs';
import { readWav, secondsOf } from '../../src/lib/wav.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool, testConfig } from '../helpers/tool-harness.mjs';

const NORMAN = 'en_US-norman-medium';
const JOHN = 'en_US-john-medium';
const WORKER = fileURLToPath(new URL('../../tools/voice.piper/piper_worker.py', import.meta.url));

/** Read one output file as planar audio. */
async function readOutput(output) {
  return readWav(await readFile(output.abs));
}

/** Largest absolute sample of a mono/stereo Audio. */
function peak(audio) {
  let max = 0;
  for (const channel of audio.channels) for (const x of channel) max = Math.max(max, Math.abs(x));
  return max;
}

test(
  'voice.piper: two lines become two 22050 Hz mono WAVs with a speech end inside them',
  needs('python', 'piper-voice'),
  async () => {
    const ws = await mkTmp();
    try {
      const { result, outputs } = await runTool(
        'voice.piper',
        {
          voice: NORMAN,
          lines: [{ text: 'Hello there.' }, { text: 'This is motionex.' }],
        },
        { workspace: ws },
      );
      assert.equal(result.voice, NORMAN);
      assert.equal(result.sample_rate, 22050);
      assert.equal(result.lines.length, 2);
      assert.equal(outputs.length, 2);
      assert.ok(Array.isArray(result.warnings), 'result.warnings must be an array');
      assert.deepEqual(result.warnings, [], 'a normal sentence must not warn');
      assert.deepEqual(outputs.map((o) => o.name).sort(), ['line-001.wav', 'line-002.wav']);
      for (const [index, line] of result.lines.entries()) {
        const output = outputs.find((o) => o.name === line.file);
        assert.ok(output, `no output named ${line.file}`);
        const audio = await readOutput(output);
        assert.equal(audio.sampleRate, 22050);
        assert.equal(audio.channels.length, 1, 'Piper writes mono');
        const seconds = secondsOf(audio);
        assert.ok(seconds >= 0.5 && seconds <= 6, `line ${index} is ${seconds} s`);
        assert.ok(Math.abs(seconds - line.seconds) <= 0.002, `reported ${line.seconds} vs ${seconds}`);
        assert.ok(line.speech_end_s < line.seconds, `speech_end_s ${line.speech_end_s} >= ${line.seconds}`);
        assert.ok(line.speech_end_s <= seconds, 'speech_end_s past the end');
        assert.ok(
          line.seconds - line.speech_end_s <= 0.35,
          `line ${index}: speech ends ${line.seconds - line.speech_end_s} s before the file does`,
        );
        assert.ok(
          line.speech_start_s >= 0 && line.speech_start_s < line.speech_end_s,
          `speech_start_s ${line.speech_start_s} must sit before speech_end_s ${line.speech_end_s}`,
        );
        assert.ok(
          Math.abs(line.speech_s - (line.speech_end_s - line.speech_start_s)) <= 0.002,
          `speech_s ${line.speech_s} must equal speech_end_s - speech_start_s`,
        );
        assert.ok(peak(audio) > 0.1, `line ${index} is silent`);
        assert.equal(line.text, index === 0 ? 'Hello there.' : 'This is motionex.');
      }
    } finally {
      await rmTmp(ws);
    }
  },
);

test(
  'voice.piper: plain-string lines are shorthand for {text} and named line-001...',
  needs('python', 'piper-voice'),
  async () => {
    const ws = await mkTmp();
    try {
      const { result, outputs } = await runTool(
        'voice.piper',
        { voice: NORMAN, lines: ['Hello there.', 'This is motionex.'] },
        { workspace: ws },
      );
      assert.equal(result.lines.length, 2);
      assert.deepEqual(
        result.lines.map((line) => line.text),
        ['Hello there.', 'This is motionex.'],
      );
      assert.deepEqual(
        result.lines.map((line) => line.name),
        ['line-001', 'line-002'],
      );
      assert.deepEqual(
        result.lines.map((line) => line.file),
        ['line-001.wav', 'line-002.wav'],
      );
      assert.deepEqual(outputs.map((o) => o.name).sort(), ['line-001.wav', 'line-002.wav']);
    } finally {
      await rmTmp(ws);
    }
  },
);

test('voice.piper: the babble rule warns on a babbling line and stays quiet on a normal one', needs('python'), () => {
  const python = testConfig(process.cwd()).python;
  const check = (payload) => {
    const run = spawnSync(python, [WORKER, '--babble', JSON.stringify(payload)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(run.status, 0, `python exited ${run.status}: ${run.stderr}`);
    return run.stdout.trim();
  };
  // en_US-norman-medium turned the raw-IPA line into 3.26 s of babble (docs/backlog.md #5).
  const ipa = check({ name: 'ha1', text: '[[hˈɑː!]]', speech_s: 3.26, length_scale: 1 });
  assert.match(ipa, /^line "ha1": 3\.26 s of speech for a 3-character line; /);
  assert.match(ipa, /Piper may be babbling/);
  // "Hey!" is 3 characters too, so it warns with the same budget.
  assert.match(check({ name: 'hey', text: 'Hey!', speech_s: 3.26, length_scale: 1 }), /3-character line/);
  // A normal sentence fits its budget, and john's 0.58 s for the same IPA line is fine.
  assert.equal(check({ name: 'normal', text: 'We were ten thousand sparks.', speech_s: 1.84, length_scale: 1 }), '');
  assert.equal(check({ name: 'ha1', text: '[[hˈɑː!]]', speech_s: 0.58, length_scale: 1 }), '');
});

test('voice.piper: an IPA line inside [[ ]] synthesizes audible audio', needs('python', 'piper-voice'), async () => {
  const ws = await mkTmp();
  try {
    const { result, outputs } = await runTool(
      'voice.piper',
      { voice: NORMAN, lines: [{ text: 'My name is [[ʃˈɒpˌuːə.]]' }] },
      { workspace: ws },
    );
    assert.equal(outputs.length, 1);
    assert.equal(result.lines[0].text, 'My name is [[ʃˈɒpˌuːə.]]');
    const audio = await readOutput(outputs[0]);
    assert.ok(secondsOf(audio) >= 0.5, `too short: ${secondsOf(audio)} s`);
    assert.ok(peak(audio) > 0.1, 'the IPA line came out silent');
  } finally {
    await rmTmp(ws);
  }
});

test('voice.piper: lines[].name chooses the output file name', needs('python', 'piper-voice'), async () => {
  const ws = await mkTmp();
  try {
    const { result, outputs } = await runTool(
      'voice.piper',
      { voice: NORMAN, lines: [{ text: 'Who are you?', name: 'who-0' }] },
      { workspace: ws },
    );
    assert.equal(result.lines[0].name, 'who-0');
    assert.equal(result.lines[0].file, 'who-0.wav');
    assert.deepEqual(
      outputs.map((o) => o.name),
      ['who-0.wav'],
    );
    assert.ok(outputs[0].bytes > 44, 'the WAV has no frames');
    assert.equal((await readFile(outputs[0].abs)).toString('ascii', 0, 4), 'RIFF');
  } finally {
    await rmTmp(ws);
  }
});

test(
  'voice.piper: an unknown voice is invalid-input and lists the installed ones',
  needs('python', 'piper-voice'),
  async () => {
    const ws = await mkTmp();
    try {
      await assert.rejects(
        runTool('voice.piper', { voice: 'xx-not-a-voice', lines: [{ text: 'Hi.' }] }, { workspace: ws }),
        (e) => {
          assert.equal(e.type, 'invalid-input');
          assert.match(e.message, /unknown voice xx-not-a-voice/);
          assert.match(e.message, /en_US-norman-medium/);
          return true;
        },
      );
    } finally {
      await rmTmp(ws);
    }
  },
);

test('voice.phonemize: "Shapur" with john is IPA and survives as UTF-8', needs('python', 'piper-voice'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool('voice.phonemize', { voice: JOHN, texts: ['Shapur'] }, { workspace: ws });
    assert.equal(result.results.length, 1);
    const [entry] = result.results;
    assert.equal(entry.text, 'Shapur');
    assert.ok(entry.sentences.length >= 1);
    assert.ok(entry.ipa.includes('ʃ'), `ipa ${JSON.stringify(entry.ipa)} has no ʃ`);
    assert.equal(entry.ipa, entry.sentences.join(' '));
    assert.equal(Buffer.from(entry.ipa, 'utf8').toString('utf8'), entry.ipa);
  } finally {
    await rmTmp(ws);
  }
});

test('listVoices: reads the installed voices', needs('piper-voice'), () => {
  const voices = listVoices(testConfig(process.cwd()).voicesDirs);
  const norman = voices.find((v) => v.name === NORMAN);
  assert.ok(norman, `norman missing from ${voices.map((v) => v.name).join(', ')}`);
  assert.equal(norman.sample_rate, 22050);
  assert.equal(norman.quality, 'medium');
  assert.equal(norman.language, 'en_US');
  assert.equal(norman.num_speakers, 1);
  assert.ok(norman.path.endsWith(`${NORMAN}.onnx`), norman.path);
  assert.deepEqual(
    voices.map((v) => v.name),
    [...voices.map((v) => v.name)].sort(),
  );
  assert.deepEqual(listVoices([]), []);
  assert.deepEqual(listVoices([path.join(norman.path, 'nope')]), []);
});

test('voice.piper: length_scale 1.3 is slower than 0.8', needs('python', 'piper-voice'), async () => {
  const ws = await mkTmp();
  try {
    const text = 'The quick brown fox jumps.';
    const slow = await runTool(
      'voice.piper',
      { voice: NORMAN, length_scale: 1.3, lines: [{ text }] },
      { workspace: ws },
    );
    const fast = await runTool(
      'voice.piper',
      { voice: NORMAN, length_scale: 0.8, lines: [{ text }] },
      { workspace: ws },
    );
    assert.ok(
      slow.result.lines[0].seconds > fast.result.lines[0].seconds,
      `1.3 gave ${slow.result.lines[0].seconds} s, 0.8 gave ${fast.result.lines[0].seconds} s`,
    );
  } finally {
    await rmTmp(ws);
  }
});
