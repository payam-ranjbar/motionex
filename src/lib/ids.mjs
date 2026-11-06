import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/** A time-sortable UUIDv7 as 32 hex chars (monotonic within a process). */
export function uuidv7Hex() {
  let ms = Date.now();
  if (ms <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    ms = lastMs;
  } else {
    lastMs = ms;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  return b.toString('hex');
}

/** "job_<32 hex>" */
export function newJobId() {
  return `job_${uuidv7Hex()}`;
}

export const JOB_ID = /^job_[0-9a-f]{32}$/;
