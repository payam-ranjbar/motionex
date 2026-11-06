// Process settings, all from MX_* environment variables (contavex style). Secrets are files, never env.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute repo/app root (the folder holding package.json). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const list = (v, sep = ',') =>
  (v ?? '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

export const DEFAULT_LIMITS = 'light=8,audio=4,voice=2,music=2,capture=1,encode=2,elevenlabs=1';

function parseLimits(s) {
  const out = {};
  for (const part of list(s)) {
    const [k, v] = part.split('=');
    if (k && Number.isFinite(Number(v))) out[k.trim()] = Math.max(0, Number(v));
  }
  return out;
}

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<import('../runner/types.mjs').Config>}
 */
export function loadConfig(env = process.env) {
  const win = process.platform === 'win32';
  const port = int(env.MX_PORT, 8095);
  const workspace = path.resolve(env.MX_WORKSPACE || path.join(APP_ROOT, 'workspace'));
  const extDir = env.MX_EXTENSIONS_DIR ?? (win ? '' : '/extensions');
  const toolsDirs = [{ path: path.join(APP_ROOT, 'tools'), origin: 'builtin' }];
  if (extDir && existsSync(extDir)) toolsDirs.push({ path: path.resolve(extDir), origin: 'extension' });
  for (const d of list(env.MX_TOOLS_DIRS, path.delimiter))
    toolsDirs.push({ path: path.resolve(d), origin: 'extension' });
  const browserPath = env.MX_BROWSER_PATH || null;
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  } catch {}

  return deepFreeze({
    version,
    appRoot: APP_ROOT,
    port,
    host: env.MX_HOST || '127.0.0.1',
    workspace,
    stateDir: path.resolve(env.MX_STATE_DIR || path.join(workspace, '.mx')),
    scratchDir: path.resolve(env.MX_SCRATCH_DIR || path.join(os.tmpdir(), 'motionex-scratch')),
    toolsDirs,
    presetsDirs: [
      path.join(APP_ROOT, 'presets'),
      ...list(env.MX_PRESETS_DIRS, path.delimiter).map((d) => path.resolve(d)),
    ],
    voicesDirs: (env.MX_VOICES_DIRS ? list(env.MX_VOICES_DIRS, path.delimiter) : [path.join(APP_ROOT, 'voices')]).map(
      (d) => path.resolve(d),
    ),
    secretsDir: path.resolve(env.MX_SECRETS_DIR || (win ? path.join(APP_ROOT, 'secrets') : '/run/secrets')),
    sampleCacheDir: path.resolve(env.MX_SAMPLE_CACHE_DIR || path.join(os.tmpdir(), 'mucavex-samples')),
    offline: bool(env.MX_OFFLINE),
    python: env.MX_PYTHON || path.join(APP_ROOT, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    node: process.execPath,
    ffmpegPath: env.FFMPEG_PATH || null,
    ffprobePath: env.FFPROBE_PATH || null,
    browser: {
      channel: env.MX_BROWSER_CHANNEL || (win && !browserPath ? 'msedge' : null),
      executablePath: browserPath,
    },
    cpuSlots: Math.max(1, int(env.MX_CPU_SLOTS, os.availableParallelism())),
    limits: { ...parseLimits(DEFAULT_LIMITS), ...parseLimits(env.MX_LIMITS) },
    maxQueued: int(env.MX_MAX_QUEUED, 1000),
    allowedOrigins: env.MX_ALLOWED_ORIGINS
      ? list(env.MX_ALLOWED_ORIGINS)
      : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    allowedHosts: env.MX_ALLOWED_HOSTS
      ? list(env.MX_ALLOWED_HOSTS)
      : [`127.0.0.1:${port}`, `localhost:${port}`, `motionex:${port}`],
    apiTokenFile: env.MX_API_TOKEN_FILE || null,
    maxUploadBytes: int(env.MX_MAX_UPLOAD_BYTES, 4 * 1024 ** 3),
    maxJsonBytes: int(env.MX_MAX_JSON_BYTES, 4 * 1024 ** 2),
    snapshotMaxBytes: int(env.MX_SNAPSHOT_MAX_BYTES, 5 * 1024 ** 2),
    killGraceMs: int(env.MX_KILL_GRACE_MS, 5000),
    logLevel: env.MX_LOG_LEVEL || 'info',
    elevenlabsUrl: env.MX_ELEVENLABS_URL || 'https://api.elevenlabs.io',
    elevenlabsDailyCharLimit: int(env.MX_ELEVENLABS_DAILY_CHAR_LIMIT, 0),
    musicMaxSeconds: int(env.MX_MUSIC_MAX_SECONDS, 1800),
    allowOverride: bool(env.MX_ALLOW_OVERRIDE),
    libDirs: {
      motion: path.join(APP_ROOT, 'lib', 'browser', 'motion'),
      gsap: path.join(APP_ROOT, 'node_modules', 'gsap', 'dist'),
    },
  });
}
