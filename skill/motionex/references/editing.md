# Editing: cutting picture and sound together

Techniques that worked in real productions, offered as options. The piece decides which ones it needs. `pacing.md`
covers held beats, comedy timing and impacts against landings.

## Cut to the form
- **The lead sets the skeleton.** When the music leads, its sections and accents are where cuts can fall; when the
  voice leads, the lines are. Lay the timeline out from whichever leads (`workflow.md`).
- **On the beat reads as intended; nearly on the beat reads as a mistake.** If cuts follow the music, put them
  exactly on the grid (`timeline.layout` reports any boundary that is off it). Cutting against the beat can be a
  choice too; make it a clear one.
- **Let the music's energy set the cutting rate**, and let the image set the floor: a viewer needs time to read a
  frame. A detailed wide shot needs longer than a close-up; text needs time to be read. If a frame cannot be taken in,
  it is too short, whatever the music does.
- **Fast cutting is a tool for the moments that build**, not a constant. A rhythm that changes keeps attention; one
  that never changes stops being felt.
- **Change something between neighbouring shots**: size, angle, direction or subject. Two similar framings in a row
  read as a jump.

## Dialogue
- **Cut a line inside its measured silence** (`audio.silence`, `speech_end_s`), never at estimated word times, so the
  next word cannot leak in. Then measure the gap: it should be silent.
- **Cut to the close-up just before the key word**, so the face is there when the word lands. On a grid, take the
  beat before the word.
- **Let reactions play.** Cutting to the listener while the speaker finishes often says more than the speaker's face.

## J-cuts and L-cuts
- **J-cut**: the next shot's sound starts before its picture. It pulls the viewer into a new place (a room's
  ambience, a voice from off screen) before they see it.
- **L-cut**: a shot's sound runs on over the next picture. It lets a line or a hit ring over its consequence or a
  reaction.
- In `audio.mix` both are clip placement: start the clip before the cut and fade it in, or let it run past the cut
  and fade it out. The picture cut can stay on the grid while the sound crosses it.
- Judge the overlap by ear: long enough to be felt, short enough that it does not muddy the shot it crosses into.
  Ambiences usually tolerate longer overlaps than voices; a hit almost never leads its cut.

## Sound for every shot
- **A still image in silence feels dead.** Give every shot without dialogue something to hear: a hit on the cut, a
  texture of what is in the frame, an ambience or room tone across a scene.
- **Find recorded sounds with `sfx.search` and bring them in with `sfx.fetch`**, or synthesize them with `sfx.synth`.
  Keep the credits the licences ask for.
- **Place a hit by its onset** (`onset_s`) so the attack lands on the cut; **start a texture from its loudest
  stretch** (`loudest_s`) so the busy part plays under the shot.
- **Measure each effect against the music at its own moment** (the `cues` report of `audio.mix`), because the music
  under it changes. Fewer, better cues beat many.

## Text and cards
- Hold a card long enough to read it comfortably, and fade it in and out rather than slamming it, unless the slam is
  the point. Bring a second line in after the first has been read.
- Keep the type large and inside the safe area of every platform copy.

## Shape
Common shapes, to use or ignore: a hook at once; a rise in acts; a stop where the music drops out for a key line; a
final build where cuts shrink; a title; a short button after it. Pick what the piece needs.

## Endings
- Fade picture and sound together. Then check what plays after the last frame: ringing tails and stray clips are
  heard as a click or a beep. Measure the last second of the mix.
- Pull the last frames from the final file and look at them.

## Checks worth automating in your project
Write them as code that prints ok or WRONG, so a change cannot silently break them: every cut on the grid (if that
is the plan), a minimum readable length per shot, no shot used twice unless repetition is the point, every shot
without dialogue has a sound, every dialogue cut sits in silence.
