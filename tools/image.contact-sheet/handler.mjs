// image.contact-sheet: scale stills to a common width, pad them to the first image's height,
// and lay them out with xstack. Labels are drawn with drawtext when the build has it.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../../src/lib/errors.mjs';
import { ffmpegInfo, runFfmpeg, runFfprobe } from '../../src/lib/ffmpeg.mjs';

const COLOR = /^[#a-zA-Z0-9@.]+$/;

/** Escape a label for drawtext's single-quoted text value. */
const escapeText = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, ' ');

/**
 * First image dimensions. ffprobe when present; otherwise read them from ffmpeg's banner.
 * @returns {Promise<{width: number, height: number}>}
 */
async function firstImageSize(file, signal) {
  try {
    const r = await runFfprobe(
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { signal },
    );
    const m = /^(\d+)x(\d+)/.exec(r.stdout.toString().trim());
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  } catch {
    // ffprobe unavailable or failed; fall through to the ffmpeg banner.
  }
  try {
    await runFfmpeg(['-hide_banner', '-i', file], { signal });
  } catch (e) {
    const m = /(\d{2,5})x(\d{2,5})/.exec(e?.detail ?? '');
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  throw new ToolError('invalid-input', `could not read the dimensions of the first image "${file}"`);
}

/**
 * @param {{images: string[], columns?: number, cell_width?: number, labels?: string[]|'auto',
 *   gap_px?: number, background?: string, format?: 'png'|'jpeg'}} input  refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const { images, columns = 4, cell_width = 480, labels, gap_px = 8, background = 'black', format = 'png' } = input;
  const { outDir, signal } = ctx;
  const warnings = [];

  if (!Number.isInteger(columns) || columns < 1) {
    throw new ToolError('invalid-input', 'columns must be a positive integer');
  }
  if (!Number.isInteger(cell_width) || cell_width < 1) {
    throw new ToolError('invalid-input', 'cell_width must be a positive integer');
  }
  if (!Number.isInteger(gap_px) || gap_px < 0) {
    throw new ToolError('invalid-input', 'gap_px must be a non-negative integer');
  }
  if (!COLOR.test(String(background))) {
    throw new ToolError('invalid-input', `background "${background}" is not a simple colour name or 0xRRGGBB value`);
  }
  if (format !== 'png' && format !== 'jpeg') {
    throw new ToolError('invalid-input', 'format must be png or jpeg');
  }

  let captions = null;
  if (labels === 'auto') captions = images.map((p) => path.basename(p));
  else if (Array.isArray(labels)) {
    if (labels.length !== images.length) {
      throw new ToolError('invalid-input', `labels has ${labels.length} entries but there are ${images.length} images`);
    }
    captions = labels.map(String);
  } else if (labels !== undefined) {
    throw new ToolError('invalid-input', 'labels must be an array of strings or "auto"');
  }

  if (captions) {
    let hasDrawtext = false;
    try {
      hasDrawtext = (await ffmpegInfo()).filters.has('drawtext');
    } catch {
      hasDrawtext = false;
    }
    if (!hasDrawtext) {
      warnings.push('drawtext not available; labels skipped');
      captions = null;
    }
  }

  const first = await firstImageSize(images[0], signal);
  // ffmpeg's scale=w:-2 keeps the aspect ratio and rounds the height to the nearest even number.
  const rawHeight = Math.round((cell_width * first.height) / first.width);
  const cellHeight = 2 * Math.round(rawHeight / 2);
  const rows = Math.ceil(images.length / columns);
  const single = images.length === 1;
  const width = single ? cell_width : columns * cell_width + (columns - 1) * gap_px;
  const height = single ? cellHeight : rows * cellHeight + (rows - 1) * gap_px;

  const chains = [];
  for (let i = 0; i < images.length; i++) {
    let chain = `[${i}:v]scale=${cell_width}:-2,pad=${cell_width}:${cellHeight}:0:(oh-ih)/2:color=${background}`;
    if (captions?.[i] !== undefined) {
      chain += `,drawtext=text='${escapeText(captions[i])}':x=4:y=h-th-4:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=2:expansion=none`;
    }
    chains.push(`${chain}[v${i}]`);
  }

  let finalLabel;
  if (single) {
    finalLabel = 'v0';
  } else {
    const layout = [];
    for (let i = 0; i < images.length; i++) {
      const x = (i % columns) * (cell_width + gap_px);
      const y = Math.floor(i / columns) * (cellHeight + gap_px);
      layout.push(`${x}_${y}`);
    }
    const inputs = images.map((_p, i) => `[v${i}]`).join('');
    chains.push(`${inputs}xstack=inputs=${images.length}:layout=${layout.join('|')}:fill=${background}[stack]`);
    // A short last row leaves the stack narrower than the grid; pad to the declared width.
    chains.push(`[stack]pad=${width}:${height}:0:0:color=${background}[out]`);
    finalLabel = 'out';
  }

  const name = format === 'jpeg' ? 'sheet.jpg' : 'sheet.png';
  const outPath = path.join(outDir, name);
  await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      ...images.flatMap((p) => ['-i', p]),
      '-filter_complex',
      chains.join(';'),
      '-map',
      `[${finalLabel}]`,
      '-frames:v',
      '1',
      outPath,
    ],
    { signal },
  );

  const info = await stat(outPath).catch(() => null);
  if (!info?.isFile()) throw new ToolError('tool-failed', `the contact sheet was not written to ${name}`);

  return {
    result: {
      width,
      height,
      cells: images.length,
      columns: single ? 1 : columns,
      rows,
      warnings,
    },
  };
}
