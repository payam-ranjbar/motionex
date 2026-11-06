# Worked example: a 6-second film, start to finish

This is the service's own acceptance test (`test/e2e/tiny-film.test.mjs`) written as agent steps. Every step is one job. Replace the `<…>` ids with the ids from your earlier results. `MX=http://127.0.0.1:8095`.

**1. Files in the workspace.** Write them directly if you share the folder, or upload them with `PUT /v1/files/...`.
- `films/tiny/scene.html`: a 640×360 canvas page using `MotionAdapters.fromFunction(draw, {duration: 6, size: {width: 640, height: 360}})` (`<script src="/_mx/lib/motion/adapters.js">`).
- `films/tiny/song.strudel`:
  ```js
  setcpm(120/4)
  let DROP = 1;
  const span = (a, b) => cat(...Array(a).fill(0), ...Array(b - a).fill(1), ...Array(64).fill(0))
  $: note("<c2 g1 a1 f1>").s("sawtooth").lpf(600).gain(.5)
  $: note("c4 e4 g4 b4").s("triangle").gain(.25).mask(span(DROP, DROP + 64))
  ```
- `films/tiny/sfx.mjs`: `export const sounds = { whoosh(kit) { /* return [L, R] Float32Arrays */ } }`.

**2. Voice**, then pin the take you like:
```json
{"tool": "voice.piper", "input": {"voice": "en_US-norman-medium", "lines": [{"name": "line", "text": "This film was made by an agent."}]}}
```
`PUT /v1/pins/tiny/voice` with `{"ref": "job:<voice>/line.wav"}`.

**3. Layout** (optional; you could hand-write the times):
```json
{"tool": "timeline.layout", "input": {"grid": {"bpm": 120},
  "scenes": [{"id": "main", "lead_s": 1, "duration_s": 6, "lines": [{"audio": "pin:tiny/voice", "who": "narrator"}]}],
  "markers": {"DROP": {"scene": "main"}}}}
```
The outputs are `timeline.json` and `dialogue-clips.json` (`[{src, at, name}]`).

**4. Music and SFX.** Run these in parallel; music is the slow one.
```json
{"tool": "music.render", "input": {"file": "films/tiny/song.strudel", "bpm": 120, "seconds": 7, "markers": {"DROP": 1}}}
{"tool": "sfx.synth", "input": {"recipe": "films/tiny/sfx.mjs"}}
```

**5. Mix**: an exact 6 s, music straight through under the voice, mastered to −16 LUFS:
```json
{"tool": "audio.mix", "input": {"duration_s": 6, "timeline": "job:<layout>/timeline.json",
  "tracks": [
    {"name": "dialogue", "clips": [{"src": "pin:tiny/voice", "at": 1.0}]},
    {"name": "music", "gain_db": -14, "clips": [{"src": "job:<music>/music.wav", "at": 0, "fade_out_s": 1}]},
    {"name": "sfx", "gain_db": -10, "clips": [{"src": "job:<sfx>/whoosh.wav", "at": "main+0.2"}]}],
  "master": {"loudness": {"target_lufs": -16, "true_peak_db": -1.5}},
  "output": {"stems": true}}}
```
Check it with `audio.speech-ratio {"voice": "job:<mix>/stems/dialogue.wav", "background": "job:<mix>/stems/music.wav"}`. Then send the human to `$MX/listen?compare=job:<mix>/mix.wav,job:<older-mix>/mix.wav`.

**6. Picture with audio**, one encode:
```json
{"tool": "picture.render", "input": {"page": "films/tiny/scene.html", "fps": 30, "workers": 2, "audio": "job:<mix>/mix.wav"}}
```
Before this, review cheaply: `picture.stills {"page": "...", "times": [0.5, 3, 5.5]}`, then `image.contact-sheet`.

**7. Check and deliver**:
```json
{"tool": "media.probe", "input": {"input": "job:<render>/video.mp4"}}
{"tool": "audio.loudness", "input": {"input": "job:<render>/video.mp4"}}
{"tool": "media.frames", "input": {"video": "job:<render>/video.mp4", "times": [3]}}
{"tool": "media.encode", "input": {"input": "job:<render>/video.mp4", "preset": "telegram-video"}}
```

Re-submitting any deterministic step with unchanged inputs returns at once (`cached_from`). So after a change, re-run the chain from the step that changed.
