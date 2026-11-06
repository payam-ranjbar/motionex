// Generated test files. Binary fixtures are never committed: tests and manifest examples describe them as FixtureSpec.
// FixtureSpec (one key):
//   {sine:   {freq, seconds, amplitude_db = -20, channels = 2, sample_rate = 48000, format = 's16'}}
//   {noise:  {seconds, amplitude_db = -20, seed = 1, channels = 2, sample_rate = 48000, format = 's16'}}   white noise, peak at amplitude
//   {silence:{seconds, channels = 2, sample_rate = 48000, format = 's16'}}
//   {concat: [FixtureSpec, ...]}   audio specs joined in time (sample rate/channels of the first)
//   {text:   "..."}                  a UTF-8 text file
//   {json:   any}                    a JSON file
//   {copy:   "<absolute path>"}      copy an existing file
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toWorkspacePath } from '../../src/lib/paths.mjs';
import { fromDb, mulberry32 } from '../../src/lib/signal.mjs';
import { encodeWav } from '../../src/lib/wav.mjs';

/** Build planar audio for an audio FixtureSpec. @returns {{sampleRate: number, channels: Float32Array[], format: string}} */
export function makeAudio(spec) {
  const [kind, o] = Object.entries(spec)[0];
  if (kind === 'concat') {
    const parts = o.map(makeAudio);
    const { sampleRate, channels, format } = parts[0];
    const n = channels.length;
    const len = parts.reduce((s, p) => s + p.channels[0].length, 0);
    const out = Array.from({ length: n }, () => new Float32Array(len));
    let at = 0;
    for (const p of parts) {
      for (let c = 0; c < n; c++) out[c].set(p.channels[Math.min(c, p.channels.length - 1)], at);
      at += p.channels[0].length;
    }
    return { sampleRate, channels: out, format };
  }
  const sr = o.sample_rate ?? 48000;
  const nch = o.channels ?? 2;
  const len = Math.round((o.seconds ?? 1) * sr);
  const amp = fromDb(o.amplitude_db ?? -20);
  const ch = new Float32Array(len);
  if (kind === 'sine') for (let i = 0; i < len; i++) ch[i] = amp * Math.sin((2 * Math.PI * o.freq * i) / sr);
  else if (kind === 'noise') {
    const r = mulberry32(o.seed ?? 1);
    for (let i = 0; i < len; i++) ch[i] = amp * (r() * 2 - 1);
  } else if (kind !== 'silence') throw new Error(`unknown audio fixture kind "${kind}"`);
  return {
    sampleRate: sr,
    channels: Array.from({ length: nch }, () => Float32Array.from(ch)),
    format: o.format ?? 's16',
  };
}

/**
 * Write a fixture into a workspace.
 * @param {string} workspace absolute
 * @param {string} rel workspace-relative POSIX path
 * @param {object} spec FixtureSpec
 * @returns {Promise<string>} absolute path
 */
export async function writeFixture(workspace, rel, spec) {
  const abs = toWorkspacePath(workspace, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  const [kind, o] = Object.entries(spec)[0];
  if (kind === 'text') await writeFile(abs, String(o), 'utf8');
  else if (kind === 'json') await writeFile(abs, JSON.stringify(o, null, 2), 'utf8');
  else if (kind === 'copy') await copyFile(o, abs);
  else {
    const a = makeAudio(spec);
    await writeFile(abs, encodeWav(a, { format: a.format }));
  }
  return abs;
}

/** Write every fixture of a manifest example. */
export async function writeFixtures(workspace, fixtures = {}) {
  for (const [rel, spec] of Object.entries(fixtures)) await writeFixture(workspace, rel, spec);
}
