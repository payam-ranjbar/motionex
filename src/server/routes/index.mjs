// GET /v1: the service's front door, a plain map of what it is and where to go next.
// GET / redirects there so a human pointing a browser at the root lands somewhere useful.

/**
 * Register the index routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{config: Readonly<import('../../runner/types.mjs').Config>}} deps
 */
export function register(router, deps) {
  router.add('GET', '/', () => ({ status: 302, headers: { Location: '/v1' }, body: null }));

  router.add('GET', '/v1', () => ({
    name: 'motionex',
    version: deps.config.version,
    workspace: deps.config.workspace,
    links: {
      tools: '/v1/tools',
      jobs: '/v1/jobs',
      files: '/v1/files',
      pins: '/v1/pins',
      capabilities: '/v1/capabilities',
      skill: '/v1/skill',
      listen: '/listen',
    },
  }));
}
