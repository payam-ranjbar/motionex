// media.encode: the delivery encoder. Explicit quality/bitrate/size/scale/audio controls, fit-to-N-MB
// two-pass (libx264/libx265) and named presets. Colour is converted only when video.color is set, using
// the scale filter's auto input matrix/range so nothing is shifted blindly.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { colorArgs, runFfmpeg, runFfprobe, videoArgs } from '../../src/lib/ffmpeg.mjs';
import { safeName } from '../../src/lib/paths.mjs';

const TWO_PASS_CODECS = new Set(['libx264', 'libx265']);

/**
 * Probe a media file for the fields this tool needs.
 * @param {string} file absolute path
 * @param {AbortSignal} signal
 * @returns {Promise<{duration_s: number|null, width: number|null, height: number|null, video_bitrate_k: number|null,
 *   audio_bitrate_k: number|null, audio_duration_s: number|null, has_audio: boolean}>}
 */
async function probeMedia(file, signal) {
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    signal,
  });
  const data = JSON.parse(stdout.toString() || '{}');
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === 'video') ?? null;
  const a = streams.find((s) => s.codec_type === 'audio') ?? null;
  const num = (x) => (x === undefined || x === null || x === '' || x === 'N/A' ? null : Number(x));
  const duration = num(data.format?.duration) ?? num(v?.duration);
  const audioDuration = num(a?.duration);
  const videoBitrate = num(v?.bit_rate);
  const audioBitrate = num(a?.bit_rate);
  return {
    duration_s: Number.isFinite(duration) ? duration : null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    video_bitrate_k: videoBitrate != null ? Math.round(videoBitrate / 1000) : null,
    audio_bitrate_k: audioBitrate != null ? Math.round(audioBitrate / 1000) : null,
    audio_duration_s: Number.isFinite(audioDuration) ? audioDuration : null,
    has_audio: a != null,
  };
}

/**
 * The real bitrate of a file's first audio stream, in kbit/s, for budgeting a stream copy. Uses ffprobe's
 * stream `bit_rate`; when a container omits it (e.g. some WAVs), sums the audio packet sizes and divides by
 * the stream's duration.
 * @param {string} file absolute path
 * @param {{audio_bitrate_k: number|null, audio_duration_s: number|null, duration_s: number|null}} probe a probeMedia result
 * @param {AbortSignal} signal
 * @returns {Promise<number|null>} kbit/s, or null when it cannot be determined
 */
async function sourceAudioBitrateK(file, probe, signal) {
  if (probe.audio_bitrate_k != null) return probe.audio_bitrate_k;
  const duration = probe.audio_duration_s ?? probe.duration_s;
  if (!duration) return null;
  const { stdout } = await runFfprobe(
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', file],
    { signal },
  );
  let bytes = 0;
  for (const token of stdout.toString().split(/\s+/)) {
    const n = Number(token);
    if (Number.isFinite(n)) bytes += n;
  }
  if (bytes <= 0) return null;
  return Math.round((bytes * 8) / duration / 1000);
}

/**
 * Build the single scale (colour + size) filter, then format=<pix_fmt>.
 * max_long_side / max_width cap the size and never upscale; the free side stays -2 (kept aspect ratio).
 * @returns {string}
 */
function buildVideoFilter({ scale, color, pixFmt, inW, inH }) {
  const s = scale ?? {};
  let w = null;
  let h = null;
  if (s.width != null || s.height != null) {
    w = s.width != null ? String(s.width) : '-2';
    h = s.height != null ? String(s.height) : '-2';
  } else if (s.max_long_side != null || s.max_width != null) {
    if (inW == null || inH == null)
      throw new ToolError('invalid-input', 'scale caps need the input dimensions, but the input could not be probed');
    let maxW = s.max_width ?? Number.POSITIVE_INFINITY;
    let maxH = Number.POSITIVE_INFINITY;
    if (s.max_long_side != null) {
      if (inW >= inH) maxW = Math.min(maxW, s.max_long_side);
      else maxH = Math.min(maxH, s.max_long_side);
    }
    const fx = maxW / inW;
    const fy = maxH / inH;
    const f = Math.min(1, fx, fy);
    if (fx <= fy) {
      w = String(Math.max(2, Math.floor((inW * f) / 2) * 2));
      h = '-2';
    } else {
      w = '-2';
      h = String(Math.max(2, Math.floor((inH * f) / 2) * 2));
    }
  }
  const scaleOpts = [];
  if (w != null && h != null) scaleOpts.push(`${w}:${h}`);
  if (color) scaleOpts.push(`in_color_matrix=auto:in_range=auto:out_color_matrix=${color}:out_range=tv`);
  const parts = [];
  if (scaleOpts.length) parts.push(`scale=${scaleOpts.join(':')}`);
  parts.push(`format=${pixFmt}`);
  return parts.join(',');
}

/**
 * @param {{input: string, replace_audio?: string, preset?: string, video?: object, audio?: object, scale?: object,
 *   fps?: number, two_pass?: boolean, target_size_mb?: number, size_margin?: number, name?: string}} input  refs resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const video = input.video ?? {};
  const audio = input.audio ?? {};
  const codec = video.codec ?? 'libx264';
  const pixFmt = video.pix_fmt ?? 'yuv420p';
  const color = video.color === undefined ? 'bt709' : video.color;
  const name = safeName(input.name ?? 'video.mp4', 'name');
  const outPath = path.join(ctx.outDir, name);
  const passlog = path.join(ctx.scratchDir, 'x264');
  const audioKbps = audio.bitrate_k ?? 192;
  const sizeMargin = input.size_margin ?? 0.04;
  const targetMb = input.target_size_mb ?? null;
  const replacePath = input.replace_audio ?? null;
  const canTwoPass = TWO_PASS_CODECS.has(codec);
  const fpsArgs = input.fps != null ? ['-r', String(input.fps)] : [];

  ctx.progress(0, 'probing input');
  const inProbe = await probeMedia(input.input, ctx.signal);
  const videoFilter = buildVideoFilter({ scale: input.scale, color, pixFmt, inW: inProbe.width, inH: inProbe.height });

  // Audio that consumes the byte budget. A copied stream is not re-encoded, so its real source bitrate
  // (not audio.bitrate_k) is what the target-size budget has to reserve for it. No audio stream -> zero.
  let budgetAudioKbps = audioKbps;
  if (audio.codec === 'copy') {
    const audioSource = replacePath ?? input.input;
    const audioProbe = audioSource === input.input ? inProbe : await probeMedia(audioSource, ctx.signal);
    if (!audioProbe.has_audio) budgetAudioKbps = 0;
    else budgetAudioKbps = (await sourceAudioBitrateK(audioSource, audioProbe, ctx.signal)) ?? audioKbps;
  }

  // Fit-to-size: derive the video bitrate from the duration and the audio budget.
  let baseBitrate = video.bitrate_k ?? null;
  if (targetMb != null) {
    const duration = inProbe.duration_s;
    if (!duration) throw new ToolError('invalid-input', 'could not determine the input duration for target_size_mb');
    baseBitrate = Math.floor(((targetMb * 8e6) / duration / 1000 - budgetAudioKbps) * (1 - sizeMargin));
    if (baseBitrate < 100) throw new ToolError('invalid-input', 'target too small for this duration');
  }
  let crf = video.crf;
  if (baseBitrate == null && crf == null) crf = 18;

  let twoPass = Boolean(input.two_pass) || targetMb != null;
  if (!canTwoPass) twoPass = false;
  const passes = twoPass ? 2 : 1;

  const targetBytes = targetMb != null ? Math.floor(targetMb * 1e6) : null;
  const mapPass1 = ['-map', '0:v:0'];
  const mapFinal = replacePath ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0', '-map', '0:a?'];
  const encAudioArgs = ['-c:a', audio.codec ?? 'aac', '-b:a', `${Math.round(audioKbps)}k`];
  if (audio.sample_rate != null) encAudioArgs.push('-ar', String(audio.sample_rate));
  if (audio.channels != null) encAudioArgs.push('-ac', String(audio.channels));

  const runAttempt = async (bitrate) => {
    const hasBitrate = bitrate != null;
    const maxrate = hasBitrate
      ? (video.maxrate_k ?? Math.round(bitrate * (video.maxrate_factor ?? 1.75)))
      : video.maxrate_k;
    const vArgs = videoArgs({
      codec,
      preset: video.preset,
      crf: hasBitrate ? undefined : crf,
      bitrate_k: hasBitrate ? Math.round(bitrate) : undefined,
      maxrate_k: maxrate,
      bufsize_k: video.bufsize_k,
      profile: video.profile,
      level: video.level,
      gop: video.gop,
      keyint_min: video.keyint_min,
      sc_threshold: video.sc_threshold,
      closed_gop: video.closed_gop,
      pix_fmt: pixFmt,
      tune: video.tune,
      x264_params: video.x264_params,
    });
    const inputs = ['-hide_banner', '-y', '-i', input.input];
    if (replacePath) inputs.push('-i', replacePath);

    if (passes === 2) {
      await runFfmpeg(
        [
          ...inputs,
          ...mapPass1,
          '-vf',
          videoFilter,
          ...fpsArgs,
          ...vArgs,
          '-pass',
          '1',
          '-passlogfile',
          passlog,
          '-an',
          '-f',
          'null',
          '-',
        ],
        { signal: ctx.signal },
      );
      ctx.progress(0.6, 'pass 2/2');
    }
    await runFfmpeg(
      [
        ...inputs,
        ...mapFinal,
        '-vf',
        videoFilter,
        ...fpsArgs,
        ...vArgs,
        ...(passes === 2 ? ['-pass', '2', '-passlogfile', passlog] : []),
        ...encAudioArgs,
        ...colorArgs(color),
        '-movflags',
        '+faststart',
        outPath,
      ],
      { signal: ctx.signal },
    );
  };

  let attempts = 0;
  let sizeBytes = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    const bitrate = baseBitrate != null ? baseBitrate * (attempt === 1 ? 1 : 0.9) : null;
    ctx.progress(attempt === 1 ? 0.1 : 0.7, `encoding attempt ${attempt}`);
    await runAttempt(bitrate);
    sizeBytes = (await stat(outPath)).size;
    if (targetBytes != null && sizeBytes > targetBytes && attempt < 2) continue;
    break;
  }

  ctx.progress(0.95, 'probing output');
  const outProbe = await probeMedia(outPath, ctx.signal);
  let videoBitrateK = outProbe.video_bitrate_k;
  if (videoBitrateK == null && outProbe.duration_s) {
    videoBitrateK = Math.round((sizeBytes * 8) / outProbe.duration_s / 1000 - (outProbe.audio_bitrate_k ?? 0));
  }
  ctx.progress(1, 'done');
  return {
    result: {
      size_bytes: sizeBytes,
      duration_s: outProbe.duration_s,
      video_bitrate_k: videoBitrateK,
      audio_bitrate_k: Math.round(budgetAudioKbps),
      passes,
      attempts,
      width: outProbe.width,
      height: outProbe.height,
    },
    outputs: [{ name }],
  };
}
