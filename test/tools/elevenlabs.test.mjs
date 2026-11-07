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
    ttsBodies: [],
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
        return sendJson(res, 200, {
          voices: [
            { voice_id: 'v2', name: 'Zed', labels: { accent: 'irish' } },
            { voice_id: 'v1', name: 'Brian', labels: {} },
          ],
        });
      }
      if (req.method === 'POST' && req.url.startsWith('/v1/text-to-speech/')) {
        state.ttsRequests += 1;
        state.ttsBody = raw ? JSON.parse(raw) : null;
        state.ttsBodies.push(state.ttsBody);
        if (state.ttsRequests <= state.fail429) return sendJson(res, 429, { detail: 'too many requests' });
        if (state.fail400) return sendJson(res, 400, { detail: 'bad input' });
        const headers = {
          'request-id': `req_test_${state.ttsRequests}`,
          'x-character-count': String(state.ttsBody?.text?.length ?? 0),
          'character-cost': String((state.ttsBody?.text?.length ?? 0) * 2),
        };
        if (req.url.includes('output_format=pcm_22050')) {
          // 1 s of a 440 Hz tone as raw 16-bit mono PCM, like ElevenLabs' pcm_<rate> formats
          const pcm = Buffer.alloc(22050 * 2);
          for (let i = 0; i < 22050; i++)
            pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 22050)), i * 2);
          res.writeHead(200, { 'content-type': 'audio/pcm', ...headers });
          res.end(pcm);
          return;
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg', ...headers });
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

const run = (ctx, tool, input) => runTool(tool, input, { workspace: ctx.ws, config: ctx.config });

test(
  'voice.elevenlabs: one WAV and MP3 per line, voice.speak result fields, the right requests',
  needs('ffmpeg'),
  async () => {
    const ctx = await setup();
    try {
      const { result, outputs } = await run(ctx, 'voice.elevenlabs', {
        voice: 'v1',
        lines: [{ text: 'Hello motionex', name: 'hello' }, 'Second line'],
        stability: 0.5,
        speed: 1.1,
      });
      assert.deepStrictEqual(outputs.map((o) => o.name).sort(), [
        'hello.mp3',
        'hello.wav',
        'line-002.mp3',
        'line-002.wav',
      ]);
      assert.equal(result.voice, 'v1');
      assert.equal(result.model, 'eleven_v3');
      assert.equal(result.sample_rate, 44100);
      assert.deepStrictEqual(
        result.lines.map((l) => [l.name, l.file, l.original, l.text, l.request_id, l.chars]),
        [
          ['hello', 'hello.wav', 'hello.mp3', 'Hello motionex', 'req_test_1', 14],
          ['line-002', 'line-002.wav', 'line-002.mp3', 'Second line', 'req_test_2', 11],
        ],
      );
      for (const l of result.lines) {
        assert.ok(Math.abs(l.seconds - 1) <= 0.1, `seconds ${l.seconds}`);
        assert.ok(l.speech_start_s >= 0 && l.speech_start_s < 0.1, `speech_start_s ${l.speech_start_s}`);
        assert.ok(l.speech_end_s > 0.9 && l.speech_end_s <= l.seconds, `speech_end_s ${l.speech_end_s}`);
        assert.ok(Math.abs(l.speech_s - (l.speech_end_s - l.speech_start_s)) < 0.002);
      }
      assert.equal(result.chars, 25);
      assert.equal(result.credits, 50); // the fake bills 2 credits per character in character-cost
      assert.deepStrictEqual(result.warnings, []);

      assert.equal(ctx.fake.state.requests.length, 2);
      const req = ctx.fake.state.requests[0];
      assert.equal(req.headers['xi-api-key'], CANARY);
      assert.ok(req.url.startsWith('/v1/text-to-speech/v1?output_format=mp3_44100_128'), req.url);
      assert.deepStrictEqual(
        ctx.fake.state.ttsBodies.map((b) => b.text),
        ['Hello motionex', 'Second line'],
      );
      assert.equal(ctx.fake.state.ttsBodies[0].model_id, 'eleven_v3');
      assert.deepStrictEqual(ctx.fake.state.ttsBodies[0].voice_settings, { stability: 0.5, speed: 1.1 });
    } finally {
      await ctx.cleanup();
    }
  },
);

test('voice.elevenlabs: pcm formats write the WAV directly at the format rate', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const { result, outputs } = await run(ctx, 'voice.elevenlabs', {
      voice: 'v1',
      lines: ['raw please'],
      output_format: 'pcm_22050',
    });
    assert.deepStrictEqual(
      outputs.map((o) => o.name),
      ['line-001.wav'],
    );
    assert.equal(result.sample_rate, 22050);
    assert.equal(result.lines[0].original, null);
    assert.ok(Math.abs(result.lines[0].seconds - 1) < 0.01, `seconds ${result.lines[0].seconds}`);
    assert.ok(result.lines[0].speech_end_s > 0.95);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: warns when audio tags meet a model that does not act them', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const tagged = await run(ctx, 'voice.elevenlabs', {
      voice: 'v1',
      lines: ['[whispers] psst'],
      model: 'eleven_flash_v2_5',
    });
    assert.equal(tagged.result.warnings.length, 1);
    assert.match(tagged.result.warnings[0], /eleven_v3/);
    const v3 = await run(ctx, 'voice.elevenlabs', { voice: 'v1', lines: ['[whispers] psst'] });
    assert.deepStrictEqual(v3.result.warnings, []);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: repeated line names are invalid input, before any request', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      run(ctx, 'voice.elevenlabs', {
        voice: 'v1',
        lines: [
          { text: 'a', name: 'x' },
          { text: 'b', name: 'x' },
        ],
      }),
      (e) => {
        assert.equal(e.type, 'invalid-input');
        assert.match(e.detail, /unique/);
        return true;
      },
    );
    assert.equal(ctx.fake.state.ttsRequests, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs: retries two 429s then succeeds', needs('ffmpeg'), async () => {
  const ctx = await setup({ server: { fail429: 2 } });
  try {
    const { result } = await run(ctx, 'voice.elevenlabs', { voice: 'v1', lines: ['retry me'] });
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
    await assert.rejects(run(ctx, 'voice.elevenlabs', { voice: 'v1', lines: ['bad'] }), (e) => {
      assert.equal(e.type, 'provider-error');
      assert.match(e.detail, /HTTP 400/);
      return true;
    });
  } finally {
    await ctx.cleanup();
  }
});

test('voice.elevenlabs-voices: lists voices from the API, sorted, with id and search', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const { result } = await run(ctx, 'voice.elevenlabs-voices', {});
    assert.equal(result.source, 'api');
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.voices, [
      { id: 'v1', voice_id: 'v1', name: 'Brian', labels: {} },
      { id: 'v2', voice_id: 'v2', name: 'Zed', labels: { accent: 'irish' } },
    ]);
    assert.equal(ctx.fake.state.requests[0].headers['xi-api-key'], CANARY);
    const irish = await run(ctx, 'voice.elevenlabs-voices', { search: 'IRISH' });
    assert.deepStrictEqual(
      irish.result.voices.map((v) => v.name),
      ['Zed'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test(
  'voice.elevenlabs-voices: a key that may not list voices gets the premade catalogue',
  needs('ffmpeg'),
  async () => {
    const ctx = await setup({ server: { voices401: true } });
    try {
      const { result } = await run(ctx, 'voice.elevenlabs-voices', {});
      assert.equal(result.source, 'catalog');
      assert.ok(result.voices.length >= 5);
      assert.ok(result.voices.every((v) => /^[A-Za-z0-9]{20}$/.test(v.id) && v.id === v.voice_id));
      assert.match(result.warnings[0], /voices_read/);
      const george = await run(ctx, 'voice.elevenlabs-voices', { search: 'george' });
      assert.deepStrictEqual(
        george.result.voices.map((v) => v.id),
        ['JBFqnCBsd6RMkjVDRZzb'],
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

test(
  'voice.elevenlabs: daily char budget counts every line and blocks before calling the API',
  needs('ffmpeg'),
  async () => {
    const ctx = await setup({ configEnv: { MX_ELEVENLABS_DAILY_CHAR_LIMIT: '10' } });
    try {
      await assert.rejects(
        run(ctx, 'voice.elevenlabs', { voice: 'v1', lines: ['x'.repeat(6), 'y'.repeat(6)] }),
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
  },
);

test('voice.elevenlabs: unavailable when the key file is absent', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-eleven-nokey-');
  const emptySecrets = await mkTmp('mx-eleven-empty-');
  try {
    const config = testConfig(ws, { MX_SECRETS_DIR: emptySecrets });
    await assert.rejects(
      runTool('voice.elevenlabs', { voice: 'v1', lines: ['hi'] }, { workspace: ws, config }),
      /unavailable/,
    );
  } finally {
    await rmTmp(ws);
    await rmTmp(emptySecrets);
  }
});

test('the canary never leaks into results, errors or logs', needs('ffmpeg'), async () => {
  const input = { voice: 'v1', lines: ['canary scenario'] };
  const scenarios = [
    { name: 'voice.elevenlabs success', input },
    { name: 'voice.elevenlabs 429', input, server: { fail429: 2 } },
    { name: 'voice.elevenlabs 400', input, server: { fail400: true } },
  ];
  for (const scenario of scenarios) {
    const ctx = await setup({ server: scenario.server ?? {} });
    try {
      const observed = await capture(() => run(ctx, 'voice.elevenlabs', scenario.input));
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
      const toolInput = tool === 'voice.elevenlabs' ? { voice: 'v1', lines: ['x'.repeat(20)] } : {};
      const observed = await capture(() => run(ctx, tool, toolInput));
      assertNoCanary(label, observed);
    } finally {
      await ctx.cleanup();
    }
  }
});
