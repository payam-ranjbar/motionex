import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { listVoices } from '../../src/lib/voices.mjs';
import { readWav, secondsOf } from '../../src/lib/wav.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool, testConfig } from '../helpers/tool-harness.mjs';

const NORMAN = 'en_US-norman-medium';
const JOHN = 'en_US-john-medium';

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
        assert.ok(peak(audio) > 0.1, `line ${index} is silent`);
        assert.equal(line.text, index === 0 ? 'Hello there.' : 'This is motionex.');
      }
    } finally {
      await rmTmp(ws);
    }
  },
);

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
