// Feature gating for tests.
//   test('name', needs('ffmpeg', 'python'), async () => { ... })
// A missing feature SKIPS the test, unless the feature is listed in MX_REQUIRE (comma list, or "all"),
// in which case needs() THROWS so the test file fails loudly. Pieces set MX_REQUIRE to what they must really test.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { browserAvailable } from '../../src/lib/browser.mjs';
import { loadConfig } from '../../src/lib/config.mjs';
import { ffmpegPath, ffprobePath } from '../../src/lib/ffmpeg.mjs';

const config = loadConfig();
const cache = new Map();

const CHECKS = {
  ffmpeg: () =>
    spawnSync(ffmpegPath(), ['-version'], { windowsHide: true }).status === 0
      ? null
      : `ffmpeg not runnable (${ffmpegPath()})`,
  ffprobe: () => (ffprobePath() ? null : 'ffprobe not found (FFPROBE_PATH)'),
  chromium: () => browserAvailable(config).reason ?? null,
  python: () => (existsSync(config.python) ? null : `python not found at ${config.python} (MX_PYTHON)`),
  'piper-voice': () =>
    config.voicesDirs.some((d) => existsSync(d) && readdirSync(d).some((f) => f.endsWith('.onnx')))
      ? null
      : `no .onnx voice in ${config.voicesDirs.join(', ')} (MX_VOICES_DIRS)`,
  samples: () =>
    existsSync(config.sampleCacheDir) && readdirSync(config.sampleCacheDir).length > 0
      ? null
      : `sample cache empty at ${config.sampleCacheDir} (MX_SAMPLE_CACHE_DIR)`,
  network: () => (process.env.MX_TEST_NETWORK === '1' ? null : 'network tests are off (MX_TEST_NETWORK=1)'),
};

export const FEATURES = Object.keys(CHECKS);

const required = () => {
  const r = (process.env.MX_REQUIRE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return r.includes('all') ? FEATURES : r;
};

/** @returns {string|null} why the feature is missing, or null */
export function missing(feature) {
  if (!CHECKS[feature]) throw new Error(`needs(): unknown feature "${feature}" (known: ${FEATURES.join(', ')})`);
  if (!cache.has(feature)) cache.set(feature, CHECKS[feature]());
  return cache.get(feature);
}

/** @returns {{skip?: string}} node:test options */
export function needs(...features) {
  const reasons = [];
  for (const f of features) {
    const why = missing(f);
    if (!why) continue;
    if (required().includes(f)) throw new Error(`required feature "${f}" is missing: ${why}`);
    reasons.push(`${f}: ${why}`);
  }
  return reasons.length ? { skip: reasons.join('; ') } : {};
}
