# Picture: pages to video

## The contract (all motionex needs)
Any HTML page can be captured if it defines:
```js
window.__motion = {
  ready: true,            // set when fonts, images and scenes are ready (not before)
  duration: 12.5,         // seconds (or pass to_s to picture.render)
  size: { width: 1920, height: 1080 },   // or pass width/height
  seek(t) { /* draw the frame for time t; may return a Promise */ },
};
```
`picture.render` opens the page in headless Chromium and calls `seek(t)` for every frame, in any order and across several parallel pages. It screenshots each frame and encodes the result.

So **every frame must be a pure function of t**:
- Animate from `t`, not from the clock.
- No `Math.random()`: use a seeded PRNG such as `Motion.random(seed)`.
- No `Date.now()`, no `setTimeout` choreography, no free-running CSS animations or videos. CSS animations are fine through the WAAPI adapter below.
- Load fonts before `ready = true` (`await document.fonts.ready`). Non-Latin scripts need their font loaded. Persian Aref Ruqaa is compact, so size it up.
- Pages are served over http from the workspace (`/w/...`), so relative paths for images, fonts, JSON and modules work. With `offline: true`, the network outside the service is blocked and reported in `page_errors`; use it for hermetic renders.

## Three ways to build a page (pick any)
1. **Plain code**: write `seek(t)` yourself (canvas, SVG, DOM). Nothing else is needed.
2. **`MotionAdapters`** (`<script src="/_mx/lib/motion/adapters.js">`):
   - `MotionAdapters.waapi({duration, size})` makes CSS `@keyframes` and Web Animations seekable;
   - `MotionAdapters.fromFunction(draw, {duration, size})` wraps a `draw(t)` for canvas or WebGL.
3. **The Motion runtime plus GSAP**: `<script src="/_mx/lib/gsap/gsap.min.js">` (plugins such as SplitText and MorphSVG are in the same folder), then `<script src="/_mx/lib/motion/runtime.js">`.
   - It reads `window.TIMELINE`, in the `timeline.json` shape from `timeline.layout`. Pass it with `globals_files: {TIMELINE: "job:<id>/timeline.json"}`.
   - Its API:
     - `Motion.scene(id, build)`: build a scene's tweens on its own timeline window;
     - `Motion.global(build)`;
     - `Motion.onFrame(fn)`;
     - `Motion.random(seed)`;
     - `Motion.pulse(t)`: a beat pulse when the timeline has a bpm, else 0;
     - `Motion.voice(t, who)`: the voice envelope 0..1, for lip sync and reactive visuals;
     - `Motion.sfx(name)`;
     - `Motion.chars(el)`: split text for per-letter animation;
     - auto captions when a `.captions` element exists.
   - `Motion.config({hideOutside: false})` lets scenes overlap.

`picture.render` can also inject things into a page without editing it:
- `inject: [fragment.html]` inserts HTML at `<!--mx:inject-->` or before `</body>`;
- `globals: {NAME: value}` and `globals_files: {NAME: ref}` define `window.NAME` before any page script.

## Review before you render
- `picture.stills` with `times: [...]` gives PNGs. Look at them; you can read images.
- `image.contact-sheet` makes a grid of 4–8 stills for a quick overview:
  - one per scene, plus 1–2 frames just after every cut;
  - check text overflow, safe margins and contrast.
- Only then run `picture.render`.
- Afterwards, pull frames from the ENCODED file with `media.frames` to catch encode problems: colour, banding, black frames.

## Rendering
- `picture.render {page, fps: 30, workers: 4, to_s, audio?: <mix ref>}`. With `audio` the master is encoded once, video and audio together. You can also mux later with `media.mux`.
- **Sections**: re-render one act with `from_s`/`to_s`, and join with `media.concat` (`mode: copy`) when the settings match.
- **The result** includes `stalls` (retried frames) and `page_errors`. Read `page_errors`; a missing font or 404 shows up there.
- **Size and fps** are yours: 1920×1080, 1080×1920 (vertical), 1080×1080, 24/25/30/60 fps.
- **Cost**: about 1–2 s of render per second of 1080p30 at 4 workers. Grain, noise and heavy blur make both the render AND the file bigger, which matters for size caps.

## "Juice" that worked (options)
These come from a comedy ad and a cinematic short:
- squash and stretch on pops, and anticipation before a jump;
- a decaying camera shake plus a 1-frame flash on hits;
- whip pans with motion blur between beats; a short glitch on every cut (about 4 frames);
- characters breathing and bouncing on their own words, with mouths driven by `Motion.voice(t, who)`;
- holding a frame (a freeze) under an impact SFX;
- seeded film grain or noise tiles for texture (watch the file size).

## Originality
Use the user's own characters and assets (silhouettes can become alpha masks with `media.ffmpeg`: `alphaextract`, `colorkey`, `scale`). Illustrations on a dark or blurred ground: either screen-blend them onto a dark scene (fast, but a light aura washes the picture out), or cut them out first (a flood fill from the border through smooth pixels, stopped by the drawing's crisp outlines, gives clean mattes) and draw them normally with your own glow.
- **Fonts**: the page may load Google Fonts (the capture has network unless `offline: true`); the container itself only has DejaVu/Liberation. Persian/Arabic: Noto Nastaliq Urdu (Nastaliq), Lalezar (display, Persian digits ۱۲۳), Aref Ruqaa. Await `document.fonts.load(font, sampleText)` with real sample text before `ready`. For RTL words in canvas set `ctx.direction = 'rtl'` and avoid trailing punctuation (bidi can put `!` on the wrong side).
- **Image sequences from `media.ffmpeg`**: declare `outputs: ["f-%03d.png"]` and write `{out:f-%03d.png}`; every frame is listed and kept. Do not imitate franchise characters, logos or names.
