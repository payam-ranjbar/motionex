// HTTP routes for pins and ref resolution. Thin wrappers over the pin store and refs.resolveRef:
// pinned takes are plain JSON, and /v1/refs/resolve strips the internal absolute path.
import { problem } from '../../lib/problem.mjs';
import { resolveRef } from '../../runner/refs.mjs';

/**
 * Register pin and ref routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{config: import('../../runner/types.mjs').Config, store: object, pins: object}} deps
 */
export function register(router, deps) {
  // Registered before the wildcard so GET /v1/pins is the list route, not a pin named "".
  router.add('GET', '/v1/pins', () => ({
    pins: deps.pins
      .list()
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }));

  router.add('GET', '/v1/pins/*name', (_req, _res, ctx) => {
    const name = ctx.params.name;
    const pin = deps.pins.get(name) ?? null;
    if (ctx.query.get('history') === '1') {
      const history = deps.pins.history(name);
      if (!pin && history.length === 0) throw problem('not-found', `no pin named "${name}"`);
      return { pin, history };
    }
    if (!pin) throw problem('not-found', `no pin named "${name}"`);
    return pin;
  });

  router.add('PUT', '/v1/pins/*name', async (_req, _res, ctx) => {
    const body = await ctx.readJson(deps.config.maxJsonBytes);
    if (!body || typeof body !== 'object' || typeof body.ref !== 'string' || body.ref === '') {
      throw problem('invalid-request', 'body must include a non-empty "ref" string');
    }
    return await deps.pins.set(ctx.params.name, { ref: body.ref, note: body.note ?? null });
  });

  router.add('DELETE', '/v1/pins/*name', async (_req, _res, ctx) => {
    const removed = await deps.pins.remove(ctx.params.name);
    if (!removed) throw problem('not-found', `no pin named "${ctx.params.name}"`);
    return { status: 204, body: null };
  });

  router.add('GET', '/v1/refs/resolve', async (_req, _res, ctx) => {
    const ref = ctx.query.get('ref');
    if (!ref) throw problem('invalid-request', 'missing ?ref query parameter');
    const resolved = await resolveRef(ref, {
      workspace: deps.config.workspace,
      store: deps.store,
      pins: deps.pins,
      blobDir: deps.store.blobDir(),
    });
    const out = {
      ref: resolved.ref,
      kind: resolved.kind,
      path: resolved.path,
      sha256: resolved.sha256,
      bytes: resolved.bytes,
    };
    if ('job' in resolved) out.job = resolved.job;
    if ('output' in resolved) out.output = resolved.output;
    return out;
  });
}
