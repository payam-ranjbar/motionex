---
name: beat-film-quality
description: Quality rules and a measuring gate for short beat-driven films made with motionex (picture cut to music, 20 to 60 seconds). Use it before calling such a film finished, when a reviewer says a cut is too still, too slow, too quiet or badly mixed, or when you need to turn that kind of feedback into rules and checks. It gives numbered rules for picture, text, sound and endings, says how each is checked, and ships gate.mjs, which measures a cut through the motionex service.
---

# Beat-film quality (a suggested skill)

This is an opinion, not part of motionex. The service enforces none of it. It is one production's rules for
short films cut to music, written down after a reviewer rejected a cut that had passed every still-frame
review. Take the rules that fit your brief and change the rest.

It builds on the `motionex` skill. Its companion, `beat-film-workflow`, says in what order to work.

A rule is checked in one of three ways:

| Mark | Meaning |
|---|---|
| **GATE** | `scripts/gate.mjs` measures it. A failure means the cut is not finished. |
| **CHECK** | The gate measures it but cannot judge it. It lists the exact moments, and a person plays them. |
| **EAR / EYE** | Nothing measures it. A person listens or looks, with the gate's contact sheet. |

## How to run the gate

The gate is one file with no dependencies (Node 20 or later). It only calls the motionex service
(`MX_URL`, default `http://127.0.0.1:8095`). Run it from the workspace root.

1. In the film's folder, write `gate.json`: `{ "bpm": 132, "drop_bar": 8, "mix": "pin:myfilm/mix" }`.
   Bars count from 0, so `drop_bar` = drop time ÷ bar length. Optional: `video` (default
   `<film-dir>/out/<folder name>.mp4`), `holds` (see P2), `music_track` (the name of the music track in the
   mix, default `music`), `reference` (the folder of a cut that was accepted).
2. Run `node <this skill>/scripts/gate.mjs <film-dir>`. It writes `review/gate.md`, `review/gate.json` and
   `review/gate-sheet.png` (two frames per bar) in the film's folder. Exit code 1 means a rule fails.
3. Fix every FAIL. Play every moment marked CHECK. Go through the EAR and EYE rules with the sheet open.
4. Put the gate's summary line, and what you did about each CHECK, in your notes.

`--video <ref>`, `--mix <ref>` and `--tag <name>` measure another file, for example a first render straight
from its job: `--video job:<id>/video.mp4 --tag draft`. Without a mix job the stem rules run on the full
mix, and S6 is skipped.

The film is expected to start its music at t = 0 at a fixed tempo, so that `beat = t * bpm / 60`.

## Picture

| Id | Rule | What the reviewer said | Check |
|---|---|---|---|
| P1 | Frame 1 is a picture: not black, not a fade. | A feed shows frame 1 before anyone presses play. | GATE |
| P2 | The picture keeps moving. At most 15% of the film is still. A still stretch over 0.5 s is a decision: declare it in `gate.json` as `holds: [{from, to, why}]`, or it is listed for a look. A hold still counts toward the 15%. | "It was not dynamic, it wasn't groovy, it was too still." "I just don't want still frames." | GATE (share), CHECK (stretches) |
| P3 | Something visibly lands on at least 75% of the beats. | "The shots should be lively to the beat, at least one element should sync to the music groove." | GATE |
| P4 | No flat bar between the intro and the end card (the first and last two bars are excused). | "The pacing was too slow." | GATE |
| P5 | The surroundings react to the music, not only the hero: name the thing in each scene that moves with the kick. | "Make the boss or the surrounding also more responsive to the music." | EYE |
| P6 | One subject per shot. Moving is not the same as busy. | "Don't go overboard and make it busy; keep it simple, easy to read." | EYE |
| P7 | Cuts are slow enough to read, and the picture inside the shot never stops. Tension comes from holding a shot that still moves, not from a still. | "Make sure pacing and cuts are not too fast, and timed for tension." Then, of a cut that held still: "the pacing was too slow". | EYE, with P2 and P4 |
| P8 | In a panel piece the panels themselves come and go (slam, slide, wipe, shatter), and the layers inside a panel move at different speeds. | "More dramatic transitions and layering and parallax and paneling. Frames come and go, like in anime." | EYE |
| P9 | An effect is centred on the thing that makes it. | "The particle effect is off center." | EYE |

## Text

| Id | Rule | What the reviewer said | Check |
|---|---|---|---|
| T1 | No word just appears. Each one gets an entrance that fits what happens in its frame. | "On text, have text animation fitting the context of the frame." | EYE |
| T2 | Text keeps a clear margin from bars and boxes, in every script the film uses. Check a second-language line next to the first. | "The text is just stuck to the health bar. There's no reasonable margin like the English version." | EYE |
| T3 | No empty speech balloon. A reaction is a sound word or a symbol. A big sound word may be larger than its panel and cut by the frame. | "Remove the empty bubbles with no text." "A big WHOA, masked by the frame it's in." | EYE |
| T4 | Fonts are chosen for the piece. A non-Latin script gets a display face made for that script. | The brief. | EYE |

## Sound

| Id | Rule | What the reviewer said | Check |
|---|---|---|---|
| S1 | −14 LUFS (−15 to −13), true peak at or under −1.5 dBTP. | The delivery standard of the platform. | GATE |
| S2 | The drop lands on its bar and is the loudest bar of music so far. | "Instant quick build up, with a dramatic beat drop in the middle." | GATE |
| S3 | No silence longer than one beat. | "There was so much silence." | CHECK |
| S4 | No stripped-down stretch longer than two bars: a break keeps a pulse running. | "The pacing was too slow." | CHECK |
| S5 | The music changes at least every four bars: a new element, a fill, a pattern change. | "The beat was too repeating." | CHECK |
| S6 | Sound effects and voice lines sit under the music. None is lost either. | "The sound effects should not compete with the soundtrack. They should only be there for some engagement." | CHECK |
| S7 | Every hit and move of the hero has a sound. | "The character should have sound effects when it punches, to give the tactile impact of a video game." | EAR, with the cue list |
| S8 | One featured sound at a time. | "Everything was competing." | EAR |
| S9 | The master holds up next to a cut that was accepted: compare the table at the end of the gate report. | "Badly mastered." | EAR |
| S10 | Voice is as rare as the brief says. A few cue words carry further than a narration. | The brief. | EAR |
| S11 | A spoken line says the word right. In a script that leaves out short vowels, write them. Play each line alone before it goes in the mix. | A line went out with one vowel wrong. | EAR |

## Art and ending

| Id | Rule | What the reviewer said | Check |
|---|---|---|---|
| A1 | Generated art is transparent cut-outs layered in code. No full-frame generated picture. | "Use transparent elements, avoid using full rendered images." | EYE |
| A2 | A character keeps its look. A change of expression is painted onto the same frame, so it starts from the same pose. | "She looks too kind." "Winks with the same start frame." | EYE |
| A3 | The ending happens inside the world: the hero comes into the end card and does something, then the emblem resolves. | "The outro with a diegetic transition: the hero coming into the UI." | EYE |

## How the limits were set

The gate was run on seven cuts of four films that one reviewer had already judged.

| Cut | The verdict | Still | Beats hit | Flat bars | Gate |
|---|---|---|---|---|---|
| Film A, cut 1 | Rejected: "awful", "too still", "too slow" | 37% | 81% | 2 | fails P2, P4 |
| Film B, cut 1 | "Real good, but it lacked some dynamic" | 24% | 69% | 1 | fails P2, P3, P4 |
| Film B, cut 2 | Accepted; no complaint about motion | 11% | 84% | 0 | passes |
| Film A, cut 2 | The remake; the notes that followed were about text, the ending and a voice line | 1% | 95% | 0 | passes |
| Film A, cut 3 | Accepted | 1% | 95% | 0 | passes |
| Film C | Accepted; no complaint | 8% | 91% | 0 | passes |
| Film D | Accepted; no complaint | 6% | 89% | 0 | passes |

The picture rules separate the two criticised cuts from the five others, with room on both sides. Seven cuts
and one reviewer are a small sample: when a new verdict contradicts a limit, move the limit and add the cut
to this table.

How motion is measured: the gate pulls the film as 54×96 gray frames. A moment is still when the mean change
over 0.1 s is under 0.6 (on a 0 to 255 scale). A beat is hit when the change right on it is 1.5 times the
change around it. A bar is flat when its mean frame-to-frame change is under 0.8. The numbers come out the
same on a half-size, low-quality copy as on the master.

### What the numbers could not tell apart

The sound rules S3 to S6 are CHECK and not GATE, because no sound measurement separated the rejected cut
from the accepted ones.

| Cut | Longest silence | Longest stripped-down stretch | Bars repeating the bar before | SFX against the music (median) | Something louder than the music |
|---|---|---|---|---|---|
| Film A, cut 1 (rejected) | 0.90 s | 3 bars | 29% | −3.8 dB | 13% of the time |
| Film B, cut 1 | 0.80 s | 3 bars | 37% | −6.3 dB | 8% |
| Film B, cut 2 | 0.80 s | 3 bars | 37% | −14.7 dB | 8% |
| Film A, cuts 2 and 3 | 0.35 s | 2 bars | 13% | −15.6 / −15.1 dB | 2% |
| Film C | 0 s | 0 | 47% | −4.6 dB | 20% |
| Film D | 0 s | 0 | 54% | +2.7 dB | 26% |

- Film B has the same break as the rejected cut (three stripped-down bars, then 0.8 s of silence), and it
  was called "real good". The difference was on screen: the rejected cut stood still through its break.
- Films C and D repeat more than the rejected cut and have louder effects, and nobody complained.
- So "too repeating", "badly mastered" and "everything was competing" were about how the track sounded, and
  these measurements do not hear that. The gate can only point at the moments to play.

**An agent cannot hear.** Every sound rule here was first judged from measurements alone, and a wrongly
spoken word went out that way. The only real check of S3 to S11 is a person playing the cut: give them the
moments, with links to the listening room (`$MX/listen?ref=<ref>`).

## Changing a rule

- New feedback: add a rule with the reviewer's words and the date. If it can be measured, add it to the gate
  and to the calibration table.
- A limit lives in two places, `LIMITS` in `scripts/gate.mjs` and this file. Change both together.
- Whoever builds the film does not move a limit to make a cut pass. If a rule is wrong for a film, say so in
  the notes and leave the FAIL standing for the person who judges.
