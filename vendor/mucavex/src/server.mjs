// HTTP API (node:http only, to keep the image small).
//
//   POST /render   body = Strudel code (text/plain, options in the query string)
//                  or application/json {code, cycles?, seconds?, cps?, tail?, sampleRate?, format?, bitrate?}
//                  -> audio in the requested format (default wav)
//   POST /analyze  same input -> JSON loudness/spectrum/structure report (add format=mp3 etc.
//                  to also get the audio back base64-encoded)
//   GET  /formats  -> formats this image can produce
//   GET  /healthz  -> {ok, workers, busy, queued}
import http from 'node:http';
import { config } from './config.mjs';
import { RenderPool } from './pool.mjs';
import { parseJob, ValidationError } from './job.mjs';
import { availableFormats } from './encode.mjs';

const pool = new RenderPool({ size: config.workers, timeoutMs: config.renderTimeoutMs });

const MAX_BODY = config.maxCodeBytes + 4096;
const CORS_BASE = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'x-render-ms, x-duration-seconds, x-cps, x-events, content-disposition',
  vary: 'Origin',
};

// The API executes the submitted code, so a random website must not be able to
// make a visitor's browser submit some. Reject unknown origins outright.
const originAllowed = (origin) =>
  origin === undefined || config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new ValidationError('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...res.cors, 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJob(req, url, defaults) {
  const body = await readBody(req);
  const query = Object.fromEntries(url.searchParams);
  let input;
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      input = { ...defaults, ...query, ...JSON.parse(body) };
    } catch {
      throw new ValidationError('invalid JSON body');
    }
  } else {
    input = { ...defaults, ...query, code: body };
  }
  const job = parseJob(input);
  if (job.format !== 'none' && !availableFormats().includes(job.format)) {
    throw new ValidationError(`format "${job.format}" isn't available in this image (try the "full" build)`);
  }
  return { job, name: String(input.name ?? 'strudel').replace(/[^\w.-]/g, '_') };
}

async function handleRender(req, res, url) {
  const { job, name } = await readJob(req, url, {});
  const { audio, meta } = await pool.render(job);
  res.writeHead(200, {
    ...res.cors,
    'content-type': audio.type,
    'content-length': audio.bytes.length,
    'content-disposition': `attachment; filename="${name}.${audio.ext}"`,
    'x-render-ms': meta.renderMs,
    'x-duration-seconds': meta.seconds.toFixed(3),
    'x-cps': meta.cps,
    'x-events': meta.events,
  });
  res.end(audio.bytes);
}

async function handleAnalyze(req, res, url) {
  const { job } = await readJob(req, url, { format: 'none' });
  job.analyze = true;
  const { audio, analysis, meta } = await pool.render(job);
  sendJson(res, 200, {
    ...meta,
    analysis,
    ...(audio && { audio: { type: audio.type, ext: audio.ext, base64: audio.bytes.toString('base64') } }),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin;
  res.cors = origin && originAllowed(origin) ? { ...CORS_BASE, 'access-control-allow-origin': origin } : CORS_BASE;
  try {
    if (!originAllowed(origin)) {
      res.writeHead(403, { 'content-type': 'application/json', vary: 'Origin' });
      return res.end(JSON.stringify({ error: `origin ${origin} is not allowed (set ALLOWED_ORIGINS)` }));
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, res.cors);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ...pool.stats() });
    if (req.method === 'GET' && url.pathname === '/formats') return sendJson(res, 200, { formats: availableFormats() });
    if (req.method === 'POST' && url.pathname === '/render') return await handleRender(req, res, url);
    if (req.method === 'POST' && url.pathname === '/analyze') return await handleAnalyze(req, res, url);
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[server] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.destroy();
  }
});

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} with ${config.workers} render worker(s); formats: ${availableFormats().join(', ')}`);
});

const shutdown = async () => {
  server.close();
  await pool.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
