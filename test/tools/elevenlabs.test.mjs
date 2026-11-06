// voice.elevenlabs / voice.elevenlabs-voices against a local fake ElevenLabs server.
// The key is a canary in a secret file: no result, error detail or log may ever contain it.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool, testConfig } from '../helpers/tool-harness.mjs';

const CANARY = 'sk_canary_DO_NOT_LEAK_123';
// The handler reads this from the child environment; keep the retry tests fast.
process.env.MX_ELEVENLABS_BACKOFF_MS = '10';

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let mp3Promise;
/** A real 1 s MP3, synthesized once with ffmpeg and reused by every fake response. */
function getMp3() {
  mp3Promise ??= runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
    '-f',
    'mp3',
    'pipe:1',
  ]).then((r) => r.stdout);
  return mp3Promise;
}

/** A fake ElevenLabs API on a random localhost port, recording every request. */
async function startFakeServer() {
  const mp3 = await getMp3();
  const state = {
    requests: [], // {method, url, headers}
    ttsRequests: 0,
    ttsBody: null,
    fail429: 0,
    fail400: false,
    voices401: false,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.method === 'GET' && req.url.startsWith('/v1/voices')) {
        if (state.voices401) return sendJson(res, 401, { detail: { message: 'unauthorized' } });
        return sendJson(res, 200, { voices: [{ voice_id: 'v1', name: 'Brian', labels: {} }] });
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/text-to-speech/')) {
        state.ttsRequests += 1;
        state.ttsBody = raw ? JSON.parse(raw) : null;
        if (state.ttsRequests <= state.fail429) return sendJson(res, 429, { detail: 'too many requests' });
        if (state.fail400) return sendJson(res, 400, { detail: 'bad input' });
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'request-id': 'req_test_1' });
        res.end(mp3);
        return;
      }
      sendJson(res, 404, { detail: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** A fresh workspace + secrets dir (holding the canary key) + fake server + matching config. */
async function setup({ configEnv = {}, server: serverFlags = {} } = {}) {
  const ws = await mkTmp('mx-eleven-');
  const secrets = await mkTmp('mx-eleven-secrets-');
  await writeFile(path.join(secrets, 'elevenlabs_api_key'), CANARY);
  const fake = await startFakeServer();
  Object.assign(fake.state, serverFlags);
  const config = testConfig(ws, {
    MX_ELEVENLABS_DAILY_CHAR_LIMIT: '0',
    MX_SECRETS_DIR: secrets,
    MX_ELEVENLABS_URL: fake.url,
    ...configEnv,
  });
  return {
    ws,
    secrets,
    fake,
    config,
    cleanup: async () => {
      await fake.close();
      await rmTmp(ws);
      await rmTmp(secrets);
    },
  };
}

/** Run a tool and return everything observable, success or failure, for canary scanning. */
async function capture(fn) {
  try {
    const out = await fn();
    return { ok: true, result: out.result, events: out.events, log: out.log };
  } catch (e) {
    return { ok: false, message: e.message, detail: e.detail, log: e.log, events: e.events };
  }
}

function assertNoCanary(label, value) {
  assert.ok(!JSON.stringify(value ?? null).includes(CANARY), `${label} leaked the canary`);
}

test('voice.elevenlabs: writes take.mp3 + take.wav and sends the right request', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const text = 'Hello motionex';
    const { result, outputs } = await runTool(
      'voice.elevenlabs',
      { voice_id: 'v1', text },
      {
        workspace: ctx.ws,
        config: ctx.config,
      },
    );
    assert.deepStrictEqual(outputs.map((o) => o.name).sort(), ['take.mp3', 'take.wav']);
    assert.equal(result.chars, text.length);
    assert.equal(result.model, 'eleven_v3');
    assert.equal(result.voice_id, 'v1');
    assert.equal(result.request_id, 'req_test_1');
    assert.ok(Math.abs(result.seconds - 1) <= 0.1, `seconds ${result.seconds}`);
    assert.equal(ctx.fake.state.requests.length, 1);
    const req = ctx.fake.state.requests[0];
    assert.equal(req.headers['xi-api-key'], CANARY);
    assert.ok(req.url.startsWith('/v1/text-to-speech/v1?output_format=mp3_44100_128'), req.url);
    assert.equal(ctx.fake.state.ttsBody.model_id, 'eleven_v3');
    assert.equal(ctx.fake.state.ttsBody.text, text);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: retries two 429s then succeeds', needs('ffmpeg'), async () => {
  const ctx = await setup({ server: { fail429: 2 } });
  try {
    const { result } = await runTool(
      'voice.elevenlabs',
      { voice_id: 'v1', text: 'retry me' },
      {
        workspace: ctx.ws,
        config: ctx.config,
      },
    );
    assert.equal(result.chars, 'retry me'.length);
    assert.equal(ctx.fake.state.ttsRequests, 3);
    assert.equal(ctx.fake.state.requests.length, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: a persistent 400 gives provider-error', needs('ffmpeg'), async () => {
  const ctx = await setup({ server: { fail400: true } });
  try {
    await assert.rejects(
      runTool('voice.elevenlabs', { voice_id: 'v1', text: 'bad' }, { workspace: ctx.ws, config: ctx.config }),
      (e) => {
        assert.equal(e.type, 'provider-error');
        assert.match(e.detail, /HTTP 400/);
        return true;
      },
    );
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs-voices: lists voices', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const { result } = await runTool('voice.elevenlabs-voices', {}, { workspace: ctx.ws, config: ctx.config });
    assert.deepStrictEqual(result.voices, [{ voice_id: 'v1', name: 'Brian', labels: {} }]);
    assert.equal(ctx.fake.state.requests[0].headers['xi-api-key'], CANARY);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs-voices: 401 mentions text-to-speech only', needs('ffmpeg'), async () => {
  const ctx = await setup({ server: { voices401: true } });
  try {
    await assert.rejects(runTool('voice.elevenlabs-voices', {}, { workspace: ctx.ws, config: ctx.config }), (e) => {
      assert.equal(e.type, 'provider-error');
      assert.match(e.detail, /text-to-speech only/);
      return true;
    });
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: daily char budget blocks before calling the API', needs('ffmpeg'), async () => {
  const ctx = await setup({ configEnv: { MX_ELEVENLABS_DAILY_CHAR_LIMIT: '10' } });
  try {
    await assert.rejects(
      runTool(
        'voice.elevenlabs',
        { voice_id: 'v1', text: 'x'.repeat(20) },
        {
          workspace: ctx.ws,
          config: ctx.config,
        },
      ),
      (e) => {
        assert.equal(e.type, 'provider-error');
        assert.match(e.detail, /budget/);
        return true;
      },
    );
    assert.equal(ctx.fake.state.ttsRequests, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: unavailable when the key file is absent', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-eleven-nokey-');
  const emptySecrets = await mkTmp('mx-eleven-empty-');
  try {
    const config = testConfig(ws, { MX_SECRETS_DIR: emptySecrets });
    await assert.rejects(
      runTool('voice.elevenlabs', { voice_id: 'v1', text: 'hi' }, { workspace: ws, config }),
      /unavailable/,
    );
  } finally {
    await rmTmp(ws);
    await rmTmp(emptySecrets);
  }
});

test('the canary never leaks into results, errors or logs', needs('ffmpeg'), async () => {
  const scenarios = [
    { name: 'voice.elevenlabs success', input: { voice_id: 'v1', text: 'canary scenario' } },
    { name: 'voice.elevenlabs 429', input: { voice_id: 'v1', text: 'canary scenario' }, server: { fail429: 2 } },
    { name: 'voice.elevenlabs 400', input: { voice_id: 'v1', text: 'canary scenario' }, server: { fail400: true } },
  ];
  for (const scenario of scenarios) {
    const ctx = await setup({ server: scenario.server ?? {} });
    try {
      const observed = await capture(() =>
        runTool('voice.elevenlabs', scenario.input, { workspace: ctx.ws, config: ctx.config }),
      );
      assertNoCanary(scenario.name, observed);
    } finally {
      await ctx.cleanup();
    }
  }
  for (const [label, server, configEnv, tool] of [
    ['voice.elevenlabs-voices success', {}, {}, 'voice.elevenlabs-voices'],
    ['voice.elevenlabs-voices 401', { voices401: true }, {}, 'voice.elevenlabs-voices'],
    ['voice.elevenlabs budget', {}, { MX_ELEVENLABS_DAILY_CHAR_LIMIT: '10' }, 'voice.elevenlabs'],
  ]) {
    const ctx = await setup({ server, configEnv });
    try {
      const input = tool === 'voice.elevenlabs' ? { voice_id: 'v1', text: 'x'.repeat(20) } : {};
      const observed = await capture(() => runTool(tool, input, { workspace: ctx.ws, config: ctx.config }));
      assertNoCanary(label, observed);
    } finally {
      await ctx.cleanup();
    }
  }
});
