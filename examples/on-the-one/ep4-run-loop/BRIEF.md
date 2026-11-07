# EP4: RUN LOOP (id: ep4-run-loop)

**Hook line:** a runner trapped in a 4-second time loop; every loop the beat adds a layer, until he breaks out.

- **Music**: minimal techno that builds to driving techno, 128 bpm. One bar = 1.875 s. 14 bars = 26.25 s. Each LOOP is 2 bars (3.75 s) and ADDS one music layer.
- **Look**: two-colour RISOGRAPH print. Fluorescent pink (#FF48B0) and deep blue (#2B3BD4) overprinting on paper cream; ink-brush strokes, grain, slight misregistration (the colour layers offset by a few pixels and jittering on hats). Each loop adds a colour or ink layer.
- **Character**: THE RUNNER, a lean brush-stroke silhouette in mid-sprint, with a run cycle drawn in 4–6 poses that step exactly on the kick (one footfall per beat).
- **POV and narration**: INNER MONOLOGUE: close, breathy, short words that repeat and mutate. Voice `en_US-john-medium`, length_scale ~1.1, close and dry, slightly pitched down (−1 semitone), no reverb (inside his head).

## Beat map (bar n starts at (n-1) × 1.875 s)
| Bars | Loop | Picture | Music layer | Words |
|---|---|---|---|---|
| 1–2 (frame 1!) | L1 | Mid-sprint already (never standing still), blue ink only; the same street with lamp posts passing on each beat; a CLOCK sign in the background shows 00:04 | kick only | **"AGAIN."** stamped in brush type |
| 3–4 | L2 | The SAME run, the same posts; pink layer added (misregistered); the runner glances at the clock | + hats | "Again." (voice, quieter); the word stacks under the first one |
| 5–6 | L3 | The same run, faster camera, motion streaks; the posts become rhythm bars | + bassline | "Faster." (voice) |
| 7–8 | L4 | Glitch: the loop stutters (a repeated frame on the off-beats); the runner LOOKS AT THE CAMERA | + synth arp, riser; the kick drops out on the last beat | "What if I don't stop?" (voice) |
| **9 = DROP (t = 15.0 s)** | BREAK OUT | He runs THROUGH the frame: the paper tears, the world explodes into full overprint colour (pink plus blue makes purple), the camera spins around him, the background is a giant stamped "1" | full driving techno: kick, bass, arp, chord stabs | none |
| 10–12 | Free | Dance-run: each footfall stamps a colour splash; the posts become dancing figures; ink splatters on snares | full | "It's not a loop." (bar 10) … **"IT'S A GROOVE."** (bar 11, huge) |
| 13–14 | Endcard | ENDCARD: "ON THE ONE" + "EP 4 · RUN LOOP" printed as two misregistered ink layers snapping into register on the final downbeat | final kick | none |

## Word effect
REPEATED WORDS STACK AND ECHO. Each loop the word appears again below the last (AGAIN / AGAIN / AGAIN) in brush type, the older ones fading into ghost ink. Every loop exactly ONE letter or word changes (AGAIN, AGAIN, FASTER, …), so the echo stack tells the story. The pink and blue print layers are misregistered on the words too.

## Music sketch (Strudel)
- `setcpm(128/4)`. Layer masks by loop with `span()`:
  - L1 kick (`s("bd*4").bank("RolandTR909")`);
  - L2 + hats (`s("~ hh ~ hh").bank("RolandTR909")`, 16th shakers);
  - L3 + rolling bass (`note("a1 [~ a1] a1 [~ a2]").s("sawtooth").lpf(400)`);
  - L4 + arp (`n("0 3 7 10").scale("A:minor").s("square").fast(2)`) plus a riser.
- The drop at cycle 8 (bar 9): everything plus chord stabs and a clap on 2 and 4.

## SFX
A paper TEAR on the break-out (the drop; use a `glitch_cut` plus a noise burst recipe), soft footstep ticks layered on the kick in L1 only, a tape-stop-like `whoosh_by` into the drop.

Follow `AGENTS.md`. End with a `## Result` section: the status, the final MP4 path, its duration, loudness and size, and what you would improve.
