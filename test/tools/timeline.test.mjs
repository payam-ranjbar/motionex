// timeline.layout tests: the golden contavex-intro layout, neutral defaults, snapping, times,
// a real audio line (speech end) and the per-frame voice envelope.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { writeFixture } from '../helpers/fixtures.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool } from '../helpers/tool-harness.mjs';

// The golden reference project (read-only): its input and the old build's timeline output.
const REF = 'C:\\Users\\me\\Projects\\motion-studio\\videos\\contavex-intro';
const VIDEO = path.join(REF, 'video.json');
const OLD = path.join(REF, 'build', 'timeline.json');
const hasGolden = existsSync(VIDEO) && existsSync(OLD);
// The golden reference is host-specific: skip when absent, but still fail if ffmpeg is required and missing.
const goldenOpts = needs('ffmpeg');
if (!hasGolden) goldenOpts.skip = 'golden reference project not present (motion-studio/videos/contavex-intro)';

const outOf = (outputs, name) => outputs.find((o) => o.name === name);
const readJson = async (outputs, name) => JSON.parse(await readFile(outOf(outputs, name).abs, 'utf8'));

// A 1 s tone then 0.4 s of silence: speechEnd should land at ~1.03 s (1 s + the 30 ms tail), not 1.4 s.
const TONE_THEN_SILENCE = {
  concat: [
    { sine: { freq: 440, seconds: 1, amplitude_db: -20, channels: 1, sample_rate: 48000 } },
    { silence: { seconds: 0.4, channels: 1, sample_rate: 48000 } },
  ],
};

test('timeline.layout: golden contavex-intro layout matches the old build', goldenOpts, async () => {
  const video = JSON.parse(await readFile(VIDEO, 'utf8'));
  const old = JSON.parse(await readFile(OLD, 'utf8'));
  const oldById = new Map(old.scenes.map((s) => [s.id, s]));

  // Rebuild the layout from the OLD cue durations, but through this tool's input shape.
  const scenes = video.scenes.map((s) => {
    const o = oldById.get(s.id);
    assert.ok(o, `old timeline has no scene "${s.id}"`);
    const lines = (s.say ?? []).map((say, i) => {
      const l = typeof say === 'string' ? { text: say } : say;
      return { dur_s: o.cues[i].dur, text: l.text };
    });
    const scene = { id: s.id, lines };
    if (s.lead !== undefined) scene.lead_s = s.lead;
    if (s.gap !== undefined) scene.gap_s = s.gap;
    if (s.tail !== undefined) scene.tail_s = s.tail;
    if (s.snap !== undefined) scene.snap_beats = s.snap;
    return scene;
  });
  const input = {
    defaults: {
      lead_s: video.lead ?? 0,
      gap_s: video.gap ?? 0,
      tail_s: video.tail ?? 0,
      snap_beats: video.snap ?? null,
    },
    grid: { bpm: video.music.bpm, beats_per_bar: 4, offset_s: 0 },
    scenes,
    markers: { drop: { scene: video.music.drop_at, align: 'bar' } },
    align_to: 'drop',
  };

  const ws = await mkTmp();
  try {
    const { result, outputs } = await runTool('timeline.layout', input, { workspace: ws });
    assert.ok(Math.abs(result.total - 31.7308) < 1e-4, `total ${result.total} != 31.7308`);
    assert.ok(Math.abs(result.music_offset_s - 1.7308) < 1e-4, `offset ${result.music_offset_s} != 1.7308`);
    for (const s of result.scenes) {
      const o = oldById.get(s.id);
      assert.ok(Math.abs(s.start - o.start) < 1e-4, `${s.id} start ${s.start} != ${o.start}`);
      assert.ok(Math.abs(s.dur - o.dur) < 1e-4, `${s.id} dur ${s.dur} != ${o.dur}`);
    }
    const timeline = await readJson(outputs, 'timeline.json');
    assert.ok(Math.abs(timeline.beatOffset - 1.7308) < 1e-4, `beatOffset ${timeline.beatOffset}`);
    assert.equal(timeline.markers.drop.bar, 3);
    assert.equal(timeline.markers.drop.cycle, 3);
  } finally {
    await rmTmp(ws);
  }
});

test('timeline.layout: all defaults are neutral (no lead, gap, tail, min or snapping)', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const { result, outputs } = await runTool(
      'timeline.layout',
      {
        extra: { name: 'demo', fps: 30 },
        scenes: [
          { id: 'a', lines: [{ dur_s: 1 }, { dur_s: 2 }] },
          { id: 'b', lines: [{ dur_s: 1.5 }] },
        ],
      },
      { workspace: ws },
    );
    assert.deepStrictEqual(result.scenes, [
      { id: 'a', start: 0, dur: 3 },
      { id: 'b', start: 3, dur: 1.5 },
    ]);
    assert.equal(result.total, 4.5);
    assert.equal(result.music_offset_s, 0);
    const timeline = await readJson(outputs, 'timeline.json');
    assert.equal(timeline.version, 1);
    assert.equal(timeline.name, 'demo');
    assert.equal(timeline.fps, 30);
  } finally {
    await rmTmp(ws);
  }
});

test('timeline.layout: snap_beats 4 at 120 bpm rounds a 3 s scene up to 4 s', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const { result } = await runTool(
      'timeline.layout',
      {
        grid: { bpm: 120, beats_per_bar: 4 },
        defaults: { snap_beats: 4 },
        scenes: [{ id: 'a', lines: [{ dur_s: 3 }] }],
      },
      { workspace: ws },
    );
    assert.equal(result.scenes[0].dur, 4);
    assert.equal(result.total, 4);
  } finally {
    await rmTmp(ws);
  }
});

test('timeline.layout: times resolve against the computed timeline', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    const { result, outputs } = await runTool(
      'timeline.layout',
      {
        scenes: [
          { id: 'a', lines: [{ dur_s: 1 }] },
          { id: 'b', lines: [{ dur_s: 2 }] },
        ],
        times: { hit: 'b#0.end-0.1' },
      },
      { workspace: ws },
    );
    assert.equal(result.total, 3);
    const timeline = await readJson(outputs, 'timeline.json');
    assert.equal(timeline.times.hit, 2.9);
  } finally {
    await rmTmp(ws);
  }
});

test('timeline.layout: an audio line uses its speech end (~1.03 s), not the file length', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'line.wav', TONE_THEN_SILENCE);
    const { result, outputs } = await runTool(
      'timeline.layout',
      { scenes: [{ id: 'a', lines: [{ audio: 'line.wav', text: 'hi' }] }] },
      { workspace: ws },
    );
    assert.ok(Math.abs(result.scenes[0].dur - 1.03) < 0.02, `scene dur ${result.scenes[0].dur}`);
    const timeline = await readJson(outputs, 'timeline.json');
    assert.ok(Math.abs(timeline.scenes[0].cues[0].dur - 1.03) < 0.02, `cue dur ${timeline.scenes[0].cues[0].dur}`);
    const clips = await readJson(outputs, 'dialogue-clips.json');
    assert.deepStrictEqual(clips, [{ src: 'line.wav', at: 0, name: 'a-0' }]);
  } finally {
    await rmTmp(ws);
  }
});

test('timeline.layout: the voice envelope has ceil(total * fps) frames', needs('ffmpeg'), async () => {
  const ws = await mkTmp();
  try {
    await writeFixture(ws, 'line.wav', { sine: { freq: 440, seconds: 1, amplitude_db: -20, channels: 1 } });
    const { result, outputs } = await runTool(
      'timeline.layout',
      {
        scenes: [{ id: 'a', lines: [{ audio: 'line.wav', who: 'narrator' }] }],
        envelope: { fps: 30 },
      },
      { workspace: ws },
    );
    const timeline = await readJson(outputs, 'timeline.json');
    assert.ok(Array.isArray(timeline.voices.narrator), 'voices.narrator should be an array');
    assert.equal(timeline.voices.narrator.length, Math.ceil(result.total * 30));
    assert.ok(
      timeline.voices.narrator.some((v) => v > 0),
      'the envelope should have loud frames',
    );
  } finally {
    await rmTmp(ws);
  }
});
