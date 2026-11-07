# EP1: KICKDRUM KAIJU (id: ep1-kickdrum-kaiju)

**Hook line:** a giant made of speakers wakes the city, and its footsteps are the kick drum.

- **Music**: hard techno, 132 bpm, 4/4. One bar = 1.8182 s. 14 bars = 25.45 s.
- **Look**: neon vector wireframe city at night. Cyan and magenta lines on near-black, CRT scanlines, chromatic glitch on hits.
- **Character**: a skyscraper-tall creature built from stacked speaker cones, with glowing woofer eyes and cable tendrils. Every time a foot lands it is a KICK: the screen shakes, building windows flash, dust rings expand.
- **POV and narration**: SECOND PERSON, an emergency broadcast. Voice `en_US-kristin-medium`, length_scale ~0.95, processed like a radio/PA (band-pass about 300–3400 Hz, a little drive, short slapback). Urgent, clipped.

## Beat map (bars are 1-based; bar n starts at (n-1) × 1.8182 s)
| Bars | Picture | Sound | Words |
|---|---|---|---|
| 1 (frame 1!) | Hard open: a giant speaker-foot SLAMS into the street on beat 1. The glass shatters into the first word | kick only, huge | **"YOU HEAR IT"** slams in on beat 1 and cracks |
| 2–3 | Low angle up the buildings; windows flicker on every kick; something huge moves behind towers | + offbeat open hats, rumble | "…before you see it." (voice, bar 2) |
| 4–5 | Close-ups cut on each bar: a woofer eye opens, a cable tendril wraps a tower, a pedestrian's phone screen vibrates on the beat | + claps 2 and 4, acid bassline enters | "Do not run. It can feel your pulse." (voice, bar 4) |
| 6 | Build: the camera pulls back, a grid floor tilts, a red EMERGENCY bar scrolls | riser plus snare roll; the kick drops out on the last 2 beats | **"BRACE"** counts down 3-2-1 on beats |
| **7 = DROP (t = 10.91 s)** | Full reveal: the KAIJU stands up in the middle of the city, every speaker cone pumping; neon floods magenta and cyan; a shockwave ring | full drop: kick, bass, supersaw stab, crash | none: let it hit |
| 8–11 | Rave: the creature stomps in rhythm; buildings' windows become an equaliser; the city lights pulse; camera cuts on bars (wide / feet / face / skyline) | groove | "It's not attacking." (bar 9) … **"IT'S DANCING."** (bar 10, slams) |
| 12–13 | Crowd silhouettes on rooftops jump on the beat; the creature bows | groove continues, filter opens | none |
| 14 | ENDCARD: "ON THE ONE" + "EP 1 · KICKDRUM KAIJU" in neon wireframe, landing on the final downbeat, then a glitch cut to black on the last frame | final kick + crash | none |

## Word effect
Words SLAM in on a kick (scale 3 to 1 in about 80 ms), then crack like glass: split the word into 6–10 polygon shards that jitter on the next hats and fly apart on the next kick. Chromatic RGB split on impact. Heavy condensed sans, all caps, white with a neon edge. Keep words between y = 15% and y = 75% of the frame.

## Music sketch (Strudel; write your own, this is direction)
- `s("bd*4").bank("RolandTR909")` loud; `s("~ oh ~ oh").bank("RolandTR909")`; claps on 2 and 4; an acid line with `note(...).s("sawtooth").lpf(sine.range(300,2200).slow(4)).lpq(8)`.
- A white-noise riser in bar 6; the drop adds a `supersaw` chord stab and a crash.
- Use section markers / a `span()` mask so the drop is exactly bar 7 (cycle 6). Strudel cycles are bars here: `setcpm(132/4)`.

## SFX (minimal; the kick is the footstep)
A glass crack under each slammed word (`glitch_cut`, or a custom recipe), a low `thump` under the drop shockwave, a short radio-static burst before each voice line.

Follow `AGENTS.md` for tools, rules and deliverables. End with a `## Result` section: the status, the final MP4 path, its duration, loudness and size, and what you would improve.
