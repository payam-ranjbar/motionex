// Time specs used by timeline.layout, audio.mix and others.
// Grammar:  number (seconds) | "<scene>" | "<scene>+1.5" | "<scene>-0.2" | "<scene>#<cue>" | "<scene>#<cue>.end[+-s]"
//           | "bar:<n>[+-s]" | "beat:<n>[+-s]"   (bar/beat need timeline.grid {bpm, beats_per_bar, offset_s}; n is 0-based)
// Scene ids match ^[\w-]+$ and MAY contain "-": if the whole string is a scene id it is that scene; otherwise a trailing
// [+-]<number> is split off as the offset.
import { ToolError } from './errors.mjs';

const OFFSET_RE = /([+-]\d*\.?\d+)$/;
const SCENE_RE = /^[\w-]+$/;
const GRID_RE = /^(bar|beat):(\d+)([+-]\d*\.?\d+)?$/;

/** @returns {{kind:'seconds', seconds:number} | {kind:'scene', scene:string, cue:number|null, end:boolean, offset:number}
 *   | {kind:'bar'|'beat', n:number, offset:number}}  (parse only; scene existence is not checked)
 * @throws {ToolError} invalid-input for an unparseable spec */
export function parseTimespec(spec) {
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec)) {
      throw new ToolError('invalid-input', `time must be a finite number, got ${String(spec)}`);
    }
    return { kind: 'seconds', seconds: spec };
  }
  if (typeof spec !== 'string') {
    throw new ToolError('invalid-input', `time must be a number or a string, got ${typeof spec}`);
  }

  const grid = GRID_RE.exec(spec);
  if (grid) return { kind: grid[1], n: Number(grid[2]), offset: Number(grid[3] ?? 0) };
  if (spec.startsWith('bar:') || spec.startsWith('beat:')) {
    throw new ToolError('invalid-input', `invalid grid time "${spec}" (expected ${spec.slice(0, 3)}:<n>[+-s])`);
  }

  // Split a trailing offset off the whole spec first (the syntactic rule), then the optional "#<cue>[.end]".
  let rest = spec;
  let offset = 0;
  const off = OFFSET_RE.exec(spec);
  if (off) {
    rest = spec.slice(0, off.index);
    offset = Number(off[1]);
  }

  let scene = rest;
  let cue = null;
  let end = false;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    scene = rest.slice(0, hash);
    const cuePart = rest.slice(hash + 1);
    const cm = /^(\d+)(\.end)?$/.exec(cuePart);
    if (!cm) throw new ToolError('invalid-input', `invalid cue in time "${spec}" (expected #<k>[.end])`);
    cue = Number(cm[1]);
    end = cm[2] !== undefined;
  }
  if (!SCENE_RE.test(scene)) throw new ToolError('invalid-input', `invalid scene in time "${spec}"`);
  return { kind: 'scene', scene, cue, end, offset };
}

/** Resolve to seconds, rounded to 1e-4. timeline: {scenes:[{id, start, dur, cues:[{at, dur}]}], grid?:{bpm, beats_per_bar=4, offset_s=0}}.
 * scene -> scene.start; "#k" -> cues[k].at; "#k.end" -> cues[k].at + cues[k].dur; bar:n -> offset_s + n*beats_per_bar*60/bpm; beat:n -> offset_s + n*60/bpm.
 * A plain number needs no timeline. @throws {ToolError} invalid-input naming `what` (unknown scene, cue, or missing grid) */
export function resolveTime(spec, timeline, what = 'time') {
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec)) throw new ToolError('invalid-input', `${what}: time must be a finite number`);
    return r4(spec);
  }
  if (typeof spec !== 'string') {
    throw new ToolError('invalid-input', `${what}: time must be a number or a string, got ${typeof spec}`);
  }

  let t;
  try {
    t = parseTimespec(spec);
  } catch (err) {
    if (err instanceof ToolError) throw new ToolError('invalid-input', `${what}: ${err.detail}`);
    throw err;
  }
  if (t.kind === 'seconds') return r4(t.seconds);

  if (!timeline || typeof timeline !== 'object') {
    throw new ToolError('invalid-input', `${what}: time spec "${spec}" needs a timeline`);
  }

  if (t.kind === 'bar' || t.kind === 'beat') {
    const g = timeline.grid;
    if (!g || !Number.isFinite(g.bpm) || g.bpm <= 0) {
      throw new ToolError('invalid-input', `${what}: "${spec}" needs timeline.grid {bpm, beats_per_bar, offset_s}`);
    }
    const beatsPerBar = g.beats_per_bar ?? 4;
    const gridOffset = g.offset_s ?? 0;
    const base = t.kind === 'bar' ? (t.n * beatsPerBar * 60) / g.bpm : (t.n * 60) / g.bpm;
    return r4(gridOffset + base + t.offset);
  }

  const scenes = Array.isArray(timeline.scenes) ? timeline.scenes : [];
  // A scene id may itself end in [+-]<number>, so prefer the unsplit name (whole spec, or the part before "#").
  const hash = spec.indexOf('#');
  const unsplit = hash === -1 ? spec : spec.slice(0, hash);
  const byUnsplit = scenes.find((s) => s && s.id === unsplit);
  const scene = byUnsplit ?? scenes.find((s) => s && s.id === t.scene);
  if (!scene) {
    const ids = scenes.map((s) => s?.id).join(', ') || '(none)';
    throw new ToolError('invalid-input', `${what}: unknown scene "${t.scene}" in "${spec}"; known scenes: ${ids}`);
  }
  const offset = byUnsplit ? (hash === -1 ? 0 : t.offset) : t.offset;

  let base = scene.start;
  if (t.cue !== null) {
    const cues = Array.isArray(scene.cues) ? scene.cues : [];
    const cue = cues[t.cue];
    if (!cue) {
      throw new ToolError('invalid-input', `${what}: scene "${scene.id}" has ${cues.length} cue(s); no cue #${t.cue}`);
    }
    base = t.end ? cue.at + cue.dur : cue.at;
  }
  return r4(base + offset);
}
