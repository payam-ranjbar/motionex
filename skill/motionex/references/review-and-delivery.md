# Review and delivery

## Review loop (cheap first, expensive last)
1. **Stills**: `picture.stills` at the act boundaries and 1–2 frames after each cut, then `image.contact-sheet` (4–8 cells). Look at the sheet, fix, and repeat. This takes seconds; a full render takes minutes.
2. **Audio**: `audio.loudness` and `audio.speech-ratio` on the mix, and `audio.levels` around the key moments. Tell the human what to listen for at `/listen`.
3. **Full render**: `picture.render` with `audio`.
4. **The encode itself**: `media.frames` at a few times from the MP4 (colour, banding, black frames) and `media.probe` (duration, streams, colour tags). Measure loudness and true peak ON the encoded file: AAC adds about 0.1–0.4 dB of true peak.
5. **Audio-only changes need no new picture render**: `media.mux` puts a new mix onto the existing video with a stream copy. In one film, three rounds of sound notes took about a minute each instead of a 4.5-minute render.

**Deliver two files**: a high-quality master (for example `video: {crf: 14, preset: "slow"}`, AAC 320k; it can be 150+ MB) and a platform copy made from it with `media.encode {preset: "fit-size", target_size_mb, audio: {codec: "copy"}}`. Copying the audio avoids a second AAC pass, which moved one master's true peak from −2.0 to −1.6 dBTP.

## Encode presets (`media.encode {input, preset}`)
| Preset | What | Notes |
|---|---|---|
| `master` | H.264 crf 18, BT.709, AAC 192k | the archive and master copy |
| `web-720p` | long side 1280, crf 23 | previews and chat |
| `fit-size` | two-pass to `target_size_mb` | any size cap; it retries once if it lands over |
| `telegram-video` | fit to 45 MB, long side 1920 | Telegram bots cap videos at 50 MB. 88 s of 1080p fit in about 40 MB at about 3.4 Mbps |
| `instagram-reel` | High@4.2, 5.3 Mbps, closed 60-frame GOP, AAC 48 kHz 128k | reels need H.264, a closed GOP and 48 kHz AAC (≤128k), ≤25 Mbps, 3 s–15 min; 9:16 is recommended, and 16:9 is letterboxed |

Every preset is JSON (`presets/encode/*.json`) and every field can be overridden in the request. "MB" means 10^6 bytes.

**Upload limits upstream**: a publishing service may cap uploads lower than the platform does; contavex, for example, accepts 64 MiB. Ask where the file is going before you choose a preset.

## Covers and posters
Pull candidate stills (`picture.stills`, or `media.frames` from the master) at 2–3 moments, put them on a contact sheet, and let the human choose. Title cards usually make the best cover.

## Hand-off
Give the human:
- the master path, or its `job:` ref plus a pin;
- the delivery encodes;
- what changed since the last version;
- anything you measured that they should listen for.

Publishing (Telegram, Instagram and so on) is outside motionex. Never post anywhere without the human's explicit go-ahead for that specific platform.
