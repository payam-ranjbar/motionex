import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
export default async function run(input, ctx) {
  ctx.progress(0.5, 'echoing');
  if (input.delay_ms) await sleep(input.delay_ms, null, { signal: ctx.signal });
  const result = { message: input.message };
  if (input.file) result.file_bytes = (await stat(input.file)).size;
  await writeFile(path.join(ctx.outDir, 'echo.json'), JSON.stringify(result));
  return { result };
}
