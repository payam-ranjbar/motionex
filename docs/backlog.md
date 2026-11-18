# motionex backlog: engine quirks found in real productions (not fixed yet)

Found while making real pieces with the deployed service. Each item says what happened, how to reproduce it, and a
suggested fix. Items fixed since are removed from this list; `docs/retro-2026-11.md` records what was fixed and how.

## music.sounds

1. **Listed sounds whose files are missing upstream.** `tom_mallet` resolves to a VCSL URL that answers HTTP 404, so it can
   never play (met again in a later production; `tom2_mallet` works). Since the November round, `music.render` names the
   URL in its skipped-events warning. Suggested fix: probe the sample map once at image build time, and mark or omit
   sounds whose files 404 in `music.sounds`.

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

4. **Nothing tells what a voice line says.** A Farsi line was pronounced wrongly and went out, because no tool returns
   text or phonemes from audio, and an agent cannot listen. Suggested fix: a `voice.transcribe` tool (speech to text with
   a language hint, per-word times); `voice.piper` could also return the phonemes it spoke.

## music.render

5. **Always renders from the start.** `picture.render` takes `from_s`/`to_s`; `music.render` takes only `seconds` or
   `cycles`, so changing one bar renders the whole song again (20 full renders, 49 minutes of machine time, in one
   two-day production; a dense score in a later one took over 13 minutes per render). Stems multiply this, since each
   stem is a full render. Suggested fix: `from_cycle`/`to_cycle`, with the same seamless-join guarantee as the picture.

## picture.stills

6. **The readiness timeout explains nothing.** A page that never set `window.__motion.ready` failed after about 61 s
   with "page never set window.__motion.ready: (no errors reported)". Suggested fix: report what the page was still
   waiting for: requests in flight, `document.fonts.status`, and the last console lines.

## Cut-outs

7. **Subject masks need a segmentation model.** `image.matte` cuts figures off soft or flat grounds, but generated
   stills with busy backgrounds needed masks from a segmentation model run outside motionex (for `image.grade`'s
   background tint and for parallax). Suggested fix: the `image.cutout` contract designed in `docs/providers.md`, with
   `image.matte` as its first provider and a segmentation model as the second. It adds a model download to the image,
   so it is the owner's decision.

## Sound libraries

8. **Freesound gives previews, not originals.** With an API key, `sfx.freesound` downloads the high-quality MP3
   preview. Original files need Freesound's OAuth2 login. Suggested fix: an optional OAuth2 token secret; with it,
   download the original and report `source: "original"`.

## timeline.layout

9. **A fixed-length scene whose lines run over says nothing.** Scenes in `beats`, `bars` or `until` warn when their
   lines need more time than the scene has; a `duration_s` scene does not, to keep voice-first results unchanged.
   Suggested fix: the same warning for `duration_s` scenes.

## Left open on purpose (owner's decision)
- The Docker image is about 2.3 GB.
- A Windows file-rename race in the agent dispatcher (outside this repo).
