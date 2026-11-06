# Vendored Mucavex renderer

- Source: github.com/payam-ranjbar/Mucavex, folder `renderer/`
- Commit: f5452804b9a1645409c83ef562a85911919a8011 (2026-10-14)
- Copied: `src/**`, `test/**`, `examples/**`, `scripts/prune-modules.sh`; upstream `package.json` kept as `package.upstream.json`.
- Licence: AGPL-3.0-or-later (declared in upstream package.json; the upstream repo has no LICENSE file).

## Local changes (only these)
- `src/config.mjs`: `maxPolyphony` default 128 -> 4096 (superdough voice stealing fades drums in long renders),
  `maxSeconds` default 600 -> 1800 (film scores run 3-12 minutes to render).

motionex does not use `server.mjs`, `pool.mjs` or `worker.mjs`; the `music.render` tool imports `engine.mjs`,
`encode.mjs` and `analyze.mjs` in a per-job child process. To re-sync, copy the same folders from a newer commit,
re-apply the two edits above, update this file, and run `node scripts/test.mjs vendor`.
