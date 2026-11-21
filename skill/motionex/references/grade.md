# Post-processing and colour

How to grade stills and finish a render without imposing a look. The look is the piece's and the human's; these are
ways to get there and to check it.

## Where to grade
- **Grade stills before they go into the page** (`image.grade`). The page then renders fast, every frame shares the
  same look, and the page animates only what moves (a glow that pulses, a flicker).
- **Finish the rendered master at encode time** for what applies to the whole film: a 3D LUT, grain, a vignette,
  sharpening (`media.encode` `video_fx`, or `lut`). Or draw them in the page when they must move with the picture.

## A common order (not a rule)
1. **Fix**: exposure and colour casts.
2. **Shape**: a contrast curve, clarity.
3. **Colour story**: push the colours that carry meaning, mute the rest.
4. **Focus**: separate the subject (tint the background through the subject's mask), vignette.
5. **Light**: a glow layer from the light sources, drawn additively in the page.

Fixing before shaping keeps a curve from exaggerating a cast; separating the subject last keeps it based on the final
colours.

## White balance
- **Read it from the greys.** `cast_a`/`cast_b` average the whole frame, so a street of brick and sky reads as a cast
  when its greys are neutral. `greys_a`/`greys_b` are the near-neutral midtones (asphalt, concrete, walls in shade);
  `greys_pct` says how much of the frame they are, and `neutral` sets what counts as near-neutral.
- **Correct it with `balance`**, which shifts every pixel's a*, b* by the same amount, so saturated colours keep their
  chroma. `cast` scales one side of an axis and drains them along with the cast.
- **A cut-out layer has no neutral ground of its own**: its greys are its clothes or its paint. Give it the shift of
  the plate it sits on (`balance[].shift_ab` in the plate's result) as `shift_ab`.
- A frame with little grey gives a weak number: `min_pct` skips the step for such a frame and says so in a warning.

## Protect what should stay
- **Light sources lose their warmth when a warm cast is removed everywhere.** Protect them (`protect: "lights"`) and
  look at what was protected (`light_mask.write_masks`) before trusting it.
- **Darkening a background can leave a dark halo around the subject.** Grow and feather the mask so the edge falls
  off softly; check the edges at full size, not in a contact sheet.
- **A mask that misses the subject does more harm than no mask.** Review every mask; leave an image out of a mask
  step when its mask is wrong.
- **A grade that moves draws the eye.** Keep adjustments static unless the movement is the intent.

## One look across a film
- Grade the whole batch with one list of steps, and name the exceptions explicitly, so the look holds from shot to
  shot.
- Generated images vary. Compare the measured values across the batch (`before`/`after` cast and luma, the subject's
  separation) and look for outliers, rather than tuning each image by eye.
- Change one thing per round and keep the earlier version, so the human can compare.

## Matching a named look
- When the human names a reference ("like that 90s animated series"), look at frames of it before you write the look
  down. A description written from memory gets filled with whatever an image generator, or your own habit, does by
  default, and every later check then compares the work with that same description, so the gap is never caught. In one
  film the look passed every check and the human still rejected it as "the wrong tone".
- Write the look as traits seen in the frames: how much of the frame is black, hard or soft shadows, the line and how
  many interior lines, how much surface detail, faces and eyes, local colour per object or one tint over everything,
  the light.
- Put the reference frames and yours side by side (`image.contact-sheet`). Simple numbers on both groups help where
  the eye adapts: the share of near-black pixels, contrast, colour strength, how many hue families, flat fills against
  soft ramps, line density. The references set the range; there are no fixed targets. The numbers say how far apart
  two looks are and the frames say how.
- Compare at one size. Small frames scaled up look flatter than they are, so scale everything to the smallest width.
- Reference frames are other people's work: keep them for study and comparison, and do not publish them or feed them
  to a generator.

## Review
- Put before and after side by side (`image.contact-sheet`), then look at full-size crops of the edges, the lights and
  the darkest areas.
- Check frames from the final encode: encoding can band smooth dark gradients, and a little grain can hide it.
- You cannot see colour the way the human does. Say what you changed and what the numbers moved, and ask one question
  about the look.

## Delivery copies
- **Changing the aspect ratio without recomposing**: pad the finished master (`media.encode` `pad`, or the
  `vertical-9x16` preset). It keeps the composition as approved and needs no new render.
- **When the vertical copy must use the whole frame**, it is a new composition: re-render the page at that size.
- Keep the master; make every platform copy from it.
