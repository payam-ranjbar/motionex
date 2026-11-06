// audio.silence: find silence runs, the leading and trailing silence, and where speech ends.
// Windows are 10 ms; a window is silent when its PEAK absolute sample over all channels is below fromDb(threshold_db).
// It measures; it never changes anything.
import { decodeAudio } from '../../src/lib/audio-io.mjs';
import { fromDb, speechEnd } from '../../src/lib/signal.mjs';

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {{input: string, threshold_db: number, min_duration_s: number}} input refs already resolved to absolute paths
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  ctx.progress(0, 'decoding');
  const audio = await decodeAudio(input.input, { sampleRate: null, channels: null, signal: ctx.signal });

  const sr = audio.sampleRate;
  const n = audio.channels[0]?.length ?? 0;
  const win = Math.max(1, Math.round(sr * 0.01)); // 10 ms
  const threshold = fromDb(input.threshold_db);

  // Peak of each 10 ms window (the last window may be short at the end of the file).
  const windowCount = Math.ceil(n / win);
  const silent = new Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const from = w * win;
    const to = Math.min(n, from + win);
    let p = 0;
    for (const ch of audio.channels) {
      for (let i = from; i < to; i++) {
        const a = Math.abs(ch[i]);
        if (a > p) p = a;
      }
    }
    silent[w] = p < threshold;
  }

  ctx.progress(0.5, 'finding silences');
  const silences = [];
  let leading_s = 0;
  let trailing_s = 0;
  for (let w = 0; w < windowCount; ) {
    if (!silent[w]) {
      w++;
      continue;
    }
    const first = w;
    while (w < windowCount && silent[w]) w++;
    const start = (first * win) / sr;
    const end = Math.min(w * win, n) / sr;
    if (end - start + 1e-9 < input.min_duration_s) continue;
    silences.push({ start: round3(start), end: round3(end) });
    if (first === 0) leading_s = end - start;
    if (w === windowCount) trailing_s = end - start;
  }

  ctx.progress(1, 'done');
  return {
    result: {
      duration_s: round3(n / sr),
      silences,
      leading_s: round3(leading_s),
      trailing_s: round3(trailing_s),
      speech_end_s: round3(speechEnd(audio, { threshold_db: -40 })),
    },
  };
}
