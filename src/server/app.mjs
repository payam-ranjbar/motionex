// The HTTP request pipeline: request ids, Host/Origin/token guards, routing and one JSON log line per request.
// Guards run before any body is read, so a web page can never POST code to this service (no DNS rebinding, no CSRF).
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { problem } from '../lib/problem.mjs';
import { createRouter, sendProblem } from './router.mjs';

/** An accepted inbound request id: short, printable, no whitespace, no log injection. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Paths that work without a token: liveness probes must not need credentials. */
const AUTH_FREE = new Set(['/livez', '/readyz']);

/**
 * Route modules registered on the one router. `jobs.mjs` and `listen.mjs` are written by other pieces and
 * may be absent in this worktree, so they are registered only when the file exists.
 */
const ROUTE_MODULES = [
  './routes/index.mjs',
  './routes/health.mjs',
  './routes/capabilities.mjs',
  './routes/tools.mjs',
  './routes/jobs.mjs',
  './routes/files.mjs',
  './routes/pins.mjs',
  './routes/skill.mjs',
  './routes/view.mjs',
  './routes/listen.mjs',
];

/** The pathname of a request URL without its query string (never throws). */
function pathnameOf(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return String(rawUrl ?? '/');
  }
}

/**
 * Constant-time comparison of a Bearer token from an Authorization header.
 * Lengths are compared first (timingSafeEqual needs equal-length buffers); the length itself is not a secret.
 * @param {string|undefined} header
 * @param {string} token
 * @returns {boolean}
 */
function bearerMatches(header, token) {
  if (typeof header !== 'string') return false;
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  const given = Buffer.from(m[1], 'utf8');
  const want = Buffer.from(token, 'utf8');
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * Read the API token file once. A configured but unreadable token file is a startup error: the service must
 * never fall open when its operator asked for authentication.
 * @param {string} file
 * @returns {string}
 */
function readToken(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the API token file ${file}: ${e.message}`);
  }
  const token = text.trim();
  if (token === '') throw new Error(`the API token file ${file} is empty`);
  return token;
}

/**
 * Write one JSON log line per finished request. Never logs bodies or headers.
 * @param {Record<string, unknown>} line
 */
function defaultLog(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Build the HTTP request handler.
 * Async because it registers route modules with dynamic imports (jobs.mjs and listen.mjs may not exist here).
 * @param {{config: Readonly<import('../runner/types.mjs').Config>, store: object, registry: object, pins: object,
 *   service: object, ready?: () => {ready: boolean, reasons: string[]}, log?: (line: object) => void}} deps
 * @returns {Promise<(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>>}
 */
export async function createApp(deps) {
  const config = deps.config;
  const log = typeof deps.log === 'function' ? deps.log : defaultLog;
  const quiet = config.logLevel === 'silent';
  const token = config.apiTokenFile ? readToken(config.apiTokenFile) : null;

  const router = createRouter();
  for (const spec of ROUTE_MODULES) {
    const url = new URL(spec, import.meta.url);
    if (!existsSync(fileURLToPath(url))) continue; // written by another piece, not in every worktree
    let mod;
    try {
      mod = await import(url.href);
    } catch (e) {
      throw new Error(`route module ${spec} could not be loaded: ${e.message}`);
    }
    if (typeof mod.register !== 'function') throw new Error(`route module ${spec} does not export register()`);
    mod.register(router, deps);
  }

  return async function handleRequest(req, res) {
    const started = process.hrtime.bigint();
    const pathname = pathnameOf(req.url);

    // 1. request id: echo a well-formed one, otherwise mint a fresh uuid
    const inbound = req.headers['x-request-id'];
    const requestId = typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('x-request-id', requestId);

    // 6. one log line per request, whatever the outcome (a client abort counts too)
    if (!quiet) {
      let logged = false;
      const write = () => {
        if (logged) return;
        logged = true;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        try {
          log({
            ts: new Date().toISOString(),
            level: 'info',
            request_id: requestId,
            method: req.method ?? '',
            path: pathname,
            status: res.statusCode,
            ms: Math.round(ms * 1000) / 1000,
          });
        } catch {
          // logging must never break a response
        }
      };
      res.on('finish', write);
      res.on('close', write);
    }

    /** Refuse the request without reading its body, but drain the socket so keep-alive stays sane. */
    const refuse = (code, detail) => {
      req.resume();
      sendProblem(res, problem(code, detail), requestId);
    };

    // 2. Host: DNS-rebinding guard. Health probes are exempt: they are read-only, and Docker's HEALTHCHECK calls
    //    them from inside the container (Host 127.0.0.1:<MX_PORT>) whatever host port the service is published on.
    const host = req.headers.host;
    if (
      !AUTH_FREE.has(pathname) &&
      !config.allowedHosts.includes('*') &&
      !(typeof host === 'string' && config.allowedHosts.includes(host))
    ) {
      refuse('host-not-allowed', host ? `Host ${JSON.stringify(host)} is not in MX_ALLOWED_HOSTS` : 'no Host header');
      return;
    }

    // 3. Origin: a browser must never be able to call this service (runs before any body is read)
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== '' && !config.allowedOrigins.includes('*')) {
      if (!config.allowedOrigins.includes(String(origin))) {
        refuse('origin-not-allowed', `Origin ${JSON.stringify(origin)} is not in MX_ALLOWED_ORIGINS`);
        return;
      }
    }

    // 4. Bearer token for everything but the probes
    if (token !== null && !AUTH_FREE.has(pathname) && !bearerMatches(req.headers.authorization, token)) {
      refuse('unauthenticated', 'send Authorization: Bearer <token>');
      return;
    }

    // 5. routing
    try {
      const handled = await router.handle(req, res, { deps, requestId });
      if (!handled) {
        req.resume();
        sendProblem(res, problem('not-found', pathname), requestId);
      }
    } catch (err) {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      console.error(err);
      sendProblem(res, problem('internal'), requestId);
    }
  };
}
