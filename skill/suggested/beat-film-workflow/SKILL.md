---
name: beat-film-workflow
description: A working path for building a short beat-driven film with motionex (picture cut to music, 20 to 60 seconds), as seven stages that each end in a checkpoint. Use it when starting such a film, when briefing an agent to build one, or when several agents build episodes of a series and should work the same way without sharing a build script. It fixes what must be true before moving on and leaves the method inside each stage to the builder.
---

# Beat-film workflow (a suggested skill)

This is an opinion, not part of motionex, and it is a path, not a script. Nothing here runs for you, and no
step forces a method. Each stage ends in a checkpoint: what must be true before you go on. How you get
there is your craft.

The order exists so that a weak part is found while it is still cheap to change. It builds on the
`motionex` skill, and the rule ids (P1, S2, ...) are those of the `beat-film-quality` skill, which also
ships the gate used below.

## What is fixed and what is yours

| Fixed | Yours |
|---|---|
| The checkpoints below, in this order | Everything inside a stage: method, tools, order, how many passes |
| The quality rules, the gate and its limits | Story, look, sound, type, structure of the page |
| Every job is a file in `jobs/`; approved work is pinned | Your own helper scripts, in your film's folder |
| Your notes say what you did, measured and could not check | How you measure beyond the gate |
| You do not publish | |

If a checkpoint is wrong for your film, say why in your notes and go on. Do not skip it silently.

## The path

### 1. Read, then write the beat map

Read the brief and the quality rules. Then, before any picture or sound, write the plan as a table in your
notes: one row per bar, with what the music does, what the picture does and which sound events fall there.

Checkpoint:
- `gate.json` exists with `bpm` and `drop_bar`. Bars count from 0: `drop_bar` = drop time ÷ bar length.
  (One film wrote 7 for its seventh bar and failed the gate; the right value was 6.)
- The beat map has no bar where nothing changes on screen, no break longer than two bars, and a pulse
  running through every break (P4, S3, S4).
- Each scene names the thing in the surroundings that moves with the kick (P5).

### 2. Music first

The music sets the clock for everything else, and a render takes minutes, so start it early and work on
the picture while it runs. If the film has spoken lines, record their drafts before you write the song,
so the form leaves room for them; read the form back from the render's `markers_found`.

Checkpoint (measure with `audio.levels` per bar on the render):
- `result.warnings` is empty: a wrong sound name is skipped without an error, and that part is silent.
- The drop's bar is the loudest bar so far (S2).
- Something changes at least every four bars (S5), and no stretch is stripped down for more than two (S4).
- The track is pinned.

The gate cannot run yet; it needs a picture. These three numbers are the ones it will check later.

### 3. Picture

Every frame is a function of `t`: `beat = t * bpm / 60`. Build in acts or blocks so that one can change
without the others.

Use `picture.stills` and `image.contact-sheet` for layout, type, margins and colour. They cannot show
motion: one film passed every still review and was then rejected as "too still".

Checkpoint:
- Stills at frame 1, at the drop and at the end card look right (P1, T2, A3).
- Lines in two scripts are checked side by side for margin (T2).
- Every word on screen has an entrance written for it (T1). No empty balloon (T3).
- For every bar of the beat map you can name what moves on the beat and what moves between beats.

### 4. Voice, effects, mix

Take sound events from the picture's own event list, so a hit on screen and its sound share one time.

Checkpoint:
- Voice is as rare as the brief says (S10). A line in a script without short vowels has them written (S11).
- Every hit and move of the hero has a sound (S7).
- Each cue is measured against the music at its own moment (`audio.speech-ratio`, or stems per beat):
  under the music, and not more than 26 dB under it (S6).
- The mix is −14 LUFS, true peak at or under −1.5 dBTP (S1), pinned, and named as `mix` in `gate.json`.

You cannot hear. You have measured the sound; you have not listened to it. Say so in your notes, and list
the moments the human should play (the listening room is `$MX/listen?ref=<ref>`).

### 5. The first whole cut is a draft: gate it at once

Render the whole film and run the gate on the job output, before any polish:

```
node <beat-film-quality>/scripts/gate.mjs <film-dir> --video job:<render id>/<name> --tag draft
```

Checkpoint:
- No FAIL. A FAIL on P2, P3 or P4 means the picture does not move enough; go back to stage 3 for those
  bars. The report names the still stretches and the flat bars.
- Every CHECK line is played or looked at, and answered in your notes.
- You have gone through the EYE and EAR rules with the gate's sheet open.

### 6. Change only what changed

| What changed | What to run again |
|---|---|
| Only the sound | The mix, then `media.mux` onto the same picture. No picture render. |
| One act of the picture | That section with `from_s`/`to_s`, then `media.concat` (mode `copy`), then `media.mux`. |
| Shared page code (timing, camera, a layer used everywhere) | The whole picture. |
| The music | The music, the mix and the mux. The picture only if the timing moved. |

Sections join without a seam when they use the same size, fps and encoder settings and their borders fall
on whole frames (`round(t * fps) / fps`). Render sections without audio and add the mix at the end.

Run the gate again after every change. Stop when it has no FAIL and no CHECK you have not answered.

### 7. Deliver

Checkpoint:
- The master and the platform copy are pinned.
- The platform copy is in the film's `out/` folder and meets the brief's format, size and loudness.
- The gate has run on that file, with no options, and does not fail.
- Frames pulled from the final file with `media.frames` look like your stills.
- Your notes have: the decisions, the job ids and pins, the gate's summary line, what you did about each
  CHECK, and a plain list of what nobody verified.

Then stop. Publishing is the human's call.

## What the time costs

Measured on one 30 s film at 1080×1920, 30 fps, in a container without a GPU:

| Step | Time |
|---|---|
| Full picture | 6 min |
| The same at half size (`device_scale_factor: 0.5`) | 5.5 min: size does not buy time; the cost is in the page |
| A 2 s section | about 30 s |
| Joining sections, adding the mix | under 1 s each |
| One music render | about 2.5 min, always from the start |
| The gate | a few seconds |

So a small draft is not worth making, and sections are. The gate gives the same picture numbers on a
small, low-quality file as on the master, so a fast encoder preset is fine for a draft.

## Habits that saved earlier films

- Write every job as a file in `jobs/` and keep the job id next to it. A job you cannot find is a job you
  render again.
- Poll a queued or running job; never send it again.
- Pin a thing when it is approved, with a note saying who approved what. Outputs never change; pins move.
- A helper script is welcome when you run the same three jobs for the fifth time. Keep it in your film's
  folder. It is yours, not a shared tool.
- On Windows with Git Bash, write files with your write tool: shell heredocs with nested quotes break.
- When a note from an earlier film claims a tool misbehaves, test it before you work around it.
