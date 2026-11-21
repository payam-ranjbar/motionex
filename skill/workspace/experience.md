# What earlier workspaces learned

Notes from productions made with the engine. They are about how a production is run: checking, reviewing, keeping
decisions. None of them says how a film should look or sound, and none of them is a rule. A workspace takes the ones
its user wants, usually by writing them into a skill of its own.

## Checking
- **A step can end on a check.** Checks written as code that print `ok`, `WRONG` (fix it) or `LOOK` (a person or a
  second agent decides) make a loop of make, check, fix, check again. A round limit keeps a loop from running on.
- **Measure what cannot be seen or heard.** For a picture: lint the page (overlaps, cut-off parts, text size) and look
  at stills at full size before a full render. For sound: loudness, true peak, speech ratio, levels per section. The
  human listens; when the numbers and the human disagree, the human is right about what they want.
- **Measure a render before building on it, at the grain where it can fail.** A music cue has succeeded, found its
  markers and met its loudness while being one stuck tone; its level per bar showed it. A picture's white balance
  shows in its greys, not in an average of the whole frame.
- **A check that compares the work with the agent's own description passes a wrong description.** When the user names
  a reference, keeping frames of it and measuring against them catches what a description cannot.
- **Passing checks is not acceptance.** The user's verdict stays open until they give it.

## Working cheaply
- Stills, a low-resolution draft or a section (`from_s`/`to_s`) cost little; the full-resolution render is the
  expensive one.
- Image generators can have a daily limit. A review that separates what a re-cut can fix from what needs a new image
  lets the work go on when the limit is reached, and the hand-over can list what waits.

## Reviews
- **A fresh reader finds what the maker cannot.** Two kinds have been useful: one who checks for contradictions and
  for things added without a reason, and one who is given none of the maker's reasoning and says whether the work is
  good. Their notes are advice; the user decides.
- **Reviewers need current media.** Stills made before the last change show a version that no longer exists.
- **When a choice is open and visual, pictures settle it faster than words**: a couple of versions of the same subject,
  shown before anything is built on one.

## Keeping decisions
- **The user's words as written**, with the agent's reading of an unclear note beside them, never in their place.
- **Which things are the user's, and which are the workspace's way of working.** Writing that down keeps an agent from
  changing the first while improving the second.
- **A setting the work depends on, with nothing behind it but a guess, costs the most when it is wrong.** The shape of
  the frame decides every image; asking before the first image is cheap.
- **A way of working improves when its failures are traced.** After the user's notes on a result: find where the
  process let the fault through, change the smallest thing, prove the change on real work, and log it.
- **A new workspace is proved by a fresh session making one project in it**, and by reading what that session tripped on.

## One layout that has been used for a series
A workspace that makes many episodes the same way grew these, beyond the template's files. They are an example.

| Path | Holds |
|---|---|
| `docs/PIPELINE.md` | The steps, in order: what each needs, who does it, its result file, its check |
| `docs/pipeline/<n>-<step>.md` | One guide per step |
| A change log | Each change to the pipeline, with its cause and its proof |
| `kit/` | A shared picture library that every project's page uses |
| `tools/` | One command per step, each submitting engine jobs and printing check lines |
| `assets/` | Fonts, icons and samples, with their sources and licences |
