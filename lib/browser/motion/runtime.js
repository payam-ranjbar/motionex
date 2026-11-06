// motionex browser motion runtime (optional). Classic script: defines window.Motion and window.__motion.
//
// Scene pages may use this to build one paused GSAP timeline from window.TIMELINE and the scenes registered
// with Motion.scene(). It then exposes the capture contract:
//   window.__motion = { ready, seek(t), duration, size }
// The runtime is a convenience on top of that contract; nothing requires it. Pages without GSAP should use
// adapters.js (window.MotionAdapters) instead.
//
// Rules for scene code, so every frame is reproducible:
//   - animate with GSAP tweens on the scene's timeline only (no CSS transitions or animations)
//   - use Motion.random(seed) instead of Math.random()
//   - anything that depends on time outside GSAP goes in Motion.onFrame(t => ...)
(() => {
  const T = window.TIMELINE ?? {};
  const beat = T.bpm ? 60 / T.bpm : null;
  const builders = new Map();
  const globals = [];
  const frameHooks = [];
  const options = {
    hideOutside: true,
    captions: { in: 0.2, out: 0.14, lead: 0.06 },
  };

  window.Motion = {
    T,
    beat,
    /** Set runtime options. Callable any time before the scenes are built. */
    config(over = {}) {
      if (over.hideOutside !== undefined) options.hideOutside = !!over.hideOutside;
      if (over.captions) Object.assign(options.captions, over.captions);
      return options;
    },
    /** build(tl, el, scene): add tweens to tl; 0 = scene start, scene.dur = its end. */
    scene(id, build) {
      builders.set(id, build);
    },
    /** build(master, T): tweens that span scenes (absolute times). */
    global(build) {
      globals.push(build);
    },
    /** fn(t): runs after every seek, with the absolute time in seconds. */
    onFrame(fn) {
      frameHooks.push(fn);
    },
    random(seed = 1) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    },
    /** 1 on each beat, decaying towards 0 before the next one. 0 when there is no bpm. */
    pulse(t, decay = 5) {
      if (!beat) return 0;
      const song = t + (T.beatOffset ?? 0); // the music may start partway into the song
      if (song < 0) return 0;
      return Math.exp(-decay * ((song % beat) / beat));
    },
    /** Voice loudness at time t, 0..1 (from the build's per-frame envelope); `who` = one cast voice. */
    voice(t, who) {
      const v = (who ? T.voices?.[who] : T.voice) ?? [];
      const x = t * T.fps;
      const i = Math.floor(x);
      const a = v[i] ?? 0;
      const b = v[i + 1] ?? a;
      return a + (b - a) * (x - i);
    },
    /** Start times of a sound effect from the timeline's sfx list, by file name (e.g. "poof"). */
    sfx(name) {
      return (T.sfx ?? []).filter((x) => x.name === name).map((x) => x.at);
    },
    /** Wrap each character of el in <span class="ch"> and return the spans. */
    chars(el) {
      const text = el.textContent;
      el.textContent = '';
      return [...text].map((c) => {
        const s = document.createElement('span');
        s.className = 'ch';
        s.textContent = c === ' ' ? ' ' : c;
        el.appendChild(s);
        return s;
      });
    },
  };

  async function fontsReady() {
    await Promise.all((T.fonts ?? []).map((f) => document.fonts.load(f).catch(() => {})));
    await document.fonts.ready;
  }

  function captions(master, stage) {
    const box = stage?.querySelector('.captions');
    if (!box) return;
    const c = options.captions;
    for (const cue of (T.scenes ?? []).flatMap((s) => s.cues ?? [])) {
      const line = document.createElement('p');
      line.className = 'caption';
      line.textContent = cue.text;
      if (cue.who) line.dataset.who = cue.who;
      box.appendChild(line);
      gsap.set(line, { autoAlpha: 0 });
      master.fromTo(
        line,
        { autoAlpha: 0, y: 18 },
        { autoAlpha: 1, y: 0, duration: c.in, ease: 'power2.out' },
        Math.max(0, cue.at - c.lead),
      );
      master.to(line, { autoAlpha: 0, duration: c.out, ease: 'power1.in' }, cue.at + cue.dur - 0.04);
    }
  }

  /** The declared size if the timeline has one, otherwise the stage's rendered size. */
  function resolveSize(stage) {
    const s = T.size;
    if (s && typeof s === 'object') {
      if (Array.isArray(s)) return { width: s[0], height: s[1] };
      return { width: s.width, height: s.height };
    }
    if (stage) return { width: stage.offsetWidth, height: stage.offsetHeight };
    return null;
  }

  async function build() {
    await fontsReady();
    const stage = document.getElementById('stage');
    const master = gsap.timeline({ paused: true });
    for (const s of T.scenes ?? []) {
      const el = stage?.querySelector(`[data-scene="${s.id}"]`);
      if (!el) {
        console.warn(`no [data-scene="${s.id}"] element in the stage`);
        continue;
      }
      const tl = gsap.timeline();
      if (options.hideOutside) {
        gsap.set(el, { autoAlpha: 0 });
        tl.set(el, { autoAlpha: 1 }, 0);
      }
      builders.get(s.id)?.(tl, el, s);
      if (options.hideOutside) tl.set(el, { autoAlpha: 0 }, s.dur);
      master.add(tl, s.start);
    }
    for (const b of globals) b(master, T);
    captions(master, stage);
    master.set({}, {}, T.total);
    // Render every tween once, in order, so later seeks in any order are exact.
    master.progress(1).progress(0);

    const seek = (t) => {
      master.seek(t, false);
      for (const fn of frameHooks) fn(t);
    };
    seek(0);
    const size = resolveSize(stage);
    window.__motion = { ready: true, seek, duration: T.total, ...(size ? { size } : {}) };
  }

  function start() {
    if (typeof gsap === 'undefined') {
      throw new Error(
        'motion runtime requires GSAP 3 (global `gsap`); pages without GSAP should use MotionAdapters (adapters.js)',
      );
    }
    return build();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
