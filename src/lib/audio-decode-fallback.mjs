// Decode sample files the engine's Web Audio decoder rejects, by routing them through ffmpeg.
//
// superdough loads a sample as `fetch(url).then((res) => res.arrayBuffer()).then((bytes) => ac.decodeAudioData(bytes))`.
// node-web-audio-api's decoder refuses some otherwise valid files that ship in sample banks (the VCSL darbuka WAVs,
// for example, have a 20-byte `fmt ` chunk that it calls a "malformed fmt_pcm chunk"), and a sample that fails to
// decode turns its events silent with no hint of which file. This module wraps the fetch that
// vendor/mucavex/src/fetch.mjs installed, remembers the URL of every ArrayBuffer handed out, then patches
// `decodeAudioData` to retry a rejected buffer through ffmpeg (WAV pcm_f32le on stdout, same rate and channels) and
// decode the result. When ffmpeg cannot read the bytes either, the thrown error names the sample URL, and the
// engine's per-event `console.warn` turns that into a warning that names the failing file.
//
// Install this AFTER the vendored modules are imported (their import installs the cached fetch) and always
// `uninstall()` in a finally. It throws when the context class has no `decodeAudioData` to patch.
import { runFfmpeg } from './ffmpeg.mjs';

/** ffmpeg: any input on stdin -> WAV PCM float32 on stdout, keeping the input sample rate and channel count. */
const TRANSCODE_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-f',
  'wav',
  '-c:a',
  'pcm_f32le',
  'pipe:1',
];

/** URL of every ArrayBuffer the patched fetch returned, so a decode failure can name the sample. */
const urlOf = new WeakMap();

/**
 * Find the prototype that owns `decodeAudioData` (node-web-audio-api defines it on BaseAudioContext.prototype,
 * which OfflineAudioContext inherits) and its original implementation.
 * @param {any} contextClass
 * @returns {{proto: object, decode: Function}|null}
 */
function findDecode(contextClass) {
  let proto = contextClass?.prototype;
  while (proto) {
    if (Object.hasOwn(proto, 'decodeAudioData')) {
      return { proto, decode: proto.decodeAudioData };
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/** A standalone ArrayBuffer copy of a Buffer (ffmpeg's Buffer may be a view into a shared pool). */
function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Wrap the installed fetch so every ArrayBuffer it returns is remembered with its URL. The Response itself is
 * returned unchanged apart from that one method.
 * @param {typeof fetch} fetchImpl
 * @returns {typeof fetch}
 */
function wrapFetch(fetchImpl) {
  return async function fetchRememberingUrl(input, init) {
    const res = await fetchImpl.call(this, input, init);
    if (!res || typeof res.arrayBuffer !== 'function') return res;
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const arrayBuffer = res.arrayBuffer.bind(res);
    try {
      Object.defineProperty(res, 'arrayBuffer', {
        configurable: true,
        writable: true,
        value: async () => {
          const bytes = await arrayBuffer();
          urlOf.set(bytes, url);
          return bytes;
        },
      });
    } catch {
      // A frozen Response cannot be annotated; the sample simply has no URL in its fallback error.
    }
    return res;
  };
}

/**
 * @typedef {object} AudioDecodeFallback
 * @property {Set<string>} transcoded URLs of the samples that had to go through ffmpeg
 * @property {() => void} uninstall restore the previous fetch and decodeAudioData
 */

/**
 * Install the ffmpeg fallback for `decodeAudioData`.
 * @param {{contextClass?: any, signal?: AbortSignal, ffmpeg?: typeof runFfmpeg}} [options]
 *   `contextClass` defaults to `globalThis.OfflineAudioContext`; `ffmpeg` defaults to `runFfmpeg`.
 * @returns {AudioDecodeFallback}
 * @throws {Error} when `contextClass` has no `decodeAudioData` on its prototype chain
 */
export function installAudioDecodeFallback({
  contextClass = globalThis.OfflineAudioContext,
  signal,
  ffmpeg = runFfmpeg,
} = {}) {
  const target = findDecode(contextClass);
  if (!target) throw new Error('decodeAudioData not found on the OfflineAudioContext prototype chain');
  const { proto, decode } = target;

  const previousFetch = globalThis.fetch;
  const transcoded = new Set();
  let live = true;

  const transcode = async (bytes) => {
    const { stdout } = await ffmpeg(TRANSCODE_ARGS, { input: Buffer.from(bytes), stdout: 'buffer', signal });
    if (!stdout || stdout.length === 0) throw new Error('ffmpeg wrote no audio');
    return toArrayBuffer(stdout);
  };

  async function decodeWithFallback(...args) {
    const [arrayBuffer, successCallback, errorCallback] = args;
    // Keep the original argument validation/throw for anything that is not an ArrayBuffer.
    if (!(arrayBuffer instanceof ArrayBuffer)) return decode.apply(this, args);
    const url = urlOf.get(arrayBuffer);
    // node-web-audio-api detaches the input buffer while decoding, so keep a copy for the ffmpeg retry.
    const copy = arrayBuffer.slice(0);
    try {
      const decoded = await decode.call(this, arrayBuffer);
      if (typeof successCallback === 'function') successCallback(decoded);
      return decoded;
    } catch (originalError) {
      if (!url) {
        if (typeof errorCallback === 'function') {
          errorCallback(originalError);
          return undefined;
        }
        throw originalError;
      }
      let decoded;
      try {
        decoded = await decode.call(this, await transcode(copy));
      } catch (ffmpegError) {
        // Collapse whitespace: ffmpeg's stderr is multi-line, and the engine's "event skipped" console.warn
        // is parsed line-by-line, so a newline would hide the sample's name from the render's warnings.
        const reason = (ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        const failure = new Error(`could not decode sample ${url}: ${originalError.message} (ffmpeg: ${reason})`);
        if (typeof errorCallback === 'function') {
          errorCallback(failure);
          return undefined;
        }
        throw failure;
      }
      transcoded.add(url);
      if (typeof successCallback === 'function') successCallback(decoded);
      return decoded;
    }
  }

  const patchedFetch = wrapFetch(previousFetch);
  globalThis.fetch = patchedFetch;
  proto.decodeAudioData = decodeWithFallback;

  return {
    transcoded,
    uninstall() {
      if (!live) return;
      live = false;
      if (globalThis.fetch === patchedFetch) globalThis.fetch = previousFetch;
      if (proto.decodeAudioData === decodeWithFallback) proto.decodeAudioData = decode;
    },
  };
}
