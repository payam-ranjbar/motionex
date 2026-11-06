// Startup and shutdown of the motionex service: state dirs, the job store lock, registry, pins, executor,
// scheduler, job service, HTTP server, graceful drain. `bin/mx.mjs serve` calls serve().

import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../lib/config.mjs';
import { loadRegistry } from '../registry/registry.mjs';
import { createExecutor } from '../runner/execute.mjs';
import { createPinStore } from '../runner/pins.mjs';
import { Scheduler } from '../runner/scheduler.mjs';
import { createJobService } from '../runner/service.mjs';
import { JobStore } from '../runner/store.mjs';
import { createApp } from './app.mjs';

/** Exit code for "another motionex already owns this state dir" (EX_CONFIG, sysexits.h). */
const EXIT_LOCKED = 78;

/**
 * Start the service.
 * @param {Readonly<import('../runner/types.mjs').Config>} [config]
 * @param {{listen?: boolean}} [opts] `listen: false` builds everything but binds no socket (tests, tooling)
 * @returns {Promise<{server: import('node:http').Server, port: number,
 *   deps: {config: object, store: JobStore, registry: object, pins: object, service: object,
 *     ready: () => {ready: boolean, reasons: string[]}}, close: () => Promise<void>}>}
 */
export async function serve(config = loadConfig(), { listen = true } = {}) {
  await mkdir(config.workspace, { recursive: true });
  await mkdir(config.stateDir, { recursive: true });
  await mkdir(config.scratchDir, { recursive: true });

  const store = new JobStore({ stateDir: config.stateDir, workspace: config.workspace });
  /** @type {string[]} */
  let queued;
  try {
    queued = await store.open();
  } catch (err) {
    if (err?.code !== 'ELOCKED') throw err;
    if (!listen) throw err;
    process.stderr.write(`another motionex is using ${config.stateDir}\n`);
    process.exit(EXIT_LOCKED);
  }

  /** @type {{ready: boolean, reasons: string[]}} */
  let state = { ready: false, reasons: ['startup in progress'] };
  const ready = () => state;

  /** @type {any} */
  const deps = { config, store, ready };
  try {
    const registry = await loadRegistry({ config });
    for (const bad of registry.invalid()) {
      process.stderr.write(`warning: tool folder ${bad.dir} is not usable: ${bad.errors.join('; ')}\n`);
    }
    const pins = createPinStore({
      stateDir: config.stateDir,
      workspace: config.workspace,
      store,
      blobDir: store.blobDir(),
    });
    await pins.open();
    const executor = createExecutor({ config });
    const scheduler = new Scheduler({
      totalSlots: config.cpuSlots,
      limits: config.limits,
      maxQueued: config.maxQueued,
    });
    const service = createJobService({ config, registry, store, pins, executor, scheduler });

    service.recover(queued);

    Object.assign(deps, { registry, pins, executor, scheduler, service });
    state = { ready: true, reasons: [] };
  } catch (err) {
    // A half-built service must not keep the single-writer lock or a listening socket alive.
    await store.close().catch(() => {});
    throw err;
  }

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  let requestHandler;
  try {
    requestHandler = await createApp(deps);
  } catch (err) {
    // A broken pipeline (e.g. an unreadable API token file) must not keep the single-writer lock.
    await store.close().catch(() => {});
    throw err;
  }
  const server = http.createServer(requestHandler);
  server.requestTimeout = 0; // long polls and big uploads are legitimate

  /** @type {Map<string, () => void>} signal handlers installed by this serve() call */
  const signalHandlers = new Map();

  let closing = null;
  /** Graceful shutdown: stop accepting, cancel running jobs, release the store lock, close the socket. */
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      await deps.service.drain();
      server.closeAllConnections?.();
      await closed.catch(() => {});
      await store.close();
      for (const [signal, onSignal] of signalHandlers) process.off(signal, onSignal);
      signalHandlers.clear();
    })();
    return closing;
  };

  let port = config.port;
  if (listen) {
    port = await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.off('error', onError);
        const listed = server.address();
        resolve(typeof listed === 'object' && listed ? listed.port : config.port);
      });
    });

    process.stdout.write(
      `motionex ${config.version} listening on http://${config.host}:${port} ` +
        `(workspace ${config.workspace}, ${deps.registry.list().length} tools)\n`,
    );

    for (const signal of ['SIGTERM', 'SIGINT']) {
      const onSignal = () => {
        close()
          .catch(() => {})
          .then(() => process.exit(0));
      };
      signalHandlers.set(signal, onSignal);
      process.on(signal, onSignal);
    }
  }

  return { server, port, deps, close };
}
