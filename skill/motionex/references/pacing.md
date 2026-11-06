# Pacing and editing

**Held beats.** After an impactful line, give it air.
- Editors call a pause of about 1 s "a beat", and 2–3 s a dramatic pause.
- In one film the user asked for "1–2 s of breathing room" after impactful lines, then capped it: "no more than 1, 2 or 3 sec".
- The final cut used per-line holds of 1.0–2.8 s, and they mattered most BEFORE the climax.
- With `timeline.layout`, set `pause_s` per line (or `gap_s` per scene).

**Hits go in the silences.** Put an impact or a reveal inside the held beat, not over the words. One fix moved a landing animation and its SFX into the pause before the next line, and it read much better.

**Comedy runs tight.**
- 0.12–0.2 s between lines;
- pauses inside lines trimmed to about 0.2 s, except the joke pause;
- cuts on half-beats.
- Acted voice takes run long, so tighten them (`audio.process` `tighten_pauses`, `tempo`).

**Cutting on the beat** feels intentional, but it is a choice:
- `snap_beats: 4` (2 s bars at 120 bpm) suits a cinematic piece;
- `snap_beats: 0.5` suits a fast ad;
- `snap_beats: null` means no grid at all.

**Land the drop on the cut** by moving where the music STARTS (`music_offset_s` from `timeline.layout`, and `offset_s` on the music clip in `audio.mix`), rather than stretching scenes.

**Length grows quietly.** Acted pauses, held beats and snapping all add up. One ad went from about 60 s to 112 s before tightening. Check `total` in the layout result after every change, and tell the human when it moves.
