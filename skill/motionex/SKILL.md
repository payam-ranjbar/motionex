---
name: motionex
description: Create and direct motion-graphics videos with the motionex service. It covers voice-over (Piper TTS with IPA control, optional ElevenLabs), HTML/JS animation captured to video, music written in Strudel and rendered by Mucavex, synthesized sound effects, mixing and loudness, analysis, and platform encodes, all through an HTTP API or the mx CLI. Use it when asked to make or change a video, explainer, animatic, trailer, ad, reel, short film or title card, or any of its voice, music, sound, mix, picture or encode.
---

# motionex

motionex is a toolbox, not a pipeline. It is one service holding bare tools for voice, picture, music, sound, mix, analysis and encoding. You compose them in any order you like. **Nothing is required or enforced.** You need no voice, no song, no beat grid and no fixed size, and every opinion (ducking, a loudness target, snapping) is a parameter or a named preset you may use or ignore. The craft notes in `references/` are experience from real productions. Treat them as options, never as rules.

## Connect
- **Service**: `MX=${MX_URL:-http://127.0.0.1:8095}`. Check it with `curl -s $MX/readyz`.
- **Workspace**: one folder shared with the service, mounted at `/workspace` inside it. Every file path you give a tool is RELATIVE to the workspace, for example `films/teaser/scene.html`.
  - If you can see that folder (it is usually your project folder), write files there directly.
  - Otherwise upload a file with `curl -X PUT --data-binary @scene.html $MX/v1/files/films/teaser/scene.html`.
- **What exists**:
  - `curl -s "$MX/v1/tools?brief=1"` lists every tool.
  - `curl -s $MX/v1/tools/<name>` gives the full input schema and examples.
  - `curl -s $MX/v1/capabilities` lists voices, presets, the browser and limits.
  - `references/tools.md` (or `GET $MX/v1/skill/references/tools.md`) has every tool's fields, live from the service.

## Call a tool
Write the job to a FILE. Shell-quoting JSON is how mistakes happen.
```bash
cat > jobs/voice.json <<'EOF'
{"tool": "voice.piper", "input": {"voice": "en_US-john-medium", "length_scale": 1.1,
  "lines": [{"name": "intro", "text": "They called it a glitch."}]}}
EOF
curl -s -X POST "$MX/v1/jobs?wait=120" -H 'content-type: application/json' --data @jobs/voice.json
```
- **The response is a Job**: `{id, status, result, outputs: [{name, ref, path, bytes}], error}`. Output file names are fixed by each tool (`music.wav`, `mix.wav`, `line1.wav`…); only a few tools take a `name` field, so check the schema rather than guessing. A request that fails validation returns a problem body (no `id`), so check `status`/`type` before reading `id` in your scripts.
  - `status` is `queued`, `running`, `succeeded`, `failed` or `canceled`.
  - `?wait=N` holds the request up to N seconds (at most 300). If the job is still running you get 202; poll with `curl -s "$MX/v1/jobs/<id>?wait=300"`. Never sleep-loop.
- **Outputs are files** at `outputs[].path`, for example `.mx/jobs/<id>/out/intro.wav`. Read them directly in the workspace, or with `GET $MX/v1/jobs/<id>/outputs/<name>`.
- **Errors** are `application/problem+json` with `errors[]` naming the bad field. A failed job has `error.type` and `error.detail`, and `GET $MX/v1/jobs/<id>/log` gives the tool's log.
- **The `mx` CLI** does the same, with less typing: `mx run voice.piper jobs/voice-input.json --wait`, `mx job <id> --wait`, `mx get job:<id>/intro.wav ./intro.wav`, `mx tools`.
  - Inside the container: `docker exec motionex mx ...`.
  - From a checkout of the repo: `node bin/mx.mjs ...`.

## Refs: point at files and earlier outputs
Any input field that takes a file accepts:
- a workspace path: `films/teaser/song.strudel`;
- `job:<id>/<output>`: an output of an earlier job, for example `job:job_01…/intro.wav`;
- `pin:<name>` or `pin:<name>#<output>`: a pinned take or render.

Outputs are **immutable**: a new run never overwrites an old one. Deterministic tools (mix, music, encode, analysis) are **cached**: re-submitting the same input with the same file contents returns the earlier result at once, with `cached_from` set. So re-running a whole chain only redoes what changed. Pass `"cache": "off"` to force a fresh run.

## Keep what the human liked
- **Pin approved work**: `mx pin voice/intro job:<id>/intro.wav`, or `PUT $MX/v1/pins/voice/intro` with `{"ref": "...", "note": "user: love the pause"}`.
  - Re-pinning keeps a history (`GET $MX/v1/pins/voice/intro?history=1`), so rollback is just re-pinning an old ref.
  - Pinning a workspace path freezes a copy, so later edits never change what the pin points to.
- **Piper is non-deterministic.** Every take differs. A take the human liked exists only as its output file, so pin it before you experiment.
- **Offer A/B choices rather than replacing** something the human already heard. In practice "upgrades" (a fancier voice, a busier score, a redesign) were rolled back more than once.
- **Keep a decision log**, `notes.md` in your project: what changed, what the human said, what is settled.

## You cannot hear. They can.
You measure; the human listens. After each audio change:
1. say what you changed and what you measured;
2. say what to listen for;
3. ask ONE specific question ("Is the music too loud under the last line?");
4. make one or two changes per round.

Your "ears" are `audio.loudness`, `audio.levels`, `audio.speech-ratio`, `audio.stats` and `audio.silence`. The human is at `$MX/listen`, the listening room: recent jobs with players, one file with `?ref=<ref>`, A/B with `?compare=<ref>,<ref>`, and a scrubbable live preview with `?page=<workspace .html>&audio=<ref>&timeline=<ref>`. Any workspace file also opens directly at `$MX/w/<path>`. When the numbers and the human disagree, the human wins.

## One way to make a film (an example path, not a rule)
1. **Brief**: the story, the length, the platform (16:9 or 9:16, any size cap) and the look. Ask at most 2–3 questions, then sketch.
2. **Voice drafts**: `voice.phonemize` names and odd words first, then `voice.piper` (or `voice.elevenlabs`), and `audio.process` for character (pitch, EQ, speed).
3. **Timing**: `timeline.layout` turns the takes into scene times and cues (`timeline.json`). It is optional; you may also hand-write absolute times.
4. **Picture**: HTML pages that expose `window.__motion`. Review with `picture.stills` and `image.contact-sheet` BEFORE a full render.
5. **Music**: a Strudel song through `music.render`, with markers for the sections, checked with `audio.stats` or `audio.levels`.
6. **Sound effects**: `sfx.synth`, the built-in generic recipes or your own recipe file.
7. **Mix**: `audio.mix`. The default is a plain sum; add a preset or explicit options. Check with `audio.loudness` and `audio.speech-ratio`.
8. **Render**: `picture.render` with `audio` set. It encodes once, video and audio together.
9. **Check the encode**: `media.frames` and `media.probe`.
10. **Deliver**: `media.encode` with a preset such as `fit-size` (Telegram), `instagram-reel` or `web-720p`.

Every step is replaceable. A music-only piece, a silent loop, a title card or a pure SFX job are all fine.

## Time and cost (rough)
- **Picture**: the container has no GPU. A 22 s 1080p30 canvas-heavy page took about 2 minutes with 6 workers (≈5 s of render per second of video); simple DOM/SVG pages are faster, heavy blur, filters and WebGL slower. Iterate with stills, a 960×540 draft or a `from_s`/`to_s` section, and render the full 1080p once.
- **Music**: a 60–90 s score takes 3–12 minutes to render. Run it while you work on picture.
- **Piper**: seconds per line.
- **Mix and encode**: seconds to a minute; a two-pass delivery encode takes 1–2 minutes.
- **ElevenLabs**: about 1 credit per character. Identical requests reuse the earlier take for free.

## Gotchas
- **Pronunciation**: Piper voices read espeak phonemes, and the `john` voice is British phonemes read by an American speaker. If a name comes out wrong, check it with `voice.phonemize`, then write raw IPA in the text: `"My name is [[ʃˈɒpˌuːə.]]"`. The final punctuation goes INSIDE the brackets.
- **Frames must be reproducible**: animate from the time passed to `seek(t)`. Use no `Math.random()` (use a seeded PRNG), no `Date`, and no free-running CSS animation unless the page uses the WAAPI adapter. Load fonts before setting `ready`.
- **fx chains can clip**: check `peak_db` and the warnings in the results.
- **The mixer default is a plain sum**: 32-bit float, no limiter. Ask for loudness explicitly when you want it.
- **Size caps**: Telegram bots allow 50 MB, and Instagram reels need H.264, a closed GOP and AAC at 48 kHz. Use `media.encode` presets.
- **Music renders take minutes**: render variants in parallel jobs, not in sequence.

## References
- `references/api.md`: endpoints, job lifecycle, refs, pins, files, errors, and curl and CLI recipes.
- `references/tools.md`: every tool, with fields, defaults and examples (generated live).
- `references/picture.md`: the `__motion` contract, the optional Motion runtime and GSAP, adapters, stills review, fonts, lip sync, "juice".
- `references/voice.md`: voices, speed, IPA and pronunciation, character fx, ElevenLabs direction.
- `references/music.md`: a Strudel cheat sheet, section markers, polyphony, reading the analysis.
- `references/sound.md`: mix options and what real listeners accepted or rejected, loudness targets, SFX synthesis.
- `references/pacing.md`: held beats, hits in the silences, comedy timing, cutting on the beat.
- `references/review-and-delivery.md`: review loops, encode presets, platform limits, covers.
- `references/collaboration.md`: briefs, parallel agents (one file per act), decision logs.
- `references/extending.md`: add your own tool (any language), presets and extensions.
- `references/example-tiny-film.md`: a complete 6-second film as a sequence of jobs (copy the shapes).
