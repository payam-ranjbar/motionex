// Minimal HTTP router and response helpers for the motionex service.
// node:http only, no framework. Patterns are literal segments, :name (one segment) or a final
// *name that captures the rest of the path.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { mediaTypeOf } from '../lib/media-types.mjs';
import { problem, problemBody } from '../lib/problem.mjs';

const HEAD = 'HEAD';

/** Compile a pattern string into segments. */
function compile(pattern) {
  return String(pattern)
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) return { type: 'param', name: part.slice(1) };
      if (part.startsWith('*')) return { type: 'wild', name: part.slice(1) };
      return { type: 'literal', value: part };
    });
}

/** decodeURIComponent that turns bad encoding into an invalid-request problem. */
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw problem('invalid-request', 'bad percent-encoding in path');
  }
}

/** Match a compiled route against a pathname; returns params or null. */
function matchRoute(route, pathname) {
  const parts = pathname.split('/');
  const segs = route.segs;
  const last = segs[segs.length - 1];
  const hasWild = Boolean(last && last.type === 'wild');
  const fixed = hasWild ? segs.length - 1 : segs.length;
  if (hasWild ? parts.length < fixed : parts.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < fixed; i++) {
    const seg = segs[i];
    const raw = parts[i];
    if (seg.type === 'literal') {
      if (seg.value !== raw) return null;
    } else if (seg.type === 'param') {
      if (!raw) return null;
      params[seg.name] = decodeSegment(raw);
    } else {
      return null;
    }
  }
  if (hasWild) params[last.name] = parts.slice(fixed).map(decodeSegment).join('/');
  return params;
}

/** The Allow header value from the routes whose pattern matched. */
function allowOf(matches) {
  const seen = new Set();
  for (const { route } of matches) {
    seen.add(route.method);
    if (route.method === 'GET') seen.add(HEAD);
  }
  return [...seen].join(', ');
}

/**
 * Parse a single byte range.
 * @returns {{start:number,end:number}|'invalid'|null} null means "send the full file".
 */
function parseRange(header, size) {
  if (header === undefined || header === null) return null;
  const h = String(header).trim();
  if (!h.toLowerCase().startsWith('bytes=')) return null;
  const spec = h.slice(6).trim();
  if (spec.includes(',')) return null; // multiple ranges: ignore
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return 'invalid';
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  if (size === 0) return 'invalid';
  if (a === '') {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  if (b === '') return { start, end: size - 1 };
  const end = Number(b);
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Write a JSON response. HEAD requests get headers (incl. Content-Length) and no body.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} obj
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  if (res.req?.method === HEAD) res.end();
  else res.end(body);
}

/**
 * Write an RFC 9457 problem response. `problem.extras.headers` is merged into the response
 * headers (and removed from the body).
 * @param {import('node:http').ServerResponse} res
 * @param {import('../lib/problem.mjs').Problem} p
 * @param {string} [requestId]
 */
export function sendProblem(res, p, requestId) {
  const body = problemBody(p, requestId);
  const headers = { 'Content-Type': 'application/problem+json' };
  if (body.headers && typeof body.headers === 'object') {
    Object.assign(headers, body.headers);
    delete body.headers;
  }
  if (requestId) headers['x-request-id'] = requestId;
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  headers['Content-Length'] = buf.length;
  res.writeHead(p.status, headers);
  if (res.req?.method === HEAD) res.end();
  else res.end(buf);
}

/**
 * Collect the request body, rejecting with payload-too-large past `limit` bytes. The stream is
 * left flowing so the socket drains instead of hanging.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Buffer>}
 */
export async function readBody(req, limit) {
  const max = limit ?? Number.POSITIVE_INFINITY;
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > max) {
      req.on('error', () => {});
      req.resume();
      throw problem('payload-too-large', `limit ${limit} bytes`);
    }
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > max) {
        fail(problem('payload-too-large', `limit ${limit} bytes`));
        req.resume(); // keep draining so the socket is not left hanging
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(problem('internal', 'request aborted')));
  });
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
export async function readJson(req, limit) {
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  const contentType = String(req.headers['content-type'] ?? '').trim();
  if (contentType.toLowerCase().startsWith('multipart/')) throw problem('unsupported-media-type');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (e) {
    throw problem('malformed-json', e.message);
  }
}

/** Pipe a file range into the response, ignoring client aborts. */
async function pipeFile(abs, res, range) {
  try {
    await pipeline(createReadStream(abs, range), res);
  } catch {
    // Headers are already sent; a client abort or stream error has nowhere to go.
  }
}

/**
 * Stream a file with Range/ETag/Last-Modified support.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} abs
 * @param {{mediaType?: string, headers?: Record<string, string>}} [opts]
 */
export async function streamFile(req, res, abs, { mediaType, headers = {} } = {}) {
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw problem('file-not-found', String(abs));
  }
  if (!info.isFile()) throw problem('file-not-found', String(abs));
  const size = info.size;
  const etag = `"${size}-${Math.floor(info.mtimeMs)}"`;
  const base = {
    'Content-Type': mediaType ?? mediaTypeOf(abs),
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    ...headers,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base);
    res.end();
    return;
  }

  const ranged = parseRange(req.headers.range, size);
  if (ranged === 'invalid') {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    res.end();
    return;
  }
  if (ranged) {
    const { start, end } = ranged;
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === HEAD) res.end();
    else await pipeFile(abs, res, { start, end });
    return;
  }

  res.writeHead(200, { ...base, 'Content-Length': size });
  if (req.method === HEAD) res.end();
  else await pipeFile(abs, res);
}

/** Apply a handler's return value to the response. */
function interpretReturn(req, res, value) {
  if (value === undefined) {
    if (!res.headersSent && !res.writableEnded) res.writeHead(204).end();
    return;
  }
  const isResponseObject =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.status === 'number' &&
    'body' in value;
  if (!isResponseObject) {
    sendJson(res, 200, value);
    return;
  }
  const body = value.body;
  const headers = value.headers ?? {};
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const h = { ...headers };
    if (h['Content-Length'] === undefined && h['content-length'] === undefined) h['Content-Length'] = buf.length;
    res.writeHead(value.status, h);
    if (req.method === HEAD) res.end();
    else res.end(buf);
  } else if (body !== null && body !== undefined && typeof body === 'object') {
    sendJson(res, value.status, body, headers);
  } else {
    res.writeHead(value.status, headers);
    res.end();
  }
}

/** Send a thrown error: a Problem as-is, anything else as a stackless 500. */
function respondError(res, err, requestId) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  if (err && err.name === 'Problem') {
    sendProblem(res, err, requestId);
    return;
  }
  console.error(err);
  sendProblem(res, problem('internal'), requestId);
}

/**
 * Build a router.
 * @returns {{add: (method: string, pattern: string, handler: Function) => void, handle: Function}}
 */
export function createRouter() {
  const routes = [];

  return {
    /** Register a handler for a method + pattern. */
    add(method, pattern, handler) {
      routes.push({ method: String(method).toUpperCase(), pattern, handler, segs: compile(pattern) });
    },

    /**
     * Dispatch a request. Returns false when no pattern matches (the caller sends 404); otherwise
     * sends a response and returns true.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {{deps?: unknown, requestId?: string}} [opts]
     * @returns {Promise<boolean>}
     */
    async handle(req, res, { deps, requestId } = {}) {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        sendProblem(res, problem('invalid-request', 'invalid request URL'), requestId);
        return true;
      }

      const matches = [];
      try {
        for (const route of routes) {
          const params = matchRoute(route, url.pathname);
          if (params) matches.push({ route, params });
        }
      } catch (err) {
        respondError(res, err, requestId);
        return true;
      }
      if (matches.length === 0) return false;

      const method = req.method ?? 'GET';
      const chosen = matches.find((m) => m.route.method === method || (method === HEAD && m.route.method === 'GET'));
      if (!chosen) {
        sendProblem(res, problem('method-not-allowed', '', { headers: { Allow: allowOf(matches) } }), requestId);
        return true;
      }

      const ctx = {
        params: chosen.params,
        url,
        query: url.searchParams,
        requestId,
        deps,
        readJson: (limit) => readJson(req, limit),
      };

      try {
        interpretReturn(req, res, await chosen.route.handler(req, res, ctx));
      } catch (err) {
        respondError(res, err, requestId);
      }
      return true;
    },
  };
}
