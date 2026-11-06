# motionex API

Base URL: `MX=${MX_URL:-http://127.0.0.1:8095}`. JSON in and out. Errors are RFC 9457 `application/problem+json`:
`{type: "urn:motionex:problem:<code>", title, status, detail, request_id, errors?: [{field, message}]}`.
`field` is a JSON pointer into what you sent (`/input/lines/0/text`).

## Discover
| Call | Gives |
|---|---|
| `GET /readyz` | 200 when ready (503 with reasons otherwise) |
| `GET /v1` | name, version, links |
| `GET /v1/capabilities` | ffmpeg version, browser, python, **voices**, **presets** per kind, limits, offline flag |
| `GET /v1/tools?brief=1` | every tool: name, title, summary, available, unavailable_reason |
| `GET /v1/tools/{name}` | one tool: `input_schema` (with descriptions and defaults), `output_schema`, `examples`, `preset_names` |
| `GET /v1/skill/references/tools.md` | all tools as readable markdown |

## Jobs
Submit:
```bash
curl -s -X POST "$MX/v1/jobs?wait=120" -H 'content-type: application/json' \
  -H 'Idempotency-Key: teaser-voice-v1' --data @jobs/voice.json
```
- **The body**: `{tool, input, cache?, label?, project?, note?, timeout_s?}`.
  - `cache` is `auto` (the tool's default), `reuse` or `off`.
  - `label`, `project` and `note` are your own tags; filter on them later.
- **`Idempotency-Key` is optional.** Re-sending the same key with the same body returns the same job, with the header `idempotent-replay: true`, so it is safe to retry. The same key with a different body gives a 422.
- **The status code**: 200 when the job is already finished (it ran within `wait`, or came from the cache); 202 otherwise. `Location: /v1/jobs/{id}`.

Follow, cancel, clean up:
| Call | Purpose |
|---|---|
| `GET /v1/jobs/{id}?wait=300` | the job; holds until it finishes (up to 300 s). Use this instead of sleep loops |
| `GET /v1/jobs/{id}/events?after=N&wait=60` | progress, log and state events after seq N (long-poll) |
| `GET /v1/jobs/{id}/log` | the tool's stderr: why it failed, ffmpeg messages, page errors |
| `POST /v1/jobs/{id}/cancel` | cancel; kills its processes, including browsers |
| `GET /v1/jobs?tool=&status=&label=&project=&limit=` | newest first; `full=1` includes inputs |
| `GET /v1/jobs/{id}/outputs/{name}` | download an output (Range supported) |
| `DELETE /v1/jobs/{id}` | delete its output files (refused when pinned) |

A job: `{id, tool, status, progress: {fraction, message}, input, inputs: [{pointer, ref, path, sha256}], result, outputs: [{name, ref, path, sha256, bytes, media_type}], error: {type, title, detail, retryable}, cached_from, created_at, started_at, finished_at}`.

Job error types:
- `invalid-input`: you sent something the tool cannot use; the detail says what.
- `input-unreadable`: a referenced file is missing or broken.
- `tool-failed`: see the log.
- `timeout` and `interrupted`: retryable.
- `canceled`
- `out-of-memory`
- `provider-error`, `rate-limited`, `network`: ElevenLabs.
- `invalid-output`

## Refs
Every file input takes one of:
- `films/a/scene.html`: a workspace path, relative POSIX, no `..`.
- `job:<id>/<output>`: an output of a succeeded job. Outputs can be nested, for example `job:<id>/stems/dialogue.wav`.
- `pin:<name>`, or `pin:<name>#<output>` for a pin of a whole job.
- `GET /v1/refs/resolve?ref=...` returns `{kind, path, sha256, bytes}`.

Small workspace inputs (5 MB or less) are snapshotted into `.mx/blobs/` when a job is submitted, so you can always see exactly what a job used.

## Pins (approved takes and renders)
```bash
curl -s -X PUT $MX/v1/pins/teaser/voice/intro -H 'content-type: application/json' \
  -d '{"ref": "job:job_0193.../intro.wav", "note": "user approved, warmer read"}'
curl -s "$MX/v1/pins/teaser/voice/intro?history=1"   # every earlier target; re-PUT an old ref to roll back
curl -s $MX/v1/pins                                  # all pins
curl -s -X DELETE $MX/v1/pins/teaser/voice/intro
```
- Pin names are lowercase, may contain `/`, and never contain `#`.
- `"ref": "job:<id>"` (no output) pins a whole job; use it later as `pin:<name>#<output>`.

## Files (when you cannot write the workspace folder directly)
| Call | Purpose |
|---|---|
| `PUT /v1/files/{path}` | raw body; `--data-binary @local.file`; 201 `{path, bytes, sha256}` |
| `PUT /v1/files/{path}?from=<ref>` | server-side copy of a ref into the workspace |
| `GET /v1/files/{path}` | download (Range, ETag) |
| `GET /v1/files?prefix=films&recursive=1` | list |
| `DELETE /v1/files/{path}[?recursive=1]` | delete |

`.mx/` is motionex state: it is readable, but you cannot write it through the API.

## Preview in a browser
- `GET /w/{path}` serves workspace files over http, so a human can open `http://127.0.0.1:8095/w/films/a/scene.html`.
- `GET /_mx/lib/motion/runtime.js`, `/_mx/lib/motion/adapters.js` and `/_mx/lib/gsap/gsap.min.js` are the optional libraries. GSAP's plugins are under `/_mx/lib/gsap/`.
- `GET /listen` is the listening room for the human.

## mx CLI
```
mx tools [name] [--json]
mx run <tool> <input.json|-> [--wait[=s]] [--label L] [--project P] [--cache auto|reuse|off] [--key K] [--json]
mx job <id> [--wait] [--json]    mx jobs [--tool T] [--status S]    mx events <id> --follow    mx cancel <id>
mx put <local> <workspace-path>  mx get <path|job:..|pin:..> <local>
mx pin <name> <ref> [--note N]   mx unpin <name>   mx pins [name] [--history]
mx skill install <dir>           mx validate-tools <dir>
```
- The input file holds only the tool INPUT, not the `{tool, input}` envelope.
- Exit codes: 0 succeeded, 1 failed, 2 canceled, 3 still running, 64 usage error, 69 service unreachable.
- `MX_URL` overrides the address.
