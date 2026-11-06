// media.probe: inspect a media file with ffprobe and return a compact, typed summary.
import { ToolError } from '../../src/lib/errors.mjs';
import { runFfprobe } from '../../src/lib/ffmpeg.mjs';

/** Parse an ffprobe rate string like "30/1" into a number rounded to 0.001, or null. */
function parseRate(rate) {
  if (typeof rate !== 'string') return null;
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(rate);
  if (!m) return null;
  const den = Number(m[2]);
  if (!den) return null;
  return Math.round((Number(m[1]) / den) * 1000) / 1000;
}

/** A number from an ffprobe value, or null when it is absent / "N/A" / not finite. */
function num(v) {
  if (v === undefined || v === null || v === '' || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Copy a defined value onto `out` under `key`. */
function put(out, key, value) {
  if (value !== null && value !== undefined) out[key] = value;
}

/**
 * @param {{input: string, raw?: boolean}} input refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  ctx.progress(0, 'probing');
  const { stdout } = await runFfprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input.input], {
    signal: ctx.signal,
    stdout: 'buffer',
  });
  let probe;
  try {
    probe = JSON.parse(stdout.toString('utf8') || '{}');
  } catch (e) {
    throw new ToolError('tool-failed', `ffprobe returned invalid JSON: ${e.message}`);
  }

  const streams = (probe.streams ?? []).map((s) => {
    const out = { index: num(s.index) ?? 0, type: s.codec_type ?? 'unknown', codec: s.codec_name ?? null };
    put(out, 'width', num(s.width));
    put(out, 'height', num(s.height));
    put(out, 'fps', parseRate(s.avg_frame_rate));
    put(out, 'pix_fmt', s.pix_fmt ?? null);
    put(out, 'color_space', s.color_space ?? null);
    put(out, 'color_range', s.color_range ?? null);
    put(out, 'color_transfer', s.color_transfer ?? null);
    put(out, 'color_primaries', s.color_primaries ?? null);
    put(out, 'sample_rate', num(s.sample_rate));
    put(out, 'channels', num(s.channels));
    put(out, 'duration_s', num(s.duration));
    put(out, 'bit_rate', num(s.bit_rate));
    return out;
  });

  const first = probe.streams?.[0] ?? {};
  const result = {
    duration_s: num(probe.format?.duration) ?? num(first.duration),
    size_bytes: num(probe.format?.size),
    format: probe.format?.format_name ?? null,
    bit_rate: num(probe.format?.bit_rate),
    streams,
  };
  if (input.raw) result.raw = probe;
  ctx.progress(1, 'done');
  return { result };
}
