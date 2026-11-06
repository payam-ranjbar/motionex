// Optional mixer dynamics: clip leveling, relative track levels, sidechain compression.
// Every function is opt-in; the mixer only calls them when a request (or a preset) asks for a feature.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../errors.mjs';
import { runFfmpeg } from '../ffmpeg.mjs';
import { fitLength } from '../signal.mjs';
import { encodeWav, readWav } from '../wav.mjs';

/** Median of a numeric list (average of the two middles when even); null for an empty list. */
function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Gain (dB) per clip that brings it to the target loudness (the median of non-null clipLufs, or a LUFS number).
 * Clips already within tolerance_lu get 0; null (silent) clips get 0; gains are clamped to [min_db, max_db].
 * @param {(number|null)[]} clipLufs @returns {number[]} */
export function levelClips(clipLufs, { to = 'median', tolerance_lu = 0.75, min_db = -9, max_db = 6 } = {}) {
  const target = typeof to === 'number' ? to : median(clipLufs.filter((x) => x != null));
  return clipLufs.map((lufs) => {
    if (lufs == null || target == null) return 0;
    const delta = target - lufs;
    if (Math.abs(delta) <= tolerance_lu) return 0;
    return Math.min(max_db, Math.max(min_db, delta));
  });
}

/** Extra gain (dB) per track for `level` specs: {lufs: n} -> n - measured[name]; {relative_to: other, lu: n} -> (measured[other] + gains[other]) + n - measured[name].
 * Resolved in dependency order. Tracks without `level` get 0. measured[name] is the track's integrated LUFS after its fx and gain_db (null = silent -> 0).
 * @param {{name: string, level?: {lufs?: number, relative_to?: string, lu?: number}}[]} tracks @param {Record<string, number|null>} measured
 * @returns {Record<string, number>} @throws {ToolError} invalid-input on unknown relative_to or a cycle */
export function trackLevelGains(tracks, measured) {
  const byName = new Map(tracks.map((t) => [t.name, t]));
  const gains = {};
  const state = new Map(); // 'visiting' while resolving, 'done' once gains[name] is final

  const resolve = (name) => {
    const seen = state.get(name);
    if (seen === 'done') return gains[name] ?? 0;
    if (seen === 'visiting') throw new ToolError('invalid-input', `level cycle detected at track "${name}"`);
    const track = byName.get(name);
    if (!track) return 0;
    state.set(name, 'visiting');

    const level = track.level;
    let gain = 0;
    if (level?.lufs != null) {
      const own = measured?.[name];
      if (own == null) console.warn(`track "${name}" level skipped: integrated loudness is null (silent)`);
      else gain = level.lufs - own;
    } else if (level?.relative_to != null) {
      const other = level.relative_to;
      if (!byName.has(other))
        throw new ToolError('invalid-input', `track "${name}".level.relative_to: unknown track "${other}"`);
      const otherGain = resolve(other);
      const own = measured?.[name];
      const base = measured?.[other];
      if (own == null || base == null)
        console.warn(`track "${name}" level skipped: integrated loudness is null (silent)`);
      else gain = base + otherGain + (level.lu ?? 0) - own;
    }

    state.set(name, 'done');
    gains[name] = gain;
    return gain;
  };

  for (const track of tracks) resolve(track.name);
  return gains;
}

const SIDECHAIN_DEFAULTS = {
  threshold: 0.02,
  ratio: 6,
  attack_ms: 20,
  release_ms: 400,
  knee: 2.8,
  makeup: 1,
  lookahead_s: 0,
};

/** Drop the first `lookahead_s` seconds of the key, then zero-pad to the target's length (advance the key in time). */
function advanceKey(key, targetFrames, sampleRate, lookahead_s) {
  const lead = Math.max(0, Math.round((lookahead_s ?? 0) * sampleRate));
  return {
    sampleRate,
    channels: key.channels.map((ch) => {
      const out = new Float32Array(targetFrames);
      const take = Math.min(targetFrames, Math.max(0, ch.length - lead));
      for (let i = 0; i < take; i++) out[i] = ch[i + lead];
      return out;
    }),
  };
}

/** Reshape the key to the target's channel count: mono -> duplicate, multi -> average. */
function matchChannels(key, targetCh) {
  const inCh = key.channels.length;
  if (inCh === targetCh) return key;
  if (inCh === 1)
    return {
      sampleRate: key.sampleRate,
      channels: Array.from({ length: targetCh }, () => Float32Array.from(key.channels[0])),
    };
  const len = key.channels[0]?.length ?? 0;
  if (targetCh === 1) {
    const out = new Float32Array(len);
    for (const ch of key.channels) for (let i = 0; i < len; i++) out[i] += ch[i];
    for (let i = 0; i < len; i++) out[i] /= inCh;
    return { sampleRate: key.sampleRate, channels: [out] };
  }
  return { sampleRate: key.sampleRate, channels: key.channels.slice(0, targetCh) };
}

/** Apply sidechain compression to TRACK buffers, in array order. Key = buffers[key] advanced by lookahead_s and padded to the target's length.
 * ffmpeg sidechaincompress=threshold:ratio:attack:release:knee:makeup with the target as input 0 and the key as input 1.
 * @param {Record<string, import('../wav.mjs').Audio>} buffers @param {{target: string, key: string, threshold?: number, ratio?: number, attack_ms?: number, release_ms?: number, knee?: number, makeup?: number, lookahead_s?: number}[]} sidechains
 * @returns {Promise<Record<string, import('../wav.mjs').Audio>>} new map; untouched tracks are passed through; every buffer keeps its length */
export async function applySidechains(buffers, sidechains, { signal } = {}) {
  const out = { ...buffers };
  for (const entry of sidechains ?? []) {
    const { target, key } = entry;
    const targetAudio = out[target];
    const keyAudio = out[key];
    if (!targetAudio || !keyAudio) {
      console.warn(`sidechain ${target}<-${key} skipped: no track named ${!targetAudio ? target : key}`);
      continue;
    }
    const sampleRate = targetAudio.sampleRate;
    const targetFrames = targetAudio.channels[0]?.length ?? 0;
    const preparedKey = matchChannels(
      advanceKey(keyAudio, targetFrames, sampleRate, entry.lookahead_s),
      targetAudio.channels.length,
    );
    const opts = { ...SIDECHAIN_DEFAULTS, ...entry };
    const chain =
      `sidechaincompress=threshold=${opts.threshold}:ratio=${opts.ratio}:` +
      `attack=${opts.attack_ms}:release=${opts.release_ms}:knee=${opts.knee}:makeup=${opts.makeup}`;

    const dir = await mkdtemp(path.join(os.tmpdir(), 'mx-sidechain-'));
    try {
      const targetFile = path.join(dir, 'target.wav');
      const keyFile = path.join(dir, 'key.wav');
      await writeFile(targetFile, encodeWav(targetAudio, { format: 'f32' }));
      await writeFile(keyFile, encodeWav(preparedKey, { format: 'f32' }));
      const args = [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-i',
        targetFile,
        '-i',
        keyFile,
        '-filter_complex',
        `[0:a][1:a]${chain}[o]`,
        '-map',
        '[o]',
        '-c:a',
        'pcm_f32le',
        '-f',
        'wav',
        'pipe:1',
      ];
      const { stdout } = await runFfmpeg(args, { signal });
      out[target] = fitLength(readWav(stdout), targetFrames);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return out;
}
