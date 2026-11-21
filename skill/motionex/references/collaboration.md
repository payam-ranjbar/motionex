# Working with a human (and with other agents)

## The human
- **Brief briefly**: ask 2–3 questions at most (story or message, length, platform and shape, mood or reference), then sketch something they can react to.
- **They hear; you measure.** Report what you changed and measured, what to listen for, and one specific question.
- **Respect settled decisions.** Write every decision the human makes into `notes.md` (voice, pronunciation, fonts, palette, tagline, mix balance), and keep it across sessions. Re-arguing a settled choice wastes their time.
- **Rollbacks are normal.** In one production the user rolled back a voice upgrade, a busier score and a character redesign. Keep everything pinned and versioned, and offer variants as A/B.
- **Taste words matter.** Quote them in your log ("more Persian charm", "snappier and glitchier", "charming villain"). When a word is ambiguous, propose two concrete interpretations.
- **Keep their words, and your reading beside them.** When you act on an ambiguous note, write the note as they wrote it, then the reading you chose, and tell them which reading you took.
- **Passing checks is not acceptance.** Your checks can all pass on work the human then rejects (in one film, every check passed and the human rejected the look). Keep their verdict visibly open until they give it.

## Briefs that worked
For anything beyond a few scenes, write `BRIEF.md` with:
- characters, look and palette, fonts;
- an **absolute timing table taken from the real voice takes** (the `timeline.layout` output), not guesses;
- a shot list per act;
- a technical contract: the page size, the `__motion` contract, the shared helpers file, "seeded randomness only", and the fonts to load.

## Parallel agents
- **One file per act**: `act-a.html`, `act-b.html`, … plus a shared `stage.html` of helpers and assets. Combine them with `picture.render` `inject: [...]`, or one page that loads them all.
- **Give each act agent the brief, the timing table and its own file.** It reviews its own stills (2–4 rounds).
- **Run the score as a separate agent or job from the start**; it is the slowest asset.
- **The director (you) reviews stills at the act boundaries and the cuts**, and owns the mix and the final render.
- **Isolation**: every job is immutable and has its own id, so parallel agents never overwrite each other's outputs. Give each agent its own workspace subfolder for source files.

## Reviews by other agents
- **A fresh agent reviews better than the maker.** Give it the brief, the work and the stills, and none of your
  reasoning; a reviewer handed your view tends to confirm it.
- **Consistency and taste are two reviews.** One asks whether the work contradicts the brief or the plan and whether
  anything was added for no reason. The other asks whether it is good: clear, funny or moving as the brief wants, well
  paced, good to look at, with better versions written out. Asked for both at once, a reviewer tends to do the first
  and skip the second.
- **Render the review media fresh for every review.** Stills made before the last fix show a reviewer something that
  no longer exists.
- **Judge the look against the human's references, not your own description of them** (see `grade.md`, "Matching a
  named look").
- **Notes are advice.** Take the ones you agree with on your own choices, list what you left and why, and send
  anything that touches the human's choices to the human as a question.

## Originality guardrails
Use the user's own characters and designs. "In the spirit of" is fine; franchise names, logos and character likenesses are not.
