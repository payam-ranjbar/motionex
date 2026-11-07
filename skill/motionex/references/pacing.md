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

**A landing is not an impact.** Something that FORMS (a word assembling, particles becoming a shape) should complete on the beat. Something that HITS (a burst, an explosion, a flash, a cut to the drop) should START on the beat. One film had its swarm explode into a whale that was already finished 0.4 s before the drop, because every keyframe was built to land; the fix was to start the burst on the downbeat and let it land 0.4 s later.

**Cues on the frame.** A sound is heard at its onset, not at the start of its file: a soft "h" or a fade-in puts the audible start 40–60 ms in. When a cue must hit with a word or a flash ("exactly that moment, without any delay" was the note), place the clip early by its `onset_s` (`audio.process`) or `speech_start_s` (`voice.piper`). Then check the frame and the waveform together.

**Make the story beat visible.** At the exact frame of a story beat, the subject must be in front and the prop must be on a visible face or hand. In one film, sunglasses flew onto two frozen guests who stood behind a giant demon, so the beat was invisible; the user's note: "the demon layer should be on top of the man and woman". Check that frame in stills before rendering.

**The rule of three.** Transformations satisfy in threes. A demon who changed twice at the end got a third state on request ("the rule of third is more satisfying"). Give every state the same entrance language (the same flash, flare and sound), so the third one reads as the pay-off.

**Length grows quietly.** Acted pauses, held beats and snapping all add up. One ad went from about 60 s to 112 s before tightening. Check `total` in the layout result after every change, and tell the human when it moves.
