# Music: Strudel through Mucavex

`music.render {file: "films/a/song.strudel" | code: "...", seconds | cycles, bpm | cps, markers?, tail_s?, format?}` renders a Strudel song offline with the same engine as the strudel.cc REPL: superdough, the default sample banks and GM soundfonts. It also returns an analysis.

- **Length**: `seconds` (or `cycles`). Add `tail_s: 2` so reverb and delay ring out.
- **Tempo**: `bpm` (with `beats_per_cycle`, default 4) or `cps`. Without either, the song's own `setcpm`/`setcps` applies.
- **Polyphony**: `max_polyphony` defaults to 4096. Strudel's own default of 128 steals voices and FADES THE DRUMS in long renders; we measured 4–17 dB too quiet.
- **Determinism**: noise and random patterns are seeded (`seed`, default 0), so a re-render is identical and the job cache works.
- **Cost**: a 60–90 s score renders in 3–12 minutes. Dense arrangements are slower. Render variants as separate jobs at the same time, and keep working.
- **Offline**: samples are fetched once into a cache volume. `offline: true` uses only the cache.

## Section markers: let picture and music meet
Write songs with named markers that the picture can move without a rewrite:
```js
let HUNT = 4;   // cycle where the hunt section starts
let DARK = 23;  // works for 15..24
let DROP = 34;  // works for 20..34
// A section is an on/off pattern of cycles. Build masks from arrays: string and backtick
// literals are parsed as mini-notation, so `${...}` interpolation does NOT work in Strudel.
const span = (a, b) => cat(...Array(a).fill(0), ...Array(b - a).fill(1), ...Array(64).fill(0))
$: s("bd*4").bank("RolandTR909").mask(span(DROP, DROP + 64))     // drums only after the drop
$: note("<c2 g1>").s("sawtooth").lpf(500).mask(span(DARK, DROP)) // the dark part
```
- `music.render {markers: {DROP: 31}}` rewrites `let DROP = …;` before rendering. `song.strudel` in the outputs shows exactly what was rendered.
- Write the song so it works over a RANGE of marker values, and say which range in a comment. Then the edit can move without breaking the music.
- `timeline.layout` can compute a marker's bar from a scene start (`markers: {DROP: {scene: "reveal"}}`, `align_to: "DROP"`). It returns `music_offset_s`, where to start the music so the drop lands on the cut. Moving the music start is easier than stretching scenes.

## Strudel cheat sheet
- **Parts**: one part per `$:` line; mute with `_$:`, solo with `S$:`.
- **Tempo**: `setcpm(BPM/4)` for 4 beats per cycle.
- **Mini-notation**: `"bd sd"` · `"bd*4"` · `"[bd bd] sd"` · `"<c e g>"` (one per cycle) · `"bd, hh*8"` (stack) · `"~"` (rest) · `"bd?"` · `"bd(3,8)"` (Euclid).
- **Synths**: `sawtooth square triangle sine supersaw`, and `white pink brown` noise.
- **Samples**: `bd sd hh oh cp rim lt mt ht cr` with `.bank("RolandTR909")`, `RolandTR808` or `LinnDrum`.
- **GM instruments**: `gm_piano gm_epiano1 gm_acoustic_bass gm_string_ensemble_1 …`, or `.piano()`.
- **Notes**: `note("c3 e3 g3")`, `n("0 2 4 7").scale("C:minor")`, `chord("<Am7 Dm7 G7 C^7>").voicing()`.
- **Shaping**: `.gain .lpf .hpf .lpq .attack .decay .sustain .release .room .size .delay .delaytime .delayfeedback .pan .crush .coarse .distort .vowel`.
- **Movement**: `sine.range(a,b).slow(n)`, `.every(4, x=>x.fast(2))`, `.sometimes(...)`, `.jux(rev)`, `.off(1/8, x=>x.add(note(12)))`.
- **Structure**: `"<a b>"`, `.mask("<1 1 0 1>")`, `arrange([4, partA], [4, partB])`.

## Reading the analysis (guides, not laws)
`result.analysis` (and `audio.stats` on any file) gives peak, rms, crest, clipped samples, the spectrum split, stereo width, per-cycle loudness and warnings.
- **Peak** at or below −1 dBFS with nothing clipped. If it clips, lower `.gain()` on the loudest part, or everything with `all(x => x.gain(.8))`.
- **RMS** −20 to −12 dBFS is a healthy level for a bed before mixing.
- **Crest** under ~6 dB sounds squashed; over ~20 dB is sparse or very dynamic.
- **Spectrum**: more than 70% low is muddy (high-pass the non-bass parts); more than 35% high can be harsh.
- **Stereo width** near 0 is mono: try `.pan()` or `.jux(rev)`.
- **Per-cycle loudness** shows the structure. Use it, or `audio.levels` with a grid, to confirm the drop lands where the picture needs it.

## Working with a listener
Sketch small (2–4 layers), check, then let the human listen at `/listen`. Change one or two things per round and keep a log line per version ("v7: hats to 16ths, bass .8→.6; user: 'more drive'").

Identity matters more than polish. One user loved a "Persian charm" half-time zarb/tombak groove and preferred it to a snappier, busier remake. Snappier is not always better; offer the remake as a B, not a replacement.
