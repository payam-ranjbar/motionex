// audio.mix fades: a fade-out ends on the last sample that is actually HEARD. When the mix length cuts a
// clip, `audibleLen` moves the end of the fade to the cut, so the audible end is a fade and not a hard cut.
// Pure functions, no ffmpeg: SR = 1000 so 1 sample = 1 ms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGainFades, prepareClip } from '../../src/lib/mix/clips.mjs';

const SR = 1000;
const ones = (n) => [Float32Array.from({ length: n }, () => 1)];

test('applyGainFades: the fade-out ends on the last sample of the buffer', () => {
  const [ch] = applyGainFades(ones(1000), { fadeOutS: 0.5, sampleRate: SR });
  assert.equal(ch.length, 1000);
  assert.equal(ch[0], 1);
  assert.equal(ch[499], 1, 'the fade starts after the buffer_end - fadeOut samples');
  assert.ok(Math.abs(ch[500] - 499 / 500) < 1e-7);
  assert.ok(Math.abs(ch[750] - 249 / 500) < 1e-7);
  assert.equal(ch[999], 0, 'the fade ends on the last sample');
});

test('applyGainFades: audibleLen moves the end of the fade-out to the cut', () => {
  const [ch] = applyGainFades(ones(1000), { fadeOutS: 0.5, sampleRate: SR, audibleLen: 700 });
  assert.equal(ch[199], 1, 'full level before the fade');
  assert.ok(Math.abs(ch[200] - 499 / 500) < 1e-7);
  assert.ok(Math.abs(ch[450] - 249 / 500) < 1e-7);
  assert.equal(ch[699], 0, 'silent on the last audible sample');
  assert.equal(ch[700], 0, 'inaudible samples are clamped at 0, never inverted');
  assert.equal(ch[999], 0);
  // No audibleLen is the same as audibleLen = the buffer length (nothing changes for an untruncated clip).
  assert.deepEqual(
    applyGainFades(ones(1000), { fadeOutS: 0.5, sampleRate: SR, audibleLen: 1000 })[0],
    applyGainFades(ones(1000), { fadeOutS: 0.5, sampleRate: SR })[0],
  );
});

test('applyGainFades: no fade-out asked for means no fade at the cut', () => {
  const [ch] = applyGainFades(ones(1000), { sampleRate: SR, audibleLen: 700 });
  assert.ok(
    ch.every((s) => s === 1),
    'fade_out_s 0 leaves every sample at unity',
  );
  const [cut] = applyGainFades(ones(1000), { fadeOutS: 0.5, sampleRate: SR, audibleLen: 0 });
  assert.ok(
    cut.every((s) => s === 0),
    'a clip with no audible part is silent',
  );
});

test('prepareClip passes audibleLen to the fade and still pans', () => {
  const audio = { sampleRate: SR, channels: ones(1000) };
  const clip = { gain_db: 0, pan: 0, fade_in_s: 0, fade_out_s: 0.5 };
  const [mono] = prepareClip(audio, clip, { outCh: 1, audibleLen: 700 });
  assert.equal(mono[699], 0);
  assert.equal(mono[999], 0);
  // Mono into stereo at pan 0 is the equal-power law: 0.7071 per channel.
  const [L] = prepareClip(audio, clip, { outCh: 2, audibleLen: 700 });
  assert.ok(Math.abs(L[0] - Math.SQRT1_2) < 1e-7);
  assert.equal(L[699], 0);
});
