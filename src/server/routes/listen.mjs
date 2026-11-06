// The listening room: one static page for the HUMAN (agents can't hear). Recent jobs with players,
// A/B comparison (?compare=<ref>,<ref>) and a live, scrubbable page preview synced to audio
// (?page=<workspace .html>&audio=<ref>&timeline=<ref>). It only calls the public API from the same origin.
import { readFile } from 'node:fs/promises';

const PAGE = new URL('../ui/listen.html', import.meta.url);

export function register(router) {
  router.add('GET', '/listen', async () => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: await readFile(PAGE, 'utf8'),
  }));
}
