// fetch() wrapper used by superdough to load sample maps and audio files.
// - file:// URLs are read from disk (bundle or mount your own sample packs)
// - http(s) responses are cached on disk, so a sample bank is downloaded once
//   and later renders work fully offline.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.mjs';

const nativeFetch = globalThis.fetch;

const cachePath = (url) => {
  const hash = createHash('sha256').update(url).digest('hex');
  return path.join(config.sampleCacheDir, hash.slice(0, 2), hash);
};

const fromBytes = (bytes) => new Response(bytes, { status: 200 });

async function cachedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input.url ?? String(input));

  if (url.startsWith('file://')) {
    return fromBytes(await readFile(fileURLToPath(url)));
  }
  if (!/^https?:\/\//.test(url) || (init?.method && init.method !== 'GET')) {
    return nativeFetch(input, init);
  }

  const file = cachePath(url);
  try {
    return fromBytes(await readFile(file));
  } catch {}

  if (config.offline) {
    throw new Error(`offline mode: ${url} is not in the sample cache`);
  }
  const res = await nativeFetch(url, init);
  if (!res.ok) return res;
  const bytes = Buffer.from(await res.arrayBuffer());
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  } catch (err) {
    console.warn(`[fetch] could not cache ${url}: ${err.message}`);
  }
  return fromBytes(bytes);
}

export function installFetch() {
  globalThis.fetch = cachedFetch;
}
