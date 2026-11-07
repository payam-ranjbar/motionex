// GET /v1/capabilities: what this installation can actually do right now (binaries, browser, python, voices,
// providers, presets, limits). Everything is measured, nothing is enforced: agents read it and decide.
import { existsSync } from 'node:fs';
import { browserAvailable, browserLabel } from '../../lib/browser.mjs';
import { ffmpegInfo, ffmpegPath, ffprobePath } from '../../lib/ffmpeg.mjs';
import { listPresets } from '../../lib/presets.mjs';
import { listVoices } from '../../lib/voices.mjs';

/** The preset kinds the service ships (folder names under presets/). */
const PRESET_KINDS = ['encode', 'mix', 'timeline', 'audio-process'];

/** ffmpeg path/version/major, degraded to "unknown" when ffmpeg cannot be run at all. */
async function ffmpegPart() {
  try {
    const info = await ffmpegInfo();
    return { path: info.path, version: info.version, major: info.major };
  } catch {
    return { path: ffmpegPath(), version: 'unknown', major: 0 };
  }
}

/**
 * Register the capabilities route.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{config: Readonly<import('../../runner/types.mjs').Config>, registry: object}} deps
 */
export function register(router, deps) {
  const config = deps.config;

  router.add('GET', '/v1/capabilities', async () => {
    /** @type {Record<string, string[]>} */
    const presets = {};
    for (const kind of PRESET_KINDS) {
      presets[kind] = listPresets(kind, config.presetsDirs).map((p) => p.name);
    }
    return {
      version: config.version,
      ffmpeg: await ffmpegPart(),
      ffprobe: Boolean(ffprobePath()),
      browser: { ...browserAvailable(config), label: browserLabel(config) },
      python: { path: config.python, available: existsSync(config.python) },
      voices: listVoices(config.voicesDirs),
      providers: { elevenlabs: { enabled: Boolean(deps.registry.get('voice.elevenlabs')?.available) } },
      // contract -> its providers and whether each can run here (GET /v1/contracts has the schemas)
      contracts: Object.fromEntries(
        (deps.registry.listContracts?.() ?? []).map((c) => [
          c.name,
          c.providers.map(({ provider, tool, available }) => ({ provider, tool, available })),
        ]),
      ),
      presets,
      limits: {
        cpu_slots: config.cpuSlots,
        classes: config.limits,
        max_upload_bytes: config.maxUploadBytes,
        max_queued: config.maxQueued,
      },
      offline: config.offline,
    };
  });
}
