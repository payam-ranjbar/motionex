// image.grade: colour-grade stills with an ordered list of steps before they go into a page. The pixel math is plain
// JS on typed arrays (grade.mjs); ffmpeg only decodes and encodes. Each step does only what its fields say, and the
// numbers in the result (mean L*, a*, b*, subject separation) let an agent that cannot see check the grade.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { isSafeName } from '../../src/lib/paths.mjs';
import { applyStep, glowLayer, lightMask, maskFrom, measure, parseCube } from './grade.mjs';

const MAX_PIXELS = 16_000_000;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|ppm|pgm|pnm|pam|avif)$/i;

/** The fields each op needs and may take. */
const OPS = {
  cast: { need: ['axis', 'amount'], may: ['protect'] },
  saturation: { need: ['amount'], may: ['hue', 'rest'] },
  curve: { need: [], may: ['contrast', 'pivot', 'lift', 'shoulder', 'gamma'] },
  exposure: { need: ['ev'], may: [] },
  clarity: { need: ['amount'], may: ['radius'] },
  tint: { need: ['amount'], may: ['color', 'where', 'grow', 'feather', 'protect'] },
  vignette: { need: ['amount'], may: ['softness'] },
  lut: { need: ['file'], may: ['amount'] },
};

/** `amount` means something different per op, so its range is checked here; the schema checks the rest. */
const AMOUNT = { cast: [0, 1], saturation: [0, 10], clarity: [-1, 4], tint: [0, 1], vignette: [-1, 1], lut: [0, 1] };

/** Defaults of the optional step fields (documented in the schema descriptions). */
const STEP_DEFAULTS = {
  cast: { protect: 'none' },
  clarity: { radius: 0.02 },
  tint: { color: '#000000', where: 'everywhere', grow: 0, feather: 0, protect: 'none' },
  vignette: { softness: 0.5 },
  lut: { amount: 1 },
};

const LIGHT_DEFAULTS = {
  hue_min_deg: 15,
  hue_max_deg: 65,
  min_value: 0.75,
  min_saturation: 0.35,
  core_value: 0.92,
  spread: 0.01,
  write_masks: false,
};
const GLOW_DEFAULTS = { radii: [0.004, 0.015, 0.05], strength: 1 };

const invalid = (detail) => new ToolError('invalid-input', detail);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** "#rrggbb" or "#rgb" (the # is optional) -> encoded sRGB 0..1. */
function parseHex(hex, what) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex));
  if (!m) throw invalid(`${what} "${hex}" must be a hex colour such as "#000000"`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((o) => Number.parseInt(h.slice(o, o + 2), 16) / 255);
}

/**
 * Check every step against its op and fill its defaults; read and parse LUT files.
 * @returns {Promise<{steps: object[], warnings: string[]}>}
 */
async function prepareSteps(steps, rawSteps) {
  const out = [];
  const warnings = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const at = `steps[${i}]`;
    const spec = OPS[s.op];
    const fields = [...spec.need, ...spec.may];
    for (const key of Object.keys(s)) {
      if (key !== 'op' && !fields.includes(key)) {
        throw invalid(`${at}.${key} is not a field of op "${s.op}" (its fields: ${fields.join(', ') || 'none'})`);
      }
    }
    for (const key of spec.need) {
      if (s[key] === undefined) throw invalid(`${at}.${key} is required for op "${s.op}"`);
    }
    const step = { ...STEP_DEFAULTS[s.op], ...s };
    const range = AMOUNT[s.op];
    if (range && step.amount !== undefined && !(step.amount >= range[0] && step.amount <= range[1])) {
      throw invalid(`${at}.amount must be from ${range[0]} to ${range[1]} for op "${s.op}" (got ${step.amount})`);
    }
    if (s.op === 'saturation' && s.rest !== undefined && !s.hue) {
      throw invalid(`${at}.rest needs ${at}.hue: it is the multiplier for colours outside the hue range`);
    }
    if (s.op === 'curve' && fields.every((k) => s[k] === undefined)) {
      warnings.push(`${at} is a curve with no fields; it does nothing`);
    }
    if (s.op === 'tint') step.color = parseHex(step.color, `${at}.color`);
    if (s.op === 'lut') {
      const ref = rawSteps?.[i]?.file ?? s.file;
      let text;
      try {
        text = await readFile(s.file, 'utf8');
      } catch (e) {
        throw new ToolError('input-unreadable', `${at}.file "${ref}" could not be read (${e.code ?? e.message})`);
      }
      try {
        step.lut = parseCube(text);
      } catch (e) {
        throw invalid(`${at}.file "${ref}" is not a usable .cube LUT: ${e.message}`);
      }
    }
    out.push(step);
  }
  return { steps: out, warnings };
}

/** Base name of a ref: the file name without its image extension, made safe for an output name. */
function baseFromRef(ref) {
  let s = String(ref ?? '');
  const hash = s.lastIndexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  s =
    s
      .replace(/^(job|pin):/, '')
      .split('/')
      .pop() ?? '';
  return s
    .replace(IMAGE_EXT, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 100);
}

/** One output name per image, unique within the call, and no two output files the same. */
function planNames(items, rawItems, ext, extras) {
  const names = new Array(items.length);
  const used = new Set();
  items.forEach((it, i) => {
    if (it.name === undefined) return;
    const n = String(it.name).replace(IMAGE_EXT, '');
    if (!isSafeName(n) || n.length > 100) {
      throw invalid(`images[${i}].name "${it.name}" must be 1 to 100 letters, digits, _ . or - (no folders)`);
    }
    if (used.has(n)) throw invalid(`images[${i}].name "${n}" is already the name of another image in this call`);
    used.add(n);
    names[i] = n;
  });
  items.forEach((_it, i) => {
    if (names[i]) return;
    const base = baseFromRef(rawItems?.[i]?.image) || `image-${i + 1}`;
    let n = base;
    for (let k = 2; used.has(n); k++) n = `${base}-${k}`;
    used.add(n);
    names[i] = n;
  });
  const files = new Map();
  names.forEach((n, i) => {
    for (const f of [`${n}.${ext}`, ...extras.map((x) => `${n}-${x}.png`)]) {
      if (files.has(f)) {
        throw invalid(`images[${i}] and images[${files.get(f)}] would both write ${f}; give one of them another name`);
      }
      files.set(f, i);
    }
  });
  return names;
}

/** Image dimensions: ffprobe when present, else ffmpeg's banner. */
async function imageSize(file, signal, what) {
  try {
    const r = await runFfprobe(
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
      { signal },
    );
    const s = JSON.parse(r.stdout.toString()).streams?.[0];
    if (s && Number(s.width) > 0 && Number(s.height) > 0) return { width: Number(s.width), height: Number(s.height) };
  } catch (e) {
    if (e?.type === 'canceled') throw e;
    // ffprobe unavailable or unreadable; fall through to the ffmpeg banner.
  }
  try {
    await runFfmpeg(['-hide_banner', '-i', file], { signal });
  } catch (e) {
    if (e?.type === 'canceled') throw e;
    const m = /Video:.*?\b(\d{1,5})x(\d{1,5})\b/.exec(e?.detail ?? '');
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  throw new ToolError('input-unreadable', `${what} is not an image ffmpeg can read`);
}

/** Decode the first frame as 8-bit RGBA, optionally scaled to width x height. */
async function decodeRgba(file, width, height, signal, what, scale = false) {
  const args = ['-hide_banner', '-v', 'error', '-i', file, '-frames:v', '1'];
  if (scale) args.push('-vf', `scale=${width}:${height}:flags=bicubic`);
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-');
  let stdout;
  try {
    ({ stdout } = await runFfmpeg(args, { signal, stdout: 'buffer' }));
  } catch (e) {
    if (e?.type === 'canceled') throw e;
    throw new ToolError('input-unreadable', `${what} could not be decoded: ${String(e?.detail ?? e).slice(-300)}`);
  }
  const want = width * height * 4;
  if (!stdout || stdout.length !== want) {
    throw new ToolError('input-unreadable', `${what} decoded to ${stdout?.length ?? 0} bytes, not ${want}`);
  }
  return stdout;
}

/** Encode 8-bit pixels (gray, rgb24 or rgba) to a PNG or JPEG file. */
async function encode(buf, width, height, pixFmt, file, signal, quality = null) {
  const codec = quality === null ? [] : ['-c:v', 'mjpeg', '-q:v', String(Math.round(2 + ((100 - quality) * 29) / 99))];
  await runFfmpeg(
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      pixFmt,
      '-s',
      `${width}x${height}`,
      '-i',
      '-',
      '-frames:v',
      '1',
      ...codec,
      '-update',
      '1',
      file,
    ],
    { signal, input: buf },
  );
}

const to8 = (v) => (v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0);

/**
 * @param {{images: {image: string, name?: string, mask?: string}[], steps?: object[], light_mask?: object,
 *   glow?: {radii?: number[], strength?: number}, format?: 'png'|'jpeg', quality?: number}} input
 *   refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const { outDir, signal } = ctx;
  const raw = ctx.rawInput ?? input;
  const checkAbort = () => {
    if (signal?.aborted) throw new ToolError('canceled', 'canceled');
  };

  const prepared = await prepareSteps(input.steps ?? [], raw.steps);
  const steps = prepared.steps;
  const warnings = [...prepared.warnings];
  const lm = { ...LIGHT_DEFAULTS, ...(input.light_mask ?? {}) };
  const glow = input.glow ? { ...GLOW_DEFAULTS, ...input.glow } : null;
  const format = input.format ?? 'png';
  const quality = input.quality ?? 92;
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const extras = [...(glow ? ['glow'] : []), ...(lm.write_masks ? ['lights'] : [])];
  const names = planNames(input.images, raw.images, ext, extras);
  const protectsLights = steps.some((s) => s.protect === 'lights');
  await mkdir(outDir, { recursive: true });

  const images = [];
  const count = input.images.length;
  for (let i = 0; i < count; i++) {
    checkAbort();
    const item = input.images[i];
    const name = names[i];
    const at = `images[${i}]`;
    ctx.progress(i / count, `${name}: decoding`);

    const { width: W, height: H } = await imageSize(item.image, signal, `${at}.image`);
    if (W * H > MAX_PIXELS) {
      throw invalid(`${at}.image is ${W}x${H} (${((W * H) / 1e6).toFixed(1)} megapixels); the limit is 16 megapixels`);
    }
    const n = W * H;
    const px = await decodeRgba(item.image, W, H, signal, `${at}.image`);
    let alpha = null;
    for (let k = 0; k < n; k++) {
      if (px[k * 4 + 3] !== 255) {
        alpha = new Float32Array(n);
        for (let j = 0; j < n; j++) alpha[j] = px[j * 4 + 3] / 255;
        break;
      }
    }
    const rgb = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      rgb[k * 3] = px[k * 4] / 255;
      rgb[k * 3 + 1] = px[k * 4 + 1] / 255;
      rgb[k * 3 + 2] = px[k * 4 + 2] / 255;
    }

    let mask = null;
    let maskPct = null;
    if (item.mask) {
      const ms = await imageSize(item.mask, signal, `${at}.mask`);
      if (ms.width * ms.height > MAX_PIXELS) throw invalid(`${at}.mask is over 16 megapixels`);
      const resize = ms.width !== W || ms.height !== H;
      if (resize) warnings.push(`${name}: the mask is ${ms.width}x${ms.height}; it was resized to ${W}x${H}`);
      const mp = await decodeRgba(item.mask, W, H, signal, `${at}.mask`, resize);
      mask = maskFrom(mp, n).mask;
      let sum = 0;
      for (let k = 0; k < n; k++) sum += mask[k];
      maskPct = round((100 * sum) / n);
      if (maskPct < 1) warnings.push(`${name}: the mask covers ${maskPct}% of the frame (almost none of it)`);
      else if (maskPct > 99) warnings.push(`${name}: the mask covers ${maskPct}% of the frame (almost all of it)`);
    }

    ctx.progress((i + 0.2) / count, `${name}: light mask`);
    const lights = lightMask(rgb, W, H, lm);
    let lightSum = 0;
    for (let k = 0; k < n; k++) lightSum += lights.soft[k];
    const lightsPct = round((100 * lightSum) / n);
    if (lightsPct > 40) {
      warnings.push(
        `${name}: the light mask covers ${lightsPct}% of the frame; check it with light_mask.write_masks, or raise ` +
          'light_mask.min_value or min_saturation',
      );
    } else if (lightSum === 0 && protectsLights) {
      warnings.push(`${name}: no light pixels were found, so protect "lights" keeps nothing; check light_mask`);
    }
    const before = measure(px, 4, n, lights.soft, alpha, mask);

    const img = { width: W, height: H, rgb, lights: lights.soft, mask };
    const skipped = [];
    for (let s = 0; s < steps.length; s++) {
      checkAbort();
      ctx.progress((i + 0.3 + (0.5 * s) / steps.length) / count, `${name}: ${steps[s].op}`);
      const why = applyStep(img, steps[s]);
      if (why) {
        skipped.push(s);
        warnings.push(`${name}: steps[${s}] (${steps[s].op}) was skipped: ${why}`);
      }
    }

    ctx.progress((i + 0.85) / count, `${name}: encoding`);
    const keepAlpha = alpha !== null && format === 'png';
    if (alpha && !keepAlpha) warnings.push(`${name}: the image has transparency, which JPEG cannot keep`);
    const ch = keepAlpha ? 4 : 3;
    const out = Buffer.alloc(n * ch);
    for (let k = 0; k < n; k++) {
      out[k * ch] = to8(rgb[k * 3]);
      out[k * ch + 1] = to8(rgb[k * 3 + 1]);
      out[k * ch + 2] = to8(rgb[k * 3 + 2]);
      if (keepAlpha) out[k * 4 + 3] = px[k * 4 + 3];
    }
    const file = `${name}.${ext}`;
    await encode(
      out,
      W,
      H,
      keepAlpha ? 'rgba' : 'rgb24',
      path.join(outDir, file),
      signal,
      format === 'jpeg' ? quality : null,
    );
    const after = measure(out, ch, n, lights.soft, alpha, mask);

    const entry = {
      name,
      file,
      width: W,
      height: H,
      before: { luma: before.luma, cast_a: before.cast_a, cast_b: before.cast_b },
      after: { luma: after.luma, cast_a: after.cast_a, cast_b: after.cast_b },
      lights_pct: lightsPct,
      skipped_steps: skipped,
    };
    if (mask) {
      const sep = (m) =>
        m.luma_in === null || m.luma_out === null
          ? null
          : round(20 * Math.log10(Math.max(m.luma_in, 0.1) / Math.max(m.luma_out, 0.1)));
      entry.subject = {
        mask_pct: maskPct,
        luma_in: after.luma_in,
        luma_out: after.luma_out,
        separation_db: sep(after),
        separation_db_before: sep(before),
      };
    }

    if (glow) {
      checkAbort();
      ctx.progress((i + 0.9) / count, `${name}: glow`);
      const layer = glowLayer(
        rgb,
        W,
        H,
        lights.raw,
        glow.radii.map((r) => r * W),
        glow.strength,
      );
      if (layer.peak === 0) warnings.push(`${name}: no pixel is in the light mask, so the glow layer is black`);
      const g8 = Buffer.alloc(n * 3);
      for (let k = 0; k < n * 3; k++) g8[k] = to8(layer.rgb[k]);
      entry.glow_file = `${name}-glow.png`;
      await encode(g8, W, H, 'rgb24', path.join(outDir, entry.glow_file), signal);
    }
    if (lm.write_masks) {
      const m8 = Buffer.alloc(n);
      for (let k = 0; k < n; k++) m8[k] = to8(lights.soft[k]);
      entry.lights_file = `${name}-lights.png`;
      await encode(m8, W, H, 'gray', path.join(outDir, entry.lights_file), signal);
    }
    images.push(entry);
  }

  ctx.progress(1, 'done');
  return { result: { images, warnings } };
}
