// image.matte: cut a figure out of an illustration whose background is a soft, blurred glow or a flat colour.
// Faithful port of episodes/ep7-div/matte.mjs (five Persian-miniature characters on a broad beige aura):
//   1. 3x3 box smooth, gradient = max channel central difference
//   2. flood-fill the border through smooth pixels -> background
//   3. clear enclosed smooth "pockets" (glow trapped between an arm and the body) that are large, smooth and
//      close in colour to the glow reference (the mean of the background pixels that touch the figure)
//   4. keep the largest figure component, 5. erode, 6. soften the alpha with a 3x3 average
// Decoding and PNG encoding go through the shared ffmpeg wrapper.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';
import { safeOutputPath } from '../../src/lib/paths.mjs';

const MAX_PIXELS = 16_000_000;

/**
 * Image dimensions. ffprobe when present; otherwise read them from ffmpeg's banner.
 * @returns {Promise<{width: number, height: number}>}
 */
async function imageSize(file, signal) {
  try {
    const r = await runFfprobe(
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
      { signal },
    );
    const s = JSON.parse(r.stdout.toString()).streams?.[0];
    if (s && Number(s.width) > 0 && Number(s.height) > 0) {
      return { width: Number(s.width), height: Number(s.height) };
    }
  } catch {
    // ffprobe unavailable or unreadable; fall through to the ffmpeg banner.
  }
  try {
    await runFfmpeg(['-hide_banner', '-i', file], { signal });
  } catch (e) {
    const m = /(\d{2,5})x(\d{2,5})/.exec(e?.detail ?? '');
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  throw new ToolError('invalid-input', `could not read the dimensions of "${file}"`);
}

/**
 * @param {{image: string, threshold?: number, erode_px?: number, pockets?: boolean|{enabled?: boolean,
 *   min_px?: number, max_grad?: number, max_dist?: number}, keep_largest?: boolean, mask?: boolean, name?: string}} input
 *   refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const { outDir, signal } = ctx;
  const threshold = input.threshold ?? 9;
  const erodePx = input.erode_px ?? 2;
  const keepLargest = input.keep_largest ?? true;
  const mask = input.mask ?? false;
  const name = safeOutputPath(input.name ?? 'matte.png', 'name');

  const pocketsRaw = input.pockets ?? {};
  const pocketsEnabled = pocketsRaw === false ? false : pocketsRaw.enabled !== false;
  const minPx = typeof pocketsRaw === 'object' ? (pocketsRaw.min_px ?? 250) : 250;
  const maxGrad = typeof pocketsRaw === 'object' ? (pocketsRaw.max_grad ?? 2.8) : 2.8;
  const maxDist = typeof pocketsRaw === 'object' ? (pocketsRaw.max_dist ?? 60) : 60;

  ctx.progress(0, 'probing');
  const { width: W, height: H } = await imageSize(input.image, signal);
  if (W * H > MAX_PIXELS) {
    throw new ToolError(
      'invalid-input',
      `image is ${W}x${H} (${((W * H) / 1_000_000).toFixed(1)} megapixels); the limit is 16 megapixels`,
    );
  }
  const N = W * H;

  ctx.progress(0.05, 'decoding');
  const decoded = await runFfmpeg(
    ['-hide_banner', '-v', 'error', '-i', input.image, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { signal, stdout: 'buffer' },
  );
  const raw = decoded.stdout;
  if (!raw || raw.length !== N * 4) {
    throw new ToolError('tool-failed', `decoded ${raw?.length ?? 0} bytes, expected ${N * 4} for ${W}x${H} rgba`);
  }

  ctx.progress(0.15, 'smoothing');
  // Smoothed per-channel image (3x3 box) so pixel noise does not read as an edge.
  const sm = new Float32Array(N * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            s += raw[(yy * W + xx) * 4 + c];
            n++;
          }
        }
        sm[(y * W + x) * 3 + c] = s / n;
      }
    }
  }

  // Gradient = max channel central difference.
  const grad = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let g = 0;
      const i = y * W + x;
      for (let c = 0; c < 3; c++) {
        const gx = Math.abs(sm[(i + 1) * 3 + c] - sm[(i - 1) * 3 + c]);
        const gy = Math.abs(sm[(i + W) * 3 + c] - sm[(i - W) * 3 + c]);
        g = Math.max(g, gx, gy);
      }
      grad[i] = g;
    }
  }

  ctx.progress(0.45, 'flood fill');
  // Flood-fill the background from the border through smooth pixels. Everything reached is background.
  const bg = new Uint8Array(N);
  const q = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  const push = (i) => {
    if (!bg[i] && grad[i] < threshold) {
      bg[i] = 1;
      q[qt++] = i;
    }
  };
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  while (qh < qt) {
    const i = q[qh++];
    const x = i % W;
    const y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }

  // Glow reference colour: the mean of the background pixels that touch the figure.
  let gr = 0;
  let gg = 0;
  let gb = 0;
  let gn = 0;
  for (let i = W; i < N - W; i++) {
    if (!bg[i]) continue;
    if (!bg[i - 1] || !bg[i + 1] || !bg[i - W] || !bg[i + W]) {
      gr += sm[i * 3];
      gg += sm[i * 3 + 1];
      gb += sm[i * 3 + 2];
      gn++;
    }
  }
  const glowRef = gn > 0 ? [gr / gn, gg / gn, gb / gn] : null;

  ctx.progress(0.55, 'pockets');
  // Enclosed smooth pockets: report the glow-like ones and clear them from the background mask.
  const pocketsCleared = [];
  if (pocketsEnabled) {
    const seen = new Uint8Array(N);
    for (let s0 = 0; s0 < N; s0++) {
      if (bg[s0] || seen[s0] || grad[s0] >= threshold) continue;
      qh = qt = 0;
      q[qt++] = s0;
      seen[s0] = 1;
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let gs = 0;
      let cx = 0;
      let cy = 0;
      while (qh < qt) {
        const i = q[qh++];
        n++;
        r += sm[i * 3];
        g += sm[i * 3 + 1];
        b += sm[i * 3 + 2];
        gs += grad[i];
        cx += i % W;
        cy += (i / W) | 0;
        const x = i % W;
        const neighbours = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
        for (const j of neighbours) {
          if (j >= 0 && j < N && !bg[j] && !seen[j] && grad[j] < threshold) {
            seen[j] = 1;
            q[qt++] = j;
          }
        }
      }
      if (n < minPx) continue;
      const mc = [r / n, g / n, b / n];
      const dist = glowRef
        ? Math.hypot(mc[0] - glowRef[0], mc[1] - glowRef[1], mc[2] - glowRef[2])
        : Number.POSITIVE_INFINITY;
      const meanGrad = gs / n;
      if (glowRef && meanGrad < maxGrad && dist < maxDist) {
        for (let k = 0; k < qt; k++) bg[q[k]] = 1;
        pocketsCleared.push({ x: (cx / n) | 0, y: (cy / n) | 0, px: n, mean_grad: meanGrad, dist });
      }
    }
  }

  ctx.progress(0.7, 'components');
  let fig = new Uint8Array(N);
  for (let i = 0; i < N; i++) fig[i] = bg[i] ? 0 : 1;
  if (keepLargest) {
    const lab = new Int32Array(N);
    let best = 0;
    let bestN = 0;
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (!fig[s] || lab[s]) continue;
      id++;
      let n = 0;
      qh = qt = 0;
      q[qt++] = s;
      lab[s] = id;
      while (qh < qt) {
        const i = q[qh++];
        n++;
        const x = i % W;
        const neighbours = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
        for (const j of neighbours) {
          if (j >= 0 && j < N && fig[j] && !lab[j]) {
            lab[j] = id;
            q[qt++] = j;
          }
        }
      }
      if (n > bestN) {
        bestN = n;
        best = id;
      }
    }
    // bestN === 0 means the whole image flood-filled as background; keep the figure empty rather than
    // inverting an all-zero label array into a full-frame figure.
    for (let i = 0; i < N; i++) fig[i] = bestN > 0 && lab[i] === best ? 1 : 0;
  }

  // Erode the figure edge a little to remove the aura fringe.
  for (let e = 0; e < erodePx; e++) {
    const nf = fig.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (fig[i] && (!fig[i - 1] || !fig[i + 1] || !fig[i - W] || !fig[i + W])) nf[i] = 0;
      }
    }
    fig = nf;
  }

  ctx.progress(0.85, 'alpha');
  // Soft alpha: 3x3 average of the binary matte.
  const outBuf = Buffer.alloc(N * 4);
  const maskBuf = Buffer.alloc(N);
  let kept = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          s += fig[yy * W + xx];
          n++;
        }
      }
      const a = Math.round((255 * s) / n);
      const i = y * W + x;
      outBuf[i * 4] = raw[i * 4];
      outBuf[i * 4 + 1] = raw[i * 4 + 1];
      outBuf[i * 4 + 2] = raw[i * 4 + 2];
      outBuf[i * 4 + 3] = a;
      maskBuf[i] = a;
      if (a > 127) kept++;
    }
  }

  ctx.progress(0.95, 'encoding');
  const outPath = path.join(outDir, name);
  await mkdir(path.dirname(outPath), { recursive: true });
  await runFfmpeg(
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${W}x${H}`,
      '-i',
      '-',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      outPath,
    ],
    { signal, input: outBuf },
  );
  if (mask) {
    await runFfmpeg(
      [
        '-hide_banner',
        '-v',
        'error',
        '-y',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-s',
        `${W}x${H}`,
        '-i',
        '-',
        '-frames:v',
        '1',
        '-pix_fmt',
        'gray',
        path.join(outDir, 'mask.png'),
      ],
      { signal, input: maskBuf },
    );
  }

  const figurePct = Number(((100 * kept) / N).toFixed(3));
  const warnings = [];
  if (glowRef === null) {
    warnings.push('no background pixels touch the figure: the glow reference colour is unavailable');
  }
  if (figurePct < 2) {
    warnings.push(`figure_pct is ${figurePct}% (under 2%): nothing was cut; try a lower threshold`);
  } else if (figurePct > 98) {
    warnings.push(`figure_pct is ${figurePct}% (over 98%): everything was cut; try a higher threshold`);
  }

  ctx.progress(1, 'done');
  return {
    result: {
      width: W,
      height: H,
      figure_pct: figurePct,
      pockets_cleared: pocketsCleared,
      glow_ref: glowRef,
      warnings,
    },
  };
}
