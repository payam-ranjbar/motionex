# motionex

Bare motion-graphics tools for AI agents, in one Docker service. An agent writes HTML scenes, Strudel songs and SFX recipes into a shared workspace, then calls tools over HTTP:

| Area | Tools |
|---|---|
| Voice | `voice.piper` (local TTS, raw IPA), `voice.phonemize`, `voice.elevenlabs` (optional), `audio.process` (pitch, tempo, trim, tighten pauses, fx) |
| Picture | `picture.render` (any page with `window.__motion` → H.264, audio muxed in one encode), `picture.stills`, `image.contact-sheet` |
| Music | `music.render` (Strudel via the vendored Mucavex engine, section markers, seeded, polyphony 4096) |
| Sound | `sfx.synth` (DSP kit + recipes), `audio.mix` (exact-length track/bus mixer; neutral by default; presets) |
| Analysis | `audio.loudness`, `audio.levels`, `audio.speech-ratio`, `audio.stats`, `audio.silence`, `media.probe`, `media.frames` |
| Timing | `timeline.layout` (optional: voice-driven scenes, beat snapping, music markers, time specs) |
| Delivery | `media.encode` (presets: master, web-720p, fit-size, telegram-video, instagram-reel), `media.mux`, `media.concat`, `media.ffmpeg` (escape hatch) |

**Design rule: do not enforce.** Every tool is a primitive. Every opinion is a parameter or a named preset, and every default is neutral. Outputs are immutable and pinnable; deterministic tools are cached. New tools are folders with a manifest, written in any language, and can be mounted from outside the image.

The skill that teaches agents how to use it lives in `skill/motionex/`. The service also serves it at `/v1/skill`.

## Run it
```bash
docker compose up --build -d                     # http://127.0.0.1:8095 (loopback only)
MX_WORKSPACE_HOST=/path/to/project docker compose up -d   # share a project folder with the service
curl -s http://127.0.0.1:8095/readyz
```
- **Workspace**: the host folder `./workspace` (or `MX_WORKSPACE_HOST`) is mounted at `/workspace`. Tool inputs are paths relative to it.
- **Listening room**: open http://127.0.0.1:8095/listen. It shows recent jobs with players, A/B (`?compare=ref,ref`), and live page previews.
- **Secrets** are files: copy `compose.local.example.yaml` to `compose.local.yaml` and put the ElevenLabs key in `secrets/elevenlabs_api_key`.
- **Samples**: Strudel sample banks download into the `motionex-cache` volume on first use (`offline: true` uses only the cache).

## Give an agent the skill
- **Claude Code**: `docker exec motionex mx skill install /tmp/s && docker cp motionex:/tmp/s/motionex ~/.claude/skills/`, or copy `skill/motionex` into `~/.claude/skills/`.
- **pi**: `pi --skill <repo>/skill/motionex`.
- **Anything else**: `GET /v1/skill/SKILL.md` and `GET /v1/skill/references/<file>`.

## Use it
```bash
cat > job.json <<'EOF'
{"tool": "voice.piper", "input": {"voice": "en_US-john-medium", "lines": [{"name": "hi", "text": "Hello there."}]}}
EOF
curl -s -X POST "http://127.0.0.1:8095/v1/jobs?wait=60" -H 'content-type: application/json' --data @job.json
docker exec motionex mx tools        # the same API through the CLI
```

## Develop
- Node 24, Python 3.12 (`uv venv .venv && uv pip install -r py/requirements.txt`), and Piper voices in `./voices`.
- `npm test` runs unit, tools, contract and integration tests on the host (ffmpeg from `ffmpeg-static`; Edge or Chromium through playwright-core).
- `node scripts/test.mjs docker` runs the opt-in Docker tests. `node scripts/test.mjs e2e` (with `MX_E2E_URL`) runs the acceptance film.
- `AGENTS.md` is the contract for coding agents: the tool manifest, handler and command protocol, shared modules, tests.

## Licences
AGPL-3.0-or-later, because the image includes the AGPL Mucavex/Strudel renderer. See `NOTICE.md` for Piper (GPL), ffmpeg (GPL), Chromium, GSAP and the voices.
