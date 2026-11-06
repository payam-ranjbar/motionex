// Master stage of audio.mix: master fx chain, master gain, optional loudness target (gain+limiter or two-pass loudnorm).
import { filterAudio } from '../audio-io.mjs';
import { ToolError } from '../errors.mjs';
import { checkChain, runFfmpeg } from '../ffmpeg.mjs';
import { integratedLufs, measureAudio } from '../loudness.mjs';
import { fitLength, fromDb } from '../signal.mjs';
import { encodeWav, framesOf } from '../wav.mjs';

/**
 * @param {import('../wav.mjs').Audio} audio  the summed mix (any length; returned audio has the SAME length)
 * @param {{gain_db?: number, fx?: string, loudness?: {target_lufs: number, true_peak_db?: number, method?: 'gain+limiter'|'loudnorm', lra?: number}}} master
 * @returns {Promise<{audio: import('../wav.mjs').Audio, report: {before: object, after: object, gain_db: number, method: string|null, warning?: string}}>}
 *   before/after = loudness.measureAudio() results */
export async function applyMaster(audio, master = {}, { signal } = {}) {
  const n = framesOf(audio);

  const before = await measureAudio(audio, { signal });

  // 1. Master fx chain (agent-supplied; checked before it reaches ffmpeg). Never changes the length.
  if (master.fx) {
    audio = fitLength(await filterAudio(audio, checkChain(master.fx, 'master.fx'), { signal }), n);
  }

  // 2. Master gain (in JS; no extra ffmpeg pass). Tracked for the report.
  let appliedGainDb = 0;
  if (master.gain_db != null && master.gain_db !== 0) {
    audio = applyGainDb(audio, master.gain_db);
    appliedGainDb = master.gain_db;
  }

  // 3. Optional loudness target.
  let loudnessGainDb = 0;
  let preLoudnessI = null;
  let warning;
  if (master.loudness) {
    const { target_lufs, true_peak_db = -1.5, method = 'gain+limiter', lra = 11 } = master.loudness;
    const i = integratedLufs(audio);
    if (i == null) {
      // Digital silence: an integrated loudness target cannot be reached. Skip; the caller sees the warning.
      warning = 'integrated loudness is null (silence): loudness target skipped';
    } else if (method === 'loudnorm') {
      preLoudnessI = i;
      audio = fitLength(await loudnorm(audio, { target_lufs, true_peak_db, lra, signal }), n);
    } else {
      // gain + limiter: one measured gain, then a true-peak-safe limiter.
      const g = target_lufs - i;
      audio = applyGainDb(audio, g);
      const limit = Math.min(1, Math.max(0.0625, 10 ** ((true_peak_db - 0.5) / 20)));
      const chain = `alimiter=limit=${limit.toFixed(6)}:attack=4:release=60:level=disabled:latency=1`;
      audio = fitLength(await filterAudio(audio, chain, { signal }), n);
      loudnessGainDb = g;
    }
  }

  const after = await measureAudio(audio, { signal });

  // For loudnorm the applied gain is what actually happened (after.I - I before loudness); for gain+limiter it is g.
  if (preLoudnessI != null && after.integrated_lufs != null) loudnessGainDb = after.integrated_lufs - preLoudnessI;

  return {
    audio: fitLength(audio, n),
    report: {
      before,
      after,
      gain_db: appliedGainDb + loudnessGainDb,
      method: master.loudness?.method ?? null,
      ...(warning ? { warning } : {}),
    },
  };
}

/** Multiply every sample by fromDb(gain_db). Returns a new Audio of the same shape. */
function applyGainDb(audio, gain_db) {
  const g = fromDb(gain_db);
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g;
      return out;
    }),
  };
}

/** Two-pass ffmpeg loudnorm. Pass 1 measures, pass 2 applies the measured values linearly. */
async function loudnorm(audio, { target_lufs, true_peak_db, lra, signal }) {
  const measured = await loudnormMeasure(audio, { target_lufs, true_peak_db, lra, signal });
  const layout =
    audio.channels.length === 1 ? 'mono' : audio.channels.length === 2 ? 'stereo' : `${audio.channels.length}c`;
  const chain =
    `loudnorm=I=${target_lufs}:TP=${true_peak_db}:LRA=${lra}:` +
    `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:` +
    `measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,` +
    // loudnorm outputs 192 kHz internally; name the rate and layout ffmpeg 6.0 cannot negotiate on its own.
    `aresample=${audio.sampleRate},aformat=sample_fmts=flt:channel_layouts=${layout}`;
  return filterAudio(audio, chain, { signal });
}

/** loudnorm pass 1: print_format=json; the measurement object is the last `{` that starts a line of stderr. */
async function loudnormMeasure(audio, { target_lufs, true_peak_db, lra, signal }) {
  const args = [
    '-hide_banner',
    '-nostats',
    '-f',
    'wav',
    '-i',
    'pipe:0',
    '-af',
    `loudnorm=I=${target_lufs}:TP=${true_peak_db}:LRA=${lra}:print_format=json`,
    '-f',
    'null',
    '-',
  ];
  const { stderr } = await runFfmpeg(args, { input: encodeWav(audio, { format: 'f32' }), signal });
  const text = String(stderr ?? '');
  let at = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '{' && (i === 0 || text[i - 1] === '\n')) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ToolError('tool-failed', 'loudnorm pass 1 printed no measurement JSON');
  let measured;
  try {
    measured = JSON.parse(text.slice(at));
  } catch (e) {
    throw new ToolError('tool-failed', `loudnorm pass 1 measurement JSON is invalid: ${e.message}`);
  }
  const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
  const missing = keys.filter((k) => measured[k] == null);
  if (missing.length)
    throw new ToolError('tool-failed', `loudnorm pass 1 measurement is missing ${missing.join(', ')}`);
  return measured;
}
