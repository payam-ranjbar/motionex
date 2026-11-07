// audio-decode-fallback: routes sample files the node-web-audio-api decoder rejects through ffmpeg.
// The malformed WAV is built with ffmpeg, then its `fmt ` chunk is padded to 20 bytes, exactly the shape the
// cached VCSL darbuka file has and node-web-audio-api calls a "malformed fmt_pcm chunk". Real ffmpeg and a
// real node-web-audio-api OfflineAudioContext are used, so the test proves the fallback, not a mock.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { OfflineAudioContext } from 'node-web-audio-api';
import { installAudioDecodeFallback } from '../../src/lib/audio-decode-fallback.mjs';
import { runFfmpeg } from '../../src/lib/ffmpeg.mjs';
import { needs } from '../helpers/needs.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

/** Insert `extra` zero bytes into the WAV `fmt ` chunk (16 -> 20 rejects as "malformed fmt_pcm chunk"). */
function padFmtChunk(buf, extra) {
  const at = buf.indexOf('fmt ');
  assert.ok(at >= 0, 'the ffmpeg WAV has a fmt chunk');
  const size = buf.readUInt32LE(at + 4);
  const end = at + 8 + size;
  const merged = Buffer.concat([buf.subarray(0, end), Buffer.alloc(extra), buf.subarray(end)]);
  merged.writeUInt32LE(size + extra, at + 4);
  merged.writeUInt32LE(buf.readUInt32LE(4) + extra, 4);
  return merged;
}

/** ffmpeg a 0.2 s stereo 44.1 kHz PCM WAV, then make its `fmt ` chunk 20 bytes like the cached darbuka. */
async function malformedWav(dir) {
  const out = path.join(dir, 'source.wav');
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=0.2',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    '-y',
    out,
  ]);
  return padFmtChunk(await readFile(out), 4);
}

/** An HTTP server that serves one fixed body, so the patched fetch records a real URL. */
async function serve(body) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: (name) => `http://127.0.0.1:${port}/${name}`, close: () => new Promise((r) => server.close(r)) };
}

const openServers = [];
after(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

test('audio-decode-fallback: a rejected WAV decodes through ffmpeg and names itself', needs('ffmpeg'), async () => {
  const ws = await mkTmp('mx-decode-');
  const bytes = await malformedWav(ws);
  const server = await serve(bytes);
  openServers.push(server);
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const url = server.url('Darbuka_1_hit_vl1_rr1.wav');
  try {
    // Without the fallback the decoder rejects exactly like the cached darbuka file.
    const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await assert.rejects(ctx.decodeAudioData(raw), /malformed fmt_pcm chunk/);

    const fallback = installAudioDecodeFallback({ contextClass: OfflineAudioContext });
    try {
      const res = await fetch(url);
      const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
      assert.equal(decoded.numberOfChannels, 2);
      assert.equal(decoded.sampleRate, 44100);
      assert.equal(decoded.length, Math.round(0.2 * 44100));
      assert.deepEqual([...fallback.transcoded], [url], 'the transcoded URL is reported');
    } finally {
      fallback.uninstall();
    }

    // Uninstall puts the original decoder back.
    await assert.rejects(ctx.decodeAudioData(raw), /malformed fmt_pcm chunk/);
  } finally {
    await rmTmp(ws);
  }
});

test('audio-decode-fallback: a failure names the URL and the original error', needs('ffmpeg'), async () => {
  const server = await serve(Buffer.from('this is not audio at all'));
  openServers.push(server);
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const url = server.url('broken.wav');
  const fallback = installAudioDecodeFallback({ contextClass: OfflineAudioContext });
  try {
    const res = await fetch(url);
    const bytes = await res.arrayBuffer();
    await assert.rejects(ctx.decodeAudioData(bytes), (err) => {
      assert.match(err.message, /could not decode sample/);
      assert.ok(err.message.includes(url), `error should name ${url}: ${err.message}`);
      assert.match(err.message, /decodeAudioData/);
      // Single line: the engine's per-event warning parser stops at the first newline.
      assert.ok(!err.message.includes('\n'), `error should be one line: ${JSON.stringify(err.message)}`);
      return true;
    });
    assert.equal(fallback.transcoded.size, 0, 'a failed sample is not reported as transcoded');
  } finally {
    fallback.uninstall();
  }
});
