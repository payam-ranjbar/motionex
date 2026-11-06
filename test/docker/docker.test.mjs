// Docker integration (O2). Opt-in: node scripts/test.mjs docker  (sets MX_DOCKER_TESTS=1).
// Needs the image motionex:local (docker compose build). The docker CLI comes from MX_DOCKER or PATH.
// Starts a container the way compose does (read-only, non-root, cap_drop ALL, loopback port) on a temp workspace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const ON = process.env.MX_DOCKER_TESTS === '1';
const DOCKER = process.env.MX_DOCKER || 'docker';
const IMAGE = process.env.MX_DOCKER_IMAGE || 'motionex:local';
const NAME = `motionex-test-${process.pid}`;
const PORT = Number(process.env.MX_DOCKER_PORT || 18095);
const CANARY = 'sk_canary_DOCKER_DO_NOT_LEAK_42';
const BASE = `http://127.0.0.1:${PORT}`;
let ws;
let secrets;

const docker = (...args) => spawnSync(DOCKER, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const sh = (cmd) => docker('exec', NAME, 'sh', '-c', cmd);
const opts = { skip: ON ? false : 'set MX_DOCKER_TESTS=1 (node scripts/test.mjs docker)', timeout: 600_000 };

async function waitHealthy(ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(`${BASE}/readyz`)).status === 200) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`container not ready:\n${docker('logs', NAME).stdout.slice(-3000)}`);
}
async function job(tool, input, wait = 300) {
  const r = await fetch(`${BASE}/v1/jobs?wait=${wait}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, input }) });
  return r.json();
}

before(async () => {
  if (!ON) return;
  ws = await mkTmp('mx-docker-ws-');
  secrets = await mkTmp('mx-docker-secrets-');
  writeFileSync(path.join(secrets, 'elevenlabs_api_key'), CANARY);
  mkdirSync(path.join(ws, 'films'), { recursive: true });
  docker('rm', '-f', NAME);
  const r = docker('run', '-d', '--name', NAME, '--read-only', '--tmpfs', '/tmp:size=1g,mode=1777', '--shm-size=1g',
    '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001', '--init',
    '-p', `127.0.0.1:${PORT}:8095`, '-e', `MX_ALLOWED_HOSTS=127.0.0.1:${PORT},localhost:${PORT}`,
    '-v', `${ws}:/workspace`, '-v', `${secrets}:/run/secrets:ro`, '-v', 'motionex-test-cache:/cache', IMAGE);
  assert.equal(r.status, 0, r.stderr);
  await waitHealthy();
});
after(async () => {
  if (!ON) return;
  docker('rm', '-f', NAME);
  await rmTmp(ws);
  await rmTmp(secrets);
});

test('image: non-root, read-only rootfs, one ffmpeg >= 7, healthcheck', opts, async () => {
  assert.equal(sh('id -u').stdout.trim(), '10001');
  assert.notEqual(sh('touch /etc/motionex-x').status, 0);
  const v = /ffmpeg version n?(\d+)/.exec(sh('ffmpeg -hide_banner -version').stdout);
  assert.ok(Number(v?.[1]) >= 7, `ffmpeg ${v?.[1]}`);
  assert.equal(sh('mx healthcheck').status, 0);
  const size = docker('image', 'inspect', IMAGE, '--format', '{{.Size}}').stdout.trim();
  console.log(`image size ${(Number(size) / 1e9).toFixed(2)} GB`);
});

test('in-image smoke: ffmpeg filters, piper, mucavex, chromium webgl', opts, async () => {
  const r = sh('node /app/scripts/docker-smoke.mjs');
  assert.equal(r.status, 0, r.stdout.slice(-3000));
});

test('guards: path traversal, evil origin, unknown host', opts, async () => {
  const trav = await fetch(`${BASE}/v1/files/..%2F..%2Fetc%2Fpasswd`, { method: 'PUT', body: 'x' });
  assert.ok([404, 422].includes(trav.status), `traversal ${trav.status}`);
  const evil = await fetch(`${BASE}/v1/jobs`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{"tool":"media.probe","input":{}}' });
  assert.equal(evil.status, 403);
});

test('secrets: elevenlabs available from the secret FILE, canary never in logs or API', opts, async () => {
  const t = await (await fetch(`${BASE}/v1/tools/voice.elevenlabs`)).json();
  assert.equal(t.available, true, t.unavailable_reason);
  const all = await (await fetch(`${BASE}/v1/tools`)).text();
  const caps = await (await fetch(`${BASE}/v1/capabilities`)).text();
  assert.ok(!all.includes(CANARY) && !caps.includes(CANARY));
  const logs = docker('logs', NAME);
  assert.ok(!`${logs.stdout}${logs.stderr}`.includes(CANARY));
  assert.ok(!docker('inspect', NAME).stdout.includes(CANARY), 'the key must not be in env or config');
});

test('cancel kills the browser', opts, async () => {
  writeFileSync(path.join(ws, 'films', 'slow.html'), `<!doctype html><body><canvas id=c width=1280 height=720></canvas><script>
const x = document.getElementById('c').getContext('2d');
window.__motion = { ready: true, duration: 120, size: { width: 1280, height: 720 },
  seek(t) { for (let i = 0; i < 400; i++) { x.fillStyle = 'hsl(' + (i + t * 90) % 360 + ',70%,50%)'; x.fillRect((i * 37) % 1280, (i * 53) % 720, 200, 120); } } };
</script></body>`);
  const j = await job('picture.render', { page: 'films/slow.html', workers: 2 }, 0);
  await sleep(8000);
  const browsers = () => Number(sh("grep -l headless_shell /proc/[0-9]*/cmdline 2>/dev/null | wc -l").stdout.trim());
  assert.ok(browsers() > 0, 'expected a running headless shell');
  await fetch(`${BASE}/v1/jobs/${j.id}/cancel`, { method: 'POST' });
  const done = await (await fetch(`${BASE}/v1/jobs/${j.id}?wait=30`)).json();
  assert.equal(done.status, 'canceled');
  await sleep(10_000);
  assert.equal(browsers(), 0, 'headless shell still running after cancel');
});

test('restart: a running job becomes interrupted', opts, async () => {
  const j = await job('music.render', { code: `note("c2*8").s("sawtooth").lpf(${400 + (Date.now() % 97)})`, seconds: 600, offline: true }, 0);
  await sleep(3000);
  assert.equal(docker('restart', NAME).status, 0);
  await waitHealthy();
  const after = await (await fetch(`${BASE}/v1/jobs/${j.id}`)).json();
  assert.equal(after.status, 'failed');
  assert.equal(after.error.type, 'interrupted');
});
