# A project

A project is one video, or one build of a video, in its own folder under `projects/`. A workspace holds as many as
the user wants; each stands on its own.

## Start one
1. Pick a short id with the user, or from their words (`teaser`, `e02-night-shift`).
2. Copy `projects/_template/` to `projects/<id>/` and add a line for it to `projects/README.md`.
3. Fill in `brief.md`:
   - **What the user said about this project**, as written, one fact per line (U1, U2, …).
   - **Settings for this project.** Start from the table in `WORKSPACE.md`. A row the user set differently for this
     project carries their value and the fact it comes from. Rows still "not set" stay that way.
   - **Open.** What the work will need that nobody has said yet. Ask about the ones the next piece of work depends on;
     the rest can wait until something depends on them.
4. Start `notes.md`: the decision log.

## While working
- **Before a piece of work, check what it rests on.** If it depends on a setting that is not set, ask first. Work
  built on a guess has to be redone when the guess is wrong, and the user did not choose it.
- **Use the engine through its own skill.** The tools are bare; they do what their parameters say. The values come
  from this project's settings.
- **Keep the user's work apart from yours.** What they gave is not edited. What you made from it sits beside it.
- **Write decisions down as they happen**, in `notes.md`: what was decided, by whom (their words, or your choice and
  its reason), and what it changed. A choice of yours is one they can overturn, so make it easy to find.
- **Show work in the form the user asked to see it.** If they have not said, ask what they want to see and when.
- **Say what you measured and what you only assume.** You cannot see a picture move or hear a mix; the engine's
  analysis tools measure. When a number and the user disagree, the user is right about what they want.
- Helpers for this project alone live in the project; ones that will serve other projects go in the workspace's `tools/`.

## Resume one
Read `brief.md`, then `notes.md` from the end backwards until you know: what exists, what the user last said, what is
open, and what the next step was.

## Hand over
At the end of a session, `notes.md` says:
- what exists, and where;
- what the user has seen and what they said about it, in their words;
- what is open, and who it waits for;
- anything that is known to be wrong and not yet fixed.

A project is finished when the user says so. Record that in `brief.md` with the date.
