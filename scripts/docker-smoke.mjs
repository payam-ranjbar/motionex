#!/usr/bin/env node
// Smoke checks that only make sense inside the motionex image: one ffmpeg >= 7 with the filters we use,
// Piper synthesis, Mucavex (node-web-audio-api + libasound) rendering, and the Chromium headless shell
// capturing a WebGL page. Prints one JSON report; exits 1 when a check fails.
//   docker run --rm --read-only --tmpfs /tmp --entrypoint node motionex:local scripts/docker-smoke.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/lib/config.mjs';

const config = loadConfig();
const report = {};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    report[name] = { ok: true, ...(await fn()), ms: Date.now() - t0 };
  } catch (e) {
    report[name] = { ok: false, error: String(e?.stack ?? e).slice(0, 1500), ms: Date.now() - t0 };
  }
};

await check('ffmpeg', async () => {
  const v = spawnSync(config.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' });
  const f = spawnSync(config.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const e = spawnSync(config.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const want = ['drawtext', 'loudnorm', 'alimiter', 'sidechaincompress', 'ebur128', 'xstack', 'afreqshift', 'acompressor'];
  const missing = want.filter((x) => !new RegExp(`\\s${x}\\s`).test(f.stdout));
  const enc = ['libx264', 'libmp3lame', 'aac', 'flac', 'libopus'].filter((x) => !new RegExp(`\\s${x}\\s`).test(e.stdout));
  const version = /ffmpeg version (\S+)/.exec(v.stdout)?.[1];
  if (missing.length || enc.length) throw new Error(`missing filters ${missing} encoders ${enc}`);
  return { version, probe: spawnSync(config.ffprobePath ?? 'ffprobe', ['-version']).status === 0 };
});

await check('piper', async () => {
  const voice = path.join(config.voicesDirs[0], 'en_US-norman-medium.onnx');
  const out = path.join(tmp, 'line.wav');
  const py = [
    'import sys, wave',
    'from piper import PiperVoice, SynthesisConfig',
    'v = PiperVoice.load(sys.argv[1])',
    'with wave.open(sys.argv[2], "wb") as w:',
    '    v.synthesize_wav("My name is [[ʃˈɒpˌuːə.]]", w, syn_config=SynthesisConfig(length_scale=1.1))',
    'print(v.phonemize("Shapur"))',
  ].join('\n');
  const r = spawnSync(config.python, ['-c', py, voice, out], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return { bytes: statSync(out).size, phonemes: r.stdout.trim() };
});

await check('mucavex', async () => {
  await import('../vendor/mucavex/src/resolve-hooks.mjs');
  const { render } = await import('../vendor/mucavex/src/engine.mjs');
  const r = await render({ code: 'note("c3 e3 g3").s("sawtooth").lpf(800)', cycles: 2, sampleRate: 48000 });
  const peak = Math.max(...r.channels.map((c) => c.reduce((m, s) => Math.max(m, Math.abs(s)), 0)));
  if (!(peak > 0.05)) throw new Error(`silent render (peak ${peak})`);
  return { seconds: r.seconds, peak: Number(peak.toFixed(3)) };
});

await check('chromium', async () => {
  const { launchBrowser } = await import('../src/lib/browser.mjs');
  const html = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="320" height="180"></canvas>
<script>
const gl = document.getElementById('c').getContext('webgl', { preserveDrawingBuffer: true });
window.__gl = !!gl;
if (gl) { gl.clearColor(0.0, 0.8, 0.2, 1.0); gl.clear(gl.COLOR_BUFFER_BIT); }
document.body.insertAdjacentHTML('beforeend', '<p style="font:24px sans-serif;color:#fff">Text ✓ متن 😀</p>');
window.__motion = { ready: true, seek: () => {}, duration: 1 };
</script></body></html>`;
  const file = path.join(tmp, 'page.html');
  writeFileSync(file, html);
  const browser = await launchBrowser(config);
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await page.goto(`file://${file}`);
    await page.waitForFunction(() => window.__motion?.ready === true);
    const t0 = Date.now();
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 320, height: 180 } });
    const firstShotMs = Date.now() - t0;
    const gl = await page.evaluate(() => window.__gl);
    const pixel = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = document.getElementById('c');
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext('2d');
      ctx.drawImage(g, 160, 90, 1, 1, 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    if (!gl || pixel[1] < 150) throw new Error(`WebGL not rendering (gl=${gl}, pixel=${pixel})`);
    return { version: browser.version(), webgl: gl, pixel, png_bytes: shot.length, first_shot_ms: firstShotMs };
  } finally {
    await browser.close();
  }
});

await check('readonly', async () => {
  const w = spawnSync('sh', ['-c', 'touch /etc/motionex-x 2>&1; echo $?'], { encoding: 'utf8' });
  const home = spawnSync('sh', ['-c', 'mkdir -p "$HOME" && touch "$HOME/x" && echo ok'], { encoding: 'utf8' });
  return { etc_write_blocked: w.stdout.trim().endsWith('1'), home_writable: home.stdout.trim() === 'ok', uid: os.userInfo().uid };
});

report.fonts = readdirSync('/usr/share/fonts/truetype').join(',');
const ok = Object.values(report).every((r) => typeof r !== 'object' || r.ok !== false);
console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
