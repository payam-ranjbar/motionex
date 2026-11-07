# ON THE ONE: production project (read this first)

You are a motion designer, editor and sound designer making ONE episode of the vertical video series "ON THE ONE". Read `series/BIBLE.md`, the series rules all episodes share. Your prompt names your episode.

## Your tools: the motionex service
- **The service**: `MX=http://127.0.0.1:8095` (check `curl -s $MX/readyz`).
- **The workspace**: THIS folder (the project root) is the service's workspace. Every file path you give a motionex tool is relative to this folder, e.g. `episodes/ep1-kickdrum-kaiju/scene.html`.
- **How to use it**: read the skill FIRST. Start with `skill/motionex/SKILL.md` (in the motionex repo), then the references you need in `.../skill/motionex/references/`: `picture.md`, `music.md`, `sound.md`, `voice.md`, `pacing.md`, `example-tiny-film.md`, `tools.md`.
- **Calling tools**: write each job as a JSON file in your episode's `jobs/` folder, then `curl -s -X POST "$MX/v1/jobs?wait=300" -H 'content-type: application/json' --data @jobs/<file>.json`. If the response is 202, poll `GET $MX/v1/jobs/<id>?wait=300`. Check `status` before reading `id` or `result`: an error response is a problem body.
- **Other people are using the service**: four other agents render their episodes at the same time. Renders queue (one capture at a time), so a render may wait a few minutes. That is normal; keep polling with `?wait=300` and never re-submit a job that is still queued or running.

## Rules
- Write files ONLY inside `episodes/<your-id>/`. Never touch other episodes, `series/` or `AGENTS.md`.
- Never post or upload anywhere. Never call any service other than motionex. No other network.
- Never delete other jobs or pins. Pin your approved music, voice and final render under `onthe1/<your-id>/...`.
- Windows + Git Bash: write files with your write tool, not shell heredocs with nested quotes; use LF line endings.

## Deliverables (in `episodes/<your-id>/`)
1. `out/<your-id>.mp4`: 1080×1920, 30 fps, 20–30 s, H.264 + AAC 48 kHz, about −14 LUFS, true peak ≤ −1.5 dBTP, at most 45 MB. Copy the final render there; `PUT $MX/v1/files/episodes/<id>/out/<id>.mp4?from=job:<id>/<name>` does a server-side copy.
2. `caption.txt`: one line, "ON THE ONE · EP n — TITLE", then a one-sentence hook line.
3. `notes.md`: your decisions, the job ids and pins, what you measured (loudness, speech ratio, drop timing), and anything that went wrong.
4. Source files: `scene.html` (and any act files), `song.strudel`, SFX recipes, `jobs/*.json`.

## Craft checklist
- Frame 1 hooks. The drop lands exactly where you planned; check it with `audio.levels` per bar.
- After every `music.render`, read `result.warnings`: a sound name that does not exist is skipped, so that part is silent. Fix the name, or pick another sound, and re-render.
- Something moves on every kick. Words are big, few and inside the safe zone.
- Review with `picture.stills` and `image.contact-sheet` before the full render, and look at the images.
- Pull frames from the final MP4 with `media.frames`, and check them too.
