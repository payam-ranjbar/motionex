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
