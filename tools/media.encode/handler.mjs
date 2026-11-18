// media.encode: the delivery encoder. Explicit quality/bitrate/size/scale/audio controls, fit-to-N-MB
// two-pass (libx264/libx265) and named presets. Colour is converted only when video.color is set, using
// the scale filter's auto input matrix/range so nothing is shifted blindly.
// Optional picture steps, in this order: lut (a 3D LUT file), video_fx (an agent chain), scale, then pad
// (fit inside a frame and fill the rest). With target_size_mb, an input that already fits and needs no other
// change is returned unchanged instead of being encoded again (copy_if_fits).
import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { checkChain, colorArgs, runFfmpeg, runFfprobe, videoArgs } from '../../src/lib/ffmpeg.mjs';
import { safeName } from '../../src/lib/paths.mjs';

const TWO_PASS_CODECS = new Set(['libx264', 'libx265']);
const PAD_Y = { center: '(oh-ih)/2', top: '0', bottom: 'oh-ih' };

// checkChain refuses movie, amovie, sendcmd and zmq. video_fx also refuses filters and options that read or
// write files or load code, and options whose value is read from a file ("/option=path"), so the chain cannot
// reach files outside the workspace. The checks run on a copy without quotes and backslashes, which the
// filtergraph parser would remove. A LUT goes through the lut field, whose path the handler builds itself.
const FILE_FILTERS =
  /(?:^|[,;\]])\s*(a?movie|a?sendcmd|a?zmq|lut1d|lut3d|drawtext|subtitles|ass|removelogo|frei0r|vidstabdetect|vidstabtransform|signature|metadata|dnn_\w+|derain|sr|nnedi|libplacebo|find_rect|cover_rect|lensfun|libvmaf|vmafmotion|ocr|program_opencl|openclsrc)\s*(?=[=,;[@\s]|$)/i;
const FILE_OPTIONS =
  /(?:^|[=:])\s*(file|filename|textfile|fontfile|fontsdir|psfile|stats_file|log_path|model|db_path|shader_path|custom_shader_path|datapath)\s*=/i;
const OPTION_FROM_FILE = /(?:^|[=:])\s*\/[\w-]+\s*=/;

/**
 * Probe a media file for the fields this tool needs.
 * @param {string} file absolute path
 * @param {AbortSignal} signal
 * @returns {Promise<{duration_s: number|null, width: number|null, height: number|null, video_bitrate_k: number|null,
 *   audio_bitrate_k: number|null, audio_duration_s: number|null, has_audio: boolean, video_codec: string|null,
 *   pix_fmt: string|null, color_space: string|null, fps: number|null, audio_codec: string|null,
 *   sample_rate: number|null, channels: number|null}>}
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
  const rate = (r) => {
    const [n, d] = String(r ?? '')
      .split('/')
      .map(Number);
    return n > 0 && d > 0 ? n / d : null;
  };
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
    video_codec: v?.codec_name ?? null,
    pix_fmt: v?.pix_fmt ?? null,
    color_space: v?.color_space ?? null,
    fps: rate(v?.r_frame_rate),
    audio_codec: a?.codec_name ?? null,
    sample_rate: num(a?.sample_rate),
    channels: a?.channels ?? null,
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
 * Check an agent-supplied video_fx chain: checkChain, then the file-reading filters and options it misses.
 * @param {string} chain
 * @returns {string} the chain, unchanged
 * @throws {ToolError} invalid-input
 */
function checkVideoFx(chain) {
  checkChain(chain, 'video_fx');
  const plain = chain.replace(/[\\'"]/g, '');
  checkChain(plain, 'video_fx');
  const f = FILE_FILTERS.exec(plain);
  if (f) {
    const hint = /^lut[13]d$/i.test(f[1]) ? '; pass a 3D LUT file with the lut field instead' : '';
    throw new ToolError(
      'invalid-input',
      `video_fx: the "${f[1]}" filter reads or writes files and is not allowed${hint}`,
    );
  }
  const o = FILE_OPTIONS.exec(plain);
  if (o) throw new ToolError('invalid-input', `video_fx: the "${o[1]}" option names a file and is not allowed`);
  if (OPTION_FROM_FILE.test(plain))
    throw new ToolError('invalid-input', 'video_fx: option values read from a file ("/option=path") are not allowed');
  return chain;
}

/**
 * Chroma-subsampled pixel formats cannot hold odd sizes: 4:2:0 needs even width and height, 4:2:2 and 4:1:1 an
 * even width.
 * @param {{width: number, height: number}} pad
 * @param {string} pixFmt
 * @throws {ToolError} invalid-input
 */
function checkPad(pad, pixFmt) {
  const evenW = /420|422|411|^nv1[26]|^nv21|^p01[026]/.test(pixFmt);
  const evenH = /420|^nv12|^nv21|^p01[026]/.test(pixFmt);
  const odd = [];
  if (evenW && pad.width % 2) odd.push(`width ${pad.width}`);
  if (evenH && pad.height % 2) odd.push(`height ${pad.height}`);
  if (odd.length)
    throw new ToolError(
      'invalid-input',
      `pad: ${odd.join(' and ')} must be even for ${pixFmt}, whose chroma is subsampled (for example 1080x1920)`,
    );
}

/**
 * An absolute path as a filter option value inside a -vf graph: escaped once for the option parser (\ ' :)
 * and once more for the graph parser (\ ' [ ] , ;). Windows backslashes become forward slashes.
 * @param {string} abs
 * @returns {string}
 */
function filterPath(abs) {
  const p = process.platform === 'win32' ? abs.replace(/\\/g, '/') : abs;
  return p.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');
}

/**
 * The explicit scale size as [w, h] option strings, or null when scale asks for nothing.
 * max_long_side / max_width cap the size and never upscale; the free side stays -2 (kept aspect ratio).
 * @returns {[string, string]|null}
 */
function scaleSize(scale, inW, inH) {
  const s = scale ?? {};
  if (s.width != null || s.height != null) {
    return [s.width != null ? String(s.width) : '-2', s.height != null ? String(s.height) : '-2'];
  }
  if (s.max_long_side == null && s.max_width == null) return null;
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
  if (fx <= fy) return [String(Math.max(2, Math.floor((inW * f) / 2) * 2)), '-2'];
  return ['-2', String(Math.max(2, Math.floor((inH * f) / 2) * 2))];
}

/**
 * Scale options that fit the picture inside the pad box, up or down, keeping the display aspect ratio (dar, so a
 * non-square SAR is honoured). The free side is rounded to an even size and never exceeds the box.
 * @param {{width: number, height: number}} pad
 * @returns {string}
 */
function fitScale({ width: W, height: H }) {
  const wide = `gte(dar,${W}/${H})`;
  const w = `if(${wide},${W},min(${W},max(2,round(${H}*dar/2)*2)))`;
  const h = `if(${wide},min(${H},max(2,round(${W}/dar/2)*2)),${H})`;
  return `w='${w}':h='${h}':flags=lanczos`;
}

/**
 * The -vf graph: [lut] -> [video_fx] -> [scale] -> [fit + pad + setsar] -> format=<pix_fmt>.
 * The colour conversion rides on the first scale filter (the explicit size, else the pad fit, else its own).
 * @returns {string}
 */
function buildVideoFilter({ scale, color, pixFmt, inW, inH, pad, lut, fx }) {
  const parts = [];
  // lut3d works in RGB: convert with the source's own matrix and range, so the LUT sees the real colours.
  if (lut) parts.push('scale=in_color_matrix=auto:in_range=auto', `lut3d=file=${filterPath(lut)}`);
  if (fx) parts.push(fx);
  const size = scaleSize(scale, inW, inH);
  const scales = [size ? `${size[0]}:${size[1]}` : null, pad ? fitScale(pad) : null].filter(Boolean);
  if (color) {
    const colorOpts = `in_color_matrix=auto:in_range=auto:out_color_matrix=${color}:out_range=tv`;
    if (scales.length) scales[0] = `${scales[0]}:${colorOpts}`;
    else scales.push(colorOpts);
  }
  for (const s of scales) parts.push(`scale=${s}`);
  if (pad) {
    const y = PAD_Y[pad.position ?? 'center'];
    parts.push(`pad=w=${pad.width}:h=${pad.height}:x=(ow-iw)/2:y=${y}:color=${pad.color ?? 'black'}`, 'setsar=1');
  }
  parts.push(`format=${pixFmt}`);
  return parts.join(',');
}

/** Encoder name -> the codec_name ffprobe reports for its streams (unknown encoders map to themselves). */
function codecOf(encoder) {
  const e = String(encoder).toLowerCase();
  if (/x264|h264/.test(e)) return 'h264';
  if (/x265|hevc/.test(e)) return 'hevc';
  if (/vp9/.test(e)) return 'vp9';
  if (e === 'libvpx' || /vp8/.test(e)) return 'vp8';
  if (/av1/.test(e)) return 'av1';
  if (/aac/.test(e)) return 'aac';
  if (/opus/.test(e)) return 'opus';
  if (/mp3/.test(e)) return 'mp3';
  if (/vorbis/.test(e)) return 'vorbis';
  return e;
}

/** True when `scale` would change a w x h picture (a cap the picture already meets changes nothing). */
function scaleChanges(s, w, h) {
  if (!s) return false;
  if (s.width != null || s.height != null)
    return (s.width != null && s.width !== w) || (s.height != null && s.height !== h);
  if (s.max_width != null && w > s.max_width) return true;
  return s.max_long_side != null && Math.max(w, h) > s.max_long_side;
}

/**
 * Why a target-size request that the input already fits still needs an encode, or null when the input can be
 * returned unchanged: nothing else is asked and its streams already match what the encode would make.
 * @returns {string|null}
 */
function encodeReason(input, probe, { codec, pixFmt, color, audio, name }) {
  if (input.replace_audio) return 'replace_audio is set';
  if (input.pad) return 'pad is set';
  if (input.lut) return 'lut is set';
  if (input.video_fx) return 'video_fx is set';
  if (probe.width == null || probe.height == null) return 'the input size is unknown';
  if (scaleChanges(input.scale, probe.width, probe.height)) return 'scale changes the size';
  if (input.fps != null && (probe.fps == null || Math.abs(input.fps - probe.fps) > 1e-3)) return 'fps changes the rate';
  if (codecOf(codec) !== probe.video_codec) return `the video codec changes (${probe.video_codec} -> ${codec})`;
  if (pixFmt !== probe.pix_fmt) return `the pixel format changes (${probe.pix_fmt} -> ${pixFmt})`;
  if (color && probe.color_space !== color)
    return `the colour matrix changes (${probe.color_space ?? 'untagged'} -> ${color})`;
  if (probe.has_audio && audio.codec !== 'copy') {
    const ac = audio.codec ?? 'aac';
    if (codecOf(ac) !== probe.audio_codec) return `the audio codec changes (${probe.audio_codec} -> ${ac})`;
    if (audio.sample_rate != null && audio.sample_rate !== probe.sample_rate) return 'audio.sample_rate changes';
    if (audio.channels != null && audio.channels !== probe.channels) return 'audio.channels changes';
  }
  if (path.extname(input.input).toLowerCase() !== path.extname(name).toLowerCase()) return 'the container changes';
  return null;
}

/**
 * @param {{input: string, replace_audio?: string, preset?: string, video?: object, audio?: object, scale?: object,
 *   pad?: {width: number, height: number, color?: string, position?: string}, video_fx?: string, lut?: string,
 *   fps?: number, two_pass?: boolean, target_size_mb?: number, size_margin?: number, copy_if_fits?: boolean,
 *   name?: string}} input  refs resolved to absolute paths
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
  const targetBytes = targetMb != null ? Math.floor(targetMb * 1e6) : null;
  const replacePath = input.replace_audio ?? null;
  const canTwoPass = TWO_PASS_CODECS.has(codec);
  const fpsArgs = input.fps != null ? ['-r', String(input.fps)] : [];
  const pad = input.pad ?? null;
  const lut = input.lut ?? null;
  const fx = input.video_fx ? checkVideoFx(input.video_fx) : null;
  if (pad) checkPad(pad, pixFmt);
  /** @type {string[]} */
  const warnings = [];

  const report = async ({ passes, attempts, sizeBytes, audioBudgetK, passthrough }) => {
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
        audio_bitrate_k: Math.round(audioBudgetK),
        passes,
        attempts,
        width: outProbe.width,
        height: outProbe.height,
        passthrough,
        warnings,
      },
      outputs: [{ name }],
    };
  };

  ctx.progress(0, 'probing input');
  const inProbe = await probeMedia(input.input, ctx.signal);

  // Audio that consumes the byte budget. A copied stream is not re-encoded, so its real source bitrate
  // (not audio.bitrate_k) is what the target-size budget has to reserve for it. No audio stream -> zero.
  let budgetAudioKbps = audioKbps;
  if (audio.codec === 'copy') {
    const audioSource = replacePath ?? input.input;
    const audioProbe = audioSource === input.input ? inProbe : await probeMedia(audioSource, ctx.signal);
    if (!audioProbe.has_audio) budgetAudioKbps = 0;
    else budgetAudioKbps = (await sourceAudioBitrateK(audioSource, audioProbe, ctx.signal)) ?? audioKbps;
  }

  // Fit-size on an input that already fits: an encode could only make it bigger or lose quality, so when nothing
  // else is asked and its streams already match, return the file unchanged.
  if (targetBytes != null && input.copy_if_fits !== false) {
    const inBytes = (await stat(input.input)).size;
    if (inBytes <= targetBytes) {
      const reason = encodeReason(input, inProbe, { codec, pixFmt, color, audio, name });
      if (reason == null) {
        await copyFile(input.input, outPath);
        let keptAudioK = 0;
        if (inProbe.has_audio) keptAudioK = (await sourceAudioBitrateK(input.input, inProbe, ctx.signal)) ?? 0;
        warnings.push(
          `the input (${inBytes} bytes) already fits under target_size_mb ${targetMb} (${targetBytes} bytes) and nothing else was asked, so it was returned unchanged without encoding; pass copy_if_fits: false to encode anyway`,
        );
        return report({ passes: 0, attempts: 0, sizeBytes: inBytes, audioBudgetK: keptAudioK, passthrough: true });
      }
      ctx.log(`the input already fits under the target, but ${reason}, so it is encoded`);
    }
  }

  const videoFilter = buildVideoFilter({
    scale: input.scale,
    color,
    pixFmt,
    inW: inProbe.width,
    inH: inProbe.height,
    pad,
    lut,
    fx,
  });

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
  if (targetBytes != null && sizeBytes > targetBytes) {
    warnings.push(
      `the output (${sizeBytes} bytes) is still over target_size_mb ${targetMb} (${targetBytes} bytes) after ${attempts} attempts`,
    );
  }

  return report({ passes, attempts, sizeBytes, audioBudgetK: budgetAudioKbps, passthrough: false });
}
