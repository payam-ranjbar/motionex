// Optional Freesound sound-library provider: a tiny client for the Freesound API v2 (search, sound details, preview
// download) and the licence vocabulary shared by the sfx.search and sfx.fetch contracts.
// The API key is read from a secret FILE by the tool handlers and passed in here. It travels only in the
// Authorization header, only to the API's own origin, and never appears in a URL, a log, a result or an error.
import { ToolError } from './errors.mjs';

const BODY_SNIPPET = 300;

/** Licence codes of the sfx contracts, with Freesound's filter names. */
export const LICENSES = Object.freeze({
  cc0: 'Creative Commons 0',
  by: 'Attribution',
  'by-nc': 'Attribution NonCommercial',
  'sampling+': 'Sampling+',
});

const LICENSE_TITLES = { cc0: 'CC0 1.0', by: 'CC BY', 'by-nc': 'CC BY-NC', 'sampling+': 'CC Sampling+' };

/**
 * A Freesound licence (a Creative Commons URL or a licence name) as a contract code.
 * @param {string} license
 * @returns {'cc0'|'by'|'by-nc'|'sampling+'|'other'}
 */
export function licenseCode(license) {
  const s = String(license ?? '').toLowerCase();
  if (s.includes('publicdomain/zero') || s === 'creative commons 0' || s === 'cc0') return 'cc0';
  if (s.includes('sampling+')) return 'sampling+';
  if (s.includes('/by-nc') || s === 'attribution noncommercial' || s === 'attribution non-commercial') return 'by-nc';
  if (s.includes('/by/') || s.endsWith('/by') || s === 'attribution') return 'by';
  return 'other';
}

/** "CC BY 4.0"-style title for a credit line (the version from the URL when it has one). */
export function licenseTitle(license) {
  const code = licenseCode(license);
  if (code === 'other') return String(license ?? 'unknown licence');
  const version = String(license ?? '').match(/\/(\d+\.\d+)\/?$/)?.[1];
  return code === 'cc0' ? LICENSE_TITLES.cc0 : `${LICENSE_TITLES[code]}${version ? ` ${version}` : ''}`;
}

/** A Freesound search filter for licence codes and a length range (Solr syntax). */
export function searchFilter({ licenses, min_seconds, max_seconds, extra } = {}) {
  const parts = [];
  if (licenses?.length) {
    const names = licenses.map((c) => `"${LICENSES[c]}"`);
    parts.push(names.length === 1 ? `license:${names[0]}` : `license:(${names.join(' OR ')})`);
  }
  if (min_seconds !== undefined || max_seconds !== undefined)
    parts.push(`duration:[${min_seconds ?? 0} TO ${max_seconds ?? '*'}]`);
  if (extra) parts.push(extra);
  return parts.join(' ');
}

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

/** A ToolError for an HTTP failure. `what` names the request without its query; the body is cut short. */
function httpError(status, body, what) {
  const snippet = String(body ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, BODY_SNIPPET);
  const detail = `Freesound HTTP ${status} for ${what}${snippet ? `: ${snippet}` : ''}`;
  if (status === 429) return new ToolError('rate-limited', detail);
  if (status === 401 || status === 403)
    return new ToolError('provider-error', `${detail}; check the freesound_api_key secret file`);
  if (status === 404) return new ToolError('invalid-input', `${detail}; no such sound`);
  if (status >= 500) return new ToolError('provider-error', detail, { retryable: true });
  return new ToolError('provider-error', detail);
}

/**
 * Create a Freesound API v2 client.
 * @param {{apiKey: string, baseUrl?: string, backoffMs?: number, retries?: number, fetchImpl?: typeof fetch}} opts
 */
export function createClient({
  apiKey,
  baseUrl = 'https://freesound.org',
  backoffMs = 1500,
  retries = 3,
  fetchImpl = fetch,
}) {
  const origin = new URL(baseUrl).origin;

  /** GET with retries on 429, 5xx and network errors. The key goes only to the API's own origin. */
  async function get(url, { signal, what, accept } = {}) {
    const headers = {};
    if (accept) headers.accept = accept;
    if (new URL(url).origin === origin) headers.authorization = `Token ${apiKey}`;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new ToolError('canceled', 'request canceled');
      let res;
      try {
        res = await fetchImpl(url, { headers, signal, redirect: 'follow' });
      } catch (e) {
        if (signal?.aborted) throw new ToolError('canceled', 'request canceled');
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt, signal);
          continue;
        }
        throw new ToolError('network', `network error calling Freesound (${what}): ${e.message}`);
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs * 2 ** attempt,
          signal,
        );
        continue;
      }
      throw httpError(res.status, text, what);
    }
  }

  const api = (route, query) => {
    const url = new URL(`/apiv2${route}`, baseUrl);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    return url.href;
  };

  /**
   * Text search.
   * @param {{query: string, filter?: string, sort?: string, page_size?: number, page?: number, fields: string}} q
   * @returns {Promise<{count: number, results: object[]}>}
   */
  async function search(q, { signal } = {}) {
    const res = await get(api('/search/', q), { signal, what: 'search', accept: 'application/json' });
    return res.json();
  }

  /** One sound's details. @returns {Promise<object>} */
  async function sound(id, fields, { signal } = {}) {
    const res = await get(api(`/sounds/${encodeURIComponent(id)}/`, { fields }), {
      signal,
      what: `sound ${id}`,
      accept: 'application/json',
    });
    return res.json();
  }

  /** Download a file (a preview). @returns {Promise<Buffer>} */
  async function download(url, { signal, what } = {}) {
    const res = await get(url, { signal, what });
    return Buffer.from(await res.arrayBuffer());
  }

  return { search, sound, download };
}
