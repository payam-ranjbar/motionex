# motionex backlog: engine quirks found in real productions (not fixed yet)

Found while making real pieces with the deployed service. Each item says what happened, how to reproduce it, and a
suggested fix. Items fixed since are removed from this list; `docs/retro-2026-11.md` records what was fixed and how.

## music.sounds

1. **Listed sounds whose files are missing upstream.** `tom_mallet` resolves to a VCSL URL that answers HTTP 404, so it can
   never play. Since the November round, `music.render` names the URL in its skipped-events warning. Suggested fix: probe
   the sample map once at image build time, and mark or omit sounds whose files 404 in `music.sounds`.

## image.contact-sheet

2. **No "all images of a job" shortcut.** Building `images` means listing `job:<id>/<name>` for every still. The skill
   shows the one-line map from `result.stills`. Suggested fix: accept a whole-job ref (`job:<id>`) and expand it to the
   job's image outputs in name order, with an optional glob.

## Left open on purpose (owner's decision)
- The Docker image is about 2.3 GB.
- A Windows file-rename race in the agent dispatcher (outside this repo).
