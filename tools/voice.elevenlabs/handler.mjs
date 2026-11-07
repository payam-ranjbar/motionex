// voice.elevenlabs: the ElevenLabs provider of the voice.speak contract. Speaks each line with one ElevenLabs
// voice and writes <name>.wav (plus the original <name>.mp3) with the same timing fields as voice.piper.
// The API key comes from the elevenlabs_api_key secret file and is never logged or returned.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeAudio, writeAudio } from '../../src/lib/audio-io.mjs';
import { createClient } from '../../src/lib/elevenlabs.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { normalizeLines, speechBounds } from '../../src/lib/speech.mjs';

const today = () => new Date().toISOString().slice(0, 10);

// eleven_v3 performs audio tags ("[whispers] hi"); other models may read the brackets out loud.
const AUDIO_TAG = /\[[a-z][a-z' -]{1,30}\]/i;

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

/** Raw 16-bit little-endian mono PCM (ElevenLabs pcm_<rate>) as planar float audio. */
function pcmToAudio(buf, sampleRate) {
  const n = Math.floor(buf.length / 2);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = buf.readInt16LE(i * 2) / 32768;
  return { sampleRate, channels: [ch] };
}

/**
 * @param {{voice: string, lines: (string|{text: string, name?: string})[], model: string, stability?: number,
 *   similarity?: number, style?: number, speed?: number, seed?: number, language?: string, output_format: string,
 *   speech_end_threshold_db: number}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const lines = normalizeLines(input.lines);
  const apiKey = await ctx.secret('elevenlabs_api_key');
  if (!apiKey) throw new ToolError('provider-error', 'no ElevenLabs key');

  const total = lines.reduce((sum, l) => sum + l.text.length, 0);
  const limit = ctx.config.elevenlabsDailyCharLimit ?? 0;
  const usageFile = path.join(ctx.config.stateDir, 'elevenlabs-usage.json');
  if (limit > 0 && (await charsUsed(usageFile)) + total > limit) {
    throw new ToolError('provider-error', `daily ElevenLabs character budget reached (${limit} characters)`);
  }

  const backoffMs = Number(process.env.MX_ELEVENLABS_BACKOFF_MS) || 1500;
  const client = createClient({ apiKey, baseUrl: ctx.config.elevenlabsUrl, backoffMs });

  const voice_settings = {};
  if (input.stability !== undefined) voice_settings.stability = input.stability;
  if (input.similarity !== undefined) voice_settings.similarity_boost = input.similarity;
  if (input.style !== undefined) voice_settings.style = input.style;
  if (input.speed !== undefined) voice_settings.speed = input.speed;
  const pcmRate = /^pcm_(\d+)$/.exec(input.output_format)?.[1];

  const results = [];
  const warnings = [];
  let sampleRate = 0;
  let credits = null;
  // One line at a time: ElevenLabs caps concurrent requests per key (2 on the Free tier).
  for (const [i, line] of lines.entries()) {
    ctx.progress(i / lines.length, `${i + 1}/${lines.length} ${line.name}`);
    const take = await client.synthesize(
      {
        voice_id: input.voice,
        text: line.text,
        model_id: input.model,
        output_format: input.output_format,
        ...(Object.keys(voice_settings).length ? { voice_settings } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.language !== undefined ? { language_code: input.language } : {}),
      },
      { signal: ctx.signal },
    );
    if (limit > 0) await addChars(usageFile, line.text.length);

    let audio;
    let original = null;
    if (pcmRate) {
      audio = pcmToAudio(take.audio, Number(pcmRate));
    } else {
      original = `${line.name}.mp3`;
      await writeFile(path.join(ctx.outDir, original), take.audio);
      audio = await decodeAudio(path.join(ctx.outDir, original), {
        sampleRate: null,
        channels: null,
        signal: ctx.signal,
      });
    }
    const file = `${line.name}.wav`;
    await writeAudio(path.join(ctx.outDir, file), audio, { format: 'wav', signal: ctx.signal });
    sampleRate = audio.sampleRate;

    const bounds = speechBounds(audio, { threshold_db: input.speech_end_threshold_db });
    if (bounds.speech_s === 0) {
      warnings.push(`line "${line.name}": no audible speech above ${input.speech_end_threshold_db} dBFS`);
    }
    if (input.model !== 'eleven_v3' && AUDIO_TAG.test(line.text)) {
      warnings.push(
        `line "${line.name}": audio tags such as [whispers] are performed by eleven_v3; ${input.model} may read them aloud`,
      );
    }
    if (take.credits !== null) credits = (credits ?? 0) + take.credits;
    results.push({
      name: line.name,
      file,
      text: line.text,
      ...bounds,
      original,
      request_id: take.request_id,
      chars: take.chars ?? line.text.length,
    });
  }

  ctx.progress(1, 'done');
  return {
    result: {
      voice: input.voice,
      model: input.model,
      sample_rate: sampleRate,
      lines: results,
      chars: results.reduce((sum, l) => sum + l.chars, 0),
      credits,
      warnings,
    },
  };
}
