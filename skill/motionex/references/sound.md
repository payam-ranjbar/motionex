# Sound: mixing, loudness, effects

## The mixer (`audio.mix`)
A declarative track/bus mixer that sums clips sample-accurately to an EXACT length:
```json
{"duration_s": 32, "timeline": "job:<layout-id>/timeline.json",
 "tracks": [
   {"name": "dialogue", "clips": [{"src": "pin:teaser/voice/intro", "at": "intro#0"}]},
   {"name": "music", "gain_db": -12, "clips": [{"src": "job:<music-id>/music.wav", "at": 0, "offset_s": 1.73, "fade_out_s": 2}]},
   {"name": "sfx", "clips": [{"src": "job:<sfx-id>/thump.wav", "at": "reveal+0.5", "gain_db": -6}]}],
 "output": {"stems": true, "preview_mp3": true}}
```
- **`at`** is seconds, or a time spec from a timeline: `"scene"`, `"scene+1.5"`, `"scene#2"` (when cue 2 starts), `"scene#2.end-0.1"`, `"bar:8"`, `"beat:3"`. `dialogue-clips.json` from `timeline.layout` is a ready-made clip list.
- **The default is neutral**: a plain float sum, no ducking, no normalising, no limiter, 32-bit float output. Nothing happens unless you ask for it.
- **Options you can ask for**:
  - per clip: `gain_db`, `pan`, fades, `offset_s`/`duration_s`, `fx` (any ffmpeg chain);
  - per track: `fx`, `gain_db`, `level: {relative_to: "dialogue", lu: -9}` or `{lufs: -23}`, `clip_leveling` (evens out takes);
  - `buses`;
  - `sidechain` (ducking, with an optional look-ahead);
  - `master: {fx, gain_db, loudness: {target_lufs, true_peak_db, method}}`.
- **Presets** (`"preset": "dialogue-anchored"`) fill in settings for tracks named `dialogue`, `music` and `sfx`. Your request always wins.

## What real listeners said (use it as evidence, not as rules)
From one narrative short, mixed five times:

| Mix | What it did | Verdict |
|---|---|---|
| 1 | −14 LUFS master, music ducked under every line | "the audio is too loud", "sound effects are too loud" (SFX had been +10 dB) |
| 2 | multiband ducking plus a 0.4 s "suck-out" before the drop | "when it talks it interrupts the music, don't do that" |
| 3 (accepted) | dialogue clip-leveled to one level; music STRAIGHT THROUGH about 8–9 LU under the dialogue with a static −3 dB EQ pocket at 1–4 kHz; SFX about 14 LU under, and nothing under a line within 12 LU of it; master −16 LUFS, limiter at −1.5 dBTP | approved ("play the music seamlessly, a bit louder") |

The accepted balance is the preset `dialogue-anchored`. `ducked-bed` (classic ducking, −14 LUFS) still suits ads and explainers, where the voice must always win. Ask which the piece wants.

## Measure with your "ears"
- **`audio.loudness`**: integrated LUFS, LRA, true peak, and a curve (`curve: {step_s: 0.5}`) to find loud spots.
- **`audio.speech-ratio {voice, background}`**: voice versus everything else in the speech band (300–3400 Hz), per line. In the accepted mix it was 14–23 dB before the climax, and 6–8 dB at the climax, where the lines got harder to hear. Under about 10 dB, ask the human whether the words are clear.
- **`audio.levels`**: levels per window, scene (with a timeline) or bar/beat. Check that a hit actually lands, and how loud the drop is.
- **`audio.silence`**: gaps, the leading and trailing silence, and the speech end.

## Loudness targets (a choice, not a law)
- **−14 LUFS**: what streaming platforms normalise to; punchy.
- **−16 LUFS**: calmer, and good for narrative pieces. It was chosen after "too loud" at −14.
- **Telegram** does not normalise, so your master is what people hear.
- **True peak**: keep it at −1 to −1.5 dBTP for lossy encodes. `gain+limiter` now honours the TRUE-peak ceiling (it re-limits on inter-sample overshoot and warns if it cannot). AAC adds roughly 0.1–0.4 dB, so master about 0.3–0.5 dB under the delivery ceiling, and measure the encoded MP4 with `audio.loudness`.
- **Fades at the cut**: a clip longer than the mix (`duration_s`) gets its `fade_out_s` applied at the mix end, its audible end.
- **`gain+limiter`** iterates until the limited mix lands on the target (±0.3 LU). If the material is too peaky to get there under the ceiling, the result says so in `warnings`; lower the target, or tame the transients (a gentle compressor on the drums or the bus) first. Pushing a master louder costs transient snap: check the drop with `audio.levels` afterwards.

## Sound effects (`sfx.synth`)
- **Built-in generic recipes**, pure synthesis and seeded: `rain_bed`, `glitch_cut`, `glitch_micro`, `whoosh_by`, `swish`, `thump`, `burst`, `ui_blip`. Each takes `params`.
- **Your own recipes**: a `.mjs` in the workspace exporting `sounds = {name(kit, params) { return [L, R]; }}`. `kit.rng()` returns the next random number (0..1) from the seeded stream, not a generator: write `const r = () => kit.rng();`.
  - `kit` has noise generators, oscillators, bells, filters (`svf`, `lp`, `hp`, `bpf`), saturation, bitcrush, stutter, reverb, echo, envelopes, resampling and `pal(name, k, slot)` for slicing palette audio.
  - A palette is any audio you pass in, for example one-shots rendered from Strudel sample banks with `music.render` (`s("gong")` and so on).
- **What worked**:
  - Fewer, better cues: 192 cues went down to 85, and it sounded better.
  - Tie SFX to picture events: a glitch hit on every cut, an impact on every freeze.
  - Put hits in the silences, not over words.
