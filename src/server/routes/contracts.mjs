// Contract routes: the provider contracts (contracts/<name>.json) and which tools implement them.
//   GET /v1/contracts           every contract with its providers (?brief=1 drops the schemas and examples)
//   GET /v1/contracts/:name     one contract: schemas, examples, providers and whether each can run here
// A job names a contract like a tool: {"tool": "voice.speak", "input": {"provider": "piper", ...}}.
import { problem } from '../../lib/problem.mjs';

const BRIEF_OMIT = new Set(['input_schema', 'output_schema', 'examples', 'description']);

/** True for `?flag=1` (and true/yes/on). */
function flag(value) {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Register the contract routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{registry: object}} deps
 */
export function register(router, deps) {
  router.add('GET', '/v1/contracts', (_req, _res, ctx) => {
    const brief = flag(ctx.query.get('brief'));
    const contracts = (deps.registry.listContracts?.() ?? []).map((c) =>
      brief ? Object.fromEntries(Object.entries(c).filter(([key]) => !BRIEF_OMIT.has(key))) : c,
    );
    return { contracts };
  });

  router.add('GET', '/v1/contracts/:name', (_req, _res, ctx) => {
    const info = deps.registry.contractInfo?.(ctx.params.name);
    if (!info) throw problem('not-found', `no contract named ${JSON.stringify(ctx.params.name)}`);
    return info;
  });
}
