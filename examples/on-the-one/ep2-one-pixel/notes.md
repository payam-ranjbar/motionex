# EP2 · ONE PIXEL — production notes

Deliverable: `out/ep2-one-pixel.mp4` — 1080×1920, 30 fps, H.264 (yuv420p, bt709/tv) + AAC 48 kHz
stereo 256 kbps, **25.567 s**, **10.2 MB**, **−14.0 LUFS integrated**, **−2.2 dBTP** true peak.
Pinned as `onthe1/ep2-one-pixel/final`.

## The idea

One coral pixel on a flat 27 × 48 pixel grid (40 px cells, off-white paper `#F2EEE6`, ink `#16171A`,
accent coral `#FF5A4E`). It pops in on beat 1, hops, tries to be seen, then finds a beat and at bar 7
becomes **the right eye of a giant smiling picture** — the rest of the face and a crowd of little pixel
people rain in on the four beats of that bar, in beat-quantised waves. Bars 8–11 the whole picture
dances and the palette hard-cuts every bar. Bar 12 the picture explodes back to a loose grid and the
pixel bows. Bar 13 is the endcard.

Three things I added on top of the brief:

1. **The camera gag is a grid-resolution gag.** Instead of a zoom, the grid gets *finer*: 27 columns →
   77 columns (14 px cells), so the hero becomes a speck in a huge grid without anything leaving frame.
   It snaps back to 27 columns on bar 5 beat 1.
2. **The bounce trail becomes the smile.** During bars 5–6 the hero bounces across the whole width at
   16th-note resolution, leaving ink pixels snapped to the grid — a waveform made of pixels. At the drop
   those trail pixels fly up and become the picture's smile, so the rhythm line literally turns into the
   face's mouth. (The wave-2 head cells deliberately exclude the smile; the smile comes only from the trail.)
3. **The hero IS the right eye.** It is never re-drawn as a face cell: it streaks from the centre to the
   3 × 3 eye position over 0.34 s at the drop and stays there, winking, then returns to the middle to bow.

## Beat map (122 bpm, bar = 1.967213 s, 13 bars = 25.5738 s)

| Bar | t | Picture | Words on screen | Voice |
|---|---|---|---|---|
| 1 | 0.000 | grid empty, coral pixel POPS in on beat 1 (squash + coral shockwave), blinks | **HI.** (already assembled in frame 1) | "I'm one pixel." @0.50 |
| 2 | 1.967 | hops one cell per kick (arc per beat) | | |
| 3 | 3.934 | grows 2×, flashes white on every kick — trying to be seen | **NOBODY** | "Nobody sees one pixel." @4.15 |
| 4 | 5.902 | camera pulls out: grid 27 → 77 columns, it is now a 28 px speck still flashing | **SEES ME.** | |
| 5 | 7.869 | camera snaps back in (77 → 27 cols in 0.35 s), bounces across the width leaving a pixel trail | **A BEAT.** | "So I found a beat." @8.05 |
| 6 | 9.836 | the trail draws the whole waveform | | |
| **7** | **11.803** | **DROP.** Coral flash + shake. Pixels rain in on the kick in 4 beat-quantised waves and snap to the grid: head, then lower head, then the trail becomes the smile, then the crowd. | — | — |
| 8 | 13.770 | full picture, palette → ink bg / paper face | | |
| 9 | 15.738 | palette → coral face; rows shift on the offbeat; the hero winks on beat 3 | | |
| 10 | 17.705 | palette → night blue | **PART OF** | "Now I'm part of something." @17.95 |
| 11 | 19.672 | palette → paper / ink face | **IT ALL.** | |
| 12 | 21.639 | picture explodes back to a scattered grid; the hero returns to the middle and bows | **BIG.** | "Big." @21.85 |
| 13 | 23.607 | ENDCARD assembles on beats: ON / THE / ONE / EP 2 / ONE PIXEL; the coral pixel sits under the title blinking | endcard | — |

Words assemble out of individual pixels flying in from seeded random grid cells, in 4 waves on 8th notes,
so every word is **complete exactly on its bar's downbeat**. On the offbeat after its line it falls apart
like Tetris pieces (gravity + spin). Each word sits on a flat paper "sticker" with an ink border so it
always reads against the picture. Font: hand-built 5 × 7 bitmap (A–Z, 0–9, `. , ! ? ' - : ·`), auto-fitted
to the 994 px safe width and the 250–1520 px safe band.

## Jobs

| step | job id | note |
|---|---|---|
| music v1 | `job_01a1b2e00a6076d0a93f7b4fd05fe2d0` | peak **+4.7 dBFS, 4786 clipped samples** — thrown away |
| music v2 | `job_01a1b2e08a387035a26e6685793edc84` | `postgain(0.5)` + `.hpf()` on melodic parts → peak −1.2 |
| **music v3 (used)** | `job_01a1b2e0e9ee7044accc0a4dcf29659d` | peak −0.6 dBFS, crest 17.7, **warnings: []** (every sound name resolved) |
| voice (piper) | `job_01a1b2e02a9473c486bae075f2d124be` | `en_US-joe-medium`, length_scale 1.05 |
| **voice fx (used)** | `job_01a1b2e0450273e096bb678c1ceef87a` | HPF 95 + comp + warmth, +0.6 st, peak −3 dB, mono 48 k |
| voice fx v2 (tested, rejected) | `job_01a1b2e95fe677e69d744e80a9a1a6f7` | heavier 2-stage comp — measured *worse* speech ratio, so not used |
| **sfx (used)** | `job_01a1b2e268df7308a21042698732853a` | 11 sounds, all rendered |
| **mix (used)** | `job_01a1b2ecd7d2751096c7281b2b19cf08` | −14.0 LUFS, −2.2 dBTP |
| mix (rejected) | `job_01a1b2e9fb6d74338a14d2133ffd5888` | −14.2 LUFS / −1.5 dBTP — the AAC encode overshot to −1.4 dBTP |
| render v1 | `job_01a1b2ea65e7723e8c3c12e0d7629ef1` | 767 frames, 0 stalls, but −1.4 dBTP |
| **render (used)** | `job_01a1b2ed046b71d580968b1a274891d4` | 767 frames, 0 stalls, 0 page errors, 47.7 s render |
| stills reviews | `job_01a1b2e3364074afa4a214254d21562d`, `job_01a1b2e4880c7076aba20a3b2b2a2329`, `job_01a1b2e65d877638b1df47a6f51cf85e`, `job_01a1b2e70834751cb4cfd140ecf3c01a` | 4 rounds, 12–15 stills each |
| contact sheets | `job_01a1b2e34b0d70f3a62930e04f8cdd39`, `job_01a1b2e5a629734bb3eb84e1c4cdea61`, `job_01a1b2e6786774fcbcc46d22fe9a8916`, `job_01a1b2e710b870dd8398ef240a12d921`, `job_01a1b2f138a97467a5d8b09a1377a42e` | the last one is from the encoded MP4 |
| final frames | `job_01a1b2f1074e703bab17249601feae8c` | 12 PNGs out of `out/ep2-one-pixel.mp4` |

Pins: `onthe1/ep2-one-pixel/{final, mix, music, voice, voice-l2..l5}`.

## What I measured

**Music, per bar (`audio.levels`, 122 bpm grid on `music.wav`)** — the drop is the loudest bar:

```
bar  1  -17.92      bar  5  -17.42      bar  9  -16.80      bar 13  -14.93
bar  2  -17.93      bar  6  -17.39      bar 10  -15.97      tail   -21.51
bar  3  -17.35      bar  7  -14.60  <-- DROP
bar  4  -17.30      bar  8  -17.15      bar 11  -16.15
                                        bar 12  -16.68 (breakdown)
```
The drop is 2.8 LU above the bar-6 build; the final endcard hit sits just under it at −14.93.

**Final MP4 (`audio.loudness` on `out/ep2-one-pixel.mp4`)**: −14.0 LUFS, LRA 3.6 LU,
sample peak −2.4 dBFS, **true peak −2.2 dBTP**.

**Speech-to-background ratio (`audio.speech-ratio`, dialogue stem vs music stem)**:

| line | window | ratio |
|---|---|---|
| 1 "I'm one pixel." | 0.50–1.50 | 14.06 dB |
| 2 "Nobody sees one pixel." | 4.10–5.80 | 15.09 dB |
| 3 "So I found a beat." | 8.00–9.00 | 16.48 dB |
| 4 "Now I'm part of something." | 18.00–19.30 | 7.53 dB |
| 5 "Big." | 21.80–22.10 | 17.72 dB |

median 15.09 dB, min 7.53 dB. Line 4 lands on the hottest groove bar; that is the same
"6–8 dB at the climax" band the reference mix was accepted at. There is **no ducking** anywhere:
the music is one clip at a static −4 dB with a static −3.5 dB pocket at 1.4–3.6 kHz plus a gentle
peak compressor, and the voice is 4 dB up on it.

**Picture**: 767 frames, 0 stalls, 0 `page_errors`, 47.7 s of render at 4 workers.

## What went wrong (and the fix)

- **Strudel render clipped**: first take peaked at +4.7 dBFS with 4786 clipped samples. Fixed with a flat
  `all(x => x.postgain(0.5))` (a trim, not a balance change) plus `.hpf()` on the e-piano, strings and lead.
- **Wrong bar arithmetic in the hero path.** Bars 5–6 were computed from `5*BAR` instead of `4*BAR`, so
  during the whole trail section the pixel was drawn off to the left of where the trail was. Caught by a
  still that should have shown the hero and the trail and showed neither. Fixed in both `heroAt` and `trailAt`.
- **Endcard lines overlapped.** I spaced them by 220 px while a 46 px font pixel makes a 322 px line.
  Fixed by pinning explicit sizes and y positions and checking the arithmetic (fs 32 / 32 / 32 / 20 / 18 at
  y 400 / 650 / 900 / 1230 / 1390 → spans 288–1453, inside the 250–1520 safe band).
- **Words were invisible over the face.** In the night-blue palette the word colour and the face colour were
  both cream. Fixed with the paper "sticker" plate behind each word.
- **Frame 1 was washed out.** A white impact flash was still at 31% on frame 0, greying the big "HI.".
  Replaced with a 26% coral flash that decays in 3 frames, so the type stays crisp.
- **The hero was invisible during the trail.** The grid was still at 77 columns (14 px cells) at the start of
  bar 5. Fixed by moving the snap-back to bar 5 beat 1 (0.35 s) and snapping the trail to the 40 px grid.
- **The AAC encode overshot the ceiling.** The mix was mastered to −1.5 dBTP, but AAC added inter-sample
  peaks and the MP4 measured −1.4 dBTP. Fixed by mastering to −2.2 dBTP and encoding the audio at 256 kbps;
  the MP4 now measures −2.2 dBTP.
- **Dead frame at t = 3.0 s.** Between "HI." falling apart (2.86 s) and "NOBODY" starting to assemble
  (3.20 s) only the tiny hopping pixel is on screen. Kept deliberately — it is the "nobody sees me" beat —
  but it is the one place I would tighten if I had another pass.

## Files

- `scene.html` — the whole episode, one canvas page, pure `seek(t)`, no external assets.
- `song.strudel` — 13 bars of deep house with the markers `INTRO BASS CHORD DROP BREAK END`.
- `sfx/ep2-sfx.mjs` — 11 recipes (`hop1..hop4`, `blink`, `assemble`, `swish_in`, `land`, `scatter`, `bow`, `final`).
- `jobs/*.json` — every job request; `jobs/out/*.json` — the job responses (ids, measurements, warnings).

## What I would improve next

1. Fill the 2.9–3.2 s gap so there is never a frame without a word or a bigger move.
2. The crowd figures are simple coral blocks; real 3-cell-tall pixel people with legs would sell the
   "dancing crowd" reading better at bar 8–11.
3. Give line 4 its own section pocket (a *static* −2 dB on the music only for bars 10–11) rather than
   relying on the global 1–3.6 kHz dip, so the climax line clears 10 dB instead of 7.5.
4. Bars 8–11 all use the same row-shift dance; a second move (columns sliding, or the head rotating a
   quarter turn on each bar) would make the four palette swaps feel like four different pictures.
