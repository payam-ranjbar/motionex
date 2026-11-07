# ON THE ONE: series bible

**Logline:** micro-stories where everything lands on the beat. Each episode is a 20–30 second vertical (9:16) animated story driven by an upbeat track: techno, house, funk breaks or groove. The beat is the editor. Cuts, impacts, camera moves and words all hit on it. Narration is occasional: a few punchy lines, never wall-to-wall.

**Tagline:** *every story lands on the beat.*

## Series rules (the shared DNA)
1. **Hook in the first second.** Frame 1 is never black and never a slow fade. Open on motion, a big word or a creature already moving, on beat 1.
2. **The beat is the editor.** Hard cuts and big moves land on downbeats. Small things (blinks, flickers, letters, particles) ride the hats and offbeats. Something visibly reacts to the kick at all times.
3. **One build and one drop.** Every episode has a tension section, then a DROP (about 40–55% in) where style, colour and energy jump. The drop is the money shot.
4. **Words are visuals.** Every narration line also appears on screen as kinetic type, with a word effect unique to the episode. Big, few words, high contrast. They live in the vertical safe zone: nothing important in the top 12% or bottom 20%, where platform UI covers it.
5. **Occasional narrative.** 2–5 short lines in total, placed in breaks or over the groove, never fighting the drop. Music plays straight through under the voice (no ducking). Voice clarity comes from a static EQ pocket and level.
6. **Endcard.** The last ~1.5 s is "ON THE ONE" plus "EP n · TITLE", in that episode's style, landing on a final downbeat.
7. **Format.** 1080×1920, 30 fps, 20–30 s, H.264, AAC 48 kHz, −14 LUFS (social), true peak at or below −1.5 dBTP.

## The five episodes

| Ep | Title | Music | Look | Character | POV / narration | Word effect | Structure |
|---|---|---|---|---|---|---|---|
| 1 | **KICKDRUM KAIJU** | hard techno 132 bpm, 4/4 kick | neon vector wireframe city at night, glitch scanlines | a giant creature built of speaker cones; its footsteps ARE the kick | **2nd person**, emergency broadcast ("You hear it before you see it.") | words SLAM in on kicks and crack like glass | multi-angle creature arc: city sleeps, then stomps, then reveal, then the city joins the rave |
| 2 | **ONE PIXEL** | deep house 122 bpm, warm chords | flat pixel-art / geometric minimalism, a single colour accent | one lonely pixel | **1st person**, shy and deadpan ("I am one pixel. Hi.") | letters assemble out of pixels and fall apart on the offbeat | one-scene transformation: one pixel, then many, then at the drop they form a picture |
| 3 | **HEIST ON THE OFFBEAT** | funk breakbeat 110 bpm, slap bass, horn stabs | paper-cut collage noir, halftone, split screens | a crew of three raccoon thieves | **3rd person**, a sports commentator calling the heist play by play | comic onomatopoeia stamps (SNAP! CLICK!) plus split-flap counters | multi-shot heist in split screens: plan, sneak, the drop is the vault opening, escape |
| 4 | **RUN LOOP** | minimal to driving techno 128 bpm; each loop adds a layer | two-colour risograph ink, brush strokes, misregistration | a runner stuck in a time loop | **inner monologue**, looping and changing ("Again." / "Again." / "Faster.") | repeated words stack and echo, each loop one word changes | loop structure: the same 4-bar run repeats, each loop adds colour, speed and layers until the break-out drop |
| 5 | **THE SUN SWALLOWER** | Persian techno 124 bpm: four-on-the-floor plus tombak/daf patterns | psychedelic myth poster meets Persian miniature: gold, lapis, flat perspective | a serpent (azhdaha) that swallows the sun, and a drummer who drums it back up | **mythic storyteller**, an old voice ("Long ago, when the sun still had a heartbeat…") | calligraphic stroke reveals, words drawn as if by a reed pen | 3-act myth: dark world, the drummer drums, at the drop the serpent spits the sun out on the one |

## Production notes
- The tools are the motionex service (http://127.0.0.1:8095); the skill is `skill/motionex/` in this repo.
- Beat sync: render the song at an exact bpm and start it at t = 0 in the mix. In the page, `beat = t * bpm / 60`, `bar = beat / 4`, and the kick phase is `beat % 1`. Drive visuals from that, and land cuts on integer bars.
- Each episode lives in `episodes/<id>/`, with `out/<id>.mp4`, `notes.md` and `caption.txt`.
