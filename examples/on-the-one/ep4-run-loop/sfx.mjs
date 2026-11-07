// ON THE ONE - EP4 RUN LOOP - sound effects
// Pure synthesis with the sfx.synth DSP kit: paper, ink, feet and stamps.
export const describe = {
  tear: 'paper tearing under the drop: hundreds of band-passed noise grains plus a low body',
  stamp: 'a brush-blocked word hitting the paper: thud, paper slap',
  tick: 'a soft footstep on the kick, L1 only',
  splat: 'an ink splash stamped on a footfall in the free section',
};

export const finish = {
  tear: { peak_db: -2, fade_out_s: 0.05 },
  stamp: { peak_db: -2.5, fade_out_s: 0.05 },
  tick: { peak_db: -8, fade_out_s: 0.01 },
  splat: { peak_db: -6, fade_out_s: 0.03 },
};

export const sounds = {
  // paper tearing: dense grain stream, densest at the start, over a low body and a thump
  tear(kit, { seconds = 0.85 } = {}) {
    const rng = () => kit.rng();
    const out = kit.buf(seconds);
    let t = 0.004;
    while (t < seconds * 0.92) {
      const u = t / seconds;
      const rate = 420 * (1 - u) + 45;
      t += -Math.log(1 - rng()) / rate;
      const dur = 0.006 + rng() * 0.026;
      const gl = Math.max(8, Math.ceil(dur * kit.SR));
      const grain = new Float32Array(gl);
      for (let i = 0; i < gl; i++) grain[i] = (rng() * 2 - 1) * Math.exp(-i / (gl * 0.34));
      const bp = kit.bpf(grain, 1500 + rng() * 5200, 2.4);
      const amp = (0.2 + rng() * 0.8) * (1 - 0.45 * u);
      kit.add(out, kit.st(bp, (rng() * 2 - 1) * 0.7), t, amp * 0.55);
    }
    // the low body of the sheet giving way
    const low = kit.lp(kit.brown(seconds), 300);
    kit.envApply(low, kit.ad(0.004, 0.18));
    kit.add(out, kit.st(low), 0, 0.5);
    // the impact underneath
    const th = kit.osc(0.4, kit.bpx([[0, 170], [0.13, 42]]));
    kit.envApply(th, kit.ad(0.003, 0.1));
    kit.add(out, kit.st(kit.sat(th, 1.9)), 0, 0.8);
    return out;
  },

  // a stamped word: heavy thud plus the slap of the block on paper
  stamp(kit) {
    const b = kit.buf(0.5);
    const th = kit.osc(0.5, kit.bpx([[0, 130], [0.10, 44]]));
    kit.envApply(th, kit.ad(0.002, 0.1));
    kit.add(b, kit.st(kit.sat(th, 2.2)), 0, 0.9);
    const slap = kit.bpf(kit.white(0.14), 1900, 0.9);
    kit.envApply(slap, kit.expd(6));
    kit.add(b, kit.st(slap, 0.05), 0, 0.42);
    return b;
  },

  // a footfall: a tick of rubber on the street, low and friendly
  tick(kit) {
    const b = kit.buf(0.18);
    const click = kit.bpf(kit.white(0.05), 3400, 1.5);
    kit.envApply(click, kit.expd(90));
    kit.add(b, kit.st(click, -0.12), 0, 0.5);
    const th = kit.osc(0.15, kit.bpx([[0, 200], [0.05, 68]]));
    kit.envApply(th, kit.ad(0.002, 0.04));
    kit.add(b, kit.st(kit.sat(th, 1.4)), 0, 0.6);
    return b;
  },

  // an ink splash: a downward-swept noise burst and a few droplets
  splat(kit) {
    const b = kit.buf(0.38);
    const body = kit.lp(kit.white(0.3), kit.bpx([[0, 4600], [0.16, 640]]));
    kit.envApply(body, kit.ad(0.002, 0.055));
    kit.add(b, kit.st(body, 0.15), 0, 0.75);
    for (let i = 0; i < 4; i++) {
      const d = kit.osc(0.09 + i * 0.01, kit.bpx([[0, 900 + i * 640], [0.06, 380 + i * 200]]));
      kit.envApply(d, kit.expd(70));
      kit.add(b, kit.st(d, -0.45 + 0.3 * i), 0.012 + 0.018 * i, 0.13);
    }
    return b;
  },
};
