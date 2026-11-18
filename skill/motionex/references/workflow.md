# The order of work: plan, then sound, then picture

These are habits that made films cheaper to change, not rules. Every step can be skipped or reordered.

## Plan before you make anything
Write the plan in your notes first, so every later step has the context it needs:
- **What it is for**: the story or message, who watches it, where (shape, length range, platform).
- **What leads**: the music (a trailer, a music video, a beat-driven short) or the voice (an explainer, a narrated
  piece). The lead sets the clock that everything else fits.
- **The form**: the sections in order, what each one does, and where the turns are (a hit, a stop, a reveal).
- **Per section**: what is seen, what is said, what is heard besides the music, and how fast it should feel.
- **The look and the sound**, in the human's words. Quote taste words; when one is ambiguous, propose two readings.

One table that lines up sections with picture, words and sound is enough. Show it to the human before rendering
anything slow.

## Sound first
Sound sets the time; pictures can be made to any length.
- **Voice drafts are quick.** Record them early (`voice.speak`); their real lengths, measured, tell you how much room
  each line needs. Lengths you guess are wrong.
- **Make the music to the plan.** Write the song with section markers (`music.md`), render it early (it is the slow
  asset) and read its form back from the result (`markers_found`: every section with its time). Render stems when
  you will balance parts per section.
- **Settle the music before cutting to it.** When the picture later needs more or less time, change the picture or
  move a marker, rather than stretching the music.

When the voice leads, the order flips: lay scenes out from the takes (`timeline.layout` with `lines`) and align the
music to them with markers and `music_offset_s`. Both paths are fine; pick the one that matches what leads the piece.

## The cut list, on the form
Lay the scenes out on the music's grid (`timeline.layout` with `grid` and scene lengths in `beats` or `bars`, or
`until` a bar), then read its `grid_report`. Place the lines and the effects on that timeline. `editing.md` has the
craft: cutting on the beat, close-ups on key words, J- and L-cuts.

## Picture to match
Make or generate the shots the cut list asks for, grade them as one batch (`grade.md`), and build the page from the
timeline, so a change in the timeline moves the picture with it. Review stills and a contact sheet before a full
render.

## Effects, mix, render, deliver
- Effects come from the cut list's events: a hit on a cut, a texture under a shot, an ambience under a scene
  (`sound.md`).
- Mix, then measure: loudness, true peak, the voice against the music, each effect against the music at its moment.
- Render once at full size; check frames from the final file; make platform copies from the master.

## Change only what changed
- Only the sound: mix again and `media.mux` it onto the same picture.
- One section of the picture: render that section (`from_s`/`to_s`) and join.
- The music: mix and mux again; render the picture only if the timing moved.

Keep a decision log (`notes.md`): what changed, what the human said, what is settled.
