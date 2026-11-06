// audio.mix render: track fx/gain/level, sidechains, mute, bus summing, master stage and output writing.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { filterAudio, writeAudio } from '../audio-io.mjs';
import { ToolError } from '../errors.mjs';
import { checkChain } from '../ffmpeg.mjs';
import { integratedLufs, measureAudio } from '../loudness.mjs';
import { fitLength, fromDb, peak } from '../signal.mjs';
import { applySidechains, trackLevelGains } from './dynamics.mjs';
import { applyMaster } from './master.mjs';

/** An N-frame, `channels`-channel silent Audio. */
function emptyAudio(sampleRate, channels, n) {
  return { sampleRate, channels: Array.from({ length: channels }, () => new Float32Array(n)) };
}

/** Add `src` into `dst`, sample by sample, over the shorter of the two lengths. */
export function sumInto(dst, src) {
  const n = dst.channels[0]?.length ?? 0;
  const nch = Math.min(dst.channels.length, src.channels.length);
  for (let c = 0; c < nch; c++) {
    const d = dst.channels[c];
    const s = src.channels[c];
    const len = Math.min(n, s.length);
    for (let i = 0; i < len; i++) d[i] += s[i];
  }
}

/** Run a track/bus fx chain (checked) and pad/trim to exactly n frames. */
export async function applyTrackFx(audio, fx, n, { signal } = {}) {
  const chain = checkChain(fx, 'track fx');
  return fitLength(await filterAudio(audio, chain, { signal }), n);
}

/** Scale an Audio by a gain in dB (returns the input unchanged for 0 dB). */
export function applyGainDb(audio, gainDb) {
  if (!gainDb) return audio;
  const g = fromDb(gainDb);
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((ch) => ch.map((x) => x * g)) };
}

/**
 * Apply track fx and gain, optional `level`, optional sidechains, then mute and sum through buses.
 * @param {object} plan @param {Map<string, import('../wav.mjs').Audio>} trackBuffers @param {number} n
 * @returns {Promise<{mix: import('../wav.mjs').Audio, stems: Map<string, import('../wav.mjs').Audio>,
 *   gains: Record<string, number>}>} stems are post-fx/gain/level/sidechain, pre-bus.
 */
export async function buildMix(plan, trackBuffers, n, { signal } = {}) {
  const stems = new Map();
  const gains = {};
  for (const track of plan.tracks) {
    let audio = trackBuffers.get(track.name);
    if (track.fx) audio = await applyTrackFx(audio, track.fx, n, { signal });
    const g = track.gain_db ?? 0;
    audio = applyGainDb(audio, g);
    gains[track.name] = g;
    stems.set(track.name, audio);
  }

  if (plan.tracks.some((t) => t.level)) {
    const measured = {};
    for (const track of plan.tracks) measured[track.name] = integratedLufs(stems.get(track.name));
    const levelGains = trackLevelGains(plan.tracks, measured);
    for (const track of plan.tracks) {
      const g = levelGains[track.name] ?? 0;
      if (g) {
        stems.set(track.name, applyGainDb(stems.get(track.name), g));
        gains[track.name] += g;
      }
    }
  }

  if (plan.sidechain.length) {
    const applied = await applySidechains(Object.fromEntries(stems), plan.sidechain, { signal });
    for (const [name, audio] of Object.entries(applied)) stems.set(name, audio);
  }

  const busMap = new Map();
  for (const bus of plan.buses) busMap.set(bus.name, emptyAudio(plan.sampleRate, plan.channels, n));
  const mix = emptyAudio(plan.sampleRate, plan.channels, n);
  for (const track of plan.tracks) {
    if (track.mute) continue;
    sumInto(track.bus ? busMap.get(track.bus) : mix, stems.get(track.name));
  }
  for (const bus of plan.buses) {
    let audio = busMap.get(bus.name);
    if (bus.fx) audio = await applyTrackFx(audio, bus.fx, n, { signal });
    sumInto(mix, applyGainDb(audio, bus.gain_db ?? 0));
  }
  return { mix, stems, gains };
}

/**
 * Run the master stage only when the request asked for it (fx, non-zero gain_db, or loudness).
 * @returns {Promise<{mix: import('../wav.mjs').Audio, report: object|null}>}
 */
export async function applyMasterStage(mix, master = {}, { signal } = {}) {
  const wanted = Boolean(master?.fx) || (master?.gain_db ?? 0) !== 0 || Boolean(master?.loudness);
  if (!wanted) return { mix, report: null };
  const { audio, report } = await applyMaster(mix, master, { signal });
  return { mix: audio, report };
}

/** Write the mix, optional wav32f stems and optional preview.mp3. @returns {Promise<string[]>} output names */
export async function writeOutputs({ outDir, output, mix, stems }, { signal } = {}) {
  const names = [];
  await writeAudio(path.join(outDir, output.name), mix, { format: output.format, signal });
  names.push(output.name);
  if (output.stems) {
    await mkdir(path.join(outDir, 'stems'), { recursive: true });
    for (const [track, audio] of stems) {
      const rel = `stems/${track}.wav`;
      await writeAudio(path.join(outDir, rel), audio, { format: 'wav32f', signal });
      names.push(rel);
    }
  }
  if (output.preview_mp3) {
    await writeAudio(path.join(outDir, 'preview.mp3'), mix, { format: 'mp3', bitrate_k: 192, signal });
    names.push('preview.mp3');
  }
  return names;
}

/** Write the report JSON alongside the audio. @param {string} outDir @param {object} report @returns {Promise<string>} */
export async function writeReport(outDir, report, { signal } = {}) {
  if (signal?.aborted) throw new ToolError('canceled', 'canceled');
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return 'report.json';
}

/**
 * Measure every stem and assemble the report. Adds the clip warning when a non-float format clips.
 * @returns {Promise<object>} the tool result
 */
export async function buildReport({ plan, n, mix, stems, gains, masterReport, warnings, output }, { signal } = {}) {
  const tracks = {};
  for (const track of plan.tracks) {
    const m = await measureAudio(stems.get(track.name), { signal });
    tracks[track.name] = {
      integrated_lufs: m.integrated_lufs,
      true_peak_dbtp: m.true_peak_dbtp,
      sample_peak_dbfs: m.sample_peak_dbfs,
      gain_applied_db: gains[track.name] ?? 0,
    };
  }
  const all = [...warnings];
  if (peak(mix) > 1 && output.format !== 'wav32f')
    all.push(`mix peaks above 0 dBFS; it was clipped in ${output.format}; use wav32f or a master limiter`);
  return {
    duration_s: n / plan.sampleRate,
    samples: n,
    sample_rate: plan.sampleRate,
    channels: plan.channels,
    tracks,
    master: masterReport,
    warnings: all,
  };
}
