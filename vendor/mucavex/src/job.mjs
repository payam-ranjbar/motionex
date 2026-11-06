// Validate and normalise a render request into an engine job.
import { config } from './config.mjs';
import { ALL_FORMATS } from './encode.mjs';

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export class ValidationError extends Error {
  status = 400;
}

export function parseJob(input) {
  const code = input.code;
  if (typeof code !== 'string' || !code.trim()) throw new ValidationError('`code` is required');
  if (Buffer.byteLength(code) > config.maxCodeBytes) {
    throw new ValidationError(`code is larger than ${config.maxCodeBytes} bytes`);
  }

  const job = {
    code,
    cycles: num(input.cycles),
    seconds: num(input.seconds),
    cps: num(input.cps),
    tail: num(input.tail),
    sampleRate: num(input.sampleRate),
    format: input.format ?? 'wav',
    bitrate: num(input.bitrate),
    analyze: input.analyze === true || input.analyze === 'true' || input.analyze === '1',
  };

  for (const key of ['cycles', 'seconds', 'cps', 'sampleRate']) {
    if (job[key] !== undefined && !(Number.isFinite(job[key]) && job[key] > 0)) {
      throw new ValidationError(`\`${key}\` must be a positive number`);
    }
  }
  if (job.tail !== undefined && !(Number.isFinite(job.tail) && job.tail >= 0 && job.tail <= 30)) {
    throw new ValidationError('`tail` must be between 0 and 30 seconds');
  }
  if (job.sampleRate !== undefined && (job.sampleRate < 8000 || job.sampleRate > 96000)) {
    throw new ValidationError('`sampleRate` must be between 8000 and 96000');
  }
  if (job.format !== 'none' && !ALL_FORMATS.includes(job.format)) {
    throw new ValidationError(`\`format\` must be one of: ${ALL_FORMATS.join(', ')}`);
  }
  if (job.bitrate !== undefined && !(job.bitrate >= 32 && job.bitrate <= 320)) {
    throw new ValidationError('`bitrate` must be between 32 and 320 (kbps)');
  }
  return job;
}
