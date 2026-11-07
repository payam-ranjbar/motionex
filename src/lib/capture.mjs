// Picture capture: serve a workspace page over http, drive `window.__motion.seek(t)` in a headless browser
// and pull the pixels back. Ported from an earlier in-house build script (openPage, frameAt with
// retry, the ordered flush to ffmpeg). The page contract:
//   window.__motion = { ready: true, seek(t) -> void | Promise, duration?, size?: {width, height} }
//
// Headless Chromium stalls for ~15 s on the first screenshot of a fresh page, so every worker page is
// warmed up with a throwaway low-quality JPEG before the real frames start.
import { launchBrowser } from './browser.mjs';
import { ToolError } from './errors.mjs';
import { relFromWorkspace } from './paths.mjs';
import { startStaticServer } from './static.mjs';

/** First line of an error, so a Playwright stack does not end up in a job error detail. */
const firstLine = (e) => String(e?.message ?? e ?? '').split(/\r?\n/)[0];

/** Requests that never leave the machine; they are not "outside" traffic and are never blocked. */
const LOCAL_SCHEME = /^(?:data|blob|about|filesystem):/i;

/**
 * The browser's own pid, so the runner can kill it on cancel. Playwright dropped `browser.process()`, so the
 * Chromium browser process is asked for its own id over CDP; null when that is not available.
 * @param {import('playwright-core').Browser} browser
 * @returns {Promise<number|null>}
 */
async function browserPid(browser) {
  if (typeof browser.process === 'function') return browser.process()?.pid ?? null;
  try {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const self = (processInfo ?? []).find((p) => p.type === 'browser');
      return Number.isInteger(self?.id) ? self.id : null;
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    return null;
  }
}

/** `window.__motion` probe: what the page says about itself. */
const motionInfo = () => {
  const m = window.__motion ?? {};
  const s = m.size ?? {};
  const ok = Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0;
  return {
    duration: Number.isFinite(m.duration) ? Number(m.duration) : null,
    size: ok ? { width: Math.round(s.width), height: Math.round(s.height) } : null,
  };
};

/**
 * @typedef {object} Capture
 * @property {{width: number, height: number}} size  viewport the pages render at
 * @property {number|null} duration  `window.__motion.duration`, when the page declares one
 * @property {() => Promise<import('playwright-core').Page>} newPage  a fresh context + ready page
 * @property {string[]} pageErrors  pageerror messages, console errors and offline blocks (shared, not unique)
 * @property {Set<string>} loaded  workspace-relative paths the static server actually served
 * @property {() => Promise<void>} close  closes pages, the browser and the static server
 */

/**
 * Start a capture session: static server for the workspace, one headless browser, and a probe page that
 * tells us the size and duration the page wants.
 * @param {object} opts
 * @param {import('../runner/types.mjs').Config} opts.config
 * @param {string} opts.workspace absolute workspace root
 * @param {string} opts.pageAbs absolute path of the page inside the workspace
 * @param {string[]} [opts.inject] absolute paths of HTML fragments to compose into the page
 * @param {Record<string, unknown>} [opts.globals] window globals defined before the page scripts run
 * @param {string} [opts.query] query string appended to the page url (no leading '?')
 * @param {number} [opts.width] explicit width; else `window.__motion.size.width`
 * @param {number} [opts.height] explicit height; else `window.__motion.size.height`
 * @param {number} [opts.deviceScaleFactor] device pixel ratio of the page contexts
 * @param {boolean} [opts.offline] refuse every request whose origin is not the static server
 * @param {number} [opts.readyTimeoutMs] how long a page may take to set `window.__motion.ready`
 * @param {(pid: number) => void} [opts.onPid] called with the browser's pid, for cancel/kill
 * @returns {Promise<Capture>}
 * @throws {ToolError} invalid-input (page outside the workspace, never ready, no size), tool-failed
 */
export async function openCapture({
  config,
  workspace,
  pageAbs,
  inject = [],
  globals = {},
  query = 'render',
  width,
  height,
  deviceScaleFactor = 1,
  offline = false,
  readyTimeoutMs = 60_000,
  onPid = () => {},
}) {
  const pagePath = relFromWorkspace(workspace, pageAbs);
  if (!pagePath || pagePath === '..' || pagePath.startsWith('../')) {
    throw new ToolError('invalid-input', `page is not inside the workspace: ${pagePath || pageAbs}`);
  }
  /** @type {string[]} */
  const pageErrors = [];
  const record = (message) => {
    const text = String(message ?? '').trim();
    if (text) pageErrors.push(text);
  };

  const server = await startStaticServer({
    root: workspace,
    libDirs: config.libDirs,
    compose: { pagePath, inject, globals },
  });
  const origin = server.origin;
  const pageUrl = `${server.pageUrl(pagePath)}${query ? `?${query}` : ''}`;

  let browser;
  try {
    browser = await launchBrowser(config);
  } catch (e) {
    await server.close();
    throw new ToolError('tool-failed', `could not launch a browser: ${firstLine(e)}`);
  }
  const pid = await browserPid(browser);
  if (Number.isInteger(pid)) onPid(pid);

  /** @type {import('playwright-core').BrowserContext[]} */
  const contexts = [];
  let closed = false;

  /** Collect pageerror and console errors for one page. */
  function watch(page) {
    page.on('pageerror', (e) => record(e?.message ?? e));
    page.on('console', (msg) => {
      if (msg.type() === 'error') record(msg.text());
    });
  }

  /** Wait for `window.__motion.ready === true`, then for the fonts the page is still loading. */
  async function waitReady(page, timeoutMs) {
    try {
      await page.waitForFunction(() => window.__motion?.ready === true, null, { timeout: timeoutMs });
    } catch {
      const why = pageErrors.length ? pageErrors.slice(-10).join('; ') : '(no errors reported)';
      throw new ToolError('invalid-input', `page never set window.__motion.ready: ${why}`);
    }
    // Fonts change layout, so a frame taken before they settle is wrong. A page without document.fonts is fine.
    await page
      .evaluate(async () => {
        await document.fonts?.ready;
        return true;
      })
      .catch(() => {});
  }

  /** Navigate to the page and wait until it says it is ready. */
  async function goReady(page) {
    let response = null;
    try {
      response = await page.goto(pageUrl, { waitUntil: 'load' });
    } catch (e) {
      throw new ToolError('tool-failed', `page could not be loaded (${pagePath}): ${firstLine(e)}`);
    }
    if (response && response.status() >= 400) {
      throw new ToolError('invalid-input', `page ${pagePath} is not served: http ${response.status()}`);
    }
    await waitReady(page, readyTimeoutMs);
  }

  let size = null;
  let duration = null;
  let probe = null;
  try {
    const probeContext = await browser.newContext();
    contexts.push(probeContext);
    probe = await probeContext.newPage();
    watch(probe);
    await goReady(probe);
    const info = await probe.evaluate(motionInfo);
    duration = info.duration;
    const w = Number.isFinite(width) ? Math.round(width) : info.size?.width;
    const h = Number.isFinite(height) ? Math.round(height) : info.size?.height;
    if (!(w > 0) || !(h > 0)) {
      throw new ToolError('invalid-input', 'no size: pass width/height or set window.__motion.size');
    }
    size = { width: w, height: h };
  } catch (e) {
    // Nothing has been handed to the caller yet, so nothing else will ever close this session.
    await closeAll();
    throw e;
  } finally {
    await probe?.close().catch(() => {});
  }

  /** A new browser context (own window, own viewport) with a loaded, ready page. */
  async function newPage() {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor,
    });
    contexts.push(context);
    if (offline) {
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (LOCAL_SCHEME.test(url)) return route.continue();
        let sameOrigin = false;
        try {
          sameOrigin = new URL(url).origin === origin;
        } catch {
          sameOrigin = false;
        }
        if (sameOrigin) return route.continue();
        record(`blocked: ${url}`);
        return route.abort('blockedbyclient').catch(() => {});
      });
    }
    const page = await context.newPage();
    watch(page);
    try {
      await goReady(page);
    } catch (e) {
      await context.close().catch(() => {});
      throw e;
    }
    return page;
  }

  /** Close every context, the browser and the static server; safe to call twice. */
  async function closeAll() {
    if (closed) return;
    closed = true;
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  return { size, duration, newPage, pageErrors, loaded: server.loaded, close: closeAll };
}

/**
 * Take the stall out of the first screenshot of a fresh page: seek to 0 and throw away a small JPEG.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<void>}
 * @throws {ToolError} tool-failed
 */
export async function warmUp(page) {
  try {
    await page.evaluate((t) => window.__motion.seek(t), 0);
    await page.screenshot({ type: 'jpeg', quality: 10, timeout: 60_000 });
  } catch (e) {
    throw new ToolError('tool-failed', `page warm-up failed: ${firstLine(e)}`);
  }
}

/**
 * One frame: seek, screenshot; on failure seek again and retry (headless screenshots occasionally stall).
 * @param {import('playwright-core').Page} page
 * @param {number} t time in seconds
 * @param {{type?: 'jpeg'|'png', quality?: number, timeoutMs?: number, retries?: number,
 *   onStall?: (t: number, err: Error) => void}} [opts]
 * @returns {Promise<Buffer>}
 * @throws {ToolError} tool-failed when every attempt failed
 */
export async function frameAt(page, t, { type = 'jpeg', quality = 95, timeoutMs = 15_000, retries = 3, onStall } = {}) {
  const attempts = Number.isFinite(retries) && retries >= 1 ? Math.floor(retries) : 1;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.evaluate((x) => window.__motion.seek(x), t);
      const shot = { type, timeout: timeoutMs };
      if (type === 'jpeg') shot.quality = quality;
      return await page.screenshot(shot);
    } catch (e) {
      last = e;
      if (attempt < attempts) onStall?.(t, e);
    }
  }
  throw new ToolError(
    'tool-failed',
    `frame at ${t.toFixed(3)} s failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${firstLine(last)}`,
  );
}

/**
 * Render `count` frames starting at frame index `first` across `pages`, writing them IN ORDER through
 * `write` (ffmpeg's stdin). Worker w renders frames w, w+pages.length, ...; a ready map plus `next`
 * re-orders the out-of-order results, and `write` resolving is the back-pressure.
 * @param {object} o
 * @param {import('playwright-core').Page[]} o.pages one page per worker
 * @param {number} o.first index of the first frame (t = (first + i) / fps)
 * @param {number} o.count how many frames
 * @param {number} o.fps frames per second
 * @param {(buf: Buffer) => Promise<void>} o.write writes one frame, in order
 * @param {object} [o.frameOpts] passed to frameAt (type, quality, timeoutMs, retries)
 * @param {(fraction: number) => void} [o.onProgress] called every ~fps frames
 * @param {AbortSignal} [o.signal] checked between frames
 * @returns {Promise<{stalls: number}>}
 * @throws {ToolError} canceled, or the first write/frame error
 */
export async function renderFrames({ pages, first, count, fps, write, frameOpts = {}, onProgress, signal }) {
  const workers = Math.max(1, pages.length);
  // Buffered frames waiting for their turn. Bounded, so one slow page cannot make the others hoard frames.
  const highWater = Math.max(4, workers * 2);
  /** @type {Map<number, Buffer>} */
  const ready = new Map();
  let next = 0;
  let written = 0;
  let stalls = 0;
  /** @type {Error|null} */
  let writeError = null;
  /** @type {(() => void)[]} */
  let waiters = [];

  const report = () => {
    const every = Math.max(1, Math.round(fps));
    if (onProgress && written > 0 && written % every === 0) onProgress(written / count);
  };

  /** Let blocked workers look again once the queue has drained. */
  const wake = () => {
    if (ready.size >= highWater || !waiters.length) return;
    const all = waiters;
    waiters = [];
    for (const resolve of all) resolve();
  };
  const waitForRoom = () => new Promise((resolve) => waiters.push(resolve));

  let flushing = Promise.resolve();
  /** Drain every frame that is now at the front of the queue, in order. */
  const flush = () => {
    flushing = flushing
      .then(async () => {
        while (ready.has(next)) {
          const buf = ready.get(next);
          ready.delete(next);
          next += 1;
          await write(buf);
          written += 1;
          report();
          wake();
        }
      })
      .catch((e) => {
        writeError ??= e;
        wake();
      });
    return flushing;
  };

  const worker = async (page, w) => {
    for (let i = w; i < count; i += workers) {
      if (signal?.aborted) throw new ToolError('canceled', 'render canceled');
      if (writeError) throw writeError;
      // The frame at `next` is never held back: whoever can unblock the queue always runs.
      while (i > next && ready.size >= highWater && !writeError && !signal?.aborted) await waitForRoom();
      if (writeError) throw writeError;
      if (signal?.aborted) throw new ToolError('canceled', 'render canceled');
      const t = (first + i) / fps;
      const buf = await frameAt(page, t, {
        ...frameOpts,
        onStall: (at, err) => {
          stalls += 1;
          frameOpts.onStall?.(at, err);
        },
      });
      ready.set(i, buf);
      flush();
    }
  };

  // A cancel while every worker waits for room must wake them, or the render would never settle.
  const onAbort = () => wake();
  signal?.addEventListener('abort', onAbort, { once: true });
  let frameError = null;
  try {
    await Promise.all(
      pages.map((page, w) =>
        worker(page, w).catch((e) => {
          frameError ??= e;
        }),
      ),
    );
    await flushing;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (frameError) throw frameError;
  if (writeError) throw writeError;
  if (signal?.aborted) throw new ToolError('canceled', 'render canceled');
  onProgress?.(1);
  return { stalls };
}
