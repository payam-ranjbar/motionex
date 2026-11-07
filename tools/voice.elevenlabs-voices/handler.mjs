// voice.elevenlabs-voices: the ElevenLabs provider of the voice.list contract -> {voices: [{id, name, labels}]}.
// A key scoped to text-to-speech may not list voices (401/403); then the premade catalogue next to this file is
// returned with a warning. The API key comes from the elevenlabs_api_key secret file and is never logged or returned.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '../../src/lib/elevenlabs.mjs';
import { ToolError } from '../../src/lib/errors.mjs';

/** Keep voices whose id, name or labels contain `search` (case-insensitive). */
function matches(voice, search) {
  if (!search) return true;
  const hay = [voice.voice_id, voice.name, ...Object.values(voice.labels ?? {})].join(' ').toLowerCase();
  return hay.includes(search.toLowerCase());
}

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
  let voices;
  let source = 'api';
  const warnings = [];
  try {
    voices = await client.voices({ search: input.search }, { signal: ctx.signal });
  } catch (e) {
    if (!(e instanceof ToolError) || !/HTTP 40[13]/.test(e.detail ?? '')) throw e;
    const catalog = JSON.parse(await readFile(path.join(ctx.toolDir, 'catalog.json'), 'utf8'));
    voices = catalog.voices;
    source = 'catalog';
    warnings.push(
      'the ElevenLabs key may not list voices (it lacks voices_read), so these are premade voices from the ' +
        'built-in catalogue; any other voice id you know also works with voice.speak',
    );
  }
  const list = voices
    .filter((v) => matches(v, input.search))
    .map((v) => ({ id: v.voice_id, voice_id: v.voice_id, name: v.name, labels: v.labels ?? {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
  ctx.progress(1, 'done');
  return { result: { voices: list, source, warnings } };
}
