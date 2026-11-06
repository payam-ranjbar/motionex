// Cheap, dependency-free "ears" for an AI agent: numbers that describe a render
// well enough to catch silence, clipping, mud, harshness, a dead stereo field or
// a section that drops out.
const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);

// One-pole low-pass coefficient for cutoff `fc`.
const onePole = (fc, sr) => 1 - Math.exp((-2 * Math.PI * fc) / sr);

export function analyze(channels, sampleRate, { cps, seconds } = {}) {
  const L = channels[0];
  const R = channels[1] ?? channels[0];
  const n = L.length;

  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let dc = 0;
  let midSq = 0;
  let sideSq = 0;
  let silent = 0;

  // Band energy split: low < 250 Hz, mid 250 Hz-4 kHz, high > 4 kHz.
  const aLow = onePole(250, sampleRate);
  const aHigh = onePole(4000, sampleRate);
  let lpLow = 0;
  let lpHigh = 0;
  let eLow = 0;
  let eMid = 0;
  let eHigh = 0;

  const win = Math.max(1, Math.round(sampleRate * 0.05)); // 50 ms silence windows
  let winSq = 0;

  for (let i = 0; i < n; i++) {
    const l = L[i];
    const r = R[i];
    const m = (l + r) / 2;
    const s = (l - r) / 2;
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    if (al >= 0.999 || ar >= 0.999) clipped++;
    sumSq += (l * l + r * r) / 2;
    dc += m;
    midSq += m * m;
    sideSq += s * s;

    lpLow += aLow * (m - lpLow);
    lpHigh += aHigh * (m - lpHigh);
    const hi = m - lpHigh;
    const mid = lpHigh - lpLow;
    eLow += lpLow * lpLow;
    eMid += mid * mid;
    eHigh += hi * hi;

    winSq += m * m;
    if ((i + 1) % win === 0) {
      if (Math.sqrt(winSq / win) < 0.001) silent++; // below -60 dBFS
      winSq = 0;
    }
  }

  const eTotal = eLow + eMid + eHigh || 1;
  const pct = (e) => Math.round((e / eTotal) * 1000) / 10;

  // Per-cycle loudness so the agent can see structure (drops, builds, gaps).
  const perCycle = [];
  if (cps) {
    const cycleLen = sampleRate / cps;
    for (let c = 0; c * cycleLen < n; c++) {
      const from = Math.floor(c * cycleLen);
      const to = Math.min(n, Math.floor((c + 1) * cycleLen));
      let p = 0;
      let sq = 0;
      for (let i = from; i < to; i++) {
        const m = (L[i] + R[i]) / 2;
        sq += m * m;
        const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (a > p) p = a;
      }
      perCycle.push({ cycle: c, rmsDb: db(Math.sqrt(sq / Math.max(1, to - from))), peakDb: db(p) });
    }
  }

  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const totalWindows = Math.floor(n / win) || 1;
  const report = {
    seconds: seconds ?? n / sampleRate,
    sampleRate,
    peakDb: db(peak),
    rmsDb: db(rms),
    crestDb: Math.round((db(peak) - db(rms)) * 10) / 10,
    clippedSamples: clipped,
    dcOffset: Math.round((dc / Math.max(1, n)) * 1e5) / 1e5,
    silencePct: Math.round((silent / totalWindows) * 1000) / 10,
    stereoWidth: Math.round((Math.sqrt(sideSq) / (Math.sqrt(midSq) || 1)) * 100) / 100,
    bandsPct: { low: pct(eLow), mid: pct(eMid), high: pct(eHigh) },
    perCycle,
  };
  report.warnings = warnings(report);
  return report;
}

function warnings(r) {
  const w = [];
  if (r.peakDb === -Infinity) w.push('render is completely silent');
  else if (r.rmsDb < -40) w.push('very quiet overall (RMS below -40 dBFS)');
  if (r.clippedSamples > 0) w.push(`${r.clippedSamples} clipped samples: lower .gain() or add .postgain()`);
  if (r.silencePct > 60 && r.peakDb !== -Infinity) w.push(`${r.silencePct}% of the render is near-silent: very sparse, or parts drop out`);
  if (r.bandsPct.low > 75) w.push('low end dominates (possible mud): try .hpf() on non-bass parts');
  if (r.bandsPct.high > 40) w.push('a lot of high-frequency energy (possibly harsh): try .lpf()');
  if (r.crestDb < 6 && r.peakDb !== -Infinity) w.push('low crest factor: sounds squashed/over-compressed');
  if (r.stereoWidth < 0.02 && r.peakDb !== -Infinity) w.push('essentially mono: try .pan()');
  if (Math.abs(r.dcOffset) > 0.01) w.push('DC offset present');
  const silentCycles = r.perCycle.filter((c) => c.rmsDb < -50).map((c) => c.cycle);
  if (silentCycles.length && silentCycles.length < r.perCycle.length) w.push(`silent cycles: ${silentCycles.join(', ')}`);
  return w;
}
