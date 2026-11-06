import { ToolError } from '../../../../src/lib/errors.mjs';
export default async function run(input) {
  process.stderr.write('fake.fail is about to fail\n');
  if (input.mode === 'throw') throw new Error('boom');
  if (input.mode === 'tool-error') throw new ToolError('invalid-input', 'bad value for x');
  if (input.mode === 'exit') process.exit(3);
  return { result: { ok: 'not a boolean' } };
}
