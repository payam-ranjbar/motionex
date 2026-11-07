# Providers and contracts

One capability, several services. Speaking a line is the same job whether Piper runs it locally or ElevenLabs
performs it in the cloud, so an agent should be able to switch provider without rewriting its jobs or anything
downstream of them. motionex does this with **contracts** (the shared shape of a capability) and **providers** (the
tools that implement one).

## What was already pluggable
- **Tools are the unit of extension.** Each tool is a folder with a manifest, written in any language (Node handler or
  a JSONL command), discovered at start and from `/extensions`. Resources, caching, secrets and availability are
  declared per tool.
- **Opinions are presets** (`presets/<kind>/*.json`), merged under a request.
- **SFX recipes** are modules: `sfx.synth` runs the built-in recipes or any recipe file an agent writes.
- **Pictures meet a page contract**, `window.__motion` (`seek(t)`, `ready`, `duration`). Any page that implements it
  renders; `lib/browser/motion/adapters.js` adapts animation libraries (GSAP, WAAPI, CSS) to it.
- **Infrastructure is shared**, not duplicated: ffmpeg, audio I/O, loudness and signal helpers in `src/lib/`.

What was missing was a layer above the tools. `voice.piper` and `voice.elevenlabs` did the same job with different
inputs (`{voice, lines[]}` against `{voice_id, text}`), different outputs (`<name>.wav` per line with speech timing
against one `take.wav`) and different results. Switching provider meant rewriting the job and every `job:<id>/...`
ref after it.

## The pattern
| Piece | Where | Role |
|---|---|---|
| Contract (the port) | `contracts/<name>.json` | Shared input fields, shared result fields, output files in words, examples |
| Provider (an adapter) | any tool with `"implements": [{"contract", "provider"}]` | Accepts the contract's fields with the same meaning, may add its own, returns at least the contract's result |
| Routing | `src/runner/service.mjs` | A job whose `tool` is a contract runs as the provider's tool, with `provider` removed from the input |
| Conformance | `src/registry/registry.mjs` | At load: the tool has every contract input field and every required result field. At run time: a contract job's result is checked against the contract's `output_schema` |
| Discovery | `GET /v1/contracts`, `capabilities.contracts`, the skill's `tools.md` | Which providers exist and which can run here |

```json
{"tool": "voice.speak", "input": {"provider": "piper", "voice": "en_US-john-medium", "lines": ["Hello."]}}
{"tool": "voice.speak", "input": {"provider": "elevenlabs", "voice": "JBFqnCBsd6RMkjVDRZzb", "lines": ["Hello."], "stability": 0.5}}
```
Both write `line-001.wav` and return `{voice, sample_rate, lines: [{name, file, text, seconds, speech_start_s,
speech_end_s, speech_s}], warnings}`. The job records `tool` (what ran), `contract` and `provider`. The cache key is the
provider tool plus its input, so a contract job and the same job sent straight to the tool share cached results.

**Why the adapters are tools, not modules inside one tool.** A provider differs in exactly the things the tool manifest
already declares: language (Piper is Python), resource class and concurrency (ElevenLabs allows two requests per key),
cache policy (reuse paid takes, never cache Piper's random ones), secrets and availability. Keeping each provider a
tool keeps all of that, keeps every provider callable by name, and lets an extension add a provider by dropping a
folder into `/extensions` without touching the image.

**Do not enforce** still holds. There is no default provider: the agent names one, and an unknown name is a 422 that
lists the installed providers. Defaults belong to each provider (`model: eleven_v3`, Piper's own length scale), never
to the contract; the registry refuses a contract that sets defaults.

## Contracts today
| Contract | Providers | Shared input | Shared result |
|---|---|---|---|
| `voice.speak` | `piper` → `voice.piper`, `elevenlabs` → `voice.elevenlabs` | `voice`, `lines`, `speed`, `speech_end_threshold_db` | `voice`, `sample_rate`, `lines[]` with speech timing, `warnings`; files `<name>.wav` |
| `voice.list` | `piper` → `voice.piper-voices`, `elevenlabs` → `voice.elevenlabs-voices` | `search` | `voices: [{id, name, language?, labels?}]`, `warnings?` |

`src/lib/speech.mjs` holds what a Node voice provider needs to match Piper exactly: `normalizeLines` (line naming) and
`speechBounds` (the same speech-start/end rule as the Piper worker).

## Adding a provider
Example: an OpenAI or Azure text-to-speech provider for `voice.speak`.
1. Make a tool folder, `voice.azure/`, with `tool.json` and `handler.mjs`. Declare
   `"implements": [{"contract": "voice.speak", "provider": "azure"}]`, and an `input_schema` that has every
   `voice.speak` field (`voice`, `lines`, `speed`, `speech_end_threshold_db`) plus your own (`style`, `region`). Do not
   declare `provider`; the service removes it.
2. In the handler, use `normalizeLines(input.lines)`, call the service once per line, write `<name>.wav` into
   `ctx.outDir`, and measure each take with `speechBounds`. Return the contract's result fields; add your own freely.
3. Secrets are files: `"requires": {"secrets": ["azure_speech_key"]}` and `await ctx.secret('azure_speech_key')`.
4. Mount the folder at `/extensions` (or `MX_TOOLS_DIRS`). `GET /v1/contracts/voice.speak` lists `azure`; a broken
   provider shows in `GET /v1/tools?invalid=1` with the reason (for example `input_schema lacks "speed"`).
5. A new capability gets a new contract file: `contracts/` in the image, `<extension dir>/contracts/` or
   `MX_CONTRACTS_DIRS`. Contract names share the job namespace with tool names, so a contract needs a name no tool has.

## Candidates (designed, built when a second provider arrives)
| Capability | Contract | Providers it would route | Shared core |
|---|---|---|---|
| Music | `music.song` | `strudel` → `music.render` (score), a generative model (prompt to music), MIDI with a soundfont | input `seconds`, `bpm`, `seed`, `name`; result `seconds`, `peak_db`, `markers_applied`, `warnings`; file `<name>.wav` |
| Sound effects | `sfx.make` | `dsp` → `sfx.synth` (recipes), a text-to-SFX model, a sample library | input `sounds: [{name, ...}]`, `seed`; result `sounds: [{name, file, seconds}]`, `warnings` |
| Cut-outs | `image.cutout` | `threshold` → `image.matte`, a segmentation model, a cloud API | input `image`, `name`; result `width`, `height`, `figure_pct`, `warnings`; file `<name>.png` |
| Transcripts | `speech.transcribe` (new) | a local Whisper, a cloud speech-to-text | input `inputs`; result `items: [{file, text, words?}]`; used to check that each take says its line |

Not contracts, on purpose:
- **Picture capture.** The port is already the page contract (`window.__motion`), with animation libraries adapted
  in `lib/browser/motion/adapters.js`. The browser that captures is configuration (`MX_BROWSER_CHANNEL`,
  `MX_BROWSER_PATH`). A different capture engine (a GPU renderer, another browser) would become `picture.capture`.
- **Encoding.** ffmpeg is infrastructure shared by many tools; presets are its extension point.

## Rules of thumb
- Bump a contract's major version when a shared field changes meaning or a required result field is added; adding an
  optional field is a minor change. Providers then follow at their own pace.
- Keep the shared core small: what every provider can honour with the same meaning. Ranges may differ (ElevenLabs
  accepts `speed` 0.7 to 1.2, Piper anything positive); each provider's schema says so and the error names the field.
- Report what the provider knows about cost in the result (ElevenLabs: `chars`, `credits`), since some keys cannot read
  the account.
