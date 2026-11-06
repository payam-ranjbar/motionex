import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError } from '../../src/lib/errors.mjs';
import { parseTimespec, resolveTime } from '../../src/lib/timespec.mjs';

const timeline = {
  scenes: [
    {
      id: 'intro',
      start: 0,
      dur: 4,
      cues: [
        { at: 0.3, dur: 1.2 },
        { at: 1.7, dur: 1.0 },
      ],
    },
    { id: 'reveal', start: 4, dur: 6, cues: [{ at: 4.5, dur: 2 }] },
    { id: 'reveal-2', start: 10, dur: 3, cues: [] },
  ],
  grid: { bpm: 120, beats_per_bar: 4, offset_s: 0.25 },
};

const invalid = (e) => e instanceof ToolError && e.type === 'invalid-input';

test('parseTimespec: numbers', () => {
  assert.deepEqual(parseTimespec(2.5), { kind: 'seconds', seconds: 2.5 });
  assert.deepEqual(parseTimespec(0), { kind: 'seconds', seconds: 0 });
});

test('parseTimespec: scene forms', () => {
  assert.deepEqual(parseTimespec('reveal'), { kind: 'scene', scene: 'reveal', cue: null, end: false, offset: 0 });
  assert.deepEqual(parseTimespec('reveal+1.4'), { kind: 'scene', scene: 'reveal', cue: null, end: false, offset: 1.4 });
  // The syntactic rule splits the trailing offset, even though "-" is a legal scene-id char.
  assert.deepEqual(parseTimespec('reveal-2'), { kind: 'scene', scene: 'reveal', cue: null, end: false, offset: -2 });
  assert.deepEqual(parseTimespec('reveal-2+1'), { kind: 'scene', scene: 'reveal-2', cue: null, end: false, offset: 1 });
  assert.deepEqual(parseTimespec('intro#1'), { kind: 'scene', scene: 'intro', cue: 1, end: false, offset: 0 });
  assert.deepEqual(parseTimespec('intro#1.end'), { kind: 'scene', scene: 'intro', cue: 1, end: true, offset: 0 });
  assert.deepEqual(parseTimespec('intro#0.end-0.1'), {
    kind: 'scene',
    scene: 'intro',
    cue: 0,
    end: true,
    offset: -0.1,
  });
  assert.deepEqual(parseTimespec('list#2-0.5'), { kind: 'scene', scene: 'list', cue: 2, end: false, offset: -0.5 });
  assert.deepEqual(parseTimespec('x+.5'), { kind: 'scene', scene: 'x', cue: null, end: false, offset: 0.5 });
});

test('parseTimespec: bar/beat forms', () => {
  assert.deepEqual(parseTimespec('bar:2'), { kind: 'bar', n: 2, offset: 0 });
  assert.deepEqual(parseTimespec('beat:3+0.1'), { kind: 'beat', n: 3, offset: 0.1 });
  assert.deepEqual(parseTimespec('bar:0-1'), { kind: 'bar', n: 0, offset: -1 });
});

test('parseTimespec: rejects junk', () => {
  for (const bad of ['', '#2', 'a#x', 'bar:x', 'beat:', 'bar:-1', 'bar:1.5', 'a b', 'a#1.5', {}, null, [1]]) {
    assert.throws(() => parseTimespec(bad), invalid, JSON.stringify(bad));
  }
  assert.throws(() => parseTimespec(Number.NaN), invalid);
  assert.throws(() => parseTimespec(Number.POSITIVE_INFINITY), invalid);
});

test('resolveTime: numbers need no timeline', () => {
  assert.equal(resolveTime(2.5, undefined), 2.5);
  assert.equal(resolveTime(0), 0);
  assert.equal(resolveTime(1 / 3), 0.3333);
  assert.throws(() => resolveTime(Number.NaN), invalid);
});

test('resolveTime: scenes and offsets', () => {
  assert.equal(resolveTime('reveal', timeline), 4);
  assert.equal(resolveTime('reveal+1.4', timeline), 5.4);
  assert.equal(resolveTime('reveal-0.5', timeline), 3.5);
  // "reveal-2" is an existing scene id, so the unsplit name wins over scene "reveal" + offset -2.
  assert.equal(resolveTime('reveal-2', timeline), 10);
  assert.equal(resolveTime('reveal-2+1', timeline), 11);
});

test('resolveTime: cues', () => {
  assert.equal(resolveTime('intro#1', timeline), 1.7);
  assert.equal(resolveTime('intro#1.end', timeline), 2.7);
  assert.equal(resolveTime('intro#0.end-0.1', timeline), 1.4);
  assert.equal(resolveTime('intro#1+0.25', timeline), 1.95);
});

test('resolveTime: grid', () => {
  assert.equal(resolveTime('bar:2', timeline), 4.25);
  assert.equal(resolveTime('beat:3+0.1', timeline), 1.85);
  // Defaults: beats_per_bar = 4, offset_s = 0.
  assert.equal(resolveTime('bar:1', { ...timeline, grid: { bpm: 60 } }), 4);
});

test('resolveTime: errors name `what`', () => {
  assert.throws(
    () => resolveTime('nope', timeline, 'poster'),
    (e) => invalid(e) && e.message.startsWith('poster: ') && e.message.includes('intro'),
  );
  assert.throws(
    () => resolveTime('intro#5', timeline, 'sfx[0]'),
    (e) => invalid(e) && e.message.startsWith('sfx[0]: ') && /cue/.test(e.message),
  );
  assert.throws(
    () => resolveTime('bar:1', { scenes: timeline.scenes }, 'music'),
    (e) => invalid(e) && e.message.startsWith('music: ') && /grid/.test(e.message),
  );
  assert.throws(
    () => resolveTime('bar:1', undefined, 'music'),
    (e) => invalid(e) && /timeline/.test(e.message),
  );
  assert.throws(
    () => resolveTime('reveal', undefined, 'at'),
    (e) => invalid(e) && /timeline/.test(e.message),
  );
  assert.throws(
    () => resolveTime('', timeline, 'at'),
    (e) => invalid(e) && e.message.startsWith('at: '),
  );
});

test('resolveTime: rounds to 4 decimals', () => {
  assert.equal(resolveTime('beat:1', timeline), 0.75);
  assert.equal(resolveTime('beat:1+0.00004', timeline), 0.75);
  assert.equal(resolveTime('beat:1+0.00006', timeline), 0.7501);
});
