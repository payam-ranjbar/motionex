# EP3: HEIST ON THE OFFBEAT (id: ep3-offbeat-heist)

**Hook line:** three raccoon thieves crack a vault; every move has to land on the offbeat.

- **Music**: funk breakbeat, 110 bpm. Breakbeat drums, slap bass, horn stabs, wah guitar. One bar = 2.1818 s. 12 bars = 26.18 s.
- **Look**: paper-cut collage noir. Cut-paper shapes with drop shadows, halftone dot textures, a cream / black / one hot orange palette, comic-panel SPLIT SCREENS (2–4 panels) that slide and resize on beats.
- **Characters**: a crew of three raccoon thieves with distinct silhouettes:
  - **Rocco**: tall, the lookout, sunglasses.
  - **Pip**: tiny, the locksmith, a huge stethoscope.
  - **Big Tuna**: round, "the muscle", always eating.
- **POV and narration**: THIRD PERSON, a SPORTS COMMENTATOR calling the heist play by play: fast, excited, slightly unhinged. Voice `en_US-norman-medium`, length_scale ~0.82, then `audio.process` `tempo` ~1.1 and a bright "stadium PA" EQ with light compression.

## Beat map (bar n starts at (n-1) × 2.1818 s)
| Bars | Picture | Sound | Words |
|---|---|---|---|
| 1 (frame 1!) | Smash open: three panels slam in on beat 1, a raccoon face in each (eyes snap open on the snare) | breakbeat drops in immediately | **"AND THEY'RE IN!"** (voice) as a comic burst |
| 2–3 | Panels slide: Rocco on the roof, Pip at the door, Big Tuna… eating; each move is ON THE OFFBEAT (hats) | + slap bass | "Rocco on lookout, Pip on the locks, and Big Tuna on… snacks?" (voice) |
| 4–5 | A laser grid; the crew dodge through it in rhythm (a step on each offbeat); the split-flap clock counts down on beats | + wah guitar, tension horns | "Three seconds on the clock—" (voice, bar 5) |
| **6 = DROP (t = 10.91 s)** | The VAULT DOOR spins open in one full-screen panel; gold coins explode outward as paper confetti; the halftone flashes orange | full horn stab section plus a crash | **"THE VAULT IS OPEN!"** (voice), stamped |
| 7–9 | The escape montage: panels multiply 1 → 2 → 4 → 8 on bars, each with a micro-gag (Tuna carrying a sandwich instead of gold) | full groove | none (let the groove ride) |
| 10–11 | The getaway: a paper car slides through panels; the alarm light pulses on the beat; then the reveal: the "vault" was a FRIDGE | groove + a siren synth | "They're gone. Unbelievable." (voice, bar 10) |
| 12 | ENDCARD: "ON THE ONE" + "EP 3 · HEIST ON THE OFFBEAT" as a paper title card stamped on the downbeat | final horn hit | none |

## Word effect
COMIC ONOMATOPOEIA STAMPS that land exactly on the offbeats and snares: SNAP! CLICK! SHH! KA-CHUNK! They are paper cut-outs with a jagged burst behind them; they rotate a few degrees in, overshoot, and settle. Also a split-flap counter (airport-board style) that flips digits on every beat for the countdown. Commentator lines also appear as lower-third TICKER text that slides in, in sports-broadcast style.

## Music sketch (Strudel)
- `setcpm(110/4)`; a breakbeat, for example `s("bd ~ ~ bd ~ ~ sd ~ , ~ hh ~ hh ~ hh ~ hh")` with ghost snares, or slice a break sample if the bank has one.
- Slap bass: `note(...).s("gm_slap_bass_1")`. Horn stabs: `s("gm_brass_section")` on accents. A wah guitar: `s("gm_electric_guitar_muted")` with an lpf LFO.
- The drop at cycle 5 (bar 6) gets a full horn hit. Use a `span()` mask.

## SFX
A paper-swish whenever a panel slides (`swish`), a click on the safe dial ticks, a big `burst` on the vault opening. Keep them few; the onomatopoeia is mostly visual.

Follow `AGENTS.md`. End with a `## Result` section: the status, the final MP4 path, its duration, loudness and size, and what you would improve.
