// Worker thread: owns one engine (superdough state is global, so one job at a time).
import './resolve-hooks.mjs';
import { parentPort } from 'node:worker_threads';

const { render, initEngine } = await import('./engine.mjs');
const { encode } = await import('./encode.mjs');
const { analyze } = await import('./analyze.mjs');

await initEngine();
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async ({ id, job }) => {
  const started = performance.now();
  try {
    const result = await render(job);
    const meta = {
      seconds: result.seconds,
      cps: result.cps,
      events: result.events,
      sampleRate: result.sampleRate,
    };
    const analysis = job.analyze ? analyze(result.channels, result.sampleRate, result) : undefined;

    let audio;
    if (job.format !== 'none') {
      const { bytes, type, ext } = await encode(result.channels, result.sampleRate, job.format, { bitrate: job.bitrate });
      audio = { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type, ext };
    }
    meta.renderMs = Math.round(performance.now() - started);
    parentPort.postMessage({ type: 'done', id, audio, analysis, meta }, audio ? [audio.bytes] : []);
  } catch (err) {
    parentPort.postMessage({ type: 'error', id, error: { name: err?.name, message: err?.message ?? String(err) } });
  }
});
