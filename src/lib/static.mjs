// Static HTTP serving for capture and preview: workspace files plus the bundled browser libs, with optional
// HTML composition (injected fragments and window globals). Pages must be served over http, never file://,
// so that fetch, ES modules and fonts behave exactly like they do for a normal site.
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { streamFile } from '../server/router.mjs';
import { relFromWorkspace, toWorkspacePath } from './paths.mjs';

/** The marker a composed page may use to choose where the injected fragments land. */
const INJECT_MARKER = '<!--mx:inject-->';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** `<head ...>` (any attributes, any case). */
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
/** `<html ...>` (any attributes, any case). */
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
/** A JS identifier: the only global names that can be written as `window.NAME`. */
const GLOBAL_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Insert a block immediately after the opening `<head>`, else `<html>`, else at the very start. */
function insertGlobals(html, block) {
  const head = HEAD_OPEN.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + block + html.slice(at);
  }
  const root = HTML_OPEN.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + block + html.slice(at);
  }
  return block + html;
}

/** Replace the first `<!--mx:inject-->`; without one insert right before `</body>`, else append. */
function insertFragments(html, block) {
  const at = html.indexOf(INJECT_MARKER);
  if (at >= 0) return html.slice(0, at) + block + html.slice(at + INJECT_MARKER.length);
  const close = html.toLowerCase().lastIndexOf('</body>');
  if (close >= 0) return html.slice(0, close) + block + html.slice(close);
  return html + block;
}

/**
 * One `<script>` that defines a window global. The JSON is escaped so a value containing `</script>`
 * (or `</` at all) can never close the tag.
 * @param {string} name a JS identifier
 * @param {unknown} value JSON-serialisable value
 * @returns {string}
 */
function globalScript(name, value) {
  const json = JSON.stringify(value === undefined ? null : value).replace(/<\//g, '<\\/');
  return `<script>window.${name} = ${json};</script>`;
}

/**
 * Compose an HTML page: `globals` become `window.NAME` scripts right after the opening `<head>`
 * (after `<html>` when the page has no head, at the very start otherwise); `inject` fragments replace the
 * first `<!--mx:inject-->` marker (before `</body>` when there is no marker, appended when there is neither).
 * @param {string} html the page source
 * @param {{inject?: string[], globals?: Record<string, unknown>}} [opts] fragment texts in order, global values
 * @returns {string} the composed page
 */
export function composeHtml(html, { inject = [], globals = {} } = {}) {
  let out = String(html ?? '');
  const scripts = Object.entries(globals ?? {})
    .filter(([name]) => GLOBAL_NAME.test(name))
    .map(([name, value]) => globalScript(name, value));
  if (scripts.length) out = insertGlobals(out, scripts.join('\n'));
  const fragments = (inject ?? []).map((f) => String(f ?? '')).filter((f) => f !== '');
  if (fragments.length) out = insertFragments(out, fragments.join('\n'));
  return out;
}

/** A short text response (404s, server-side composition errors). */
function sendText(req, res, status, text) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...NO_STORE,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/** A composed page response. */
function sendHtml(req, res, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    ...NO_STORE,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

const notFound = (req, res) => sendText(req, res, 404, 'not found');

/** Percent-decode a URL path; null when the encoding is broken. */
function decodePath(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Start a bare static server for one capture or preview session.
 * - `GET|HEAD /w/<path>` serves a workspace file under `root` (a bad path is a 404). When `<path>` is
 *   `compose.pagePath` the page is composed in memory (fragments + globals) and sent as `text/html`.
 * - `GET|HEAD /_mx/lib/<prefix>/<path>` serves from `libDirs[prefix]` (a bad path or unknown prefix is a 404).
 * - Anything else is a 404. Every response is `Cache-Control: no-store`.
 * @param {object} opts
 * @param {string} opts.root absolute workspace root
 * @param {Record<string, string>} [opts.libDirs] URL prefix -> absolute lib folder (e.g. `{gsap: '/app/node_modules/gsap/dist'}`)
 * @param {{pagePath: string, inject?: string[], globals?: Record<string, unknown>}|null} [opts.compose]
 *   pagePath is workspace-relative POSIX, inject holds ABSOLUTE paths of HTML fragment files
 * @param {boolean} [opts.offline] accepted for symmetry; blocking outside requests is the browser's job
 * @returns {Promise<{origin: string, port: number, pageUrl: (rel: string) => string, loaded: Set<string>,
 *   close: () => Promise<void>}>} loaded collects the workspace-relative POSIX paths that were served
 */
export async function startStaticServer({ root, libDirs = {}, compose = null, offline = false } = {}) {
  if (!root || typeof root !== 'string') throw new Error('startStaticServer: root (absolute workspace) is required');
  void offline; // the capture tool blocks outside requests in the browser, not here
  const workspace = path.resolve(root);
  // Resolve the composed page up front so a bad pagePath fails loudly at start, not on first request.
  const composeAbs = compose?.pagePath ? toWorkspacePath(workspace, compose.pagePath) : null;
  const libs = Object.entries(libDirs ?? {}).map(([prefix, dir]) => [String(prefix), path.resolve(String(dir))]);
  /** @type {Set<string>} */
  const loaded = new Set();

  /** Serve one workspace path (composed when it is the compose page). */
  async function serveWorkspace(req, res, rel) {
    let abs;
    try {
      abs = toWorkspacePath(workspace, rel);
    } catch {
      return notFound(req, res);
    }
    if (composeAbs && abs === composeAbs) {
      let html;
      try {
        html = await readFile(abs, 'utf8');
      } catch {
        return notFound(req, res);
      }
      const fragments = [];
      for (const frag of compose.inject ?? []) {
        try {
          fragments.push(await readFile(String(frag), 'utf8'));
        } catch (e) {
          // A missing fragment is a server-side misconfiguration: say so instead of serving a broken page.
          return sendText(req, res, 500, `inject fragment unreadable: ${e?.message ?? String(frag)}`);
        }
      }
      loaded.add(relFromWorkspace(workspace, abs));
      return sendHtml(req, res, composeHtml(html, { inject: fragments, globals: compose.globals ?? {} }));
    }
    try {
      const info = await stat(abs);
      if (!info.isFile()) return notFound(req, res);
    } catch {
      return notFound(req, res);
    }
    loaded.add(relFromWorkspace(workspace, abs));
    try {
      await streamFile(req, res, abs, { headers: NO_STORE });
    } catch {
      if (!res.headersSent) notFound(req, res);
      else res.destroy();
    }
  }

  /** Serve `/_mx/lib/<prefix>/<path>` from the matching lib folder, confined to it. */
  async function serveLib(req, res, rest) {
    const slash = rest.indexOf('/');
    if (slash <= 0) return notFound(req, res);
    const prefix = decodePath(rest.slice(0, slash));
    const sub = decodePath(rest.slice(slash + 1));
    if (prefix === null || sub === null) return notFound(req, res);
    const dir = libs.find(([name]) => name === prefix)?.[1];
    if (!dir) return notFound(req, res);
    let abs;
    try {
      abs = toWorkspacePath(dir, sub);
    } catch {
      return notFound(req, res);
    }
    try {
      await streamFile(req, res, abs, { headers: NO_STORE });
    } catch {
      if (!res.headersSent) notFound(req, res);
      else res.destroy();
    }
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(req, res);
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      return notFound(req, res);
    }
    if (pathname.startsWith('/w/')) {
      const rel = decodePath(pathname.slice('/w/'.length));
      if (rel === null) return notFound(req, res);
      return serveWorkspace(req, res, rel);
    }
    if (pathname.startsWith('/_mx/lib/')) return serveLib(req, res, pathname.slice('/_mx/lib/'.length));
    return notFound(req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendText(req, res, 500, 'internal error');
      else res.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    loaded,
    /** Absolute http URL for a workspace-relative POSIX page path, e.g. films/a/scene.html. */
    pageUrl(rel) {
      const segments = String(rel ?? '')
        .split('/')
        .map((s) => encodeURIComponent(s));
      return `${origin}/w/${segments.join('/')}`;
    },
    /** Stop listening and drop open keep-alive sockets; safe to call twice. */
    close() {
      if (!server.listening) return Promise.resolve();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
