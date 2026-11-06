// GET /livez  -> {ok: true}: the process answers HTTP at all (no dependencies checked).
// GET /readyz -> {ready: true} 200, or {ready: false, reasons} 503 while the service is still starting up.
// Both are exempt from the Bearer token so container probes work without a secret.

/**
 * Register the health routes.
 * @param {{add: (method: string, pattern: string, handler: Function) => void}} router
 * @param {{ready?: () => {ready: boolean, reasons: string[]}}} [deps]
 */
export function register(router, deps) {
  const ready = () => deps?.ready?.() ?? { ready: true, reasons: [] };

  router.add('GET', '/livez', () => ({ ok: true }));
  router.add('GET', '/health', () => ({ ok: true })); // alias: agents often guess /health first

  router.add('GET', '/readyz', () => {
    const state = ready();
    if (state?.ready) return { ready: true };
    return { status: 503, body: { ready: false, reasons: state?.reasons ?? ['not ready'] } };
  });
}
