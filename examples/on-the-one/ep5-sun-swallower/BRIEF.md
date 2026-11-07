# EP5: THE SUN SWALLOWER (id: ep5-sun-swallower)

**Hook line:** a myth. A serpent swallows the sun, and a drummer drums it back up, on the one.

- **Music**: Persian techno, 124 bpm. A four-on-the-floor kick fused with tombak/daf-style hand-drum patterns and a santur-like melody in a Persian mode (Shur / Phrygian-dominant colour). One bar = 1.9355 s. 14 bars = 27.10 s.
- **Look**: a psychedelic myth poster meets Persian miniature painting. Flat perspective, gold leaf and lapis blue, turquoise, vermilion; ornamental borders (arabesque and tile patterns) that rotate and pulse on the beat; a sun with a face; star fields as gold dots.
- **Characters**:
  - **THE AZHDAHA**: a long serpent-dragon with a tiled, scaled body, coiling across the frame.
  - **THE DRUMMER**: a small figure in miniature-painting style, with a frame drum (daf).
- **POV and narration**: a MYTHIC STORYTELLER: an old, warm, slow voice telling a legend. Voice `en_US-norman-medium`, length_scale ~1.15, pitched down (−2 semitones), a warm low shelf and a gentle hall reverb (aecho with long decay), so it sounds like a story told by the fire.

## Beat map (bar n starts at (n-1) × 1.9355 s)
| Bars | Picture | Music | Words |
|---|---|---|---|
| 1 (frame 1!) | Open ON the sun's face in gold, pulsing on the kick, surrounded by a rotating tile mandala | kick + daf hits | **"LONG AGO"**, drawn in reed-pen strokes |
| 2–3 | Pull back: the world in lapis and gold; the serpent's tail slides through the border ornaments on the offbeats | + tombak pattern, drone | "Long ago, the sun still had a heartbeat." (voice) |
| 4–5 | The AZHDAHA rises and SWALLOWS THE SUN; the frame goes dark, only the gold outline of the serpent glows in rhythm (its scales light up like an equaliser) | the drums thin out, the kick keeps going, a low drone | "Then the serpent swallowed it." (voice, bar 4) |
| 6 | Darkness; a tiny drummer climbs a mountain of stars (one step per beat) | the daf alone, building, a riser | "So a drummer climbed the dark… and played." (voice) |
| 7 | The drummer strikes the daf four times; each strike sends a gold ring through the serpent | 4 big hand-drum hits, the kick stops on the last 2 beats | none |
| **8 = DROP (t = 13.55 s)** | The serpent SPITS OUT THE SUN on the one: an explosion of gold and colour, mandalas spinning, the whole frame dancing | full Persian techno: kick, tombak groove, santur riff, bass | none |
| 9–12 | Celebration: the serpent dances in coils to the groove; tiles flip colour on beats; the sun pulses; stars rain | full groove | "And that's why," (bar 10) … **"WE DANCE ON THE ONE."** (bar 11) |
| 13–14 | ENDCARD: "ON THE ONE" + "EP 5 · THE SUN SWALLOWER" in gold calligraphic stroke reveal inside an ornamental frame, on the final downbeat | final kick + daf | none |

## Word effect
CALLIGRAPHIC STROKE REVEAL: words are DRAWN as if by a reed pen, stroke by stroke (animate an SVG `stroke-dashoffset`, or a canvas path reveal) in gold with ink-blot dots. The reveal speed rides the tombak rolls; the last stroke lands on the beat. Use an elegant serif or calligraphic display font (load it before `ready`). An optional small Persian word in Aref Ruqaa beside the English (for example "خورشید", sun) is a nice touch.

## Music sketch (Strudel)
- `setcpm(124/4)`; `s("bd*4").bank("RolandTR909")`.
- Hand drums from the default banks: try `s("tabla")`, `s("tabla2")` or `s("perc")` with a 6/8-feel accent pattern over 4/4; a frame-drum low "dum" plus a high "tak".
- The santur-like riff: `note(...).s("gm_dulcimer")` (a hammered dulcimer is close to a santur) in a mode like `C phrygian dominant` (C D♭ E F G A♭ B♭); a sub bass.
- The drop at cycle 7 (bar 8) brings everything in. Use a `span()` mask.

## SFX
A gold shimmer when words draw, a big low `thump` plus a `burst` when the sun is spat out, soft `swish`es on serpent coils. Keep them few.

Follow `AGENTS.md`. End with a `## Result` section: the status, the final MP4 path, its duration, loudness and size, and what you would improve.
