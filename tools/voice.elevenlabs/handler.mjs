// voice.elevenlabs: synthesize one line with ElevenLabs -> take.mp3 + take.wav.
// The API key comes from the elevenlabs_api_key secret file and is never logged or returned.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeAudio, writeAudio } from '../../src/lib/audio-io.mjs';
import { createClient } from '../../src/lib/elevenlabs.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { secondsOf } from '../../src/lib/wav.mjs';

const today = () => new Date().toISOString().slice(0, 10);

/** Characters already spent today, from the usage sidecar (0 when absent/stale/corrupt). */
async function charsUsed(file) {
  try {
    const usage = JSON.parse(await readFile(file, 'utf8'));
    return usage?.date === today() ? Number(usage.chars) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Record `n` more characters for today. State lives under ctx.config.stateDir, outside the workspace proper. */
async function addChars(file, n) {
  const chars = (await charsUsed(file)) + n;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ date: today(), chars })}\n`);
}

/**
 * @param {{voice_id: string, text: string, model: string, stability?: number, similarity?: number,
 *   style?: number, speed?: number, seed?: number, language?: string, output_format: string}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const apiKey = await ctx.secret('elevenlabs_api_key');
  if (!apiKey) throw new ToolError('provider-error', 'no ElevenLabs key');

  const limit = ctx.config.elevenlabsDailyCharLimit ?? 0;
  const usageFile = path.join(ctx.config.stateDir, 'elevenlabs-usage.json');
  if (limit > 0 && (await charsUsed(usageFile)) + input.text.length > limit) {
    throw new ToolError('provider-error', 'daily ElevenLabs character budget reached');
  }

  const backoffMs = Number(process.env.MX_ELEVENLABS_BACKOFF_MS) || 1500;
  const client = createClient({ apiKey, baseUrl: ctx.config.elevenlabsUrl, backoffMs });

  const voice_settings = {};
  if (input.stability !== undefined) voice_settings.stability = input.stability;
  if (input.similarity !== undefined) voice_settings.similarity_boost = input.similarity;
  if (input.style !== undefined) voice_settings.style = input.style;
  if (input.speed !== undefined) voice_settings.speed = input.speed;

  ctx.progress(0.1, 'synthesizing');
  const { audio, request_id } = await client.synthesize(
    {
      voice_id: input.voice_id,
      text: input.text,
      model_id: input.model,
      output_format: input.output_format,
      ...(Object.keys(voice_settings).length ? { voice_settings } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.language !== undefined ? { language_code: input.language } : {}),
    },
    { signal: ctx.signal },
  );

  const mp3Path = path.join(ctx.outDir, 'take.mp3');
  await writeFile(mp3Path, audio);

  ctx.progress(0.6, 'decoding');
  const decoded = await decodeAudio(mp3Path, { sampleRate: null, channels: null, signal: ctx.signal });
  await writeAudio(path.join(ctx.outDir, 'take.wav'), decoded, { format: 'wav', signal: ctx.signal });

  if (limit > 0) await addChars(usageFile, input.text.length);

  ctx.progress(1, 'done');
  return {
    result: {
      chars: input.text.length,
      seconds: secondsOf(decoded),
      request_id,
      model: input.model,
      voice_id: input.voice_id,
    },
  };
}
