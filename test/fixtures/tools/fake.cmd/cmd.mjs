// Command-tool protocol demo in Node (any language works the same way).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const req = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'progress', fraction: 0.1, message: 'starting' });
console.log('a plain stdout line is logged, not parsed');
process.stderr.write('stderr goes to the job log\n');
if (req.input.crash) process.exit(2);
if (req.input.fail) {
  out({ type: 'error', error: { type: 'invalid-input', detail: 'asked to fail', retryable: false } });
  process.exit(1);
}
writeFileSync(path.join(req.out_dir, 'msg.txt'), req.input.message, 'utf8');
out({ type: 'log', message: 'wrote msg.txt' });
out({ type: 'result', result: { message: req.input.message, env_out_dir: process.env.MX_OUT_DIR === req.out_dir } });
