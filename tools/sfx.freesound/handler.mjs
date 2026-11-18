// sfx.freesound: the Freesound provider of the sfx.fetch contract. Looks every sound up first (so a licence the
// request refuses fails the job before anything is downloaded), then downloads its high-quality preview, converts it
// to WAV, measures it and writes credits.json. The API key comes from the freesound_api_key secret file and is never
// logged or returned.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeAudio, writeAudio } from '../../src/lib/audio-io.mjs';
import { ToolError } from '../../src/lib/errors.mjs';
import { createClient, licenseCode, licenseTitle } from '../../src/lib/freesound.mjs';
import { db, mono, peak } from '../../src/lib/signal.mjs';

const FIELDS = 'id,name,duration,license,username,url,previews';
const ONSET_WINDOW_S = 0.005;
const ONSET_BELOW_PEAK_DB = 20;
const LOUDEST_WINDOW_S = 1;
const LOUDEST_HOP_S = 0.05;
const QUIET_DB = -30;

/** The request's sounds as [{id, name}], with unique names. */
function normalizeSounds(sounds) {
  const seen = new Set();
  return sounds.map((s, i) => {
    const item = typeof s === 'string' ? { id: s } : s;
    const id = String(item.id).trim();
    if (!/^\d+$/.test(id))
      throw new ToolError('invalid-input', `sounds[${i}].id "${id}" is not a Freesound sound id (digits)`);
    const name = item.name ?? `freesound-${id}`;
    if (seen.has(name)) throw new ToolError('invalid-input', `sounds[${i}].name "${name}" is used twice`);
    seen.add(name);
    return { id, name };
  });
}

/** Where the sound becomes audible: the first short window within ONSET_BELOW_PEAK_DB of the loudest one. */
function onsetSeconds(ch, sampleRate) {
  const w = Math.max(1, Math.round(ONSET_WINDOW_S * sampleRate));
  const windows = [];
  let max = 0;
  for (let i = 0; i < ch.length; i += w) {
    let sum = 0;
    const end = Math.min(ch.length, i + w);
    for (let j = i; j < end; j++) sum += ch[j] * ch[j];
    const ms = sum / (end - i);
    windows.push(ms);
    if (ms > max) max = ms;
  }
  if (max === 0) return 0;
  const floor = max * 10 ** (-ONSET_BELOW_PEAK_DB / 10);
  const k = windows.findIndex((ms) => ms >= floor);
  return (Math.max(0, k) * w) / sampleRate;
}

/** Start of the loudest LOUDEST_WINDOW_S stretch (0 when the sound is shorter), stepping LOUDEST_HOP_S. */
function loudestSeconds(ch, sampleRate) {
  const w = Math.round(LOUDEST_WINDOW_S * sampleRate);
  if (ch.length <= w) return 0;
  const cum = new Float64Array(ch.length + 1);
  for (let i = 0; i < ch.length; i++) cum[i + 1] = cum[i] + ch[i] * ch[i];
  const hop = Math.max(1, Math.round(LOUDEST_HOP_S * sampleRate));
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i + w <= ch.length; i += hop) {
    const e = cum[i + w] - cum[i];
    if (e > best) {
      best = e;
      bestAt = i;
    }
  }
  return bestAt / sampleRate;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {{sounds: (string|{id: string, name?: string})[], licenses?: string[], sample_rate: number, channels: number,
 *   format: string}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const items = normalizeSounds(input.sounds);
  const apiKey = await ctx.secret('freesound_api_key');
  if (!apiKey) throw new ToolError('provider-error', 'no Freesound key (secret file freesound_api_key)');
  const backoffMs = Number(process.env.MX_FREESOUND_BACKOFF_MS) || 1500;
  const client = createClient({ apiKey, baseUrl: ctx.config.freesoundUrl, backoffMs });

  // 1. Look every sound up, and check licences before downloading anything.
  const details = [];
  for (const [i, item] of items.entries()) {
    ctx.progress(i / (items.length * 2), `looking up sound ${item.id}`);
    const d = await client.sound(item.id, FIELDS, { signal: ctx.signal });
    const license = licenseCode(d.license);
    if (input.licenses && !input.licenses.includes(license))
      throw new ToolError(
        'invalid-input',
        `sound ${item.id} ("${d.name}") is licensed ${license} (${d.license}), not one of licenses [${input.licenses.join(', ')}]`,
      );
    const preview = d.previews?.['preview-hq-mp3'] ?? d.previews?.['preview-lq-mp3'];
    if (!preview) throw new ToolError('provider-error', `Freesound gave no preview for sound ${item.id}`);
    details.push({ ...item, d, license, preview });
  }

  // 2. Download, convert, measure.
  const warnings = [];
  const sounds = [];
  for (const [i, s] of details.entries()) {
    ctx.progress(0.5 + i / (details.length * 2), `fetching sound ${s.id}`);
    const mp3 = path.join(ctx.scratchDir, `${s.id}.mp3`);
    await writeFile(mp3, await client.download(s.preview, { signal: ctx.signal, what: `preview of sound ${s.id}` }));
    const audio = await decodeAudio(mp3, {
      sampleRate: input.sample_rate,
      channels: input.channels,
      signal: ctx.signal,
    });
    const file = `${s.name}.wav`;
    await writeAudio(path.join(ctx.outDir, file), audio, { format: input.format, signal: ctx.signal });
    const m = mono(audio);
    const seconds = m.length / audio.sampleRate;
    const peakDb = db(peak(audio));
    if (peakDb < QUIET_DB) warnings.push(`${s.name}: very quiet (peak ${peakDb.toFixed(1)} dBFS)`);
    const title = String(s.d.name ?? '');
    const author = String(s.d.username ?? '');
    const url = String(s.d.url ?? `https://freesound.org/s/${s.id}/`);
    sounds.push({
      name: s.name,
      file,
      id: s.id,
      title,
      seconds: round3(seconds),
      license: s.license,
      license_url: String(s.d.license ?? ''),
      author,
      url,
      attribution: `"${title}" by ${author} (${url}), ${licenseTitle(s.d.license)}`,
      onset_s: round3(onsetSeconds(m, audio.sampleRate)),
      loudest_s: round3(loudestSeconds(m, audio.sampleRate)),
      peak_db: Math.round(peakDb * 100) / 100,
      source: 'preview',
    });
  }

  const credits = sounds.map(({ name, id, title, author, license, license_url, url, attribution }) => ({
    name,
    id,
    title,
    author,
    license,
    license_url,
    url,
    attribution,
  }));
  await writeFile(
    path.join(ctx.outDir, 'credits.json'),
    `${JSON.stringify({ source: 'freesound', sounds: credits }, null, 2)}\n`,
  );
  return { result: { sounds, warnings } };
}
