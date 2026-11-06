import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A fresh empty temp folder. */
export async function mkTmp(prefix = 'mx-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Remove a folder, ignoring errors (Windows may hold locks briefly). */
export async function rmTmp(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
