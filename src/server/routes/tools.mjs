// Tool routes: the catalogue, one tool's manifest, and a reload of the tool folders.
//   GET  /v1/tools?brief=1&invalid=1
//   GET  /v1/tools/:name
//   POST /v1/tools/reload
import { problem } from '../../lib/problem.mjs';

/** Fields dropped by `?brief=1`: the payload is a menu, not the whole schema. */
const BRIEF_OMIT = new Set(['input_schema', 'output_schema', 'examples', 'description']);

/** True for `?flag=1` (and true/yes/on); false when absent, empty, 0 or false. */
function flag(value) {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** A tool entry without its schemas and examples. */
function brief(info) {
  return Object.fromEntries(Object.entries(info ?? {}).filter(([key]) => !BRIEF_OMIT.has(key)));
}

/**
 * Register the tool routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{registry: object}} deps
 */
export function register(router, deps) {
  router.add('GET', '/v1/tools', (_req, _res, ctx) => {
    const isBrief = flag(ctx.query.get('brief'));
    const tools = deps.registry.list().map((info) => (isBrief ? brief(info) : info));
    const body = { tools };
    if (flag(ctx.query.get('invalid'))) body.invalid = deps.registry.invalid();
    return body;
  });

  router.add('GET', '/v1/tools/:name', (_req, _res, ctx) => {
    const name = ctx.params.name;
    const info = deps.registry.info(name);
    if (!info) throw problem('unknown-tool', `no tool named ${JSON.stringify(name)}`);
    return info;
  });

  router.add('POST', '/v1/tools/reload', async () => await deps.registry.reload());
}
