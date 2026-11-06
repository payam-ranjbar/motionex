// motionex browser motion adapters (optional). Classic script: defines window.MotionAdapters.
//
// For pages that cannot or do not want to use the GSAP runtime (runtime.js): these adapters provide the same
// capture contract window.__motion = { ready, seek(t), duration, size } over CSS animations/transitions, the
// Web Animations API, or an arbitrary draw(t) function. Nothing in motionex requires the runtime.
(() => {
  function install(motion) {
    window.__motion = motion;
    document.fonts.ready.then(() => {
      motion.ready = true;
    });
    return motion;
  }

  window.MotionAdapters = {
    /** Capture CSS animations, CSS transitions and the Web Animations API. */
    waapi({ duration, size } = {}) {
      const motion = {
        ready: false,
        duration,
        seek(t) {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = t * 1000;
          }
        },
      };
      if (size) motion.size = size;
      return install(motion);
    },
    /** Capture a procedural draw(t); draw may return a Promise. */
    fromFunction(draw, { duration, size } = {}) {
      const motion = {
        ready: false,
        duration,
        seek(t) {
          return draw(t);
        },
      };
      if (size) motion.size = size;
      return install(motion);
    },
  };
})();
