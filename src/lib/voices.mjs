// Installed Piper voices: one <name>.onnx plus <name>.onnx.json per voice, spread over several folders.
// The config JSON is the source of truth for language, quality, sample rate and speaker count.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} Voice
 * @property {string} name voice name, e.g. en_US-norman-medium
 * @property {string} path absolute path of the .onnx file
 * @property {string|null} language language code from the config, e.g. en_US
 * @property {string|null} quality quality label from the config, e.g. medium
 * @property {number|null} sample_rate output sample rate in Hz
 * @property {number} num_speakers number of speakers (1 for a single-speaker voice)
 */

/**
 * List the voices installed in `dirs`, sorted by name. Folders that are missing, files without a readable
 * <name>.onnx.json config, and duplicates (the first folder wins) are skipped.
 * @param {string[]} dirs folders holding <name>.onnx + <name>.onnx.json pairs (Config.voicesDirs)
 * @returns {Voice[]}
 */
export function listVoices(dirs) {
  const found = new Map();
  for (const dir of dirs ?? []) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.onnx')) continue;
      const name = entry.name.slice(0, -'.onnx'.length);
      if (found.has(name)) continue;
      const abs = path.join(dir, entry.name);
      let json;
      try {
        json = JSON.parse(readFileSync(`${abs}.json`, 'utf8'));
      } catch {
        continue;
      }
      if (!json || typeof json !== 'object') continue;
      found.set(name, {
        name,
        path: abs,
        language: json.language?.code ?? null,
        quality: json.audio?.quality ?? null,
        sample_rate: json.audio?.sample_rate ?? null,
        num_speakers: json.num_speakers ?? 1,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
