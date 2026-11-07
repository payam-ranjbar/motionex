# EP 4 — RUN LOOP · production notes

**Logline:** a runner is trapped in a 4-second loop; every loop the print adds an ink layer and the beat
adds a layer, until the loop tears the paper and turns out to be a groove.

Deliverable: `out/ep4-run-loop.mp4` — 1080×1920, 30 fps, 28.134 s, H.264 (yuv420p, bt709) + AAC 48 kHz
stereo, 26.6 MB, **−14.3 LUFS** integrated, **−1.9 dBTP** true peak, LRA 4.7.

## The decisions

**Grid.** 128 bpm, one bar = 1.875 s. 15 bars = 28.125 s, so the whole episode is one 15-bar song with no
cuts between music and picture. Bar *n* starts at (n−1)×1.875 s. Drop = bar 9 = **15.000 s** exactly
(53% in), endcard = bars 14–15, the two plates snap into register on the final downbeat at 26.250 s.

**The loop device (the series rule "each loop adds a layer", made literal).** The page builds every frame
from a cream paper plate + a **blue** plate + a **pink** plate, multiplied together, each plate offset a few
px and jittering on the hats. The pink plate is EMPTY at first and prints one more group of elements per
loop (`pinkHas()`): L1 blue only → L2 pink joins the street and the sun → L3 the runner and the streaks →
L4 everything. So the loop escalation is visible as ink accumulating, not just as speed. Where the plates
overlap the print goes deep violet (riso overprint).

**After the drop the polarity flips.** From 15.72 s a ragged ink flood covers the frame on both plates and
the world is *punched out* of it: the runner, the street and the type are now cream paper with a blue
fringe on one side and a pink fringe on the other. The endcard goes back to ink-on-paper, in register —
mono → overprint → negative → register.

**The drop is one move, not several:** plates fly apart to ±58 px misregistration, the sheet tears along a
static jagged line and the two halves slide/rotate (±23°) apart, a 20-spoke ink burst fires from the
runner, a 2-frame cream flash lands 2 frames *after* the downbeat (so the drop frame itself is clean), and
the runner runs through the frame into a re-entry from the left, already inverted, one beat before
"IT'S NOT A LOOP."

**The runner** is a brush silhouette drawn from a tapered-disc chain (35 individual joint strokes), with a
keyframed 2-beat stride: contact → stance → toe-off → knee-up → reach, contact on every beat
(`RUNKEYS`/`footAt`). Arms pump in antiphase with elbows solved by two-circle intersection. In L4 he turns
and looks at the camera (two eye holes punched out of his head) — that pays off after the drop, where the
eyes are ink dots on the cream silhouette.

**The word effect** is baked into per-word masks (ink + knockout halo), so a word is drawn as two images
instead of glyph-by-glyph text: fast, and identical on every frame. Each word prints with a left-to-right
sweep (a printing press, 0.13 s) and carries two echoes printed further off register. Words stack in three
slots; the older word ghosts to 17% and is knocked off the slot by the next word **on the beat**. That is
how the story is told: AGAIN / AGAIN / FASTER / WHAT IF I DON'T STOP? → IT'S NOT A LOOP → IT'S A GROOVE.

**Colour.** #F1E7D6 paper, #2B3BD4 blue, #FF48B0 pink, everything multiplied, static paper fibre + static
speckle dropout (both identical every frame, so the encoder barely pays for them). Safe zone respected:
the top 12% is empty except the clock panel (which starts at y=238), the bottom 20% holds only street
debris.

## Music — `song.strudel`

`setcpm(128/4)`, one cycle = one bar, markers `LOOP2=2 LOOP3=4 LOOP4=6 DROP=8 FREE=9` (0-based cycles).
Layers enter by loop with `span()` masks, exactly as the brief asked: kick → +8th hats → +rolling bass →
+arp and a one-bar riser. Bars 7–8 pull the kick back (`.544 .530 .544 .544 .558 .544 .34 .224`) so the
drop has something to jump out of; the last beat of bar 8 has no kick at all. The drop adds crash, 16th
hats, clap on 2 and 4, chord stabs (Am7–Dm7–F^7–G7) and a driving root bass. `result.warnings` was empty on
the final render — no missing sample names, so nothing was silently skipped.

Per-bar loudness of the music (`audio.levels`, bar grid, 128 bpm):

| bar | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | **9 DROP** | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LUFS | −16.2 | −16.5 | −16.1 | −16.1 | −15.6 | −15.8 | −19.2 | −22.2 | **−15.0** | −15.3 | −15.3 | −15.4 | −15.3 | −14.8 | −14.5 |

So the drop is a **+7.2 LU** jump measured at t = 15.00 s, and bar 15 (the register snap) is the loudest
moment of the piece.

## Voice

`en_US-john-medium`, `length_scale` 1.1, then `audio.process`: pitch −1 semitone, high-pass 95 Hz, +2.5 dB
at 185 Hz, −3 dB at 4.3 kHz, gentle compressor, trimmed, peaks at −3 dBFS. Dry, no reverb (inside his head).
Five lines: "Again." / "Faster." / "What if I don't stop?" / "It's not a loop." / "It's a groove." The
fourth loop's "Again." is an echo of the first take (same file, −9 dB, low-passed, panned left) rather than
a new line — the loop repeating itself, not new narration.

Placement: 0.04, 3.79 (echo), 7.52, 11.32, 16.93, 18.42 s. "It's a groove." starts slightly before the
bar-11 downbeat so the word *groove* lands just after the type stamps on the beat.

## SFX — `sfx.mjs`

Four synthesised sounds (`sfx.synth`, seed 4): `tear` (a stream of ~240 band-passed noise grains, densest
at the attack, over a low brown-noise body and a 170→42 Hz thump), `stamp` (thud + paper slap),
`tick` (footstep, on the kick, L1 only, 8 of them), `splat` (ink splash, on every other footfall in the
free section). Plus two built-ins: `whoosh_by` (0.95 s, pitch 0.85) from 14.12 s into the drop, and a
`glitch_cut` under the tear. Stamps land on every new word (0, 3.75, 7.5, 16.875, 18.75) and on the
register snap (26.25).

## Mix

`audio.mix`, 28.125 s, three tracks, **no sidechain, no ducking**. The voice is made to sit up with a
static EQ pocket on the music (−2.5 dB at 1.1 kHz, −4.5 dB at 2.3 kHz, −2 dB at 3.6 kHz) plus a gentle
2.5:1 compressor on the dialogue bus, not by pulling the music down under each line. Music −6 dB, dialogue
+3 dB, SFX −10 dB. Master `gain+limiter` to −14 LUFS with the ceiling set to −2.2 dBTP, which measured
−1.9 dBTP (setting it to −1.5 measured −1.2, i.e. the limiter's own overshoot would have broken the spec).

Measured on the final mix:
* `audio.loudness` → −14.3 LUFS integrated, −1.9 dBTP, LRA 4.7.
* `audio.speech-ratio` (dialogue stem vs music stem) → line ratios 9.9 / 4.4 / 8.0 / 14.3 / 9.4 dB,
  median **9.4 dB**. The 4.4 dB line is the deliberate whispered echo. This is the number I would improve
  next: the words are also printed as type, so they read, but a +2 dB lift on the dialogue would put the
  median at ~11 dB.
* Per-bar `audio.levels` on the mix: bars with a line are 1–3 LU hotter than the drop bar, because the
  voice is a loud dry mono source over a techno bed — the drop still reads as the drop because the music
  jumps 7 LU and the picture changes completely.

## Review path (what I actually looked at)

Stills at ~45 time points across 9 `picture.stills` rounds, plus a contact sheet before the render, then
`media.frames` on the encoded MP4 at 0.0, 3.8, 7.6, 11.4, 13.4, 15.0, 15.35, 17.0, 19.4, 21.0, 23.0,
26.4 s and a 12-cell contact sheet of those frames. Three full renders were needed: v1 for review, v2 after
fixing frame 1 (the type's alpha ramp started at 0, so frame 1 had no word — fatal for the hook) and the
drop burst (34 spokes at 1900 px swamped the frame), v3 after making a new word knock the old one off its
slot (two words were smearing in slot 2 between 11.6 and 15.0 s).

## Job ids (motionex)

| step | job |
|---|---|
| music v1 (peak +2.3 dB, clipped — rejected) | `job_01a1b2dda323732d8413b9b784fea0a9` |
| music v2 (gain fix) | `job_01a1b2dde8757403bc242cab08acc72e` |
| music v3 (build pull-back) | `job_01a1b2de8e1072b7a688e929fdcc49d8` |
| **music final** (16-cycle kick gains + crashes) | `job_01a1b2dedb9c74fbbf6359f5e38404c5` |
| voice takes (piper) | `job_01a1b2dde85870f49bb15b34225135d0` |
| **voice processed** (pitch/EQ/trim) | `job_01a1b2de21537316b900ca8593a990fd` |
| sfx (custom recipe) | `job_01a1b2fc60fe75239afc7f4af7ef24ba` |
| sfx (built-in whoosh/glitch) | `job_01a1b2fcbae870f58cf51d4f2200a981` |
| mix v1 | `job_01a1b2fd4cd7723b8392c4428fdf6c19` |
| mix v2 (EQ pocket) | `job_01a1b2fdfdcd7488af6286c1962e7a50` |
| mix v3 (ceiling −2.2) | `job_01a1b2fe5ea3740a8df45e8d04b8d7ff` |
| **mix final** | `job_01a1b2ff38a3729f8406db81e0af8c1c` |
| render v1 (rejected: no type on frame 1) | `job_01a1b2ff880876be9889e88295b5a479` |
| render v2 (rejected: two words smearing in one slot) | `job_01a1b3094e1175df887f92f16b4667d0` |
| **render final** (26 607 598 B, 844 frames, 0 stalls, no page errors) | `job_01a1b310bdea754d86250c6a4032b1db` |

Pins: `onthe1/ep4-run-loop/{music,voice,mix,final}`.

## What went wrong / what I would fix next

* **Frame 1 was empty of type in the first render.** `wordAlpha` ramped from 0, so at t=0 the word was
  skipped entirely. Now the word starts at 62% and prints itself over 0.13 s — frame 1 already reads.
* **A hollow first glyph in the endcard.** With per-glyph `strokeText` knockouts the first glyph of each
  line lost its fill and read as a cream outline. I never found the root cause (state looked correct at
  every step); I rebuilt the type as cached per-word masks (ink image + halo image) drawn with
  `drawImage`, which is both correct and much faster, and the artifact is gone except for a faint cream
  ring inside the 'O' of "ON" where the halo (19 px) is wider than the O's own stroke — worth nudging the
  halo to `s*0.11`.
* **The 7-segment clock read as loose dashes** at first: the segment strokes were too thick for their
  length. Thinner strokes plus `q = t*0.55` gaps fixed it; it now reads 00:04 → 00:03 → 00:02 → 00:01 and
  shatters on the drop.
* **The 15.2–15.5 s tear frame has no subject** — the runner has left and the world is already inverted,
  so for about 0.4 s you are looking at torn paper. I would put the giant "1" stamp there so the money shot
  keeps a focal point.
* **`audio.mix` truncated the music clip** ("clip 0 extends past the mix length"), so the last 0.35 s fade
  is cut by the mix length instead of the clip. It measures clean (−1.9 dBTP, no click), but the tail fade
  should be done by shortening the clip, not by the mix length.
* Speech ratio 9.4 dB median is the one number I would push (see above).
