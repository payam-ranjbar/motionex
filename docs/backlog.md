# motionex backlog: engine quirks found in real productions (not fixed yet)

Found while making ON THE ONE · EP 7 "THE DIV" (2026-11-06) with the deployed service. Each item says what happened,
how to reproduce it, and a suggested fix. Items fixed since are removed from this list.

## music.render

1. **Some listed sounds never decode.** `s("darbuka*4")` (every `n`) renders silence with
   `4 event(s) skipped (silent in the render): Failed to execute 'decodeAudioData': malformed stream: wav: malformed fmt_pcm chunk`;
   `s("tom_mallet*4")` fails with `unsupported feature: core (probe): no suitable format reader found`. `music.sounds` lists
   both as available. Suggested fix: decode those sample files with ffmpeg as a fallback (or convert the bank once at build
   time), and/or have `music.sounds` mark sounds whose files fail to decode.
2. **The skip warning does not say WHICH sound failed.** "104 event(s) skipped ... malformed fmt_pcm chunk" in a 15-part song
   took a bisection (13 bars x 8 hits = darbuka) to find. Suggested fix: include the sound/bank name and n in the message.
3. **`analysis.warnings` says "silent cycles: 17" for a full 16-bar song** at `setcpm(128/4)` (per-bar LUFS -21..-15, nothing
   silent). The per-cycle split seems to use the wrong cycle length or count the tail. Suggested fix: use the song's cps for the
   per-cycle analysis, and exclude `tail_s`.

## music.sounds

4. **`filter` is a plain substring.** A regex-looking filter (`dulcimer|sitar|flute`) silently returns 0 matches. Suggested
   fix: accept a regex (or a list), or say "0 matches for substring ..." in the result.

## voice.piper

5. **A one-word line can babble.** `en_US-norman-medium` with `"Hey!"` returned 3.3 s (speech_end 3.0 s) while the other voices
   returned ~0.6 s. Reproduced again with the raw-IPA line `[[hˈɑː!]]`: 3.5 s from norman, 0.58 s from john. Suggested
   fix: warn when `seconds` is far above the text's expected length (e.g. > 0.5 s per syllable).

## media.encode

6. **`fit-size` re-encodes the audio as well**, even when only the video needs to shrink: true peak drifted from -2.0 to -1.6
   dBTP through a second AAC pass. Suggested fix: copy the audio stream when its codec already fits the target (or add
   `audio: "copy"`).

## picture.render

7. **No size feedback.** A detailed 30 s page at crf 19 came out at 72.7 MB (the project limit is 45, Telegram's bot limit 50).
   Suggested fix: report `size_bytes` and the average bitrate in the result, and optionally take a `max_size_mb` that triggers a
   `fit-size` pass.

## Missing capability

8. **No matte / background-removal tool.** Illustrated characters on a blurred, glowing ground had to be cut out with a
   hand-written flood fill (border fill through smooth pixels, stopped by crisp outlines, plus clearing enclosed glow pockets
   by smoothness). A tool such as `image.matte {image, method: "flood"|"luma"|"chroma", threshold}` returning a PNG with alpha
   would make compositing user art a one-liner. Reference implementation: `onthe1/episodes/ep7-div/matte.mjs`.
