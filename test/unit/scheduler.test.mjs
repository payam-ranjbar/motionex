import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler } from '../../src/runner/scheduler.mjs';

/** A promise whose settlement we control. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending microtask (and one macrotask) settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ids = (jobs) => jobs.map((job) => job.id);

/** Scheduler plus a helper that enqueues jobs with hand-controlled start() promises. */
function make(opts) {
  const scheduler = new Scheduler(opts);
  const started = [];
  const enqueue = (id, cls, slots = 1) => {
    const d = deferred();
    scheduler.enqueue({
      id,
      cls,
      slots,
      start: () => {
        started.push(id);
        return d.promise;
      },
    });
    return d;
  };
  return { scheduler, enqueue, started };
}

test('class limit: capture:1 serialises capture while audio runs alongside', async () => {
  const { scheduler, enqueue } = make({ totalSlots: 8, limits: { capture: 1, audio: 4 } });
  const c1 = enqueue('c1', 'capture');
  enqueue('c2', 'capture');
  enqueue('a1', 'audio');
  enqueue('a2', 'audio');

  assert.deepEqual(ids(scheduler.stats().running), ['c1', 'a1', 'a2']);
  assert.deepEqual(ids(scheduler.stats().queued), ['c2']);

  c1.resolve();
  await tick();
  assert.deepEqual(ids(scheduler.stats().running), ['a1', 'a2', 'c2']);
  assert.deepEqual(ids(scheduler.stats().queued), []);
});

test('slots: a 3-slot and a 2-slot job do not overlap on 4 slots', async () => {
  const { scheduler, enqueue } = make({ totalSlots: 4, limits: {} });
  const j1 = enqueue('j1', 'audio', 3);
  enqueue('j2', 'audio', 2);

  assert.equal(scheduler.stats().usedSlots, 3);
  assert.deepEqual(ids(scheduler.stats().running), ['j1']);
  assert.deepEqual(ids(scheduler.stats().queued), ['j2']);

  j1.resolve();
  await tick();
  assert.equal(scheduler.stats().usedSlots, 2);
  assert.deepEqual(ids(scheduler.stats().running), ['j2']);
  assert.deepEqual(ids(scheduler.stats().queued), []);
});

test('FIFO per class: three audio jobs with limit 1 start in enqueue order', async () => {
  const { scheduler, enqueue } = make({ totalSlots: 8, limits: { audio: 1 } });
  const j1 = enqueue('j1', 'audio');
  const j2 = enqueue('j2', 'audio');
  const j3 = enqueue('j3', 'audio');

  assert.deepEqual(ids(scheduler.stats().running), ['j1']);
  assert.deepEqual(ids(scheduler.stats().queued), ['j2', 'j3']);

  j1.resolve();
  await tick();
  assert.deepEqual(ids(scheduler.stats().running), ['j2']);
  assert.deepEqual(ids(scheduler.stats().queued), ['j3']);

  j2.resolve();
  await tick();
  assert.deepEqual(ids(scheduler.stats().running), ['j3']);

  j3.resolve();
  await tick();
  assert.deepEqual(ids(scheduler.stats().running), []);
});

test('no starvation: a waiting capture job reserves its slots', async () => {
  const { scheduler, enqueue } = make({ totalSlots: 4, limits: { audio: 4, capture: 1, light: 8 } });
  const a1 = enqueue('a1', 'audio', 2);
  enqueue('cap', 'capture', 4);
  enqueue('a2', 'audio', 1);
  enqueue('a3', 'audio', 1);
  enqueue('a4', 'audio', 1);
  assert.deepEqual(ids(scheduler.stats().queued), ['cap', 'a2', 'a3', 'a4']);

  // A 0-slot job may still start while the 4-slot capture job waits.
  enqueue('light1', 'light', 0);
  assert.deepEqual(ids(scheduler.stats().running), ['a1', 'light1']);
  assert.deepEqual(ids(scheduler.stats().queued), ['cap', 'a2', 'a3', 'a4']);

  // The capture job starts as soon as the first audio job finishes, before any later audio job.
  a1.resolve();
  await tick();
  assert.deepEqual(ids(scheduler.stats().running), ['light1', 'cap']);
  assert.deepEqual(ids(scheduler.stats().queued), ['a2', 'a3', 'a4']);
});

test('over-asking: slots above totalSlots are clamped and still run', async () => {
  const { scheduler, enqueue } = make({ totalSlots: 4, limits: {} });
  enqueue('big', 'audio', 16);
  assert.deepEqual(scheduler.stats().running, [{ id: 'big', cls: 'audio', slots: 4 }]);
  assert.equal(scheduler.stats().usedSlots, 4);
});

test('a rejected start() frees its slots and the next job starts', async () => {
  const { scheduler, enqueue, started } = make({ totalSlots: 4, limits: { audio: 1 } });
  const j1 = enqueue('j1', 'audio', 1);
  enqueue('j2', 'audio', 1);
  assert.deepEqual(ids(scheduler.stats().queued), ['j2']);

  await tick();
  j1.reject(new Error('boom'));
  await tick();

  assert.deepEqual(started, ['j1', 'j2']);
  assert.deepEqual(ids(scheduler.stats().running), ['j2']);
  assert.equal(scheduler.stats().usedSlots, 1);
});

test('remove(): true for a queued job (it never starts), false for running or unknown', async () => {
  const { scheduler, enqueue, started } = make({ totalSlots: 1, limits: {} });
  const run = enqueue('run', 'audio', 1);
  enqueue('q1', 'audio', 1);

  assert.equal(scheduler.remove('run'), false);
  assert.equal(scheduler.remove('nope'), false);
  assert.equal(scheduler.remove('q1'), true);
  assert.deepEqual(ids(scheduler.stats().queued), []);

  run.resolve();
  await tick();
  assert.deepEqual(started, ['run']);
  assert.deepEqual(ids(scheduler.stats().running), []);
});

test('queue-full: enqueuing past maxQueued throws a 503 Problem', () => {
  const { enqueue } = make({ totalSlots: 1, limits: { audio: 4 }, maxQueued: 2 });
  enqueue('run', 'audio', 1);
  enqueue('q1', 'audio', 1);
  enqueue('q2', 'audio', 1);

  assert.throws(
    () => enqueue('q3', 'audio', 1),
    (err) => {
      assert.equal(err.name, 'Problem');
      assert.equal(err.code, 'queue-full');
      assert.equal(err.status, 503);
      return true;
    },
  );
});

test('stats() reports running, queued and usedSlots as copies', () => {
  const { scheduler, enqueue } = make({ totalSlots: 2, limits: { audio: 1 } });
  enqueue('r1', 'audio', 2);
  enqueue('q1', 'audio', 1);
  enqueue('q2', 'audio', 1);

  const st = scheduler.stats();
  assert.equal(st.totalSlots, 2);
  assert.equal(st.usedSlots, 2);
  assert.deepEqual(st.running, [{ id: 'r1', cls: 'audio', slots: 2 }]);
  assert.deepEqual(st.queued, [
    { id: 'q1', cls: 'audio', slots: 1 },
    { id: 'q2', cls: 'audio', slots: 1 },
  ]);

  st.running.push({ id: 'x', cls: 'x', slots: 0 });
  st.queued.length = 0;
  assert.deepEqual(ids(scheduler.stats().running), ['r1']);
  assert.deepEqual(ids(scheduler.stats().queued), ['q1', 'q2']);
});

test('a class missing from limits uses limits.default', () => {
  const { scheduler, enqueue } = make({ totalSlots: 8, limits: { default: 1 } });
  enqueue('a', 'other');
  enqueue('b', 'other');
  assert.deepEqual(ids(scheduler.stats().running), ['a']);
  assert.deepEqual(ids(scheduler.stats().queued), ['b']);
});

test('the fallback class limit is 2 when limits has no default', () => {
  const { scheduler, enqueue } = make({ totalSlots: 8, limits: {} });
  enqueue('a', 'x');
  enqueue('b', 'x');
  enqueue('c', 'x');
  assert.deepEqual(ids(scheduler.stats().running), ['a', 'b']);
  assert.deepEqual(ids(scheduler.stats().queued), ['c']);
});
