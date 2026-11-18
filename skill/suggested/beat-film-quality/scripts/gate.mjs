#!/usr/bin/env node
// The gate: measure a finished cut of a beat-driven film against the rules in this skill's SKILL.md.
//   node gate.mjs <film-dir> [--video <ref>] [--mix <ref>|none] [--tag <name>] [--ref <film-dir>|none] [--no-sheet]
//                            [--bpm <n>] [--drop-bar <n>] [--root <workspace>]
// Run it from the motionex workspace root (or pass --root): <film-dir> and every file ref are relative to it.
// Bars count from 0: bar 0 is the first bar, so drop_bar = drop time / bar length.
// Reads <film-dir>/gate.json: { bpm, drop_bar, beats_per_bar?, fps?, video?, mix?, music_track?, reference?,
//                               holds?: [{from, to, why}] }.
//   video      the file to judge. Default: <film-dir>/out/<folder name>.mp4.
//   mix        the audio.mix job behind it (pin:<name> or job:<id>). It gives the stems and the cue table. Without it
//              the rules that need stems are measured on the full mix or skipped.
//   reference  another film folder whose review/gate.json is an accepted cut; the report ends with a comparison.
//   holds      stretches that are still on purpose (a freeze before the drop). P2 lists them as declared; they still
//              count toward the share of the film that is still.
// Writes <film-dir>/review/gate[-tag].json, gate[-tag].md and gate[-tag]-sheet.png (two frames per bar).
// Exit code: 0 when no rule fails, 1 when one does, 2 on a usage or service error. CHECK lines never fail the gate:
// they are the moments a person has to play.
// Everything heavy runs as motionex jobs; this file only reads their results. No dependencies.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MX = process.env.MX_URL || 'http://127.0.0.1:8095';

// The limits. Each one traces to a rule in SKILL.md; change both together.
// Calibrated against seven cuts a person had already judged (SKILL.md, "How the limits were set").
// A rule FAILS only where the numbers separated the rejected cuts from the accepted ones, or where it is a
// delivery standard. The rest are CHECK: the gate cannot judge them, so it lists the exact moments to play.
const LIMITS = {
  lufs: [-15, -13], // S1 (fail)
  true_peak_max: -1.5, // S1 (fail)
  drop_margin_lu: 0, // S2 (fail): the drop's first bar is at least as loud as every bar before it
  silence_db: -50, // S3 (check): a 50 ms window under this is silent
  silence_max_beats: 1, // S3
  quiet_under_median_lu: 3, // S4 (check): a bar this far under the film's median bar is stripped down
  quiet_max_bars: 2, // S4
  loop_same_db: 1.5, // S5 (check): two blocks closer than this (mean abs dB over 16ths x 3 bands) are the same pattern
  loop_max_blocks: 2, // S5: at most this many identical 2-bar blocks in a row
  sfx_over_music_db: 0, // S6 (check): a cue at or above the music while the music plays
  sfx_buried_db: -26, // S6: a cue this far under the music is not heard
  music_playing_db: -35, // S6: under this the music counts as a gap, and a hit there may be the loudest thing
  first_frame_std: 8, // P1 (fail)
  still_d3: 0.6, // P2: mean abs luma change over 0.1 s (0-255, 54x96 frames) under this is "nothing moved"
  still_share_max: 0.15, // P2 (fail): accepted cuts 1-11%, "lacked dynamic" 24%, rejected 37%
  still_max_s: 0.5, // P2 (check): a longer still stretch is listed unless gate.json declares it as a hold
  beat_hit_ratio: 1.5, // P3: a beat is "hit" when motion right on it is this many times the motion around it
  beat_hit_min: 0.75, // P3 (fail): accepted cuts 84-95%, "lacked dynamic" 69%
  flat_bar_motion: 0.8, // P4 (fail): a bar whose mean frame-to-frame change is under this is flat (accepted cuts: 1.1 and up)
  edge_bars: 2, // P4, S4: the first and last two bars (intro, end card) are excused
};

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const arg = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
if (!arg) {
  console.error(
    'usage: node gate.mjs <film-dir> [--video <ref>] [--mix <ref>|none] [--tag <name>] [--ref <film-dir>|none] [--no-sheet] [--bpm <n>] [--drop-bar <n>] [--root <workspace>]',
  );
  process.exit(2);
}
const ROOT = path.resolve(opt('--root') || process.cwd());
const epDir = path.resolve(ROOT, arg);
const id = path.basename(epDir);
const rel = path.relative(ROOT, epDir).split(path.sep).join('/');
const cfgFile = path.join(epDir, 'gate.json');
if (!existsSync(cfgFile)) {
  console.error(`missing ${cfgFile}: write { "bpm": <n>, "drop_bar": <n> } first (see SKILL.md)`);
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
if (opt('--bpm')) cfg.bpm = Number(opt('--bpm')); // an older cut of the same film may have another tempo
if (opt('--drop-bar')) cfg.drop_bar = Number(opt('--drop-bar'));
const FPS = cfg.fps || 30;
const BPB = cfg.beats_per_bar || 4;
const BEAT = 60 / cfg.bpm;
const BAR = BEAT * BPB;
const tag = opt('--tag');
const videoRef = opt('--video') || cfg.video || `${rel}/out/${id}.mp4`;
const mixRef = opt('--mix') || cfg.mix || 'none';
const refEp = opt('--ref') || cfg.reference || 'none';
const W = 54;
const H = 96;

// ---------- motionex ----------
async function job(tool, input) {
  const r = await fetch(`${MX}/v1/jobs?wait=300`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, input, label: 'gate', project: `gate/${id}` }),
  });
  let j = await r.json();
  if (!j.id) throw new Error(`${tool}: ${j.detail || JSON.stringify(j)}`);
  while (j.status === 'queued' || j.status === 'running')
    j = await (await fetch(`${MX}/v1/jobs/${j.id}?wait=300`)).json();
  if (j.status !== 'succeeded') throw new Error(`${tool} ${j.status}: ${j.error?.detail}`);
  return j;
}
async function output(jobId, name) {
  const r = await fetch(`${MX}/v1/jobs/${jobId}/outputs/${name}`);
  if (!r.ok) throw new Error(`output ${jobId}/${name}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function mixJobId(ref) {
  if (!ref || ref === 'none') return null;
  if (ref.startsWith('job:')) return ref.slice(4).split('/')[0];
  if (ref.startsWith('pin:')) {
    const r = await fetch(`${MX}/v1/pins/${ref.slice(4).split('#')[0]}`);
    if (!r.ok) return null;
    return (await r.json()).target?.job || null;
  }
  return null;
}

// ---------- signal helpers ----------
function readWav(buf) {
  let p = 12;
  let fmt = null;
  while (p + 8 <= buf.length) {
    const cid = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (cid === 'fmt ')
      fmt = {
        tag: buf.readUInt16LE(p + 8),
        ch: buf.readUInt16LE(p + 10),
        sr: buf.readUInt32LE(p + 12),
        bits: buf.readUInt16LE(p + 22),
      };
    if (cid === 'data') {
      const bytes = fmt.bits / 8;
      const end = Math.min(buf.length, p + 8 + size);
      const n = Math.floor((end - p - 8) / (bytes * fmt.ch));
      const x = new Float32Array(n);
      for (let i = 0, q = p + 8; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.ch; c++, q += bytes) {
          if (fmt.tag === 3) s += buf.readFloatLE(q);
          else if (bytes === 2) s += buf.readInt16LE(q) / 32768;
          else if (bytes === 3) s += buf.readIntLE(q, 3) / 8388608;
          else s += buf.readInt32LE(q) / 2147483648;
        }
        x[i] = s / fmt.ch;
      }
      return { sr: fmt.sr, x };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('not a PCM wav');
}
const dB = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -180);
function rms(x, a, b) {
  a = Math.max(0, Math.floor(a));
  b = Math.min(x.length, Math.floor(b));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}
function lowpass(x, sr, hz) {
  const k = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  const y = new Float32Array(x.length);
  let z = 0;
  for (let i = 0; i < x.length; i++) {
    z += k * (x[i] - z);
    y[i] = z;
  }
  return y;
}
function bands({ sr, x }) {
  const l1 = lowpass(lowpass(x, sr, 200), sr, 200);
  const l2 = lowpass(lowpass(x, sr, 2500), sr, 2500);
  const mid = new Float32Array(x.length);
  const high = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    mid[i] = l2[i] - l1[i];
    high[i] = x[i] - l2[i];
  }
  return [l1, mid, high];
}
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
const f1 = (v) => (v === null || v === undefined ? '--' : v.toFixed(1));
const f2 = (v) => v.toFixed(2);
const barBeat = (t) => {
  const b = Math.floor(t / BEAT + 1e-6);
  return `${Math.floor(b / BPB)}.${b % BPB}`;
};
function runs(flags, minLen) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i];
    if (on && s < 0) s = i;
    if (!on && s >= 0) {
      if (i - s >= minLen) out.push([s, i]);
      s = -1;
    }
  }
  return out;
}

// ---------- the checks ----------
const checks = [];
const add = (cid, rule, status, value, detail = []) => checks.push({ id: cid, rule, status, value, detail });

async function main() {
  const ready = await fetch(`${MX}/readyz`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!ready) throw new Error(`motionex is not ready at ${MX}`);
  console.log(`gate ${id}${tag ? ` (${tag})` : ''}: ${videoRef}, ${cfg.bpm} bpm, drop at bar ${cfg.drop_bar}`);

  const [raw, loud, levels] = await Promise.all([
    job('media.ffmpeg', {
      args: [
        '-i',
        '{in:v}',
        '-map',
        '0:v:0',
        '-vf',
        `scale=${W}:${H}:flags=area,format=gray`,
        '-f',
        'rawvideo',
        '{out:gray.raw}',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s16le',
        '{out:audio.wav}',
      ],
      inputs: { v: videoRef },
      outputs: ['gray.raw', 'audio.wav'],
    }),
    job('audio.loudness', { input: videoRef }),
    job('audio.levels', { input: videoRef, grid: { bpm: cfg.bpm, beats_per_bar: BPB } }),
  ]);
  const gray = await output(raw.id, 'gray.raw');
  const audio = readWav(await output(raw.id, 'audio.wav'));
  const N = Math.floor(gray.length / (W * H));
  const dur = N / FPS;
  const nBars = Math.floor(dur / BAR + 0.02);
  const nBeats = Math.floor(dur / BEAT + 0.02);
  const metrics = { duration_s: +dur.toFixed(2), bars: nBars };

  // ----- sound -----
  const L = loud.result;
  metrics.lufs = L.integrated_lufs;
  metrics.true_peak = L.true_peak_dbtp;
  metrics.lra = L.lra_lu;
  const okLoud =
    L.integrated_lufs >= LIMITS.lufs[0] &&
    L.integrated_lufs <= LIMITS.lufs[1] &&
    L.true_peak_dbtp <= LIMITS.true_peak_max;
  add(
    'S1',
    'Loudness about -14 LUFS, true peak at or under -1.5 dBTP',
    okLoud ? 'pass' : 'fail',
    `${L.integrated_lufs} LUFS, ${L.true_peak_dbtp} dBTP, LRA ${L.lra_lu}`,
  );

  const bars = levels.result.rows.slice(0, nBars).map((r) => r.lufs);
  metrics.bar_lufs = bars;
  const sr = audio.sr;
  const win = Math.round(sr * 0.05);
  const env = [];
  for (let i = 0; i + win <= audio.x.length; i += win) env.push(dB(rms(audio.x, i, i + win)));
  const lastSound = env.findLastIndex((v) => v > LIMITS.silence_db);
  const sil = runs(
    env.slice(0, lastSound + 1).map((v) => v < LIMITS.silence_db),
    2,
  ).map(([a, b]) => [a * 0.05, b * 0.05]);
  const longestSil = sil.reduce((p, [a, b]) => Math.max(p, b - a), 0);
  metrics.longest_silence_s = +longestSil.toFixed(2);
  add(
    'S3',
    `No silence longer than ${LIMITS.silence_max_beats} beat`,
    longestSil <= LIMITS.silence_max_beats * BEAT + 0.06 ? 'pass' : 'check',
    `longest ${f2(longestSil)} s (one beat is ${f2(BEAT)} s)`,
    sil.filter(([a, b]) => b - a > 0.15).map(([a, b]) => `silent ${f2(a)}-${f2(b)} s (bar ${barBeat(a)})`),
  );

  const medBar = median(bars.filter((v) => v !== null));
  const quiet = runs(
    bars.map((v) => v === null || v < medBar - LIMITS.quiet_under_median_lu),
    1,
  );
  const body = quiet
    .map(([a, b]) => [Math.max(a, LIMITS.edge_bars), Math.min(b, nBars - LIMITS.edge_bars)])
    .filter(([a, b]) => b > a); // an intro and an outro may be quiet
  const longestQuiet = body.reduce((p, [a, b]) => Math.max(p, b - a), 0);
  metrics.longest_quiet_bars = longestQuiet;
  add(
    'S4',
    `No stripped-down stretch longer than ${LIMITS.quiet_max_bars} bars`,
    longestQuiet <= LIMITS.quiet_max_bars ? 'pass' : 'check',
    `longest ${longestQuiet} bars more than ${LIMITS.quiet_under_median_lu} LU under the median bar (${f1(medBar)} LUFS)`,
    body.map(([a, b]) => `quiet bars ${a}-${b - 1}: ${bars.slice(a, b).map(f1).join(' ')}`),
  );

  // the mix behind the file: stems and the cue list
  const mixId = await mixJobId(mixRef);
  let stems = null;
  let mixJob = null;
  if (mixId) {
    mixJob = await (await fetch(`${MX}/v1/jobs/${mixId}`)).json();
    if (mixJob.status === 'succeeded' && mixJob.outputs?.some((o) => o.name.startsWith('stems/'))) {
      stems = {};
      for (const o of mixJob.outputs.filter((o) => o.name.startsWith('stems/') && o.name.endsWith('.wav')))
        stems[o.name.slice(6, -4)] = readWav(await output(mixId, o.name));
    }
  }
  const musicName = cfg.music_track || 'music';
  const music = stems?.[musicName] || null;

  // S2: the drop, measured on the music alone when its stem is there (a voice line is not the drop)
  const mBars = music
    ? Array.from(
        { length: nBars },
        (_, b) => +dB(rms(music.x, b * BAR * music.sr, (b + 1) * BAR * music.sr)).toFixed(1),
      )
    : bars;
  if (music) metrics.music_bar_db = mBars;
  const unit = music ? 'dB (music stem)' : 'LUFS (full mix, no stem)';
  const dropLevel = mBars[cfg.drop_bar] ?? -99;
  const loudestBefore = mBars
    .slice(0, cfg.drop_bar)
    .map((v, i) => [v, i])
    .filter(([v]) => v !== null)
    .reduce((p, q) => (q[0] > p[0] ? q : p), [-99, -1]);
  add(
    'S2',
    'The drop lands on its bar and is the loudest bar of music so far',
    dropLevel - loudestBefore[0] >= LIMITS.drop_margin_lu ? 'pass' : 'fail',
    `drop bar ${cfg.drop_bar} at ${f1(dropLevel)} ${unit}; loudest earlier bar ${loudestBefore[1]} at ${f1(loudestBefore[0])}`,
    [
      `music per bar: ${mBars.map((v, i) => `${i}:${f1(v)}`).join(' ')}`,
      `mix per bar (LUFS): ${bars.map((v, i) => `${i}:${f1(v)}`).join(' ')}`,
    ],
  );

  // S5: does the music loop?
  const src = music || audio;
  const bnd = bands(src);
  const step = (BAR / 16) * src.sr;
  const blockLen = 32;
  const nBlocks = Math.floor(nBars / 2);
  const feat = [];
  for (let k = 0; k < nBlocks; k++) {
    const v = [];
    for (const b of bnd)
      for (let s = 0; s < blockLen; s++)
        v.push(Math.max(-60, dB(rms(b, (k * blockLen + s) * step, (k * blockLen + s + 1) * step))));
    feat.push(v);
  }
  const dist = (a, b) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++)
      if (a[i] > -50 || b[i] > -50) {
        s += Math.abs(a[i] - b[i]);
        n++;
      }
    return n ? s / n : 0;
  };
  const audible = feat.map((v) => mean(v) > -50);
  const d = [];
  for (let k = 0; k + 1 < nBlocks; k++) d.push(dist(feat[k], feat[k + 1]));
  const same = d.map((v, k) => audible[k] && audible[k + 1] && v < LIMITS.loop_same_db);
  const loopRuns = runs(same, 1);
  const longestLoop = loopRuns.reduce((p, [a, b]) => Math.max(p, b - a + 1), 1);
  const feat1 = [];
  for (let k = 0; k < nBars; k++) {
    const v = [];
    for (const bb of bnd)
      for (let q = 0; q < 16; q++) v.push(Math.max(-60, dB(rms(bb, (k * 16 + q) * step, (k * 16 + q + 1) * step))));
    feat1.push(v);
  }
  const d1bar = [];
  for (let k = 0; k + 1 < nBars; k++)
    d1bar.push(mean(feat1[k]) > -50 && mean(feat1[k + 1]) > -50 ? dist(feat1[k], feat1[k + 1]) : null);
  metrics.bar_change_db = d1bar.map((v) => (v === null ? null : +v.toFixed(1)));
  const pairs = d1bar.filter((v) => v !== null);
  metrics.repeat_bar_share = pairs.length
    ? +(pairs.filter((v) => v < LIMITS.loop_same_db).length / pairs.length).toFixed(2)
    : 0;
  // how many different bars the music has: a bar is new when no earlier bar is within the limit
  let distinct = 0;
  for (let k = 0; k < nBars; k++) {
    if (mean(feat1[k]) <= -50) continue;
    let seen = false;
    for (let j = 0; j < k; j++) if (mean(feat1[j]) > -50 && dist(feat1[k], feat1[j]) < LIMITS.loop_same_db) seen = true;
    if (!seen) distinct++;
  }
  metrics.distinct_bars = distinct;
  metrics.block_change_db = d.map((v) => +v.toFixed(1));
  metrics.longest_loop_blocks = longestLoop;
  add(
    'S5',
    `The music changes at least every ${LIMITS.loop_max_blocks * 2} bars`,
    longestLoop <= LIMITS.loop_max_blocks ? 'pass' : 'check',
    `longest run of one pattern: ${longestLoop * 2} bars; ${metrics.distinct_bars} different bars in ${nBars}; ${Math.round(metrics.repeat_bar_share * 100)}% of bars repeat the bar before (${music ? 'music stem' : 'full mix, no stem'})`,
    [
      `change between 2-bar blocks (dB; under ${LIMITS.loop_same_db} is the same pattern): ${d.map((v, k) => `${k * 2}>${k * 2 + 2}:${f1(v)}`).join(' ')}`,
    ],
  );

  if (stems && music) {
    const others = Object.entries(stems)
      .filter(([n]) => n !== musicName)
      .map(([, v]) => v);
    const w = Math.round(music.sr * 0.05);
    let playing = 0;
    let over = 0;
    let eo = 0;
    let em = 0;
    for (let i = 0; i + w <= music.x.length; i += w) {
      const m = rms(music.x, i, i + w);
      let o2 = 0;
      for (const st of others) o2 += rms(st.x, i, i + w) ** 2;
      eo += o2;
      em += m * m;
      if (dB(m) < LIMITS.music_playing_db) continue;
      playing++;
      if (o2 >= m * m) over++;
    }
    metrics.over_music_share = playing ? +(over / playing).toFixed(3) : 0;
    metrics.others_vs_music_db = +(10 * Math.log10((eo + 1e-12) / (em + 1e-12))).toFixed(1);
  }

  // S6: every cue against the music at its own moment
  if (stems && music && mixJob) {
    const rows = [];
    for (const tr of mixJob.input.tracks) {
      if (tr.name === musicName || !stems[tr.name]) continue;
      const st = stems[tr.name];
      for (const c of tr.clips) {
        const len = Math.min(Math.max(c.duration_s || 0.35, 0.15), 0.35);
        const fg = dB(rms(st.x, c.at * st.sr, (c.at + len) * st.sr));
        const bg = dB(rms(music.x, c.at * music.sr, (c.at + len) * music.sr));
        rows.push({
          track: tr.name,
          name: c.name || path.basename(String(c.src)),
          at: c.at,
          fg: +fg.toFixed(1),
          music: +bg.toFixed(1),
          ratio: +(fg - bg).toFixed(1),
          gap: bg < LIMITS.music_playing_db,
        });
      }
    }
    metrics.cues = rows;
    const isVoice = (r) => r.track === 'cues' || r.track === 'voice' || r.track === 'dialogue';
    const sfx = rows.filter((r) => !isVoice(r));
    const compete = rows.filter((r) => !r.gap && r.ratio >= LIMITS.sfx_over_music_db);
    const buried = sfx.filter((r) => !r.gap && r.ratio < LIMITS.sfx_buried_db);
    const line = (r) =>
      `${isVoice(r) ? 'voice ' : ''}${r.name} at ${f2(r.at)} s (bar ${barBeat(r.at)}): ${r.fg} dB against music ${r.music} = ${r.ratio > 0 ? '+' : ''}${r.ratio}`;
    metrics.sfx_median_db = +median(sfx.filter((r) => !r.gap).map((r) => r.ratio)).toFixed(1);
    add(
      'S6',
      'Sound effects and voices sit under the music; none is lost',
      compete.length || buried.length ? 'check' : 'pass',
      `${rows.length} cues: ${compete.length} at or over the music, ${buried.length} more than ${-LIMITS.sfx_buried_db} dB under it; SFX median ${f1(metrics.sfx_median_db)} dB; something else is louder than the music ${(metrics.over_music_share * 100).toFixed(0)}% of the time`,
      [...compete.map((r) => `over: ${line(r)}`), ...buried.map((r) => `buried: ${line(r)}`)],
    );
  } else
    add('S6', 'Sound effects and voices sit under the music; none is lost', 'skip', 'no mix job with stems was found');

  // spectrum shares of the whole mix, for the comparison
  const ab = bands(audio);
  const e = ab.map((b) => rms(b, 0, b.length) ** 2);
  const et = e[0] + e[1] + e[2];
  metrics.band_share = e.map((v) => +((100 * v) / et).toFixed(1));
  let pk = 0;
  for (let i = 0; i < audio.x.length; i++) pk = Math.max(pk, Math.abs(audio.x[i]));
  metrics.crest_db = +(dB(pk) - dB(rms(audio.x, 0, audio.x.length))).toFixed(1);

  // ----- picture -----
  const fr = (i) => gray.subarray(i * W * H, (i + 1) * W * H);
  const diff = (a, b) => {
    const p = fr(a);
    const q = fr(b);
    let s = 0;
    for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
    return s / p.length;
  };
  const f0 = fr(0);
  const m0 = mean(Array.from(f0));
  const sd0 = Math.sqrt(mean(Array.from(f0).map((v) => (v - m0) ** 2)));
  add(
    'P1',
    'Frame 1 is a picture, not black and not a fade',
    sd0 >= LIMITS.first_frame_std ? 'pass' : 'fail',
    `first frame contrast ${f1(sd0)} (needs ${LIMITS.first_frame_std})`,
  );

  const d1 = [];
  for (let i = 0; i + 1 < N; i++) d1.push(diff(i, i + 1));
  const d3 = [];
  for (let i = 0; i + 3 < N; i++) d3.push(diff(i, i + 3));
  const holds = cfg.holds || [];
  const inHold = (t) => holds.some((h) => t >= h.from - 0.02 && t <= h.to + 0.02);
  const still = runs(
    d3.map((v) => v < LIMITS.still_d3),
    2,
  ).map(([a, b]) => [a / FPS, (b + 2) / FPS]);
  const stillOut = still.filter(([a, b]) => !(inHold(a) && inHold(b)));
  const longestStill = stillOut.reduce((p, [a, b]) => Math.max(p, b - a), 0);
  metrics.longest_still_s = +longestStill.toFixed(2);
  metrics.still_share = +(d3.filter((v) => v < LIMITS.still_d3).length / d3.length).toFixed(3);
  const longStills = stillOut.filter(([a, b]) => b - a > LIMITS.still_max_s + 0.04);
  const tooStill = metrics.still_share > LIMITS.still_share_max;
  add(
    'P2',
    `The picture keeps moving: at most ${LIMITS.still_share_max * 100}% of the film is still`,
    tooStill ? 'fail' : longStills.length ? 'check' : 'pass',
    `${(metrics.still_share * 100).toFixed(0)}% of the film is still; longest stretch that is not a declared hold ${f2(longestStill)} s`,
    [
      ...(tooStill ? stillOut.filter(([a, b]) => b - a > 0.3) : longStills).map(
        ([a, b]) => `still ${f2(a)}-${f2(b)} s (bar ${barBeat(a)})`,
      ),
      ...holds.map((h) => `declared hold ${h.from}-${h.to} s: ${h.why}`),
    ],
  );

  let hit = 0;
  let counted = 0;
  const missed = [];
  for (let b = 0; b < nBeats; b++) {
    const t = b * BEAT;
    if (inHold(t)) continue;
    const f = Math.round(t * FPS);
    const on = Math.max(...d1.slice(Math.max(0, f - 1), f + 3), 0);
    const a0 = Math.max(0, Math.round((t - BEAT / 2) * FPS));
    const around = median(d1.slice(a0, Math.round((t + BEAT / 2) * FPS)));
    counted++;
    if (on >= LIMITS.beat_hit_ratio * around && on >= 0.5) hit++;
    else missed.push(barBeat(t));
  }
  metrics.beat_hit_share = +(hit / counted).toFixed(2);
  add(
    'P3',
    'Something visibly lands on the beat',
    hit / counted >= LIMITS.beat_hit_min ? 'pass' : 'fail',
    `${hit} of ${counted} beats have a visible hit (${(metrics.beat_hit_share * 100).toFixed(0)}%, needs ${LIMITS.beat_hit_min * 100}%)`,
    missed.length ? [`beats with no hit: ${missed.join(' ')}`] : [],
  );

  const barMotion = [];
  for (let b = 0; b < nBars; b++)
    barMotion.push(mean(d1.slice(Math.round(b * BAR * FPS), Math.round((b + 1) * BAR * FPS))));
  const medMotion = median(barMotion);
  metrics.bar_motion = barMotion.map((v) => +v.toFixed(2));
  metrics.motion_median = +medMotion.toFixed(2);
  const flat = barMotion
    .map((v, b) => [v, b])
    .filter(([v, b]) => v < LIMITS.flat_bar_motion && b >= LIMITS.edge_bars && b < nBars - LIMITS.edge_bars);
  metrics.flat_bars = flat.map(([, b]) => b);
  const calmest = Math.min(...barMotion.slice(LIMITS.edge_bars, nBars - LIMITS.edge_bars));
  add(
    'P4',
    'No flat bar between the intro and the end card',
    flat.length ? 'fail' : 'pass',
    flat.length
      ? `flat bars (motion under ${LIMITS.flat_bar_motion}): ${flat.map(([v, b]) => `${b} (${f2(v)})`).join(', ')}`
      : `the calmest bar in the body moves ${f2(calmest)} (needs ${LIMITS.flat_bar_motion}); median bar ${f2(medMotion)}`,
    [`motion per bar: ${barMotion.map((v, i) => `${i}:${f2(v)}`).join(' ')}`],
  );

  // ----- the sheet for the look list -----
  let sheet = null;
  if (!args.includes('--no-sheet')) {
    const times = [];
    for (let b = 0; b < nBars; b++)
      times.push(
        +Math.min(dur - 0.05, b * BAR + 0.2).toFixed(3),
        +Math.min(dur - 0.05, b * BAR + 2.5 * BEAT).toFixed(3),
      );
    const fj = await job('media.frames', { video: videoRef, times, width: 270, format: 'jpeg' });
    const frames = fj.result.frames;
    const sj = await job('image.contact-sheet', {
      images: frames.map((f) => `job:${fj.id}/${f.name}`),
      columns: 8,
      cell_width: 216,
      labels: frames.map((f) => `${barBeat(f.t)}  ${f.t.toFixed(1)}s`),
      gap_px: 6,
      background: '#202020',
      format: 'png',
    });
    const png = sj.outputs.find((o) => o.name.endsWith('.png'));
    sheet = `gate${tag ? `-${tag}` : ''}-sheet.png`;
    mkdirSync(path.join(epDir, 'review'), { recursive: true });
    writeFileSync(path.join(epDir, 'review', sheet), await output(sj.id, png.name));
  }

  // ----- report -----
  checks.sort((p, q) => (p.id < q.id ? -1 : 1));
  const fails = checks.filter((c) => c.status === 'fail');
  const mark = { pass: 'PASS', fail: 'FAIL', check: 'CHECK', skip: 'SKIP' };
  const toCheck = checks.filter((c) => c.status === 'check');
  const lines = [
    `# Gate: ${id}${tag ? ` (${tag})` : ''}`,
    '',
    `File: \`${videoRef}\`, ${dur.toFixed(1)} s, ${cfg.bpm} bpm, drop at bar ${cfg.drop_bar}. Mix: ${mixId ? `\`${mixId}\`` : 'none'}.`,
    '',
    `**${fails.length ? `${fails.length} rule(s) fail: ${fails.map((c) => c.id).join(', ')}` : 'No rule fails'}; ${toCheck.length} to listen to or look at${toCheck.length ? ` (${toCheck.map((c) => c.id).join(', ')})` : ''}.** These are measurements; nobody has listened or watched.`,
    '',
  ];
  for (const c of checks) {
    lines.push(`- **${mark[c.status]} ${c.id}** ${c.rule}: ${c.value}`);
    for (const x of c.detail) lines.push(`  - ${x}`);
  }
  // comparison with the accepted reference
  const refFile = path.resolve(ROOT, refEp, 'review', 'gate.json');
  if (refEp !== 'none' && path.resolve(ROOT, refEp) !== epDir && existsSync(refFile)) {
    const R = JSON.parse(readFileSync(refFile, 'utf8')).metrics;
    const row = (name, a, b) => `| ${name} | ${a} | ${b} |`;
    lines.push('', `## Against the accepted reference (${refEp})`, '', '| | this cut | reference |', '|---|---|---|');
    lines.push(row('Loudness range (LU)', metrics.lra, R.lra), row('Crest factor (dB)', metrics.crest_db, R.crest_db));
    lines.push(row('Energy low / mid / high (%)', metrics.band_share.join(' / '), R.band_share.join(' / ')));
    lines.push(
      row('Median bar motion', metrics.motion_median, R.motion_median),
      row('Beats with a visible hit', metrics.beat_hit_share, R.beat_hit_share),
    );
    lines.push(
      row('Share of the film that is still', metrics.still_share, R.still_share),
      row('Longest silence (s)', metrics.longest_silence_s, R.longest_silence_s),
    );
    lines.push(
      row('Bars that repeat the bar before', metrics.repeat_bar_share, R.repeat_bar_share ?? '--'),
      row('SFX against the music, median (dB)', metrics.sfx_median_db ?? '--', R.sfx_median_db ?? '--'),
    );
  }
  lines.push(
    '',
    '## Still to do by ear and eye',
    '',
    `Play every moment marked CHECK above. Then open \`review/${sheet || '(no sheet made)'}\` and go through the EAR and EYE rules in the skill's \`SKILL.md\`.`,
    '',
  );
  const base = path.join(epDir, 'review', `gate${tag ? `-${tag}` : ''}`);
  mkdirSync(path.join(epDir, 'review'), { recursive: true });
  writeFileSync(`${base}.md`, lines.join('\n'));
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        id,
        tag: tag || null,
        video: videoRef,
        mix: mixId,
        at: new Date().toISOString(),
        limits: LIMITS,
        checks,
        metrics,
      },
      null,
      1,
    ),
  );
  console.log(lines.slice(4).join('\n'));
  console.log(`\nwrote ${path.relative(ROOT, base)}.md / .json${sheet ? ` and review/${sheet}` : ''}`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`gate: ${err.message}`);
  process.exit(2);
});
