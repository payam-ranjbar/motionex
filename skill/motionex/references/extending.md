# Extending motionex

A tool is a folder with a `tool.json` manifest and code. Built-in tools live in `/app/tools`. **Extensions** are folders mounted at `/extensions` (the compose file maps `./extensions` there), or listed in `MX_TOOLS_DIRS`. After adding one, call `POST /v1/tools/reload`, or restart. It then shows up in `GET /v1/tools` and in `references/tools.md`.

## Manifest (`tool.json`)
```json
{
  "name": "image.vignette",                 // dotted, equal to the folder name
  "version": "1.0.0", "title": "Vignette", "summary": "Darken the edges of an image.",
  "kind": "command",                         // "node" (handler.mjs) or "command" (any language)
  "command": ["${MX_PYTHON}", "vignette.py"],// variables: MX_PYTHON, MX_NODE, TOOL_DIR
  "deterministic": true, "cache_default": "auto",   // auto needs deterministic: true; else "reuse" or "off"
  "resources": {"class": "audio", "slots": 1},      // classes: light (0 slots), audio, voice, music, capture, encode
  "timeout_s": 300,
  "requires": {"binaries": ["python"]},
  "input_schema": {"type": "object", "additionalProperties": false, "required": ["image"],
    "properties": {
      "image": {"type": "string", "x-mx-ref": true, "description": "Image file (path, job:<id>/<out> or pin:<name>)."},
      "strength": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5, "description": "0 = none, 1 = strong."}}},
  "examples": [{"title": "default", "input": {"image": "frame.png"}, "run": false}]
}
```
(Real JSON has no comments.)

Schema rules:
- every property has a `description`;
- objects are closed (`additionalProperties: false`);
- file inputs are `{"type": "string", "x-mx-ref": true}`, and the service resolves them to absolute paths before your code runs;
- no `default` inside `oneOf`/`anyOf`.

## Node handler (`kind: "node"`)
```js
export default async function run(input, ctx) {
  // input: validated, defaults applied, refs replaced by absolute paths
  // ctx.outDir: write outputs here; ctx.scratchDir: temp files; ctx.signal: abort on cancel
  // ctx.progress(0.5, 'halfway'); ctx.log('...'); await ctx.secret('my_key');
  // ctx.lib: {wav, audioIo, signal, ffmpeg, loudness, timespec, paths, errors}  (shared helpers)
  return { result: { ok: true } };          // every file in outDir becomes an output
}
```
Throw `new ctx.lib.errors.ToolError('invalid-input', 'why')` for bad input. Any other throw becomes `tool-failed`.

## Command tool (any language)
The service writes `request.json` (input, out_dir, scratch_dir, ...) and runs your command with its path as the last argument. Print JSON lines to stdout:
```
{"type":"progress","fraction":0.5,"message":"halfway"}
{"type":"log","message":"anything"}
{"type":"result","result":{"ok":true}}
{"type":"error","error":{"type":"invalid-input","detail":"why"}}
```
- Write outputs into `out_dir`. Exit 0 after the result line.
- Python has `numpy` and `pillow` available in the service's venv (`${MX_PYTHON}`).

## Check your tool
- `mx validate-tools ./extensions/image.vignette` validates the manifest, schemas and examples offline.
- From a repo checkout, `node scripts/test.mjs contract image.vignette` runs the contract suite: descriptions, closed schemas, examples run, no writes outside `out_dir`, and determinism.

## Presets
Presets are JSON files in `presets/<kind>/<name>.json` (`encode`, `mix`, `timeline`, `audio-process`). Add your own folder with `MX_PRESETS_DIRS`. A preset is merged UNDER the request, so the request always wins.

## Ideas that fit as extensions
- Whisper transcript checks for takes.
- Formant analysis for pronunciation comparisons.
- A Lottie adapter.
- Image generators.
- A live Strudel studio for the human.
- Publishing to social platforms, which needs explicit human approval per post.
