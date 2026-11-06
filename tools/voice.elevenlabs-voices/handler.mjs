// voice.elevenlabs-voices: list the voices the key can use -> {voices: [{voice_id, name, labels}]}.
// The API key comes from the elevenlabs_api_key secret file and is never logged or returned.
import { createClient } from '../../src/lib/elevenlabs.mjs';
import { ToolError } from '../../src/lib/errors.mjs';

/**
 * @param {{search?: string}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const apiKey = await ctx.secret('elevenlabs_api_key');
  if (!apiKey) throw new ToolError('provider-error', 'no ElevenLabs key');

  const backoffMs = Number(process.env.MX_ELEVENLABS_BACKOFF_MS) || 1500;
  const client = createClient({ apiKey, baseUrl: ctx.config.elevenlabsUrl, backoffMs });
  ctx.progress(0.2, 'listing voices');
  const voices = await client.voices({ search: input.search }, { signal: ctx.signal });
  ctx.progress(1, 'done');
  return { result: { voices } };
}
