# EP1 · KICKDRUM KAIJU — production notes

**Delivered:** `out/ep1-kickdrum-kaiju.mp4` — 1080×1920, 30 fps, 25.467 s, H.264 (yuv420p, bt709/tv) + AAC 48 kHz stereo 200 kbit/s, 29 705 674 bytes (**29.7 MB**), sha256 `79b21af602d9aea6539b2ce6a3ea29666a4c6b3a3ff5c24c505b43eb66327bdd`.
Measured on the final file: **−14.2 LUFS integrated**, LRA 4.5 LU, sample peak −1.7 dBFS, **true peak −1.7 dBTP** (spec: about −14 LUFS, ≤ −1.5 dBTP).

## Beat grid (everything is derived from one number)
132 bpm, 4/4 → beat 0.454545 s, **bar 1.818182 s**, 14 bars = 25.454545 s. Bars are 1-based in the brief and in the page; `barTime(n) = (n−1)·BAR`. Cuts are hard on bar lines; the page never hard-codes seconds, it computes `beat/bar/kickPhase` from `t`.

**Drop = bar 7 = 10.909091 s.** Confirmed on the delivered MP4 with `audio.levels` on a 132 bpm bar grid (`from 10.909091 to 12.727273`, the section where the music jumps): the song's own bar-7 section is **+4.1 LU** over the build bar, and the mix adds a **+3 dB fader step** exactly on the drop kick (two music clips joined at 10.905 s with 30 ms fades), so the bed rises ≈7 dB at the drop.

## Story beats (bar → picture / sound / words)
| bar | picture | words (all slam on the kick, then crack) |
|---|---|---|
| 1 | giant speaker-foot planted in the street, dust ring, camera shake (frame 1 = impact frame) | **YOU HEAR IT** |
| 2–3 | low angle up the creature's legs, towers either side, windows flicker on every kick | **BEFORE YOU SEE IT** |
| 4 | close-up: the woofer eye opens | **DO NOT RUN** |
| 5 | the shoulder pod fires a cable that coils around a tower | **IT FEELS YOUR PULSE** |
| 6 | pull-back, the floor grid lifts and tilts, red EMERGENCY bar, kick drops to 2 beats | **BRACE** then **3 · 2 · 1** on beats 2-3-4 |
| **7** | **DROP**: the kaiju stands up, shockwave rings, magenta flood, full reveal | — |
| 8–11 | rave: stomping feet, windows become an equaliser, wide / feet / face / skyline cuts | **NOT ATTACKING** (bar 9), **IT'S DANCING** (bar 10) |
| 12–13 | rooftop crowd jumping on the beat, the creature bows | — |
| 14 | endcard on the last downbeat | **ON THE ONE** + **EP 1 · KICKDRUM KAIJU** |

## Decisions
- **Music** (`song.strudel`): hard techno, 909 four-on-the-floor, offbeat open hats, claps on 2/4, an acid saw line with a sine-swept low-pass, a white-noise riser + snare roll in the build, and at the drop a supersaw stab, a sub and a crash. Structure is built from `gate(a,b)` masks over 14 cycles (`cat()` = one value per cycle). All parts carry an evening-out `all(x => x.postgain(0.25))` so the render never clips (music.render does not limit).
- **Kaiju** is drawn from truncated speaker cones (dark near-opaque bodies, bright rims, concentric cone rings, ribs); two big woofer eyes that open on the build and burn at the drop; 4 stacked woofers pump on every kick; alternating feet stomp on every kick after the drop; it bows in bar 13. Height 23 units crouched → 37.5 standing, so the stand-up at the drop is a real scale change.
- **Word effect**: each word is rasterised once into an offscreen canvas (heavy all-caps, squeezed 16 % horizontally for a condensed look, white core + neon stroke), tinted red and cyan copies give the chromatic split on impact, and the block is cut into 8–10 rectangular shards that jitter on the hats and shatter outward on the next kick with rotation and gravity. Frame 1 already shows the crack: `w1` starts 0.10 s before t=0 with a shortened slam and a 4 px pre-pop, so frame 1 is a big legible word that is already cracking.
- **Look**: everything is hand-projected 3D wireframe on canvas 2D (no libraries, no WebGL). ~110 buildings in four rings (hero / mid / far / horizon), dark fills on the near faces, bright neon edges, equaliser windows, a perspective ground grid that warps upward in the build, dust rings on every stomp, a double shockwave in the air at the drop, CRT scanlines + roll bar + vignette, and a 4–7 frame slice tear on every bar cut (plus a white flash on the drop frame).
- **Voice**: 2nd person emergency broadcast — `en_US-kristin-medium`, `length_scale 0.95`, then `audio.process`: band-pass 280–3600 Hz, compressor drive, 38 ms slap-back, peak −3 dBFS. 5 narrative lines in 6 clips ≈ 8.3 s of speech out of 25.5 s (a third of the piece; never over the drop).
- **Mix**: `dialogue-anchored` preset shape (dialogue clip-levelled + gentle compression, music straight through with a static −3 dB EQ pocket at 2 kHz, **no ducking**), but the music rides 6 LU under the dialogue (not 9) and the master target is −14 LUFS (not −16). SFX sit 14 LU under the dialogue with a light look-ahead sidechain; the glass cracks are on their own `impact` track (−7 LU) so the sidechain does not eat them.
- **SFX** (`sfx/kaiju-sfx.mjs`, 5 sounds): `glass_crack_a/b` under every slammed word, `radio_static` before each broadcast line, `alert_beep` under BRACE, `sub_thump` under the drop shockwave. No extra impact on kicks — the kick *is* the footstep.

## Measurements
- `music.render` (27.05 s with tail): peak −3.9 dBFS, 0 clipped samples, per-bar LUFS bar1 −22.4 → bar7 (drop) −19.4, bar6 (build) −23.5 → the drop is **+4.1 LU** over the build. Warnings: "low end dominates" only — the band split is 76 % low / 22 % mid / 2 % high, expected for a 909 kick + sub + acid bed; the words live in a 280–3600 Hz pocket, and the speech-ratio below shows they stay clear.
- Speech-to-background (dialogue stem vs music stem, 300–3400 Hz): **12.2 – 19.4 dB, median 17.5 dB** → the words are never in doubt (the reference "accepted" mix ran 14–23 dB).
- Per-bar LUFS of the delivered file: `[-10.6, -19.3, -20.9, -13.9, -11.4, -13.1, -15.4, -16.3, -12.9, -12.8, -16.2, -16.1, -16.2, -15.7]`. The loudest bars are the ones carrying a voice line — the price of a dialogue-anchored balance; the *bed* is what jumps at the drop (music straight through, no ducking).
- Picture: 764 frames, 0 stalls, 0 page_errors. 25.47 s of 1080p30 took 169 s of render with 5 workers.
- Encode check with `media.frames` (15 frames) + `ffmpeg signalstats` on every frame: no near-black frame (min YAVG ≈ 22 in the darkest second), the last frame has full content (YAVG 31.9), and per-second YMAX peaks at 220–227 exactly in the seconds containing word slams (0–3, 5–6, 7–8, 9–11) — an objective confirmation that the words land on their beats.

## Sources / files
- `scene.html` — the whole picture (single page, `window.__motion.seek(t)`; every frame is a pure function of t, seeded PRNG only).
- `song.strudel`, `sfx/kaiju-sfx.mjs`, `jobs/*.json` — every job as submitted.
- Review stills and contact sheets live in the job outputs (see the table below), e.g. the delivered-frame sheet `job_01a1b2fa79cf72dab4dc595264b21452/out/sheet.jpg`. The `review/` folder in the episode is kept empty on purpose: `picture.stills`/`media.frames` outputs already sit in `.mx/jobs/<id>/out/` and are read from there.

## Jobs and pins
| what | job |
|---|---|
| music (final, delivered) | `job_01a1b2e0477f75a0b50844fd74c9f827` |
| voice takes (piper kristin) | `job_01a1b2ded3b0728297affb263015a805` |
| voice processed (broadcast PA) | `job_01a1b2def20f770885f6665022a9e679` |
| sfx (5 sounds) | `job_01a1b2df583374e4bca3e0358325458c` |
| mix v1 (rejected: −1.2 dBTP) | `job_01a1b2e981d2720a8cfe2343b171cac4` |
| **mix (delivered)** | `job_01a1b2ea3505777b88c00ba9e6b4b64f` |
| render v1 (superseded: frame 1 foot too faint) | `job_01a1b2f30e4b7126acb453f29f2eba91` |
| **render v2 (delivered)** | `job_01a1b2f79e0670d1ab3540d3f97610b8` |
| stills/contact sheets | `job_01a1b2e3f9e672aa81df11be926ea891`, `job_01a1b2e5a02e74ba984ebc4241599b1e`, `job_01a1b2fa641c76c0a45b91ebf63862ee` (delivered MP4 frames) + `job_01a1b2fa79cf72dab4dc595264b21452` (sheet) |
| 5 s draft render (motion/timing check) | `job_01a1b2eaa21d7608a2fc60aa3967c333` |

Pins (all under `onthe1/ep1-kickdrum-kaiju/…`):
- `voice` → `job_01a1b2def20f770885f6665022a9e679` (approved broadcast voice)
- `music` → `job_01a1b2e0477f75a0b50844fd74c9f827`
- `sfx` → `job_01a1b2df583374e4bca3e0358325458c`
- `mix` → `job_01a1b2ea3505777b88c00ba9e6b4b64f`
- `final` → `job_01a1b2f79e0670d1ab3540d3f97610b8` (re-pinned after the frame-1 fix; the v1 pin stays in the history)

## What went wrong (and the fix)
1. **Strudel mini-notation vs string literals.** A runtime-built `"<0 0 1>"` mask does not parse (a string literal *is* mini-notation: a lone `<` or a plain `" "` fails). Fixed by building masks with `cat(...)` from an array — and `cat` is also the correct one-value-per-cycle primitive; my first working version used `sequence()`, which puts all 14 gates *inside* every bar, so every bar measured an identical −21.0 LUFS. `audio.levels` on the bar grid caught it immediately.
2. **Canvas `multiply` tinting.** Multiplying a tint over a transparent canvas yields the tint colour, not transparency, so every word came out as a pale rectangle. Fixed with `source-in`.
3. **Double-scaled slam.** The word's shards were positioned *and* transformed by the slam scale, so frame 1 was a 3× word covering everything. Fixed by letting the transform do the scaling.
4. **Near-plane clipping.** Rings (dust, shockwave) vanished whenever one vertex fell behind the camera; the polyline now breaks instead of dropping the whole ring.
5. **The drop was quieter than the talking bars.** With music 9 LU under the dialogue, the drop bar measured −17 LUFS while voice bars hit −10.6. Fixed by riding the music to −6 LU and adding the +3 dB step at the drop; in hindsight the bed jump should have been planned for in the song sketch.
6. **Mix v1 was 0.3 dB over the ceiling** (−1.2 dBTP): the master limiter overshoots. Re-ran the mix with `true_peak_db −1.9`, which measures −1.7 on the final file.
7. **Frame 1 was too dark.** The creature was drawn at 47 % alpha in the intro (`0.35 + 0.65·energy`), so the slamming foot on frame 1 — the hook — was almost invisible. Raised to `0.82 + 0.18·energy` and pre-aged the opening dust ring by 0.2 s so frame 1 already shows it expanding. Cost one extra full render (`job_01a1b2f79e0670d1ab3540d3f97610b8`); v1 is kept as a job (and in the pin history) for comparison.
8. **Tool oddity:** in this environment `media.frames` (and `media.ffmpeg` writing PNG/JPEG) silently produce no output files when pointed at a `job:` ref or `.mx/jobs/…` path; the same `media.frames` call succeeds on a workspace path under `episodes/…/out/`. `ffmpeg signalstats` to a `.txt` works, and `picture.stills`/`image.contact-sheet` work, so the review loop used those.

## What I would improve next
1. **The creature's body still reads as a stack of rings from some angles.** I would model the woofers as fewer, much wider cones with an inner cone surface (two rings + a radial spoke) rather than concentric circles, and add a shoulder line that connects the cones into one silhouette.
2. **The drop's stand-up is under-sold** because the camera pulls back at the same time. Next time: hold the camera still for the first 4 frames of the drop (a real impact hold), then pull back — `pacing.md`'s "hold the frame under the impact". I would also storyboard the hook frame as a still *before* building the shot: I only caught the faint-foot problem by looking at the rendered frame 1.
3. **Bars 8–11 could cut more often** (on 2-bar blocks the wide/feet/face/skyline set is a little slow for hard techno); half-bar cuts on the 8th would lift the rave.
4. **The build bar is the loudest bar in the mix** (−13.1 LUFS) partly because the alert beep and the countdown cracks stack up. I would pull the beep 3 dB and use thin countdown ticks instead.
5. **Stereo width is modest** (0.14 on the music bed): a proper `jux`/haas layer on the acid and hats would widen the rave.
