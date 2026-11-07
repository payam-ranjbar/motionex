// voice.piper-voices: the Piper provider of the voice.list contract. Lists the installed Piper voices
// (<name>.onnx + <name>.onnx.json in the voice folders) as {id, name, language, labels}.
import { listVoices } from '../../src/lib/voices.mjs';

/**
 * @param {{search?: string}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const search = input.search?.toLowerCase();
  const voices = listVoices(ctx.config.voicesDirs)
    .map((v) => ({
      id: v.name,
      name: v.name,
      language: v.language,
      labels: {
        ...(v.quality ? { quality: v.quality } : {}),
        ...(v.sample_rate ? { sample_rate: String(v.sample_rate) } : {}),
        ...(v.num_speakers > 1 ? { speakers: String(v.num_speakers) } : {}),
      },
      sample_rate: v.sample_rate,
      num_speakers: v.num_speakers,
    }))
    .filter(
      (v) => !search || [v.id, v.language ?? '', ...Object.values(v.labels)].join(' ').toLowerCase().includes(search),
    );
  const warnings =
    voices.length || search ? [] : ['no Piper voices are installed (set MX_VOICES_DIRS or mount /voices)'];
  return { result: { voices, warnings } };
}
