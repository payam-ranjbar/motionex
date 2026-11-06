#!/usr/bin/env node
// Render a Strudel file without the HTTP server.
//   mucavex <file.strudel|-> [-o out.mp3] [--format mp3] [--cycles 8 | --seconds 30] [--cps 0.5]
//           [--tail 2] [--sample-rate 48000] [--bitrate 192] [--analyze]
import './resolve-hooks.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    format: { type: 'string', short: 'f' },
    cycles: { type: 'string' },
    seconds: { type: 'string' },
    cps: { type: 'string' },
    tail: { type: 'string' },
    'sample-rate': { type: 'string' },
    bitrate: { type: 'string' },
    analyze: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(
    'usage: mucavex <file.strudel|-> [-o out.wav] [-f wav|wav32|mp3|flac|ogg|opus|m4a] [--cycles N | --seconds S]\n' +
      '               [--cps X] [--tail S] [--sample-rate HZ] [--bitrate KBPS] [--analyze]',
  );
  process.exit(values.help ? 0 : 1);
}

const { parseJob } = await import('./job.mjs');
const { render } = await import('./engine.mjs');
const { encode } = await import('./encode.mjs');
const { analyze } = await import('./analyze.mjs');

const [file] = positionals;
const code = file === '-' ? await readStdin() : await readFile(file, 'utf8');
const outExt = values.out?.match(/\.(\w+)$/)?.[1];
const job = parseJob({
  code,
  cycles: values.cycles,
  seconds: values.seconds,
  cps: values.cps,
  tail: values.tail,
  sampleRate: values['sample-rate'],
  bitrate: values.bitrate,
  format: values.format ?? (outExt && outExt !== 'wav' ? outExt : 'wav'),
});

const started = performance.now();
const result = await render(job);
const { bytes, ext } = await encode(result.channels, result.sampleRate, job.format, { bitrate: job.bitrate });
const out = values.out ?? (file === '-' ? `out.${ext}` : file.replace(/\.[^./\\]+$/, '') + `.${ext}`);
await writeFile(out, bytes);
console.error(
  `wrote ${out}: ${result.seconds.toFixed(2)}s @ ${result.cps} cps, ${result.events} events, ` +
    `${Math.round(performance.now() - started)} ms`,
);
if (values.analyze) console.log(JSON.stringify(analyze(result.channels, result.sampleRate, result), null, 2));
process.exit(0);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
