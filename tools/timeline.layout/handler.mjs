// timeline.layout: lay scenes out from voice-over lines, optionally snapped to a beat grid,
// with markers that align the music and named times.
//
// Nothing is enforced: with all defaults at zero and no snapping, a scene is exactly as long as its lines.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { speechEnd } from '../../src/lib/signal.mjs';
import { resolveTime } from '../../src/lib/timespec.mjs';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
// Everything here is rounded to 1e-4, so a length or a scene start within this of a beat/bar
// multiple is treated as exactly on it (build.mjs used 1e-6, which assumes unrounded inputs).
const EPS = 1e-4;

/**
 * Per-frame voice loudness (0..1) for the lines of one speaker, ported from build.mjs:105-124.
 * `normalize: 'peak'` divides by the loudest frame, `'none'` keeps raw RMS; `gain` multiplies both.
 * @param {{who: string|null, at: number, seconds: number, tempo: number, audio: import('../../src/lib/wav.mjs').Audio|null}[]} clips
 * @param {number} frames
 * @param {number} fps
 * @param {'peak'|'none'} normalize
 * @param {number} gain
 * @returns {number[]}
 */
function voiceEnvelope(clips, frames, fps, normalize, gain) {
  const env = new Float64Array(frames);
  for (const c of clips) {
    const audio = c.audio;
    if (!audio) continue;
    const rate = audio.sampleRate;
    const samples = audio.channels[0]?.length ?? 0;
    const k = c.tempo ?? 1; // the mix plays the line k times faster
    for (let f = Math.max(0, Math.floor(c.at * fps)); f < frames; f++) {
      const t0 = f / fps - c.at;
      if (t0 >= c.seconds) break;
      const s0 = Math.max(0, Math.floor(t0 * k * rate));
      const s1 = Math.min(samples, Math.floor((t0 + 1 / fps) * k * rate));
      let sum = 0;
      for (let i = s0; i < s1; i++) sum += audio.channels[0][i] ** 2;
      env[f] = Math.max(env[f], Math.sqrt(sum / Math.max(1, s1 - s0)));
    }
  }
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  const norm = normalize === 'none' ? 1 : max || 1;
  return Array.from(env, (v) => Math.round(Math.min(1, (v / norm) * gain) * 100) / 100);
}

/**
 * @param {object} input validated input, presets merged and defaults applied; audio refs are absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 * @returns {Promise<{result: object, outputs: {name: string, media_type: string}[]}>}
 */
export default async function run(input, ctx) {
  const d = input.defaults ?? {};
  const dLead = d.lead_s ?? 0;
  const dGap = d.gap_s ?? 0;
  const dTail = d.tail_s ?? 0;
  const dMin = d.min_s ?? 0;
  const dSnap = d.snap_beats ?? null;
  const thresholdDb = input.speech_end_threshold_db ?? -40;

  const grid = input.grid;
  const beatsPerBar = grid?.beats_per_bar ?? 4;
  const gridOffset = grid?.offset_s ?? 0;
  const beatLen = grid ? 60 / grid.bpm : null;
  const barLen = grid ? beatsPerBar * beatLen : null;

  // ctx.rawInput keeps the original ref strings (input has them resolved to absolute paths).
  const rawScenes = ctx.rawInput?.scenes ?? input.scenes;

  /** @type {{id: string, start: number, dur: number, cues: {at: number, dur: number, text: string|null, who: string|null, audio: string|null}[]}[]} */
  const scenes = [];
  /** @type {{who: string|null, at: number, seconds: number, tempo: number, audio: import('../../src/lib/wav.mjs').Audio|null}[]} */
  const clips = [];
  let t = 0;

  for (let si = 0; si < input.scenes.length; si++) {
    const scene = input.scenes[si];
    const raw = rawScenes[si] ?? scene;
    const lead = scene.lead_s ?? dLead;
    const gap = scene.gap_s ?? dGap;
    const tail = scene.tail_s ?? dTail;
    const min = scene.min_s ?? dMin;
    const snap = scene.snap_beats === undefined ? dSnap : scene.snap_beats;
    if (snap != null && !grid) {
      throw new ToolError('invalid-input', `scene "${scene.id}": snap_beats needs a grid {bpm, ...}`);
    }

    const lines = scene.lines ?? [];
    // Cue lengths first: audio is measured at its speech end (Piper leaves trailing silence), tempo applied.
    const durs = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.audio) {
        const audio = await decodeAudio(line.audio, { sampleRate: null, channels: null, signal: ctx.signal });
        const tempo = line.tempo ?? 1;
        durs.push({ dur: speechEnd(audio, { threshold_db: thresholdDb }) / tempo, tempo, audio });
      } else if (line.dur_s != null) {
        durs.push({ dur: line.dur_s, tempo: line.tempo ?? 1, audio: null });
      } else {
        durs.push({ dur: 0, tempo: line.tempo ?? 1, audio: null });
      }
    }

    // Cues: lead-in, then each line, with pause_s (or gap) before every line after the first.
    let at = t + lead;
    const cues = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (li > 0) at += line.pause_s ?? gap;
      const cue = {
        at: r4(at),
        dur: r4(durs[li].dur),
        text: line.text ?? null,
        who: line.who ?? null,
        audio: raw.lines?.[li]?.audio ?? line.audio ?? null,
      };
      cues.push(cue);
      clips.push({ who: line.who ?? null, at, seconds: durs[li].dur, tempo: durs[li].tempo, audio: durs[li].audio });
      at += durs[li].dur;
    }

    // The trailing gap is never added: speechEnd is the end of the last line. An empty scene is max(tail, min).
    const speechEndT = lines.length ? at : t;
    let dur;
    if (scene.duration_s != null) {
      dur = scene.duration_s; // fixed: used exactly, never snapped
    } else {
      const needed = Math.max(speechEndT + tail - t, min);
      if (snap != null) {
        const unit = beatLen * snap;
        if (!(unit > 0)) throw new ToolError('invalid-input', `scene "${scene.id}": snap_beats must be > 0`);
        dur = Math.ceil(needed / unit - EPS) * unit;
      } else {
        dur = needed;
      }
    }
    scenes.push({ id: scene.id, start: r4(t), dur: r4(dur), cues });
    t += dur;
  }
  const total = r4(t);

  // Markers and the music offset. align_to's marker picks the global offset so a bar (or beat) lands on its scene.
  const markersIn = input.markers ?? {};
  let musicOffset = 0;
  if (input.align_to) {
    const m = markersIn[input.align_to];
    if (!m) throw new ToolError('invalid-input', `align_to "${input.align_to}" is not a marker`);
    if (!grid) throw new ToolError('invalid-input', `align_to "${input.align_to}" needs a grid`);
    const scene = scenes.find((s) => s.id === m.scene);
    if (!scene) throw new ToolError('invalid-input', `marker "${input.align_to}": unknown scene "${m.scene}"`);
    const align = m.align ?? 'bar';
    if (align === 'bar') musicOffset = r4(Math.ceil(scene.start / barLen - EPS) * barLen - scene.start);
    else if (align === 'beat') musicOffset = r4(Math.ceil(scene.start / beatLen - EPS) * beatLen - scene.start);
  }
  const markers = {};
  for (const [name, m] of Object.entries(markersIn)) {
    if (!grid) throw new ToolError('invalid-input', `marker "${name}" needs a grid`);
    const scene = scenes.find((s) => s.id === m.scene);
    if (!scene) throw new ToolError('invalid-input', `marker "${name}": unknown scene "${m.scene}"`);
    const cycle = Math.ceil((scene.start + musicOffset) / barLen - EPS);
    markers[name] = { scene: m.scene, bar: cycle, cycle, music_offset_s: musicOffset };
  }

  // Named times against the computed timeline (scenes/cues/grid).
  const timelineForTimes = {
    scenes,
    grid: grid ? { bpm: grid.bpm, beats_per_bar: beatsPerBar, offset_s: gridOffset } : undefined,
  };
  const times = {};
  for (const [name, spec] of Object.entries(input.times ?? {})) {
    times[name] = resolveTime(spec, timelineForTimes, `times.${name}`);
  }

  // Voice envelope (optional): every distinct speaker gets an array of ceil(total * fps) frames.
  let voice;
  let voices;
  if (input.envelope) {
    const fps = input.envelope.fps;
    const normalize = input.envelope.normalize ?? 'peak';
    const gain = input.envelope.gain ?? 1.25;
    const perSpeaker = input.envelope.per_speaker ?? true;
    const frames = Math.ceil(total * fps);
    if (perSpeaker) {
      const groups = new Map();
      for (const line of input.scenes.flatMap((s) => s.lines ?? [])) {
        const who = line.who ?? '';
        if (!groups.has(who)) groups.set(who, []);
      }
      for (const c of clips) {
        const who = c.who ?? '';
        if (!groups.has(who)) groups.set(who, []);
        groups.get(who).push(c);
      }
      voices = {};
      for (const [who, mine] of groups) voices[who] = voiceEnvelope(mine, frames, fps, normalize, gain);
    } else {
      voice = voiceEnvelope(clips, frames, fps, normalize, gain);
    }
  }

  ctx.progress(1, 'laid out');

  const timeline = {
    version: 1,
    total,
    ...(grid ? { bpm: grid.bpm } : {}),
    beatOffset: musicOffset,
    ...(grid ? { grid: { bpm: grid.bpm, beats_per_bar: beatsPerBar, offset_s: gridOffset } } : {}),
    scenes,
    times,
    markers,
    ...(voice ? { voice } : {}),
    ...(voices ? { voices } : {}),
    ...(input.extra ?? {}),
  };
  await writeFile(path.join(ctx.outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));

  // dialogue-clips.json: ready to paste into an audio.mix track's "clips" array.
  const dialogueClips = [];
  for (let si = 0; si < input.scenes.length; si++) {
    const scene = input.scenes[si];
    const lines = scene.lines ?? [];
    for (let li = 0; li < lines.length; li++) {
      if (!lines[li].audio) continue;
      dialogueClips.push({ src: scenes[si].cues[li].audio, at: scenes[si].cues[li].at, name: `${scene.id}-${li}` });
    }
  }
  await writeFile(path.join(ctx.outDir, 'dialogue-clips.json'), JSON.stringify(dialogueClips, null, 2));

  return {
    result: {
      total,
      scenes: scenes.map(({ id, start, dur }) => ({ id, start, dur })),
      markers,
      music_offset_s: musicOffset,
    },
    outputs: [
      { name: 'timeline.json', media_type: 'application/json' },
      { name: 'dialogue-clips.json', media_type: 'application/json' },
    ],
  };
}
