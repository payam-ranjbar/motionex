# motionex: agent guide (read all of it before you change anything)

motionex is ONE service (one Docker image) that gives AI agents bare tools to make motion-graphics videos:
voice (Piper TTS, optional ElevenLabs), picture (capture any HTML page that exposes `window.__motion` to video),
music (Strudel songs rendered by the vendored Mucavex engine), SFX synthesis, a mixer, loudness/analysis, and encoding.
Agents drive it over HTTP (`/v1/jobs`, curl-friendly) or the `mx` CLI. Every tool is a folder under `tools/`.

**Design rule above all: do not enforce.** Tools are primitives. Every opinion (ducking, loudness target, snapping,
fps, size, codec) is an explicit parameter or a named preset. Defaults are NEUTRAL: no ducking, no normalisation, no
limiter, no required voice/BPM/song/size, nothing snapped. A mixer with no options is a plain sum.

## 1. Ground rules for coding agents
- Edit/create ONLY the files your prompt lists. If you need a change elsewhere, say so in your Result instead.
- NEVER run `npm install`, `npm ci`, `pip install` or anything that downloads. No network. Add no dependencies.
- NEVER edit: `package.json`, `package-lock.json`, `AGENTS.md`, `biome.json`, `src/lib/{errors,problem,paths,config,hash,ids,canonical-json,media-types,wav,ffmpeg,audio-io,signal,presets,browser}.mjs`,
  `src/registry/*`, `src/runner/{types,context,protocol,node-host}.mjs`, `test/helpers/*`, `scripts/test.mjs`, `vendor/**`.
  These are shared contracts (owner: orchestrator).
- A file marked `// STUB (owner: X)` is yours only if your prompt names it; replace the bodies, keep the exported names and signatures.
- Do not commit. Do not touch git. Finish with the `## Result` section your prompt asks for.
- Windows + Git Bash: write multi-line scripts to files instead of heredocs/`node -e` with nested quotes.

## 2. Environment and commands
Host: Windows 11, Git Bash, Node 24, Python 3.12. The orchestrator sets these env vars for you (do not change them):
`FFMPEG_PATH`, `FFPROBE_PATH` (ffmpeg 6.0 on the host; 7.1 in Docker), `MX_PYTHON` (venv with piper-tts 1.8.0),
`MX_VOICES_DIRS` (Piper voices en_US-{norman,john,kristin,joe}-medium), `MX_BROWSER_CHANNEL=msedge` (headless Edge via
playwright-core), `MX_SAMPLE_CACHE_DIR` (warm Strudel sample cache), `MX_REQUIRE` (features your tests must really exercise).
```
node scripts/test.mjs file test/tools/my.test.mjs     # run specific test files (with the warnings guard)
node scripts/test.mjs unit|tools|contract [tool...]|integration|vendor
npx biome check <your files>                           # lint + format check (npx biome check --write <files> to fix)
```

## 3. Code conventions
- ESM `.mjs`, `node:` imports, 2-space indent, single quotes, semicolons, line width 120 (Biome). JSDoc types on exports.
- Errors inside tools: `throw new ToolError(type, detail)` from `src/lib/errors.mjs` (types in §8). Never put secrets in a detail.
- API errors: `throw problem(code, detail, extras)` from `src/lib/problem.mjs` (codes in §8).
- Paths from agents are workspace-relative POSIX; resolve only through `src/lib/paths.mjs`.
- Run ffmpeg/ffprobe ONLY via `runFfmpeg`/`runFfprobe` (`src/lib/ffmpeg.mjs`). Check every agent-supplied filter string with
  `checkChain()` before use. Always pass `signal`.
- Audio in memory is `{sampleRate, channels: Float32Array[]}` (planar, -1..1). Use `src/lib/wav.mjs`, `audio-io.mjs`, `signal.mjs`.
- Tools write ONLY into `ctx.outDir` (outputs) and `ctx.scratchDir` (temp). Never into the workspace. Honour `ctx.signal`.

## 4. The tool contract
A tool is a folder `tools/<name>/` with `tool.json` and code. Name = folder = `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`.
**Template: `tools/audio.loudness/`** (copy its shape). Manifest schema: `src/registry/manifest.schema.json`.

`tool.json` fields: `name, version (semver), title, summary (<=300 chars), description?, kind ("node"|"command"),
handler ("handler.mjs", node) | command (["${MX_PYTHON}", "worker.py"], command; vars MX_PYTHON MX_NODE TOOL_DIR),
deterministic, cache_default ("auto" requires deterministic:true | "reuse" | "off"), resources {class, slots?, memory_mb?},
timeout_s (0 = none), presets? (preset kind folder under presets/), requires? {binaries: [ffmpeg|ffprobe|chromium|python], secrets: [...]},
input_schema, output_schema?, examples (>=1: {title, input, fixtures?, run?})`.
Resource classes: `light` (slots 0), `audio`, `voice`, `music`, `capture`, `encode`, `elevenlabs`. `slots` may be
`{"from_input": "workers", "default": 4}`.

### input_schema rules (Ajv 2020, strict schema, useDefaults, allowUnionTypes)
- Top level: `{"type":"object","additionalProperties":false,...}`. EVERY property (at every level) has a `description`.
- Nested objects also use `additionalProperties:false`.
- Refs (files): `{"type":"string","x-mx-ref":true,"description":"..."}`. A ref is a workspace path (`films/a/x.wav`),
  `job:<id>/<output-path>`, `pin:<name>`, or `pin:<name>#<output-path>`. The runner resolves refs to ABSOLUTE paths before
  your handler runs (`ctx.rawInput` keeps the strings). Never put `x-mx-ref` inside `oneOf`/`anyOf`.
- NEVER put `default` inside `oneOf`/`anyOf`/`not`/`if`. Patterns:
  - "exactly one of these keys" -> one object schema listing every key in `properties` + `"minProperties":1,"maxProperties":1`.
  - "field a OR field b" -> top level `"oneOf":[{"required":["a"]},{"required":["b"]}]` (branches contain ONLY `required`).
- Defaults go on the property (`"default": 30`). Leave a field without default when "absent" means "do nothing".
- Tools with `"presets": "<kind>"` declare `"preset": {"type":"string","description":"..."}`; the registry deep-merges
  `presets/<kind>/<name>.json` UNDER the request (request wins; arrays/scalars replace) before validation and defaults.
- `examples[].fixtures`: `{ "<workspace path>": FixtureSpec }` (see `test/helpers/fixtures.mjs`: sine, noise, silence,
  concat, text, json, copy). The contract test RUNS every example with fixtures (unless `"run": false`).

### Node handler (`kind: "node"`), runs in its own child process (`src/runner/node-host.mjs`)
```js
export default async function run(input, ctx) { ... return { result, outputs }; }
// input: validated, presets merged, defaults applied, every x-mx-ref replaced by an absolute path
// ctx: { job:{id,tool,tool_version}, rawInput, workspace, outDir, scratchDir, toolDir, blobDir, signal: AbortSignal, config,
//        progress(fraction 0..1|null, message?), log(message), secret(name) -> Promise<string|null>,
//        trackProcess(pid)  // report a child process group (e.g. a browser) so cancel can kill it
//        snapshot(absPath) -> Promise<{sha256, blob}>, ffmpeg:{path, probePath, run}, lib:{wav,audioIo,signal,ffmpeg,loudness,timespec,paths,errors} }
// return: { result: object matching output_schema, outputs?: [{name, media_type?}] }  (outputs default: every file in outDir)
// errors: throw new ToolError(type, detail). Any other throw -> 'tool-failed'.
```
Import shared code by relative path from the tool folder, e.g. `import { decodeAudio } from '../../src/lib/audio-io.mjs';`.
Output file names are relative POSIX paths of `[\w.-]` segments (`mix.wav`, `stems/dialogue.wav`).

### Command tools (`kind: "command"`), any language, JSONL protocol (`src/runner/protocol.mjs`)
The runner writes `request.json` (`{job_id, tool, input (resolved), raw_input, out_dir, scratch_dir, workspace, tool_dir,
secrets_dir, config}`) and runs `command + [requestPath]` with cwd = tool folder and env `MX_REQUEST, MX_OUT_DIR,
MX_SCRATCH_DIR, PYTHONIOENCODING=utf-8, PYTHONUTF8=1, PYTHONUNBUFFERED=1`. Stdout = one JSON object per line:
`{"type":"progress","fraction":0.5,"message":"..."}`, `{"type":"log","message":"..."}`, `{"type":"pid","pid":123}`,
then exactly one `{"type":"result","result":{...},"outputs":[...]}` or `{"type":"error","error":{"type":"invalid-input","detail":"..."}}`.
Non-JSON stdout lines and stderr go to the job log. Exit 0 + result = success; otherwise `tool-failed`. Example: `test/fixtures/tools/fake.cmd`.

## 5. Shared modules you may import (signatures; read the files for details)
- `src/lib/errors.mjs`: `ToolError(type, detail, {retryable})`, `JOB_ERROR_TYPES`, `toJobError(err)`.
- `src/lib/problem.mjs`: `problem(code, detail, extras)`, `Problem`, `problemBody(p, requestId)`, `PROBLEMS`.
- `src/lib/paths.mjs`: `toWorkspacePath(ws, rel)`, `resolveWorkspacePath(ws, rel)` (async, symlink-safe), `relFromWorkspace(ws, abs)`,
  `isReserved(rel)`, `isSafeName(n)`/`safeName(n)`, `isSafeOutputPath(p)`/`safeOutputPath(p)`.
- `src/lib/config.mjs`: `loadConfig(env)` -> frozen Config (fields in `src/runner/types.mjs`), `APP_ROOT`.
- `src/lib/hash.mjs`: `sha256(data)`, `sha256File(abs)` (memoised), `sha256Dir(dir)`. `ids.mjs`: `newJobId()`, `JOB_ID`.
  `canonical-json.mjs`: `canonical(value)`. `media-types.mjs`: `mediaTypeOf(name)`.
- `src/lib/wav.mjs`: `readWav(buf)`, `encodeWav(audio, {format:'s16'|'s24'|'f32'})`, `framesOf`, `secondsOf`.
- `src/lib/ffmpeg.mjs`: `ffmpegPath()`, `ffprobePath()`, `runFfmpeg(args, {signal, cwd, input, stdout:'buffer'|'ignore', onStderrLine})`
  -> `{stdout, stderr}`, `runFfprobe`, `ffmpegInfo()` -> `{version, major, filters:Set, encoders:Set}`, `parseDuration(stderr)`,
  `atempoChain(k)`, `checkChain(chain, what)`, `videoArgs(v)`, `colorArgs('bt709')`.
- `src/lib/audio-io.mjs`: `decodeAudio(file, {sampleRate=48000|null, channels=2|null, filter, start_s, duration_s, signal})`
  (trim source -> filter -> resample), `filterAudio(audio, chain, {signal, sampleRate, channels})`, `writeAudio(file, audio, {format:'wav'|'wav24'|'wav32f'|'flac'|'mp3', bitrate_k})`.
- `src/lib/signal.mjs`: `db(x)`, `fromDb(d)`, `peak(audio)`, `rmsDb(ch, from, to)`, `mono(audio)`, `speechEnd(audio, {threshold_db=-40, tail_s=0.03})`,
  `fitLength(audio, n)`, `mulberry32(seed)`.
- `src/lib/loudness.mjs`: `ebur128(file)`, `measureAudio(audio)`, `parseEbur128Summary(stderr)`, `kWeight(audio)`, `integratedLufs(audio)`,
  `windowLufs(kw, sr, from_s, to_s)`, `loudnessCurve(audio, {window_s, step_s})`.
- `src/lib/timespec.mjs`: `parseTimespec(spec)`, `resolveTime(spec, timeline, what)`.
- `src/lib/presets.mjs`: `listPresets(kind, dirs)`, `loadPreset(kind, name, dirs)`, `deepMerge(base, over)`.
- `src/lib/browser.mjs`: `launchBrowser(config, {args})`, `browserAvailable(config)`.
- `src/registry/registry.mjs`: `loadRegistry({dirs?, config})` -> `{list(), get(name), info(name), invalid(), reload(), validate(name, input), validateResult(name, result)}`.
- `src/runner/types.mjs`: JSDoc typedefs (Config, ToolManifest, ToolEntry, Job, JobOutput, JobInput, JobEvent, Ctx).
- `src/runner/context.mjs` `makeContext(...)`; `protocol.mjs` `parseProtocolLine`, `writeRequestFile`, `interpolateCommand`, `commandEnv`.
- `vendor/mucavex/src/*`: the Strudel renderer (engine.mjs `render`, encode.mjs `encode`, analyze.mjs `analyze`); import
  `vendor/mucavex/src/resolve-hooks.mjs` FIRST (it installs module hooks), then the others with dynamic `import()`.

## 6. Tests
- `node:test` + `node:assert/strict` only. Files `test/<marker>/<name>.test.mjs`. Each test < 30 s.
- Gate on features: `test('x', needs('ffmpeg', 'python'), async () => {...})` (`test/helpers/needs.mjs`; features: ffmpeg,
  ffprobe, chromium, python, piper-voice, samples, network). Missing -> skip, BUT if the feature is in `MX_REQUIRE` the test
  FAILS. Your definition of done: zero skips for features in your `MX_REQUIRE`.
- Generate inputs with `writeFixture(ws, rel, spec)` (`test/helpers/fixtures.mjs`) in a temp workspace (`mkTmp()`/`rmTmp()`
  from `test/helpers/tmp.mjs`). Never commit binary fixtures.
- Run a tool the way the service does: `runTool(name, input, {workspace})` from `test/helpers/tool-harness.mjs` -> `{result, outputs:[{name, abs, bytes}], outDir, events, log}`;
  failures throw a ToolError with `.type`. It uses a child process, like the real runner.
- Piper and other non-deterministic outputs: assert ranges, never exact bytes.
- The contract suite (`node scripts/test.mjs contract <tool>`) checks every tool: manifest, schema rules, descriptions, examples run, no writes outside outDir, result matches output_schema.

## 7. Repo map (owner in brackets; O = orchestrator)
```
bin/mx.mjs                       CLI: serve | healthcheck | tools | run | job | jobs | cancel | put | get | pin | skill  [P3c]
src/lib/*.mjs                    shared libs [O]; loudness [W0b], timespec [W0b], static/capture [P10], biquad [P4b],
                                 elevenlabs [P5b], strudel-markers [P8], voices [P9], tool-docs [P3d], dsp/kit [P7a],
                                 mix/{plan,clips,render} [P6a], mix/master [P6b], mix/dynamics [P14]
src/registry/                    manifest schema, Ajv, registry [O]
src/runner/                      types/context/protocol/node-host [O]; store, refs [W0b]; scheduler [P1a]; service [P1b];
                                 execute, kill [P2a]; command [P2b]; pins [P3a]
src/server/                      router [W0b]; app, main [P13a]; routes/{index,health,capabilities,tools} [P13a];
                                 routes/jobs [P13b]; routes/files [P3b]; routes/pins [P3a]; routes/skill [P3d];
                                 routes/view [P10a]; routes/listen [O]
tools/<name>/                    one folder per tool
presets/{encode,mix,timeline,audio-process}/   named presets (JSON, may carry "description")
lib/browser/motion/              optional browser runtime (runtime.js, adapters.js) [P12b]; GSAP served from node_modules/gsap/dist
lib/sfx/recipes/generic.mjs      built-in SFX recipes [P7b]
vendor/mucavex/                  vendored Mucavex renderer (AGPL), do not edit
py/requirements.txt              hashed Python deps (piper-tts, pillow)
skill/motionex/                  the agent skill (SKILL.md + references) [O]
test/{unit,tools,contract,integration,docker,e2e,live}/   test markers; test/helpers [O]; test/fixtures/tools = fake tools
```

## 8. Error vocabulary
Job errors (`ToolError` type -> retryable): invalid-input (no), input-unreadable (no), tool-failed (no), timeout (yes),
canceled (no), interrupted (yes), out-of-memory (no), provider-error (no), rate-limited (yes), network (yes),
invalid-output (no), internal (no).
API problems (`problem(code)` -> status): malformed-json 400, invalid-request 422, invalid-input 422, unknown-tool 404,
tool-unavailable 422, unknown-ref 422, file-not-found 404, path-outside-workspace 422, reserved-path 403, file-locked 409,
idempotency-key-invalid 400, idempotency-key-reused 422, not-found 404, pinned 409, job-busy 409, payload-too-large 413,
unsupported-media-type 415, origin-not-allowed 403, host-not-allowed 403, unauthenticated 401, method-not-allowed 405,
queue-full 503, not-ready 503, internal 500. Body: RFC 9457 `{type:"urn:motionex:problem:<code>", title, status, detail, request_id, ...}`.

## 9. Definition of done
1. Your tests pass: `node scripts/test.mjs file <your test files>`; zero skips for features in `MX_REQUIRE`.
2. For tools: `node scripts/test.mjs contract <your tools>` passes.
3. `npx biome check <your files>` is clean.
4. No file outside your list changed (`git status` shows only your files).
5. End with `## Result`: Status, what you built, test output summary, anything you could not do, and any contract change you need.
