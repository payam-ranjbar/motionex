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

## Measuring a finished cut

3. **No motion measurement.** Whether a film moves cannot be read from stills: a cut passed every still-frame review
   and was then rejected as "too still". The check that separates such a cut compares consecutive frames: the share of
   the film where nothing changes over 0.1 s, the change on each beat against the change around it, and the mean change
   per bar. Today a client has to pull small raw gray frames through `media.ffmpeg` and do the arithmetic itself, because
   `media.frames` stops at 200 frames. Suggested fix: a `media.motion` tool taking `{video, grid?: {bpm, beats_per_bar},
   still_threshold?}` and returning per-frame change, the still stretches, and per-beat and per-bar rows.

4. **No per-cue level table.** `audio.mix` knows every clip and writes the stems, but to learn whether a cue sits over
   or under the music at its own moment a client downloads each stem and measures the windows itself, or calls
   `audio.speech-ratio` once per cue (43 calls in one production). Suggested fix: with a `reference_track` named in the
   input, `report.json` gains `cues[]`: `{track, name, at, level_db, reference_db, ratio_db}`.

5. **Nothing tells what a voice line says.** A Farsi line was pronounced wrongly and went out, because no tool returns
   text or phonemes from audio, and an agent cannot listen. Suggested fix: a `voice.transcribe` tool (speech to text with
   a language hint, per-word times); `voice.piper` could also return the phonemes it spoke.

## music.render

6. **Always renders from the start.** `picture.render` takes `from_s`/`to_s`; `music.render` takes only `seconds` or
   `cycles`, so changing one bar renders the whole song again (20 full renders, 49 minutes of machine time, in one
   two-day production). Suggested fix: `from_cycle`/`to_cycle`, with the same seamless-join guarantee as the picture.

## audio.mix

7. **The truncation warning is noise.** "clip N extends past the mix length and was truncated" appears whenever a clip
   is longer than the mix, which the music nearly always is (36 warnings in one production, none of them a problem).
   Giving the clip a `duration_s` silences it. Suggested fix: warn only when the part that is cut off is audible (above
   about −50 dB), and say how many seconds were cut.

## picture.stills

8. **The readiness timeout explains nothing.** A page that never set `window.__motion.ready` failed after about 61 s
   with "page never set window.__motion.ready: (no errors reported)". Suggested fix: report what the page was still
   waiting for: requests in flight, `document.fonts.status`, and the last console lines.

## media.encode

9. **Fit-size can make a small file bigger.** Asked to fit 44 MB, a master that was already smaller came out larger,
   with its audio encoded again. Taken from production notes, not reproduced since. Suggested fix: when the input
   already fits, return it unchanged and say so in the result.

## Left open on purpose (owner's decision)
- The Docker image is about 2.3 GB.
- A Windows file-rename race in the agent dispatcher (outside this repo).
