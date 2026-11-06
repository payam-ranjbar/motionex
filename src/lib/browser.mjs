// Browser for capture. Selection: config.browser.channel (msedge on the Windows host), then
// config.browser.executablePath, otherwise Playwright's bundled chromium headless shell (Docker).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const BASE_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--font-render-hinting=none',
  '--hide-scrollbars',
  '--mute-audio',
];
export const LINUX_ARGS = ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/opt/microsoft/msedge/msedge',
];

/**
 * Is a browser available for capture? Sync and cheap (used by the registry and test gating).
 * @returns {{ok: boolean, mode: 'channel'|'path'|'bundled'|null, reason?: string}}
 */
export function browserAvailable(config) {
  const b = config.browser ?? {};
  if (b.channel) {
    if (b.channel !== 'msedge' || EDGE_PATHS.some((p) => existsSync(p))) return { ok: true, mode: 'channel' };
    return { ok: false, mode: 'channel', reason: 'Microsoft Edge is not installed' };
  }
  if (b.executablePath) {
    return existsSync(b.executablePath)
      ? { ok: true, mode: 'path' }
      : { ok: false, mode: 'path', reason: `no browser at ${b.executablePath}` };
  }
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (dir && existsSync(dir) && readdirSync(dir).some((d) => /^chromium(_headless_shell)?-\d+/.test(d))) {
    return { ok: true, mode: 'bundled' };
  }
  return {
    ok: false,
    mode: null,
    reason: 'no browser: set MX_BROWSER_CHANNEL, MX_BROWSER_PATH, or install the Playwright headless shell',
  };
}

/**
 * Launch a headless browser.
 * @param {import('../runner/types.mjs').Config} config
 * @param {{args?: string[]}} [opts]
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser(config, { args = [] } = {}) {
  const { chromium } = await import('playwright-core');
  const b = config.browser ?? {};
  return chromium.launch({
    headless: true,
    channel: b.channel || undefined,
    executablePath: b.channel ? undefined : b.executablePath || undefined,
    args: [...BASE_ARGS, ...(process.platform === 'linux' ? LINUX_ARGS : []), ...args],
  });
}

export const browserLabel = (config) =>
  config.browser?.channel ??
  (config.browser?.executablePath ? path.basename(config.browser.executablePath) : 'chromium-headless-shell');
