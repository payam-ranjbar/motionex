// sfx.freesound-search / sfx.freesound against a local fake Freesound API and a separate fake preview server.
// The key is a canary in a secret file: it may reach the API only in the Authorization header, never the preview
// server, and never a result, an error detail or a log.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { licenseCode, licenseTitle, searchFilter } from '../../src/lib/freesound.mjs';
import { readWav } from '../../src/lib/wav.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';
import { runTool, testConfig } from '../helpers/tool-harness.mjs';

const CANARY = 'fs_canary_DO_NOT_LEAK_456';
process.env.MX_FREESOUND_BACKOFF_MS = '10';

const CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/';
const BY = 'https://creativecommons.org/licenses/by/4.0/';
const BYNC = 'http://creativecommons.org/licenses/by-nc/3.0/';

let mp3Promise;
/** 0.5 s of silence, then 1.5 s of a tone, as MP3: onset near 0.5 s. */
function getMp3() {
  mp3Promise ??= runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=mono:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:r=44100:d=1.5',
    '-filter_complex',
    '[0:a][1:a]concat=n=2:v=0:a=1[a]',
    '-map',
    '[a]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-f',
    'mp3',
    'pipe:1',
  ]).then((r) => r.stdout);
  return mp3Promise;
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      }),
    ),
  );
}

/** A fake Freesound API plus a preview server on another origin. */
async function startFakes() {
  const mp3 = await getMp3();
  // state.search, when set, answers a search: (query) => the sounds that match it.
  const state = { api: [], previews: [], fail429: 0, sounds: {}, search: null };
  const previews = await listen((req, res) => {
    state.previews.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(mp3);
  });
  const sound = (id, name, license) => ({
    id: Number(id),
    name,
    duration: 2.0,
    license,
    username: `user${id}`,
    url: `https://freesound.org/people/user${id}/sounds/${id}/`,
    tags: ['test', 'tone'],
    previews: { 'preview-hq-mp3': `${previews.url}/previews/${id}-hq.mp3`, 'preview-lq-mp3': `${previews.url}/lq.mp3` },
    num_downloads: 12,
    avg_rating: 4.5,
  });
  state.sounds = {
    101: sound(101, 'Tone one', CC0),
    202: sound(202, 'Tone two', BY),
    303: sound(303, 'Tone nc', BYNC),
  };
  const api = await listen((req, res) => {
    state.api.push({ url: req.url, headers: req.headers });
    const u = new URL(req.url, 'http://x');
    if (state.api.length <= state.fail429) return sendJson(res, 429, { detail: 'slow down' });
    if (u.pathname === '/apiv2/search/') {
      if (state.search) {
        const results = state.search(u.searchParams.get('query'));
        return sendJson(res, 200, { count: results.length, results });
      }
      return sendJson(res, 200, { count: 2, results: [state.sounds[101], state.sounds[202]] });
    }
    const m = u.pathname.match(/^\/apiv2\/sounds\/(\d+)\/$/);
    if (m)
      return state.sounds[m[1]] ? sendJson(res, 200, state.sounds[m[1]]) : sendJson(res, 404, { detail: 'Not found.' });
    sendJson(res, 404, { detail: 'not found' });
  });
  return { state, api, previews, close: async () => Promise.all([api.close(), previews.close()]) };
}

async function setup() {
  const ws = await mkTmp('mx-fs-');
  const secrets = await mkTmp('mx-fs-secrets-');
  await writeFile(path.join(secrets, 'freesound_api_key'), CANARY);
  const fake = await startFakes();
  const config = testConfig(ws, { MX_SECRETS_DIR: secrets, MX_FREESOUND_URL: fake.api.url });
  return {
    ws,
    fake,
    config,
    cleanup: async () => {
      await fake.close();
      await rmTmp(ws);
      await rmTmp(secrets);
    },
  };
}

const run = (ctx, tool, input) => runTool(tool, input, { workspace: ctx.ws, config: ctx.config });

async function capture(fn) {
  try {
    const out = await fn();
    return { ok: true, result: out.result, events: out.events, log: out.log };
  } catch (e) {
    return { ok: false, type: e.type, message: e.message, detail: e.detail, log: e.log, events: e.events };
  }
}

const assertNoCanary = (label, value) =>
  assert.ok(!JSON.stringify(value ?? null).includes(CANARY), `${label} leaked the canary`);

test('licence codes, titles and the search filter', () => {
  assert.equal(licenseCode(CC0), 'cc0');
  assert.equal(licenseCode(BY), 'by');
  assert.equal(licenseCode(BYNC), 'by-nc');
  assert.equal(licenseCode('http://creativecommons.org/licenses/sampling+/1.0/'), 'sampling+');
  assert.equal(licenseCode('Creative Commons 0'), 'cc0');
  assert.equal(licenseCode('Attribution'), 'by');
  assert.equal(licenseCode('something else'), 'other');
  assert.equal(licenseTitle(BY), 'CC BY 4.0');
  assert.equal(licenseTitle(CC0), 'CC0 1.0');
  assert.equal(searchFilter({ licenses: ['cc0'], max_seconds: 5 }), 'license:"Creative Commons 0" duration:[0 TO 5]');
  assert.equal(
    searchFilter({ licenses: ['cc0', 'by'], min_seconds: 2, extra: 'tag:foley' }),
    'license:("Creative Commons 0" OR "Attribution") duration:[2 TO *] tag:foley',
  );
  assert.equal(searchFilter({}), '');
});

test('sfx.freesound-search: contract fields, filter and auth header', async () => {
  const ctx = await setup();
  try {
    const { result } = await run(ctx, 'sfx.freesound-search', {
      query: 'tone',
      licenses: ['cc0', 'by'],
      max_seconds: 5,
      limit: 2,
      sort: 'rating_desc',
    });
    assert.equal(result.total, 2);
    assert.deepEqual(
      result.sounds.map((s) => [s.id, s.name, s.license, s.author, s.seconds]),
      [
        ['101', 'Tone one', 'cc0', 'user101', 2],
        ['202', 'Tone two', 'by', 'user202', 2],
      ],
    );
    assert.ok(result.sounds[0].preview.endsWith('/previews/101-hq.mp3'));
    assert.deepEqual(result.sounds[0].tags, ['test', 'tone']);
    const req = ctx.fake.state.api[0];
    assert.equal(req.headers.authorization, `Token ${CANARY}`);
    assert.ok(!req.url.includes(CANARY), 'the key must not travel in the URL');
    const q = new URL(req.url, 'http://x').searchParams;
    assert.equal(q.get('query'), 'tone');
    assert.equal(q.get('filter'), 'license:("Creative Commons 0" OR "Attribution") duration:[0 TO 5]');
    assert.equal(q.get('sort'), 'rating_desc');
    assert.equal(q.get('page_size'), '2');
    assert.equal(result.query_used, 'tone');
    assert.deepEqual(result.warnings, []);
    assert.equal(ctx.fake.state.api.length, 1);
    assertNoCanary('result', result);
  } finally {
    await ctx.cleanup();
  }
});

/** The search requests the fake API saw, as their query parameters. */
const searches = (ctx) => ctx.fake.state.api.map((r) => new URL(r.url, 'http://x').searchParams);

test('sfx.freesound-search: several words that find nothing explain why, with one request', async () => {
  const ctx = await setup();
  try {
    ctx.fake.state.search = (query) => (query === 'woman grunt' ? [ctx.fake.state.sounds[101]] : []);
    const { result } = await run(ctx, 'sfx.freesound-search', { query: 'woman grunt effort short', max_seconds: 3 });
    assert.deepEqual(result.sounds, []);
    assert.equal(result.total, 0);
    assert.equal(result.query_used, 'woman grunt effort short');
    assert.equal(result.warnings.length, 1);
    assert.ok(
      result.warnings[0].startsWith('no sounds match "woman grunt effort short" with filter duration:[0 TO 3]'),
      result.warnings[0],
    );
    assert.match(result.warnings[0], /matches every word/);
    assert.match(result.warnings[0], /fewer_words/);
    assert.equal(ctx.fake.state.api.length, 1, 'no retry unless fewer_words is set');
  } finally {
    await ctx.cleanup();
  }
});

test('sfx.freesound-search: fewer_words drops the last word until sounds are found, filters unchanged', async () => {
  const ctx = await setup();
  try {
    ctx.fake.state.search = (query) =>
      query === 'woman grunt' ? [ctx.fake.state.sounds[101], ctx.fake.state.sounds[202]] : [];
    const { result } = await run(ctx, 'sfx.freesound-search', {
      query: 'woman grunt effort short',
      fewer_words: true,
      licenses: ['cc0', 'by'],
      max_seconds: 3,
      filter: 'tag:foley',
      sort: 'downloads_desc',
      limit: 7,
    });
    assert.deepEqual(
      result.sounds.map((s) => s.id),
      ['101', '202'],
    );
    assert.equal(result.total, 2);
    assert.equal(result.query_used, 'woman grunt');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /no sounds match "woman grunt effort short"/);
    assert.match(result.warnings[0], /shorter query "woman grunt"/);

    const sent = searches(ctx);
    assert.deepEqual(
      sent.map((q) => q.get('query')),
      ['woman grunt effort short', 'woman grunt effort', 'woman grunt'],
      'one word dropped per request, stopping at the first query that finds sounds',
    );
    for (const q of sent) {
      assert.equal(q.get('filter'), 'license:("Creative Commons 0" OR "Attribution") duration:[0 TO 3] tag:foley');
      assert.equal(q.get('sort'), 'downloads_desc');
      assert.equal(q.get('page_size'), '7');
      assert.equal(q.get('fields'), sent[0].get('fields'));
    }
    for (const r of ctx.fake.state.api) assert.equal(r.headers.authorization, `Token ${CANARY}`);
    assertNoCanary('result', result);
  } finally {
    await ctx.cleanup();
  }
});

test('sfx.freesound-search: fewer_words stops at one word, and a phrase in quotes stays whole', async () => {
  const ctx = await setup();
  try {
    ctx.fake.state.search = () => [];
    const one = await run(ctx, 'sfx.freesound-search', { query: 'zzyzx', fewer_words: true });
    assert.deepEqual(one.result.sounds, []);
    assert.equal(one.result.query_used, 'zzyzx');
    assert.deepEqual(one.result.warnings, ['no sounds match "zzyzx"']);
    assert.equal(ctx.fake.state.api.length, 1, 'a single word has nothing to drop');

    ctx.fake.state.api.length = 0;
    const none = await run(ctx, 'sfx.freesound-search', { query: '"door creak" old wooden', fewer_words: true });
    assert.deepEqual(none.result.sounds, []);
    assert.equal(none.result.total, 0);
    assert.equal(none.result.query_used, '"door creak" old wooden');
    assert.equal(none.result.warnings.length, 1);
    assert.match(none.result.warnings[0], /nor any shorter query down to ""door creak""/);
    assert.deepEqual(
      searches(ctx).map((q) => q.get('query')),
      ['"door creak" old wooden', '"door creak" old', '"door creak"'],
      'as many requests as words, and no more',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('sfx.freesound-search: a rate limit during a fewer_words retry is waited out', async () => {
  const ctx = await setup();
  try {
    ctx.fake.state.search = (query) => (query === 'tone' ? [ctx.fake.state.sounds[101]] : []);
    ctx.fake.state.fail429 = 1;
    const { result } = await run(ctx, 'sfx.freesound-search', { query: 'tone bright', fewer_words: true });
    assert.equal(result.query_used, 'tone');
    assert.equal(result.sounds.length, 1);
    assert.deepEqual(
      searches(ctx).map((q) => q.get('query')),
      ['tone bright', 'tone bright', 'tone'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test(
  'sfx.freesound: WAVs, measurements, credits; the key never reaches the preview server',
  needs('ffmpeg'),
  async () => {
    const ctx = await setup();
    try {
      const out = await run(ctx, 'sfx.freesound', { sounds: [{ id: '101', name: 'tone' }, '202'] });
      const { result } = out;
      assert.deepEqual(out.outputs.map((o) => o.name).sort(), ['credits.json', 'freesound-202.wav', 'tone.wav']);
      const [a, b] = result.sounds;
      assert.equal(a.name, 'tone');
      assert.equal(a.file, 'tone.wav');
      assert.equal(a.license, 'cc0');
      assert.equal(b.name, 'freesound-202');
      assert.equal(b.license, 'by');
      assert.match(b.attribution, /"Tone two" by user202 \(https:\/\/freesound\.org\/.*\), CC BY 4\.0/);
      for (const s of result.sounds) {
        assert.ok(Math.abs(s.seconds - 2) < 0.15, `seconds ${s.seconds}`);
        assert.ok(Math.abs(s.onset_s - 0.5) < 0.06, `onset_s ${s.onset_s}`);
        assert.ok(s.loudest_s >= 0.45 && s.loudest_s <= 1.05, `loudest_s ${s.loudest_s}`);
        assert.ok(s.peak_db < 0 && s.peak_db > -30, `peak_db ${s.peak_db}`);
        assert.equal(s.source, 'preview');
      }
      const wav = readWav(await readFile(out.outputs.find((o) => o.name === 'tone.wav').abs));
      assert.equal(wav.sampleRate, 48000);
      assert.equal(wav.channels.length, 2);
      const credits = JSON.parse(await readFile(out.outputs.find((o) => o.name === 'credits.json').abs, 'utf8'));
      assert.deepEqual(
        credits.sounds.map((c) => [c.name, c.license]),
        [
          ['tone', 'cc0'],
          ['freesound-202', 'by'],
        ],
      );
      assert.equal(ctx.fake.state.previews.length, 2);
      for (const p of ctx.fake.state.previews) assert.equal(p.headers.authorization, undefined, 'preview got the key');
      for (const r of ctx.fake.state.api) assert.equal(r.headers.authorization, `Token ${CANARY}`);
      assertNoCanary('result', result);
      assertNoCanary('log', out.log);
    } finally {
      await ctx.cleanup();
    }
  },
);

test('sfx.freesound: a refused licence fails before any download', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const r = await capture(() => run(ctx, 'sfx.freesound', { sounds: ['101', '303'], licenses: ['cc0', 'by'] }));
    assert.equal(r.ok, false);
    assert.equal(r.type, 'invalid-input');
    assert.match(r.detail ?? r.message, /sound 303 .*by-nc/);
    assert.equal(ctx.fake.state.previews.length, 0, 'nothing was downloaded');
  } finally {
    await ctx.cleanup();
  }
});

test('sfx.freesound: an unknown id is invalid-input; 429s are retried', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const missing = await capture(() => run(ctx, 'sfx.freesound', { sounds: ['999'] }));
    assert.equal(missing.ok, false);
    assert.equal(missing.type, 'invalid-input');
    assert.match(missing.detail ?? missing.message, /404 for sound 999/);
    assertNoCanary('error', missing);

    ctx.fake.state.api.length = 0;
    ctx.fake.state.fail429 = 2;
    const ok = await run(ctx, 'sfx.freesound', { sounds: ['101'] });
    assert.equal(ok.result.sounds.length, 1);
    assert.equal(ctx.fake.state.api.length, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('sfx.freesound: duplicate names are invalid-input before any request', needs('ffmpeg'), async () => {
  const ctx = await setup();
  try {
    const r = await capture(() =>
      run(ctx, 'sfx.freesound', {
        sounds: [
          { id: '101', name: 'x' },
          { id: '202', name: 'x' },
        ],
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.type, 'invalid-input');
    assert.equal(ctx.fake.state.api.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('the Freesound tools are unavailable without the key file', async () => {
  const ws = await mkTmp('mx-fs-nokey-');
  const secrets = await mkTmp('mx-fs-nokey-secrets-');
  try {
    const config = testConfig(ws, { MX_SECRETS_DIR: secrets });
    await assert.rejects(runTool('sfx.freesound-search', { query: 'x' }, { workspace: ws, config }), /unavailable/);
  } finally {
    await rmTmp(ws);
    await rmTmp(secrets);
  }
});
