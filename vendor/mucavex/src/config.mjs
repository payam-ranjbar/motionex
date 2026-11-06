import os from 'node:os';
import path from 'node:path';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export const config = {
  port: int(process.env.PORT, 8080),
  workers: int(process.env.WORKERS, Math.max(1, Math.min(4, os.availableParallelism() - 1))),
  // Hard limits so one request can't monopolise the box.
  maxSeconds: int(process.env.MAX_SECONDS, 1800), // motionex: was 600
  renderTimeoutMs: int(process.env.RENDER_TIMEOUT_MS, 120_000),
  maxCodeBytes: int(process.env.MAX_CODE_BYTES, 64 * 1024),
  defaultSampleRate: int(process.env.SAMPLE_RATE, 44100),
  maxPolyphony: int(process.env.MAX_POLYPHONY, 4096), // motionex: was 128 (superdough voice stealing fades drums in long renders)
  sampleCacheDir: process.env.SAMPLE_CACHE_DIR ?? path.join(os.tmpdir(), 'mucavex-samples'),
  // Load the same sample banks, drum-machine aliases and GM soundfonts as the
  // strudel.cc REPL, so browser code renders identically. Needs network (or a
  // warm cache) on first boot.
  strudelDefaults: bool(process.env.STRUDEL_DEFAULTS, true),
  // Extra comma-separated sample maps preloaded in every worker, e.g.
  // "github:tidalcycles/dirt-samples,file:///samples/strudel.json"
  preloadSamples: (process.env.PRELOAD_SAMPLES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Browser origins allowed to call the API. Requests carrying any other Origin
  // header are rejected *before* the code runs (CORS alone can't prevent that:
  // a text/plain POST is a "simple request" that browsers send without preflight).
  // Requests without an Origin header (curl, CLIs, server-to-server) are allowed.
  // "*" allows every origin; only do that behind other access control.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:4321,http://127.0.0.1:4321')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Refuse network access for samples; only the cache and file:// are used.
  offline: bool(process.env.OFFLINE),
};
