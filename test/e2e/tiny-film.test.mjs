// End-to-end acceptance: a 6-second film made ONLY through the HTTP API (D9).
// Target: MX_E2E_URL (e.g. the Docker service, http://127.0.0.1:8095). Without it, an in-process server is started on a
// temp workspace. Flow: upload page/song/recipe -> voice.piper -> pin -> timeline.layout -> music.render -> sfx.synth ->
// audio.mix -> picture.render (with audio) -> media.encode fit-size; then probe, loudness, speech-ratio, frames, cache, pins.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../src/lib/config.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

let base = process.env.MX_E2E_URL;
let server = null;
let ws = null;

before(async () => {
  if (base) return;
  ws = await mkTmp('mx-e2e-');
  const { serve } = await import('../../src/server/main.mjs');
  server = await serve(loadConfig({ ...process.env, MX_WORKSPACE: ws, MX_PORT: '0', MX_ALLOWED_HOSTS: '*', MX_LOG_LEVEL: 'silent' }), { listen: true });
  base = `http://127.0.0.1:${server.port}`;
});
after(async () => {
  await server?.close();
  if (ws) await rmTmp(ws);
});

async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function put(path, content) {
  const r = await call('PUT', `/v1/files/${path}`, content, { 'content-type': 'application/octet-stream' });
  assert.equal(r.status, 201, `PUT ${path}: ${r.text}`);
}
/** Run a tool and wait until it finishes; fails the test with the job error when it does not succeed. */
async function run(tool, input, extra = {}) {
  let r = await call('POST', '/v1/jobs?wait=300', { tool, input, ...extra });
  assert.ok([200, 202].includes(r.status), `${tool}: ${r.status} ${r.text}`);
  let job = r.json;
  while (!['succeeded', 'failed', 'canceled'].includes(job.status)) {
    r = await call('GET', `/v1/jobs/${job.id}?wait=300`);
    job = r.json;
  }
  if (job.status !== 'succeeded') {
    const log = await call('GET', `/v1/jobs/${job.id}/log`);
    assert.fail(`${tool} ${job.status}: ${JSON.stringify(job.error)}\n${log.text.slice(-2000)}`);
  }
  return job;
}
const out = (job, name) => {
  const o = job.outputs.find((x) => x.name === name);
  assert.ok(o, `${job.tool} has no output ${name}: ${job.outputs.map((x) => x.name)}`);
  return o.ref;
};

const SCENE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#101018">
<canvas id="c" width="640" height="360"></canvas>
<script src="/_mx/lib/motion/adapters.js"></script>
<script>
const ctx = document.getElementById('c').getContext('2d');
MotionAdapters.fromFunction((t) => {
  ctx.fillStyle = '#101018'; ctx.fillRect(0, 0, 640, 360);
  const x = 80 + (480 * t) / 6;
  ctx.fillStyle = 'hsl(' + Math.round(t * 50) + ', 80%, 60%)';
  ctx.beginPath(); ctx.arc(x, 180, 40 + 20 * Math.sin(t * 3), 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('motionex ' + t.toFixed(2), 24, 48);
}, { duration: 6, size: { width: 640, height: 360 } });
</script></body></html>`;

const SONG = `setcpm(120/4)
let DROP = 1;
const span = (a, b) => cat(...Array(a).fill(0), ...Array(b - a).fill(1), ...Array(64).fill(0))
$: note("<c2 g1 a1 f1>").s("sawtooth").lpf(600).gain(.5)
$: note("c4 e4 g4 b4").s("triangle").gain(.25).mask(span(DROP, DROP + 64))
`;

const RECIPE = `export const sounds = {
  whoosh(kit) {
    const n = Math.round(kit.SR * 0.8);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { const env = Math.sin(Math.PI * i / n) ** 2; const v = (kit.rng() * 2 - 1) * env; L[i] = v; R[i] = v * 0.9; }
    return [L, R];
  },
};
export const describe = { whoosh: 'noise swell, 0.8 s' };
`;

test('a tiny film, end to end through the API', { timeout: 900_000 }, async () => {
  assert.equal((await call('GET', '/readyz')).status, 200);
  await put('films/tiny/scene.html', SCENE);
  await put('films/tiny/song.strudel', SONG);
  await put('films/tiny/sfx.mjs', RECIPE);

  // voice, pinned
  const voice = await run('voice.piper', { voice: 'en_US-norman-medium', lines: [{ name: 'line', text: 'This film was made by an agent.' }] });
  const take = out(voice, 'line.wav');
  const pin = await call('PUT', '/v1/pins/tiny/voice', { ref: take, note: 'e2e' });
  assert.equal(pin.status, 200, pin.text);

  // layout: one scene, 1 s lead, grid at 120 bpm, music drop aligned to the scene
  const layout = await run('timeline.layout', {
    grid: { bpm: 120 },
    scenes: [{ id: 'main', lead_s: 1, duration_s: 6, lines: [{ audio: 'pin:tiny/voice', who: 'narrator', text: 'line' }] }],
    markers: { DROP: { scene: 'main' } },
  });
  const timeline = out(layout, 'timeline.json');
  const clipsJob = await call('GET', `/v1/jobs/${layout.id}/outputs/dialogue-clips.json`);
  const dialogueClips = clipsJob.json;
  assert.ok(Array.isArray(dialogueClips) && dialogueClips.length === 1, clipsJob.text);

  // music (synth only, offline-safe), sfx
  const music = await run('music.render', { file: 'films/tiny/song.strudel', bpm: 120, seconds: 7, markers: { DROP: 1 }, offline: true });
  const sfx = await run('sfx.synth', { recipe: 'films/tiny/sfx.mjs' });

  // mix: dialogue + music bed + one whoosh, exact 6 s, master -16 LUFS
  const mix = await run('audio.mix', {
    duration_s: 6,
    timeline,
    tracks: [
      { name: 'dialogue', clips: dialogueClips.map((c) => ({ src: c.src, at: c.at })) },
      { name: 'music', gain_db: -14, clips: [{ src: out(music, 'music.wav'), at: 0, fade_out_s: 1 }] },
      { name: 'sfx', gain_db: -10, clips: [{ src: out(sfx, 'whoosh.wav'), at: 'main+0.2' }] },
    ],
    master: { loudness: { target_lufs: -16, true_peak_db: -1.5 } },
    output: { stems: true },
  });
  const mixRef = out(mix, 'mix.wav');

  // picture with audio in one encode
  const picture = await run('picture.render', { page: 'films/tiny/scene.html', fps: 30, workers: 2, audio: mixRef });
  const video = out(picture, 'video.mp4');
  assert.equal(picture.result.stalls, 0, `stalls: ${picture.result.stalls}`);

  // checks
  const probe = (await run('media.probe', { input: video })).result;
  assert.ok(Math.abs(probe.duration_s - 6) < 0.1, `duration ${probe.duration_s}`);
  const v = probe.streams.find((s) => s.type === 'video');
  const a = probe.streams.find((s) => s.type === 'audio');
  assert.equal(v.codec, 'h264');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(a.codec, 'aac');
  assert.equal(a.sample_rate, 48000);

  const loud = (await run('audio.loudness', { input: video })).result;
  assert.ok(Math.abs(loud.integrated_lufs + 16) <= 1, `I ${loud.integrated_lufs}`);
  assert.ok(loud.true_peak_dbtp <= -0.9, `TP ${loud.true_peak_dbtp}`);

  const ratio = (await run('audio.speech-ratio', { voice: out(mix, 'stems/dialogue.wav'), background: out(mix, 'stems/music.wav') })).result;
  assert.ok(ratio.summary && ratio.summary.min_db >= 6, `speech ratio ${JSON.stringify(ratio.summary)}`);

  const frames = await run('media.frames', { video, times: [3] });
  assert.equal(frames.outputs.length, 1);

  const delivery = await run('media.encode', { input: video, preset: 'fit-size', target_size_mb: 1 });
  assert.ok(delivery.result.size_bytes <= 1_000_000, `delivery ${delivery.result.size_bytes}`);

  // cache: the same music request is answered at once from the earlier job
  const again = await call('POST', '/v1/jobs?wait=5', { tool: 'music.render', input: { file: 'films/tiny/song.strudel', bpm: 120, seconds: 7, markers: { DROP: 1 }, offline: true } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.cached_from, music.id);

  // a new take never replaces the pinned one
  const voice2 = await run('voice.piper', { voice: 'en_US-norman-medium', lines: [{ name: 'line', text: 'This film was made by an agent.' }] });
  assert.notEqual(voice2.id, voice.id);
  const resolved = await call('GET', `/v1/refs/resolve?ref=${encodeURIComponent('pin:tiny/voice')}`);
  assert.equal(resolved.json.sha256, voice.outputs.find((o) => o.name === 'line.wav').sha256);
});
