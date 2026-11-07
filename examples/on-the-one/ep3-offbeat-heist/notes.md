# EP3 · HEIST ON THE OFFBEAT — production notes

Paper-cut collage noir heist, funk breakbeat 110 bpm, 12 bars = 26.18 s.
Third-person sports commentator over a crew of three raccoon thieves.

## Deliverable
`out/ep3-offbeat-heist.mp4` — 1080×1920, 30 fps, 26.182 s, H.264 (yuv420p, bt709) + AAC 48 kHz stereo 192 kbps,
26.37 MB, **−14.1 LUFS**, true peak **−1.9 dBTP**, LRA 4.0 LU, 785 frames, 0 stalls, 0 page errors.

## Beat grid
110 bpm, one cycle = one 4/4 bar = **2.18182 s**, beat = 0.54545 s, offbeat hats at +0.2727 / +0.8182 / +1.3636 / +1.9091 s.
Everything in `scene.html` is driven from `t` with `pulseAt(t, off, dec)`: kick pulse (kicks at 16ths 1 / 7 / 11),
snare pulse (16ths 5 / 13), hat pulse (the offbeats). Cuts land on integer bars, stamps on offbeats/snares.

| bar | t (s) | scene | what happens |
|---|---|---|---|
| 1 | 0.000 | in | frame 1 is three panels mid-slam + the "AND THEY'RE IN!" burst already at 80%; eyes snap open on the snare at 0.545 |
| 2–3 | 2.182 | plan | panels slide in on offbeats 2.455 / 3.000 / 3.545; SNAP! SHH! CLICK! TICK! on offbeats; ticker line 2 |
| 4–5 | 6.545 | laser | vault wall, laser grid, crew dodging one step per offbeat; split-flap countdown 3-2-1-0 flipping every beat from 8.727 |
| **6** | **10.909** | **drop** | **THE DROP.** vault slams in and spins open, gold coins as paper confetti, halftone floods orange, "THE VAULT IS OPEN!" |
| 7 | 13.091 | drop | coins raining, horn section riding |
| 8–9 | 15.273 | escape | panels multiply 2 → 4 → 8 (downbeats/mid-bar) then collapse to 1; micro-gags (Tuna eating, a $ panel) |
| 10–11 | 19.636 | getaway | paper car chase, alarm light pulsing on the kick, then the reveal: the "vault" is a FRIDGE |
| 12 | 24.000 | endcard | "ON THE ONE" / "EP 3 · HEIST ON THE OFFBEAT" stamped on the downbeat, drums out, last brass hit rings |

Drop measured with `audio.levels` on the delivered MP4 (grid 110 bpm / 4):
b1 −15.2 · b2 −12.3 · b3 −13.5 · b4 **−17.9** (tension dip) · b5 −13.3 · **b6 −12.7 (DROP)** · b7 −15.4 · b8 −15.0 · b9 −15.0 · b10 −12.3 · b11 −15.5 · b12 −18.6 (endcard).
Bars 2 and 10 are voice-forward bars (lines 2 and 5); the music-only drop jump is the filter opening at bar 6.

## Music (`song.strudel`)
Funk breakbeat, all accents written **on the offbeat**: kick at 16ths 1/7/11, snares on 2 and 4, hats on the offbeats,
slap bass (`gm_slap_bass_1`) syncopated e-minor riff, wah guitar (`gm_electric_guitar_muted`) with an lpf LFO,
horn stabs (`gm_brass_section`) from bar 3, string swell + snare roll in bars 4–5, and from bar 6 a crash, a sub hit,
offbeat claps, 16th hats and a full brass section. Bar 12 drops the kick+snare so the last brass hit rings under the endcard.
Markers `HORN=2`, `DROP=5`, `ENDC=11` (bar indices, 0-based cycles).
**The drop is a filter-open:** in the mix the pre-drop music is low-passed at 1200 Hz and 3 dB down, and crossfades to the
full-band mix 50 ms *before* the downbeat (10.82–10.87 s) so the bar-6 kick is untouched.

## Voice
`voice.piper` en_US-norman-medium, length_scale 0.82 (5 lines, commentator), then `audio.process`:
stadium-PA chain (hpf 150, compressor, −5 dB @250 Hz, +3.5 dB @1.6 k, +4 dB @3.4 k, 38 ms slap echo, lpf 9.5 k, limiter),
`tempo 1.1`, peak-normalised to −3 dBFS, mono 48 kHz. Speech ends: 0.91 / 2.96 / 1.07 / 0.79 / 1.21 s.
Placed at 0, 2.2818, 8.7273, 10.9491, 19.7164 (voice line 4 starts 40 ms after the drop downbeat so the hit is heard).

## Mix (`jobs/mix.json`) — no ducking
* dialogue +3.5 dB; music −7 dB with a static −4.5 dB EQ pocket at 2 kHz (the "clarity pocket"); sfx −12 dB
* master `gain+limiter` to −14 LUFS / −1.9 dBTP (the −1.9 ceiling is deliberate: AAC overshoots ~+0.1 dB)
* measured speech ratio (voice stem vs music stem): **min 9.5 dB, median 11.0 dB**
* per-bar music levels and the drop confirmed with `audio.levels`

## Word effect
Comic **onomatopoeia stamps**: a seeded jagged paper burst, cut-out letters with a black offset, rotating in with an
overshoot and settling (SNAP! SHH! CLICK! TICK! KA-CHUNK! VROOM! …A FRIDGE?!), plus a **split-flap counter** that flips
one digit per beat for the countdown, and a **sports lower-third ticker** (auto-wrapped to two lines, revealed by the wipe)
for the commentator lines. All type is auto-fitted to the frame width and lives inside the safe zone
(nothing above y=230 or below y=1536).

## SFX (`sfx.mjs`, 6 custom sounds, seed 7)
`stamp` (paper slap + low thud) on every onomatopoeia, `paper_slide` on every panel slide, `dial_click` on the countdown
beats, `vault_boom` + `coin_rain` at the drop, `siren` under the getaway. 23 cues, placed on beats, nothing loud under a line.

## Job ids
* music probe 2 cycles `job_01a1b2dd6b4c76e19a3bdd1d96472e7f`
* voice `job_01a1b2ddc8b1716fa306fc62f6923713` → process `job_01a1b2de02227773a56b3f1c68be6abd`
* music v1 `job_01a1b2de3b4e70df9d58809f7cf6c648` · **music v2 (used) `job_01a1b2dece3671da8259e5aa666c078a`**
* timeline.layout `job_01a1b2e2c857758aaf99769ded439898`
* sfx.synth `job_01a1b2dfbad371e5b3190bdee50e1694` (stalled — see below)
* mix v1 `job_01a1b2edcd2570b699a3da207782e515` · v2 `job_01a1b2ee65797436b02ae90012f42ec6` · v3 `job_01a1b2eecd117702a457b6555b40294c` · v4 `job_01a1b2f2b7bd75e6a34011c0f97556c1` · **v5 (used) `job_01a1b2f8b6cf719586550328b0cabbae`**
* stills `job_01a1b2e60048774684f286376cc52ff1`, `job_01a1b2e7c60d73b0b4263b74e37f14a2`, `job_01a1b2f4278576e5a59c1b77e5889aa7`; sheets `job_01a1b2e6cde87762aaf059c1fdf37ec3`, `job_01a1b2e8296476ccb3792bb4b52cff49`
* render v1 `job_01a1b2ef561573f3b08c5c952fcfc3f5` (old page) · **render v2 (used picture) `job_01a1b2f616a27438841f923ac183ac13`**
* remux `job_01a1b2f2e8eb753788383b490d1ba2a3` · **final remux `job_01a1b2f900a6715795e9736738290923`**
* final frames `job_01a1b2f981e371d0a6b901fa26e2fcf1`

## Pins
* `onthe1/ep3-offbeat-heist/music` → `job_01a1b2dece3671da8259e5aa666c078a/music.wav`
* `onthe1/ep3-offbeat-heist/voice` → `job_01a1b2de02227773a56b3f1c68be6abd/l2.wav`
* `onthe1/ep3-offbeat-heist/final` → `episodes/ep3-offbeat-heist/out/ep3-offbeat-heist.mp4` (sha256 d4908ad8…)

## What went wrong / what I did about it
1. **First music render clipped** (peak +1.2 dBFS, 122 clipped samples). Pulled every layer down 2–4 dB and high-passed
   the guitar and brass; the used render is peak +0.1 dBFS with **1** clipped sample (inaudible, and the mix scales it by −7/−10 dB).
2. **The build was barely quieter than the drop** (bar 5 −15.1 vs bar 6 −14.7). Added drop-only 16th hats, offbeat claps and a
   slap-bass octave, removed the guitar for the tension bars, and put the whole pre-drop music through a 1200 Hz lowpass at −3 dB.
3. **`sfx.synth` never finished as a job.** Its progress events reach `1 / done` in 0.2 s and all six WAVs are on disk, but the job
   record stayed `running` with `finished_at: null` (~20 min). I did not re-submit it; I copied the outputs with
   `PUT /v1/files/episodes/ep3-offbeat-heist/sfx/<name>.wav?from=.mx/jobs/<id>/out/<name>.wav` and used those files.
4. **AAC overshot the ceiling**: the −1.5 dBTP mix encoded to −1.4 dBTP. Re-mixed to −1.9 dBTP and re-muxed the existing video with
   `media.ffmpeg -c:v copy` instead of re-rendering the picture.
5. **Picture bugs found in the still review** (fixed before the final render): stamp text overflowed the frame → auto-fit to 830 px;
   the split-flap digit lost its top half → redraw the incoming digit full and fold the outgoing half over it; the ticker text
   overran the bar during the wipe → clip the text to the wipe; the drop flash was too long/washed → 0.16 s at 0.7 alpha;
   the laser panel was an empty black field → added the deposit-box vault wall.

## What I would improve next
* The laser scene (bars 4–5) is still the thinnest frame — a proper vault interior with depth and a foreground element would help.
* The drop's 5-frame white slam flash washes the vault's first frames; 2 frames would hit harder.
* The drop's jump is mostly timbral (the filter opening). A real drum fill on bar 5's last beat and a bigger sub hit would sell it louder.
* Add a slow per-panel push-in so the collage breathes between hits instead of only jolting on the kick.
* Give Big Tuna one more gag in the escape montage (he only carries the sandwich once).
