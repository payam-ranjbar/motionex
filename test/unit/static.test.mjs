import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/lib/config.mjs';
import { composeHtml, startStaticServer } from '../../src/lib/static.mjs';
import { createRouter } from '../../src/server/router.mjs';
import { register as registerView } from '../../src/server/routes/view.mjs';
import { writeFixture } from '../helpers/fixtures.mjs';
import { mkTmp, rmTmp } from '../helpers/tmp.mjs';

const PAGES = new URL('../fixtures/pages/', import.meta.url);

const PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>scene</title>',
  '    <script src="/_mx/lib/motion/runtime.js"></script>',
  '  </head>',
  '  <body>',
  '    <!--mx:inject-->',
  '    <main>scene</main>',
  '  </body>',
  '</html>',
  '',
].join('\n');

/** A 1x1 PNG so the asset test has real bytes. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** Start a real HTTP server around a configured router. */
async function serve(configure) {
  const router = createRouter();
  configure(router);
  const server = http.createServer((req, res) => {
    router
      .handle(req, res, { requestId: 'req-static', deps: {} })
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found' }));
      })
      .catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('composeHtml: globals land right after <head>, before any other script', () => {
  const html = '<html><head data-x="1"><script src="a.js"></script></head><body>hi</body></html>';
  const out = composeHtml(html, { globals: { A: { b: 1 }, N: 2 } });
  const afterHead = '<html><head data-x="1">'.length;
  assert.equal(out.slice(0, afterHead), '<html><head data-x="1">');
  assert.equal(out.indexOf('<script>window.A = {"b":1};</script>'), afterHead);
  assert.ok(out.indexOf('<script>window.N = 2;</script>') > out.indexOf('window.A'));
  assert.ok(out.indexOf('window.N') < out.indexOf('src="a.js"'), 'globals come before the page scripts');
  assert.ok(out.endsWith('<body>hi</body></html>'), 'the rest of the page is untouched');

  const noHead = composeHtml('<html><body></body></html>', { globals: { X: true } });
  assert.equal(noHead, '<html><script>window.X = true;</script><body></body></html>');

  const noHtml = composeHtml('plain text', { globals: { Y: [] } });
  assert.equal(noHtml, '<script>window.Y = [];</script>plain text');

  assert.equal(composeHtml('<head></head>', {}), '<head></head>');
});

test('composeHtml: fragments replace the first marker, else land before </body>', () => {
  const marked = composeHtml(PAGE, { inject: ['<p>one</p>', '<p>two</p>'] });
  assert.ok(marked.includes('<!--mx:inject-->') === false);
  assert.ok(marked.includes('<p>one</p>\n<p>two</p>'));
  assert.ok(marked.indexOf('<p>one</p>') < marked.indexOf('<main>scene</main>'));

  const unmarked = composeHtml('<html><body><main>x</main></body></html>', { inject: ['<p>frag</p>'] });
  assert.equal(unmarked, '<html><body><main>x</main><p>frag</p></body></html>');

  const bodyless = composeHtml('<div>x</div>', { inject: ['<p>frag</p>'] });
  assert.equal(bodyless, '<div>x</div><p>frag</p>');

  // only the first marker is replaced: the second one stays for the page to use
  const twice = composeHtml('<body><!--mx:inject--><!--mx:inject--></body>', { inject: ['<b>1</b>'] });
  assert.equal(twice, '<body><b>1</b><!--mx:inject--></body>');
});

test('composeHtml: a </script> inside a global value cannot close the tag', () => {
  const out = composeHtml('<head></head>', { globals: { Evil: { s: '</script><script>alert(1)</script>' } } });
  assert.equal(out.match(/<\/script>/g).length, 1, 'only the wrapper script closes');
  assert.ok(out.includes('<\\/script><script>alert(1)<\\/script>'));
  assert.ok(out.startsWith('<head><script>window.Evil = {"s":"<\\/script>'));
  // non-identifier names cannot be written as window.NAME and are skipped
  assert.equal(composeHtml('<head></head>', { globals: { 'x;alert(1)': 1 } }), '<head></head>');
});

test('startStaticServer: composed page, assets, lib files, confinement, loaded, close', async () => {
  const ws = await mkTmp('mx-static-');
  const config = loadConfig();
  const fragment = path.join(ws, 'films', 'a', 'frag.html');
  let server = null;
  try {
    await writeFixture(ws, 'films/a/scene.html', { text: PAGE });
    await mkdir(path.join(ws, 'films', 'a'), { recursive: true });
    await writeFile(path.join(ws, 'films', 'a', 'img.png'), PNG_1X1);
    await writeFile(fragment, '<p id="frag">fragment</p>', 'utf8');

    server = await startStaticServer({
      root: ws,
      libDirs: config.libDirs,
      compose: { pagePath: 'films/a/scene.html', inject: [fragment], globals: { T: { b: 1 } } },
    });
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(server.pageUrl('films/a/scene.html'), `${server.origin}/w/films/a/scene.html`);

    const page = await fetch(server.pageUrl('films/a/scene.html'));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const body = await page.text();
    assert.ok(body.includes('window.T = {"b":1}'), 'global is injected');
    assert.ok(body.includes('<p id="frag">fragment</p>'), 'fragment is injected');
    assert.ok(!body.includes('<!--mx:inject-->'), 'the marker is consumed');
    assert.ok(body.includes('<main>scene</main>'), 'the page itself survives');

    const head = await fetch(server.pageUrl('films/a/scene.html'), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const img = await fetch(`${server.origin}/w/films/a/img.png`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await img.arrayBuffer()).length, PNG_1X1.length);

    assert.deepEqual(
      [...server.loaded].sort(),
      ['films/a/img.png', 'films/a/scene.html'],
      'loaded holds the served workspace paths',
    );

    for (const bad of [
      '/w/../secret',
      '/w/%2e%2e/secret',
      '/w/films/a/missing.html',
      '/w/',
      '/nope',
      '/_mx/lib/nope/x.js',
      '/_mx/lib/gsap/%2e%2e/%2e%2e/package.json',
    ]) {
      const res = await fetch(`${server.origin}${bad}`);
      assert.equal(res.status, 404, `${bad} must be 404`);
      await res.text();
    }

    const js = await fetch(`${server.origin}/_mx/lib/gsap/gsap.min.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.ok((await js.text()).length > 1000, 'the vendored gsap bundle is served');

    const closed = server;
    server = null;
    await closed.close();
    await assert.rejects(fetch(`${closed.origin}/w/films/a/scene.html`), 'close() stops the server');
    await closed.close(); // idempotent
  } finally {
    if (server) await server.close();
    await rmTmp(ws);
  }
});

test('view routes: workspace streaming, composed globals/inject, lib dirs', async () => {
  const ws = await mkTmp('mx-view-');
  const config = { ...loadConfig(), workspace: ws };
  const s = await serve((router) => registerView(router, { config }));
  try {
    await writeFixture(ws, 'films/a/scene.html', { text: PAGE });
    await writeFixture(ws, 'films/a/t.json', { json: { label: 'hi' } });
    await writeFixture(ws, 'films/a/frag.html', { text: '<p id="frag">fragment</p>' });

    const composed = await fetch(`${s.base}/w/films/a/scene.html?mx_globals=T:films/a/t.json`);
    assert.equal(composed.status, 200);
    assert.equal(composed.headers.get('content-type'), 'text/html; charset=utf-8');
    const composedBody = await composed.text();
    assert.ok(composedBody.includes('window.T = {"label":"hi"}'));
    assert.ok(composedBody.includes('<!--mx:inject-->'), 'no fragment injection without mx_inject');

    const injected = await fetch(`${s.base}/w/films/a/scene.html?mx_inject=films/a/frag.html`);
    assert.equal(injected.status, 200);
    const injectedBody = await injected.text();
    assert.ok(injectedBody.includes('<p id="frag">fragment</p>'));
    assert.ok(!injectedBody.includes('<!--mx:inject-->'));

    const raw = await fetch(`${s.base}/w/films/a/scene.html`);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), PAGE, 'without a query the file is streamed untouched');

    const js = await fetch(`${s.base}/_mx/lib/gsap/gsap.min.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.ok((await js.text()).length > 1000);

    for (const bad of [
      '/w/films/a/missing.png',
      '/w/%2e%2e/x.png',
      '/w/films/a/scene.html?mx_globals=T:films/a/missing.json',
      '/w/films/a/scene.html?mx_globals=nocolon',
      '/_mx/lib/nope/x.js',
      '/_mx/lib/gsap',
    ]) {
      const res = await fetch(`${s.base}${bad}`);
      assert.ok(res.status >= 400 && res.status < 500, `${bad} must be a 4xx, got ${res.status}`);
      await res.text();
    }
  } finally {
    await s.close();
    await rmTmp(ws);
  }
});

test('page fixtures: every page exists and follows the capture contract', async () => {
  const names = ['plain.html', 'gsap.html', 'async-seek.html', 'fonts.html', 'webgl.html'];
  for (const name of names) {
    const text = await readFile(new URL(name, PAGES), 'utf8');
    assert.match(text, /window\.__motion = /, `${name} publishes window.__motion`);
    assert.match(text, /\bready\b/, `${name} has a ready flag`);
    assert.match(text, /\bseek\b/, `${name} has seek(t)`);
    assert.match(text, /\bduration\b/, `${name} declares a duration`);
    assert.match(text, /size: \{ width: \w+, height: \w+ \}/, `${name} declares its size`);
  }

  const plain = await readFile(new URL('plain.html', PAGES), 'utf8');
  assert.match(plain, /const WIDTH = 320;/);
  assert.match(plain, /const HEIGHT = 180;/);
  assert.match(plain, /const DURATION = 2;/);
  assert.match(plain, /document\.body\.style\.background = `rgb\(\$\{k\}, 0, \$\{255 - k\}\)`;/);

  const gsap = await readFile(new URL('gsap.html', PAGES), 'utf8');
  assert.match(gsap, /<script src="\/_mx\/lib\/gsap\/gsap\.min\.js"><\/script>/, 'gsap uses the absolute lib URL');
  assert.match(gsap, /paused: true/);

  const asyncSeek = await readFile(new URL('async-seek.html', PAGES), 'utf8');
  assert.match(asyncSeek, /requestAnimationFrame/);
  assert.match(asyncSeek, /return new Promise/);

  const fonts = await readFile(new URL('fonts.html', PAGES), 'utf8');
  assert.match(fonts, /document\.fonts\.ready/);
  assert.doesNotMatch(fonts, /@font-face/);
  assert.doesNotMatch(fonts, /https?:\/\//);

  const webgl = await readFile(new URL('webgl.html', PAGES), 'utf8');
  assert.match(webgl, /preserveDrawingBuffer: true/);
  assert.match(webgl, /getContext\('webgl2'/);
});
