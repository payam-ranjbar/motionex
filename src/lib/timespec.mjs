// STUB (owner: W0b-timespec). Replace the bodies; keep the exported names and signatures.
// Time specs used by timeline.layout, audio.mix and others. Ported from motion-studio build.mjs:317-332.
// Grammar:  number (seconds) | "<scene>" | "<scene>+1.5" | "<scene>-0.2" | "<scene>#<cue>" | "<scene>#<cue>.end[+-s]"
//           | "bar:<n>[+-s]" | "beat:<n>[+-s]"   (bar/beat need timeline.grid {bpm, beats_per_bar, offset_s}; n is 0-based)
// Scene ids match ^[\w-]+$ and MAY contain "-": if the whole string is a scene id it is that scene; otherwise a trailing
// [+-]<number> is split off as the offset.
import { ToolError } from './errors.mjs';

/** @returns {{kind:'seconds', seconds:number} | {kind:'scene', scene:string, cue:number|null, end:boolean, offset:number}
 *   | {kind:'bar'|'beat', n:number, offset:number}}  (parse only; scene existence is not checked)
 * @throws {ToolError} invalid-input for an unparseable spec */
export function parseTimespec(spec) {
  throw new ToolError('internal', 'not implemented: parseTimespec');
}

/** Resolve to seconds, rounded to 1e-4. timeline: {scenes:[{id, start, dur, cues:[{at, dur}]}], grid?:{bpm, beats_per_bar=4, offset_s=0}}.
 * scene -> scene.start; "#k" -> cues[k].at; "#k.end" -> cues[k].at + cues[k].dur; bar:n -> offset_s + n*beats_per_bar*60/bpm; beat:n -> offset_s + n*60/bpm.
 * A plain number needs no timeline. @throws {ToolError} invalid-input naming `what` (unknown scene, cue, or missing grid) */
export function resolveTime(spec, timeline, what = 'time') {
  throw new ToolError('internal', 'not implemented: resolveTime');
}
