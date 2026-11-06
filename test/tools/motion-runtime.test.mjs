// Tests for the optional browser motion runtime (lib/browser/motion/runtime.js + adapters.js).
// Serves test pages and the real assets from a tiny http server, drives a headless browser (Edge on this host).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../src/lib/browser.mjs';
import { loadConfig } from '../../src/lib/config.mjs';
import { needs } from '../helpers/needs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// path -> [absolute file, content-type]
const ASSETS = {
  '/gsap.min.js': [path.join(ROOT, 'node_modules', 'gsap', 'dist', 'gsap.min.js'), 'text/javascript'],
  '/runtime.js': [path.join(ROOT, 'lib', 'browser', 'motion', 'runtime.js'), 'text/javascript'],
  '/adapters.js': [path.join(ROOT, 'lib', 'browser', 'motion', 'adapters.js'), 'text/javascript'],
};

const pages = new Map();

let server;
let base;

before(async () => {
  server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    try {
      if (pages.has(p)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pages.get(p));
        return;
      }
      const asset = ASSETS[p];
      if (asset) {
        res.writeHead(200, { 'content-type': asset[1] });
        res.end(await readFile(asset[0]));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

/** Launch a fresh browser on a page served at a unique path; caller closes the browser. */
async function open(name, html) {
  const file = `/${name}.html`;
  pages.set(file, html);
  const browser = await launchBrowser(loadConfig());
  try {
    const page = await browser.newPage();
    await page.goto(`${base}${file}`, { waitUntil: 'load' });
    return { browser, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

const RUNTIME_HEAD = `<script src="/gsap.min.js"></script>
<script>window.TIMELINE = { total: 3, beatOffset: 0, scenes: [
  { id: 'a', start: 0, dur: 1.5, cues: [] },
  { id: 'b', start: 1.5, dur: 1.5, cues: [] }
] };</script>
<script src="/runtime.js"></script>`;

test('runtime: out-of-order seeks are exact and hideOutside hides other scenes', needs('chromium'), async () => {
  const { browser, page } = await open(
    'runtime-seek',
    `<!doctype html><html><head>${RUNTIME_HEAD}</head><body>
    <div id="stage" style="position:relative;width:400px;height:300px">
      <section data-scene="a" style="position:absolute;inset:0">
        <div id="box-a" style="width:100px;height:100px;background:red"></div>
      </section>
      <section data-scene="b" style="position:absolute;inset:0">
        <div id="box" style="width:100px;height:100px;background:blue"></div>
      </section>
    </div>
    <script>
      Motion.scene('b', (tl, el) => {
        tl.fromTo(el.querySelector('#box'), { opacity: 0 }, { opacity: 1, duration: 1, ease: 'none' }, 0);
      });
    </script>
    </body></html>`,
  );
  try {
    await page.waitForFunction(() => window.__motion?.ready === true);
    const out = await page.evaluate(() => {
      const box = document.getElementById('box');
      const a = document.querySelector('[data-scene="a"]');
      const opacity = () => Number.parseFloat(getComputedStyle(box).opacity);
      const result = {};
      window.__motion.seek(2.0);
      result.at20 = opacity();
      window.__motion.seek(0.2);
      result.at02 = opacity();
      window.__motion.seek(2.5);
      result.at25 = opacity();
      window.__motion.seek(2.0);
      result.aAt20 = Number.parseFloat(getComputedStyle(a).opacity);
      result.duration = window.__motion.duration;
      result.size = window.__motion.size;
      return result;
    });
    assert.ok(Math.abs(out.at20 - 0.5) <= 0.05, `b opacity at 2.0: ${out.at20}`);
    assert.ok(out.at02 <= 0.05, `b opacity at 0.2: ${out.at02}`);
    assert.ok(Math.abs(out.at25 - 1) <= 0.05, `b opacity at 2.5: ${out.at25}`);
    assert.ok(out.aAt20 <= 0.05, `scene a opacity at 2.0: ${out.aAt20}`);
    assert.equal(out.duration, 3);
    assert.deepEqual(out.size, { width: 400, height: 300 });
  } finally {
    await browser.close();
  }
});

test('runtime: Motion.config({ hideOutside: false }) keeps scenes visible', needs('chromium'), async () => {
  const { browser, page } = await open(
    'runtime-config',
    `<!doctype html><html><head>${RUNTIME_HEAD}</head><body>
    <div id="stage" style="position:relative;width:400px;height:300px">
      <section data-scene="a" style="position:absolute;inset:0"><div id="box-a"></div></section>
      <section data-scene="b" style="position:absolute;inset:0"><div id="box-b"></div></section>
    </div>
    <script>
      Motion.config({ hideOutside: false });
      Motion.scene('a', () => {});
      Motion.scene('b', () => {});
    </script>
    </body></html>`,
  );
  try {
    await page.waitForFunction(() => window.__motion?.ready === true);
    const opacity = await page.evaluate(() => {
      window.__motion.seek(2.0); // scene a's window is 0..1.5
      return Number.parseFloat(getComputedStyle(document.querySelector('[data-scene="a"]')).opacity);
    });
    assert.equal(opacity, 1);
  } finally {
    await browser.close();
  }
});

test('runtime: pulse is 0 when the timeline has no bpm', needs('chromium'), async () => {
  const { browser, page } = await open(
    'runtime-pulse',
    `<!doctype html><html><head>
    <script src="/gsap.min.js"></script>
    <script>window.TIMELINE = { total: 1, scenes: [{ id: 'a', start: 0, dur: 1, cues: [] }] };</script>
    <script src="/runtime.js"></script>
    </head><body>
    <div id="stage" style="width:100px;height:100px"><section data-scene="a"></section></div>
    <script>Motion.scene('a', () => {});</script>
    </body></html>`,
  );
  try {
    await page.waitForFunction(() => window.__motion?.ready === true);
    assert.equal(await page.evaluate(() => window.Motion.pulse(1)), 0);
    assert.equal(await page.evaluate(() => window.Motion.pulse(0)), 0);
  } finally {
    await browser.close();
  }
});

test('runtime: Motion.random(seed) is deterministic', needs('chromium'), async () => {
  const { browser, page } = await open(
    'runtime-random',
    `<!doctype html><html><head>
    <script src="/gsap.min.js"></script>
    <script>window.TIMELINE = { total: 1, scenes: [{ id: 'a', start: 0, dur: 1, cues: [] }] };</script>
    <script src="/runtime.js"></script>
    </head><body>
    <div id="stage" style="width:100px;height:100px"><section data-scene="a"></section></div>
    <script>Motion.scene('a', () => {});</script>
    </body></html>`,
  );
  try {
    await page.waitForFunction(() => window.__motion?.ready === true);
    const out = await page.evaluate(() => {
      const first = window.Motion.random(5);
      const a = [first(), first(), first()];
      const second = window.Motion.random(5);
      const b = [second(), second(), second()];
      return { a, b };
    });
    assert.equal(out.a.length, 3);
    assert.deepEqual(out.a, out.b);
  } finally {
    await browser.close();
  }
});

test('adapters: waapi seeks a paused CSS animation', needs('chromium'), async () => {
  const { browser, page } = await open(
    'adapters-waapi',
    `<!doctype html><html><head>
    <style>
      @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
      #box { width: 100px; height: 100px; background: red; animation: fade 2s linear both; animation-play-state: paused; }
    </style>
    <script src="/adapters.js"></script>
    </head><body>
    <div id="box"></div>
    <script>window.MotionAdapters.waapi({ duration: 2, size: { width: 100, height: 100 } });</script>
    </body></html>`,
  );
  try {
    await page.waitForFunction(() => window.__motion?.ready === true);
    const opacity = await page.evaluate(() => {
      window.__motion.seek(1);
      return Number.parseFloat(getComputedStyle(document.getElementById('box')).opacity);
    });
    assert.ok(Math.abs(opacity - 0.5) <= 0.05, `waapi opacity at 1: ${opacity}`);
  } finally {
    await browser.close();
  }
});

test('adapters: fromFunction passes the seek time to draw', needs('chromium'), async () => {
  const { browser, page } = await open(
    'adapters-from-function',
    `<!doctype html><html><head><script src="/adapters.js"></script></head><body>
    <script>
      window.__calls = [];
      window.MotionAdapters.fromFunction((t) => { window.__calls.push(t); }, { duration: 2 });
    </script>
    </body></html>`,
  );
  try {
    await page.waitForFunction(() => window.__motion?.ready === true);
    const calls = await page.evaluate(() => {
      window.__motion.seek(0.7);
      return window.__calls;
    });
    assert.deepEqual(calls, [0.7]);
  } finally {
    await browser.close();
  }
});
