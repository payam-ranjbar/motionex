# EP2: ONE PIXEL (id: ep2-one-pixel)

**Hook line:** a single lonely pixel finds a beat, and becomes part of a picture.

- **Music**: deep house, 122 bpm, warm and bouncy. One bar = 1.9672 s. 13 bars = 25.57 s.
- **Look**: flat pixel-art minimalism. One big chunky grid (for example 27 × 48 cells on 1080 × 1920; each cell 40 px). Background a soft off-white, cells in ink black, and ONE accent colour (coral #FF5A4E) that belongs to our hero.
- **Character**: ONE PIXEL, a single coral square with a tiny 2-pixel face (two dots for eyes) that blinks. It squashes and stretches on the beat, a little shy.
- **POV and narration**: FIRST PERSON, shy, deadpan, a bit funny. Voice `en_US-joe-medium`, length_scale ~1.05, close and dry (a touch of warmth EQ, no reverb). Small voice, big world.

## Beat map (bar n starts at (n-1) × 1.9672 s)
| Bars | Picture | Sound | Words |
|---|---|---|---|
| 1 (frame 1!) | Empty white grid, the coral pixel POPS in at centre on beat 1 (squash), blinks at the camera | soft kick + a single blip | **"HI."**, assembled from pixels |
| 2 | It hops one cell on every kick, looks around; nobody there | + offbeat hats | "I'm one pixel." (voice) |
| 3–4 | It tries to stand out: grows 2×, flashes; the camera zooms out and it becomes tiny in a huge grid | + deep bassline | "Nobody sees one pixel." (voice, bar 3) |
| 5–6 | It starts bouncing ON THE BEAT; each bounce leaves a black pixel behind; the trail starts drawing a rhythm line (a waveform made of pixels) | + chords (e-piano / organ stabs), claps | "So I found a beat." (voice, bar 5) |
| **7 = DROP (t = 11.80 s)** | Hundreds of pixels rain in on the kick, snap to the grid in beat-quantised waves and assemble a BIG pixel-art picture (a dancing crowd, or a giant face that smiles) where our coral pixel is the heart or eye | full groove, filter opens, vocal-chop-style synth stab | none |
| 8–11 | The picture dances: whole rows shift on the offbeat, colour cycles every bar (pixel palette swaps), our pixel winks | groove | "Now I'm part of something." (bar 10) |
| 12 | The picture explodes back to a scattered grid; our pixel in the middle bows | breakdown, filter closes | **"BIG."** in pixel font |
| 13 | ENDCARD: "ON THE ONE" + "EP 2 · ONE PIXEL" in chunky pixel type that assembles on beats | final kick | none |

## Word effect
Letters ASSEMBLE out of individual pixels flying in from random grid cells (seeded), quantised to arrive on the beat. On the offbeat after a line finishes they fall apart like Tetris pieces dropping off the bottom. Chunky 5×7 pixel font drawn on the same grid.

## Music sketch (Strudel)
- `setcpm(122/4)`; a soft `s("bd*4").bank("RolandTR909").gain(.8)`; `s("~ hh ~ hh")`; a shuffled shaker.
- A sine/sub bassline; chords such as `chord("<Am9 Dm9 Gmaj7 Cmaj7>").voicing()` with `.s("gm_epiano1")`; a square-wave "pixel blip" lead.
- The drop (cycle 6) opens a low-pass on everything. Use a `span()` mask.

## SFX
Tiny 8-bit `ui_blip`s on the pixel's hops (pitched up a step each hop), a soft `swish` when the pixels rain in.

Follow `AGENTS.md`. End with a `## Result` section: the status, the final MP4 path, its duration, loudness and size, and what you would improve.
