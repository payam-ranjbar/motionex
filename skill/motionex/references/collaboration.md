# Working with a human (and with other agents)

## The human
- **Brief briefly**: ask 2–3 questions at most (story or message, length, platform and shape, mood or reference), then sketch something they can react to.
- **They hear; you measure.** Report what you changed and measured, what to listen for, and one specific question.
- **Respect settled decisions.** Write every decision the human makes into `notes.md` (voice, pronunciation, fonts, palette, tagline, mix balance), and keep it across sessions. Re-arguing a settled choice wastes their time.
- **Rollbacks are normal.** In one production the user rolled back a voice upgrade, a busier score and a character redesign. Keep everything pinned and versioned, and offer variants as A/B.
- **Taste words matter.** Quote them in your log ("more Persian charm", "snappier and glitchier", "charming villain"). When a word is ambiguous, propose two concrete interpretations.

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

## Originality guardrails
Use the user's own characters and designs. "In the spirit of" is fine; franchise names, logos and character likenesses are not.
