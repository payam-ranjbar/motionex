// Shared helpers for voice providers (the voice.speak contract): line names and speech bounds, so a provider
// written in Node returns exactly the fields voice.piper's Python worker does, measured the same way.
import { ToolError } from './errors.mjs';
import { fromDb } from './signal.mjs';

/** Seconds kept after the last loud sample, as in voice.piper. */
export const SPEECH_TAIL_S = 0.03;

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Normalise voice lines: a string becomes {text}; a missing name becomes line-001, line-002, ... by position.
 * Throws invalid-input when two lines share a name or a name is "." or "..".
 * @param {(string|{text: string, name?: string})[]} lines
 * @returns {{name: string, text: string}[]}
 */
export function normalizeLines(lines) {
  const out = (lines ?? []).map((line, i) => {
    const l = typeof line === 'string' ? { text: line } : line;
    const name = l.name || `line-${String(i + 1).padStart(3, '0')}`;
    if (name === '.' || name === '..') {
      throw new ToolError('invalid-input', `line name "${name}" is not a usable file name`);
    }
    return { name, text: l.text };
  });
  const seen = new Set();
  for (const { name } of out) {
    if (seen.has(name)) throw new ToolError('invalid-input', `line names must be unique ("${name}" repeats)`);
    seen.add(name);
  }
  return out;
}

/**
 * Where speech starts and ends in a take: the first and last sample (on any channel) above `threshold_db`, the
 * end plus a 30 ms tail and capped at the file length. All zero when nothing is that loud.
 * @param {{sampleRate: number, channels: Float32Array[]}} audio
 * @param {{threshold_db?: number, tail_s?: number}} [opts]
 * @returns {{seconds: number, speech_start_s: number, speech_end_s: number, speech_s: number}}
 */
export function speechBounds(audio, { threshold_db = -40, tail_s = SPEECH_TAIL_S } = {}) {
  const sr = audio.sampleRate;
  const n = audio.channels[0]?.length ?? 0;
  const seconds = sr ? n / sr : 0;
  const thr = fromDb(threshold_db);
  const loud = (i) => audio.channels.some((ch) => Math.abs(ch[i]) > thr);
  let first = 0;
  while (first < n && !loud(first)) first++;
  if (first >= n) return { seconds: round3(seconds), speech_start_s: 0, speech_end_s: 0, speech_s: 0 };
  let last = n - 1;
  while (last > first && !loud(last)) last--;
  const start = first / sr;
  const end = Math.min(seconds, (last + 1) / sr + tail_s);
  return {
    seconds: round3(seconds),
    speech_start_s: round3(start),
    speech_end_s: round3(end),
    speech_s: round3(Math.max(0, end - start)),
  };
}
