# EP5 · THE SUN SWALLOWER — production notes

**Deliverable:** `out/ep5-sun-swallower.mp4` — 1080×1920, 30 fps, 27.097 s, H.264 High / yuv420p / bt709 + AAC 48 kHz stereo 200 kb/s, 27,234,372 bytes (27.2 MB), **−14.3 LUFS** integrated, LRA 4.2, **true peak −1.8 dBTP**.

## The idea
A three-act myth told by a fire-side storyteller, cut on the bar. The beat grid is the edit:
124 bpm, one bar = 1.9355 s, 14 bars = 27.10 s. **The drop is bar 8 = 13.5484 s** (50% in).

| bars | time | picture | words |
|---|---|---|---|
| 1 | 0.00–1.94 | extreme close on the sun's face, rays pulsing on the kick, tile mandala behind; camera pulls back | **LONG AGO** |
| 2–3 | 1.94–5.81 | the world rises into frame (lapis hills, a domed shrine, cypresses), sun pulses like a heartbeat | THE SUN HAD A HEARTBEAT (+ خورشید) |
| 4 | 5.81–7.74 | the azhdaha dives in, jaw open, the sun is pulled into its mouth and goes dark red | THE SERPENT SWALLOWED IT |
| 5 | 7.74–9.68 | blackout; only the serpent's gold outline glows, its tiles light like a meter on every kick | (same card holds) |
| 6 | 9.68–11.61 | a stepped mountain of stars; the drummer climbs one terrace per beat | A DRUMMER CLIMBED THE DARK |
| 7 | 11.61–13.55 | four daf strikes, each sends a gold ring through the serpent; the kick stops for the last two beats | AND PLAYED. |
| **8** | **13.55** | **DROP** — the serpent spits the sun out on the one: flash, 34 gold rays, three rings, 190 sparks, the coil dances | — |
| 9–12 | 15.48–23.23 | celebration: the sun pulses with its face, tiles flip colour every bar, stars rain, the drummer keeps the one | AND THAT'S WHY, / WE DANCE ON THE ONE. |
| 13–14 | 23.23–27.10 | endcard: ornamental frame drawn in, ON THE ONE + EP 5 · THE SUN SWALLOWER + خورشید | — |

## Word effect
Calligraphic stroke reveal, drawn per letter: each glyph is clipped by a slanted pen edge that travels left→right, with a wet-ink shadow, a gold gradient body, a dark inked edge, a pen-nib dot and ink blots at the leading edge, then a drawn underline flourish. Letters are staggered so a line is *written*, not wiped. Type is DejaVu Serif (the only display serif in the container) at 92–158 px, auto-fitted to 870 px, always inside the safe zone (y 1130–1400). A dark scrim behind each card keeps gold-on-gold readable over the serpent.

## Music (`song.strudel`)
Persian techno, 124 bpm, `setcpm(124/4)`, markers `DROP=7`, `END=12`, `DARK=3`.
- 909 kick 4/4; the last two beats of bar 7 are empty (the gap before the drop).
- Tombak/daf: `gm_taiko_drum` (dum) + 909 `rim` (tak) in a 3+3+2 (6/8-over-4/4) figure; 16th hats as the daf jingle; four big `gm_taiko_drum*4` strikes in bar 7.
- Santur: `gm_dulcimer` in C phrygian dominant (C D♭ E F G A♭ B♭) — a hint in bars 2–3, a descent under the swallow, an ornament in bar 6, the full 8th-note riff after the drop with an octave echo.
- Bass: saw + lpf 320 from the drop; a `gm_string_ensemble_1` drone before it; white-noise riser into the drop; crash on the drop and on the endcard downbeat; tubular bell on the endcard.
- **Sample probe first** (`probe-song.strudel`, `probe2.strudel`): `tabla`, `tabla2`, `perc`, `daf`, `tombak`, `dumbek`, `frame`, `hand`, `riq`, `shaker`, `gm_santur`, `gm_kanun`, `gm_oud`, `gm_guiro` do **not** exist in this engine; `gm_taiko_drum`, `gm_melodic_tom`, `gm_woodblock`, `gm_steel_drums`, `gm_timpani`, `gm_marimba`, `gm_agogo`, `gm_tubular_bells`, `gm_dulcimer`, `gm_contrabass`, `gm_string_ensemble_1`, `gong` do. The final render has **no missing-sound warnings**.
- Final song: peak −0.1 dBFS, 0 clipped samples, rms −16.1 dBFS. Per-bar LUFS of the music stem: intro −24.1, bar 7 −26.6, drop −22.2 (a +1.9 LU step over the intro, +4.4 over the pre-drop bar).

## Voice
`en_US-norman-medium`, `length_scale 1.15`, six takes: "Long ago, the sun still had a heartbeat." / "Then the serpent swallowed it." / "So a drummer climbed the dark, and" / "played." / "And that's why," / "we dance on the one."
`audio.process`: highpass 68 + 230 Hz warmth + highshelf −3.5 @3.1k → pitch −1.6 semitones → `aecho` 190/430 ms hall + lowpass 6.8k → compressor (0.045, 3.5:1) → peak −2.5 dB.
Placement (start times): 1.95, 5.86, 9.68, 12.45, 17.52, 19.42 — each line starts on a bar or half-bar and ends before the next event; "played." lands in the gap before the drop.

## SFX (`sfx.mjs`, `sfx.synth`)
`shimmer` (gold grains + air) on every word card and the endcard title; `swish` on the serpent's arrival and the coil; `ring` (struck daf) on the four bar-7 strikes; `thump` + `burst` on the drop. 15 cues total, all placed on picture events, none over a line.

## Mix (`audio.mix`, no ducking)
- dialogue: 6 clips, track fx `volume=6dB, acompressor 0.2/4:1, alimiter 0.6` (a static pocket, no sidechain).
- music: straight through, **section ride** — bars 1–7 at −10.5 dB, bars 8–14 at −8 dB (the bed steps *up* on the drop; nothing ducks under the voice).
- sfx: −8 dB track, thump +6 / burst +4 on the drop.
- master: `gain+limiter` to −14 LUFS / −1.5 dBTP → measured **−14.3 LUFS, TP −1.8 dBTP**, gain +4.4 dB, limiter barely engaged.
- `audio.speech-ratio` (voice vs music stems): min **8.6 dB** (line 6, over the full groove), median **14.1 dB** — in the range the reference mix accepted.
- Final per-bar LUFS: bar 7 −14.2 → **bar 8 (drop) −13.3**; music-only bars −20.3/−21.3 in the intro vs −16.9 after the drop.

## Review
Stills before the render: `picture.stills` ×5 (job_01a1b2debecf777f938cc9ec97d04473, job_01a1b2df4e9b7539850547c0dbdd403b, job_01a1b2e313f970c6850e9d4ef6e5c833, job_01a1b2e4c89f75c2a28b61d4952bcfd5, job_01a1b2e8b153763486af9065c2dbc9ae) and two contact sheets (job_01a1b2ec561477cfad4983c3ae6c4da5, job_01a1b2f107bc7658927585879560a6dd). Frames from the **final MP4**: job_01a1b2f0e9fd721882d3bb5397cda057 and job_01a1b2f18d3e7448b76bc047c4a8a2ed.

## Job ids
- sample probes: job_01a1b2dc70fc71cc812ad7493f8c305e, job_01a1b2debecf777f938cc9ec97d04473 (font probe)
- voice takes: job_01a1b2dc71567660957fe5b5045f4ed7
- voice process v1: job_01a1b2dd68e1729fa97c9f42c1ad4ab4 · **v2 (used): job_01a1b2e70d1975b4991746c0d231d5cc**
- song v1: job_01a1b2dd44ed773ca337c9130f3177be · v2: job_01a1b2e2050d74af827ad39a5c3266e6 · **v3 (used): job_01a1b2e5ea3e744295fe211935508d2f**
- sfx: job_01a1b2e2fe4e70e3a3191b24e54e2765
- mix A: job_01a1b2e7dbbb710c9fd763bbea90a68e · mix B: job_01a1b2e7dcaa752f936f694d65f59db7 · mix final: job_01a1b2e876607010a7875e398de39388 · **mix final2 (used): job_01a1b2ed85537531b0053a7c26ccebf3**
- render v1: job_01a1b2e91bb4772a88f73deecb3b8a85 · **render v2 (used): job_01a1b2ecc0d97513a0ef575aba0e95ae** (813 frames, 0 stalls, no page errors, 176 s)
- mux: job_01a1b2f0019a74d1b3ff78f91ca99848
- final probe: job_01a1b2f03a6a729d8243c9076fa55b78 · final loudness: job_01a1b2f03c5574ab93050303ead54fae · final levels: job_01a1b2ece3b17475b28cf7dcc61e6f9b · speech ratio: job_01a1b2edc3b07764bfdebeedeb531aab

## Pins
- `onthe1/ep5-sun-swallower/music` → job_01a1b2e5ea3e744295fe211935508d2f/music.wav
- `onthe1/ep5-sun-swallower/voice` → job_01a1b2e70d1975b4991746c0d231d5cc (all six takes)
- `onthe1/ep5-sun-swallower/mix` → job_01a1b2ed85537531b0053a7c26ccebf3/mix.wav
- `onthe1/ep5-sun-swallower/final` → episodes/ep5-sun-swallower/out/ep5-sun-swallower.mp4 (sha256 2bbcb4e1…)

## What went wrong / what I would improve
- **No hand-drum samples.** `tabla`, `daf`, `tombak`, `perc` are all missing in this engine, so the tombak/daf is built from `gm_taiko_drum` + 909 rim + 16th hats. It reads as a frame-drum groove, but a real daf/tombak sample set would be the single biggest upgrade.
- **No calligraphic font.** Only DejaVu/Liberation are installed, so the "reed pen" is faked with a per-letter slanted clip reveal + ink blots. A real Aref Ruqaa / nastaliq face would make the word effect sing (the Persian accent currently uses the Arabic fallback).
- The drop flash is one very hot frame (0.45 alpha + burst rays). It reads as an impact, but I would soften it to ~0.3 and add a 2-frame gold ring instead.
- The serpent's head is the weakest drawing: it reads as a dragon at 1.1× but the skull is flat and the mouth interior is a simple wedge. A proper jaw hinge with a throat and a forked tongue would help.
- The ziggurat mountain is very regular; hand-cut terraces with more jitter and a few cypresses on the ledges would feel more like a miniature.
- `media.frames` with `format: jpeg` fails on the muxed file ("Non full-range YUV is non-standard"); `format: png` works. Worth knowing.
- The music's low end dominates (analyzer warning); a high-pass on the taiko and a tighter kick would clean it up.
