// Optional ElevenLabs voice provider: a tiny client for text-to-speech and voice listing.
// The API key is read from a secret FILE by the tool handlers and passed in here; it must never be
// logged, returned in a result, or included in an error detail. Ported from motion-studio/eleven.mjs.
import { ToolError } from './errors.mjs';

const BODY_SNIPPET = 300;

/** Wait, aborting (rejecting with `canceled`) when the signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolError('canceled', 'request canceled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ToolError('canceled', 'request canceled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Build a ToolError from an HTTP response. `body` is at most 300 chars and never contains the key. */
function httpError(status, body, { voices = false } = {}) {
  const snippet = String(body ?? '').slice(0, BODY_SNIPPET);
  const detail = `ElevenLabs HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
  if (status === 429) return new ToolError('rate-limited', detail);
  if (status === 401 || status === 403) {
    const hint = voices ? '; the key may be scoped to text-to-speech only; pass a known voice_id' : '';
    return new ToolError('provider-error', detail + hint);
  }
  if (status >= 500) return new ToolError('provider-error', detail, { retryable: true });
  return new ToolError('provider-error', detail);
}

/**
 * Create an ElevenLabs API client.
 * @param {{apiKey: string, baseUrl?: string, backoffMs?: number, retries?: number, fetchImpl?: typeof fetch}} opts
 */
export function createClient({
  apiKey,
  baseUrl = 'https://api.elevenlabs.io',
  backoffMs = 1500,
  retries = 3,
  fetchImpl = fetch,
}) {
  /**
   * One request with retries. Retries 429, 5xx and network failures `retries` times, waiting
   * `backoffMs * 2**attempt` (or Retry-After seconds when the response gives one).
   * @returns {Promise<Response>} a successful (2xx) response; its body is not consumed yet.
   */
  async function request(method, route, { body, query, signal, accept, voices = false } = {}) {
    const url = new URL(route, baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = { 'xi-api-key': apiKey };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (accept) headers.accept = accept;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new ToolError('canceled', 'request canceled');
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new ToolError('canceled', 'request canceled');
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt, signal);
          continue;
        }
        throw new ToolError('network', `network error calling ${method} ${route}: ${e.message}`);
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs * 2 ** attempt;
        await sleep(wait, signal);
        continue;
      }
      throw httpError(res.status, text, { voices });
    }
  }

  /**
   * Synthesize one line of speech.
   * @param {{voice_id: string, text: string, model_id?: string, output_format?: string,
   *   voice_settings?: object, seed?: number, language_code?: string}} req
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{audio: Buffer, request_id: string|null}>}
   */
  async function synthesize(req, { signal } = {}) {
    const route = `/v1/text-to-speech/${encodeURIComponent(req.voice_id)}`;
    const res = await request('POST', route, {
      query: { output_format: req.output_format },
      body: {
        text: req.text,
        model_id: req.model_id,
        voice_settings: req.voice_settings,
        seed: req.seed,
        language_code: req.language_code,
      },
      accept: 'audio/mpeg',
      signal,
    });
    return { audio: Buffer.from(await res.arrayBuffer()), request_id: res.headers.get('request-id') ?? null };
  }

  /**
   * List premade/available voices.
   * @param {{search?: string}} [opts]
   * @param {{signal?: AbortSignal}} [run]
   * @returns {Promise<{voice_id: string, name: string, labels: object}[]>}
   */
  async function voices({ search } = {}, { signal } = {}) {
    const res = await request('GET', '/v1/voices', {
      query: { search },
      accept: 'application/json',
      voices: true,
      signal,
    });
    const json = await res.json();
    return (json.voices ?? []).map((v) => ({ voice_id: v.voice_id, name: v.name, labels: v.labels ?? {} }));
  }

  return { synthesize, voices };
}
