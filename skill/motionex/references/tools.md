# motionex tools

Every motionex tool takes a JSON object. Any file input is a ref: a workspace path such as `films/a/tone.wav`, `job:<id>/<output-path>` for an output of an earlier job, `pin:<name>` for everything in a pin, or `pin:<name>#<output-path>` for one output of a pin. The service resolves refs to files before the tool runs; write outputs through the tool that produces them. Tools enforce nothing beyond their own parameters: defaults are neutral, and every opinion (ducking, loudness target, fps, size, codec) is an explicit field or a named preset.

## Index

- **audio.levels** — RMS, sample peak and ungated LUFS per time window of an audio or video file, using explicit windows, a fixed step, or a musical bar/beat grid.
- **audio.loudness** — Integrated loudness, loudness range, true peak and sample peak of an audio or video file, optionally with a momentary or short-term loudness curve.
- **audio.mix** — Declarative track/bus mixer: places clips sample-accurately on tracks, sums them to an exact length, optional per-track fx, level, sidechain and master stage. Plain float sum by default.
- **audio.process** — Run an ordered list of processing steps over audio takes: ffmpeg filters, pitch, tempo, gain, silence trim, pause tightening, fades and peak normalisation, written as wav, flac or mp3.
- **audio.silence** — Finds silences (including leading and trailing) and where speech ends in an audio or video file, using 10 ms windows and a peak threshold.
- **audio.speech-ratio** — How far a voice sits above its background inside the speech band (default 300-3400 Hz), per line or per given window, with the minimum and median ratio.
- **audio.stats** — Peak, RMS, crest, clipping, DC offset, stereo width, band energy, silence percentage and per-cycle loudness of an audio or video file.
- **image.contact-sheet** — Lay images out in a grid so a set of stills can be reviewed at a glance.
- **media.concat** — Join two or more clips: stream copy for sections rendered with identical settings, or the concat filter to re-encode across differing sources.
- **media.encode** — Encode a video with explicit quality, bitrate, size, scaling and audio controls, including fit-to-N-MB two-pass encoding and named delivery presets.
- **media.ffmpeg** — Run an ffmpeg command on workspace files.
- **media.frames** — Grab still frames from a video at given times, as PNG or JPEG, optionally scaled to a width, to eyeball or compare an encode.
- **media.mux** — Put an audio track onto a video without re-encoding the video: stream-copy the video and encode (or copy) the audio, with an optional audio delay.
- **media.probe** — Inspect a media file with ffprobe: duration, size, format and bit rate plus a typed per-stream summary of codec, dimensions, frame rate, pixel format, colour tags, sample rate and channels.
- **music.render** — Render a Strudel song to audio with the Mucavex engine: seeded deterministic noise, named section markers, optional tempo override and an analysis report.
- **picture.render** — Render an HTML page that exposes window.__motion (ready, seek(t), duration?, size?) to a video, frame by frame, with optional audio muxed in the same pass.
- **picture.stills** — Write still frames of an HTML page that exposes window.__motion (ready, seek(t), duration?, size?) as PNG or JPEG, at the times you ask for.
- **sfx.synth** — Synthesize sound effects from a recipe module: a workspace .mjs or the built-in generic recipes. Each sound is finished (trim, fades, normalise), written as a WAV and measured.
- **timeline.layout** — Lay scenes out from voice-over lines: cue times, scene lengths, optional beat snapping, music markers and named times. Writes timeline.json and dialogue-clips.json.
- **voice.elevenlabs** — Synthesize one line of speech with ElevenLabs and write take.mp3 plus take.wav. Optional provider: it needs an elevenlabs_api_key secret file and network access.
- **voice.elevenlabs-voices** — List the ElevenLabs voices available to the key, optionally filtered by a search string. Optional provider: it needs an elevenlabs_api_key secret file and network access.
- **voice.phonemize** — Show how a Piper voice will pronounce text as IPA, sentence by sentence, without synthesizing any audio. Use it to check a name, write [[raw phonemes]] lines, or debug odd pronunciation.
- **voice.piper** — Synthesize voice-over lines to 16-bit mono WAV files with a local Piper voice, one file per line, with per-line durations and speech-end times.

## audio.levels

**Levels by time window**: RMS, sample peak and ungated LUFS per time window of an audio or video file, using explicit windows, a fixed step, or a musical bar/beat grid.

Analysis only. Windows come from an explicit list, a step in seconds or a bar/beat grid. String times (scene ids, cues, bar:n, beat:n) resolve against a timeline JSON using the same grammar as timeline.layout. Silence is reported as null, never -Infinity.

class: audio · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| input | ref | yes |  | Audio or video file to measure: a workspace path, job:<id>/<output> or pin:<name>. |
| timeline | ref |  |  | Optional timeline JSON (timeline.layout output) used to resolve string times such as scene ids, cues, bar:n and beat:n. |
| windows | array |  |  | Explicit windows. Each is measured over [from, to). |
| windows[].name | string |  |  | Optional label copied into the result row. |
| windows[].from | number\|string | yes |  | Window start: seconds or a timespec (scene id, cue, bar:n, beat:n). |
| windows[].to | number\|string | yes |  | Window end: seconds or a timespec (scene id, cue, bar:n, beat:n). |
| step_s | number |  |  | Window length in seconds: [0,s), [s,2s), ... The last window is cut at the duration. |
| grid | object |  |  | Musical windows starting at offset_s, one per bar (default) or beat. |
| grid.bpm | number | yes |  | Tempo in beats per minute. |
| grid.beats_per_bar | integer |  | 4 | Beats in a bar. |
| grid.offset_s | number |  | 0 | Seconds before the first window starts. |
| grid.per | enum |  | "bar" | Window length: one bar or one beat. |
| (one of) |  |  |  | windows \| step_s \| grid |

### Example: One-second windows of a 3 s tone

```json
{
  "input": "tone.wav",
  "step_s": 1
}
```

### Example: Windows on a beat grid

```json
{
  "input": "tone.wav",
  "grid": {
    "bpm": 120,
    "per": "beat"
  }
}
```

### Example: Named window from a timeline

```json
{
  "input": "tone.wav",
  "timeline": "timeline.json",
  "windows": [
    {
      "name": "scene-a",
      "from": "a",
      "to": "a+1"
    }
  ]
}
```

## audio.loudness

**Loudness (EBU R128)**: Integrated loudness, loudness range, true peak and sample peak of an audio or video file, optionally with a momentary or short-term loudness curve.

Measures the first audio stream with ffmpeg's ebur128 filter. Use it to check a mix against a platform target (for example -16 or -14 LUFS), to compare takes, or to find loud moments with the curve. It measures; it never changes anything.

class: audio · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| input | ref | yes |  | Audio or video file: a workspace path, job:<id>/<output> or pin:<name>. The first audio stream is measured. |
| curve | object |  |  | Also return a loudness curve. Omit for the summary only. |
| curve.window | enum |  | "momentary" | momentary = 400 ms window, short-term = 3 s window (EBU R128). |
| curve.step_s | number |  | 0.1 | Seconds between curve points. |

### Example: Summary of a file

```json
{
  "input": "tone.wav"
}
```

### Example: Momentary curve every 0.5 s

```json
{
  "input": "tone.wav",
  "curve": {
    "step_s": 0.5
  }
}
```

## audio.mix

**Mix (tracks, buses, pan)**: Declarative track/bus mixer: places clips sample-accurately on tracks, sums them to an exact length, optional per-track fx, level, sidechain and master stage. Plain float sum by default.

Sums audio clips on named tracks to an exact length. Processing order: (1) track_defaults are merged under each track with the same name; (2) every clip's `at` is resolved (seconds or a timespec against `timeline`); (3) each distinct (src, offset_s, duration_s, fx) is decoded once; (4) optional per-clip leveling; (5) per clip gain, linear fades, the pan law, then mix at its sample position; (6) track fx; (7) track gain_db; (8) optional track `level`; (9) optional sidechains; (10) mute; (11) bus fx and gain, then the master sum = buses + tracks without a bus; (12) optional master fx/gain/loudness; (13) fit to N samples and write. N = round(duration_s*sample_rate) or the latest clip end. Defaults are neutral: no ducking, no normalisation, no limiter; the default output is 32-bit float WAV so a sum above 0 dBFS does not clip. Pan law: mono into stereo is equal-power. Pan 0 gives 0.7071 per channel (matching ffmpeg's mono upmix); stereo into stereo at pan 0 is the identity; into mono a stereo clip becomes (L+R)/2 and pan is ignored.

class: audio · deterministic: yes · cache: auto · version 1.0.0 · presets: dialogue-anchored, ducked-bed

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| preset | string |  |  | Optional named mix preset; its settings are merged under this request (the request wins). |
| sample_rate | integer |  | 48000 | Mix sample rate in Hz. Default 48000. |
| channels | enum |  | 2 | Output channel count: 1 (mono) or 2 (stereo). Default 2. |
| duration_s | number |  |  | Exact output length in seconds (rounded to whole samples). Omit to use the end of the latest clip. |
| timeline | ref |  |  | Optional timeline.json ref; enables string `at` timespecs (scene, cue, bar, beat). |
| track_defaults | object |  |  | Per-track-name settings merged UNDER each track with that name (the request's track wins). Presets use this. |
| tracks | array | yes |  | Tracks to sum. Each track holds clips and is processed independently. |
| tracks[] |  |  |  |  |
| buses | array |  |  | Named sub-mixes. Tracks with `bus` sum here before the buses are summed into the master. |
| buses[].name | string | yes |  | Bus name referenced by tracks[].bus. |
| buses[].gain_db | number |  | 0 | Bus fader in dB, applied after the bus fx. Default 0. |
| buses[].fx | string |  |  | Optional ffmpeg -af chain applied to the summed bus (for example "volume=6dB"). |
| sidechain | array |  |  | Optional sidechain compressors. Each one ducks `target` using `key` as the trigger. Omit for no ducking. |
| sidechain[].target | string | yes |  | Track name to compress. |
| sidechain[].key | string | yes |  | Track name whose signal triggers the compressor. |
| sidechain[].threshold | number |  | 0.02 | Detector threshold (linear, 0..1). Default 0.02. |
| sidechain[].ratio | number |  | 6 | Compression ratio. Default 6. |
| sidechain[].attack_ms | number |  | 20 | Attack time in milliseconds. Default 20. |
| sidechain[].release_ms | number |  | 400 | Release time in milliseconds. Default 400. |
| sidechain[].knee | number |  | 2.8 | Soft knee. Default 2.8. |
| sidechain[].makeup | number |  | 1 | Makeup gain (linear). Default 1. |
| sidechain[].lookahead_s | number |  | 0 | Seconds the key is advanced to look ahead. Default 0. |
| master | object |  |  | Final stage. Absent, or neutral (no fx, gain_db 0, no loudness), means the mix is not touched. |
| master.gain_db | number |  | 0 | Master gain in dB. Default 0. |
| master.fx | string |  |  | Optional master ffmpeg -af chain. |
| master.loudness | object |  |  | Optional loudness target for the master stage. |
| master.loudness.target_lufs | number | yes |  | Target integrated loudness in LUFS. |
| master.loudness.true_peak_db | number |  | -1.5 | True-peak ceiling in dBTP. Default -1.5. |
| master.loudness.method | enum |  | "gain+limiter" | How to reach the target: a measured gain plus limiter, or ffmpeg loudnorm. Default "gain+limiter". |
| master.loudness.lra | number |  | 11 | Loudness range target in LU (loudnorm). Default 11. |
| output | object |  |  | Output files. |
| output.name | string |  | "mix.wav" | Output file name. Default "mix.wav". |
| output.format | enum |  | "wav32f" | Output WAV encoding: 32-bit float (no clipping), 24-bit or 16-bit. Default "wav32f". |
| output.stems | boolean |  | false | Also write stems/<track>.wav (32-bit float) for every track, post-level and pre-bus. Default false. |
| output.preview_mp3 | boolean |  | false | Also write a 192 kbps preview.mp3. Default false. |

### Example: Two sine clips on one track

```json
{
  "duration_s": 1,
  "tracks": [
    {
      "name": "tone",
      "clips": [
        {
          "src": "a.wav",
          "at": 0
        },
        {
          "src": "b.wav",
          "at": 0.5
        }
      ]
    }
  ]
}
```

### Example: Dialogue over music (two tracks, fixed length)

```json
{
  "duration_s": 2,
  "tracks": [
    {
      "name": "dialogue",
      "clips": [
        {
          "src": "vo.wav",
          "at": 0.25,
          "fade_in_s": 0.02,
          "fade_out_s": 0.05
        }
      ]
    },
    {
      "name": "music",
      "gain_db": -12,
      "clips": [
        {
          "src": "bed.wav",
          "at": 0
        }
      ]
    }
  ]
}
```

## audio.process

**Process audio (pitch, tempo, trim, fades)**: Run an ordered list of processing steps over audio takes: ffmpeg filters, pitch, tempo, gain, silence trim, pause tightening, fades and peak normalisation, written as wav, flac or mp3.

The voice-fx and cleanup pass, for one file or a batch of takes. Each step does exactly one thing and the steps run in the order given, so a take can be pitched down for a deeper voice, its long pauses tightened, its edges faded and its peak normalised in one job. With no steps and no conversion options a file is only re-encoded. Presets such as deep-hero carry a whole named chain; a request's own steps replace a preset's steps. A step that needs real DSP is an ffmpeg chain, so it appears in the result's chain list in the order it ran; gain, trim, tightening, fades and normalisation are done in memory and do not add a chain. Nothing is enforced: no normalisation, no trimming, no resampling unless asked.

class: audio · deterministic: yes · cache: auto · version 1.0.0 · presets: deep-hero, uncanny-villain

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| inputs | array | yes |  | Audio files to process, in order. Each becomes one output; the same stem twice gets a -2/-3 suffix. |
| inputs[] | ref |  |  | One audio file: a workspace path, job:<id>/<output> or pin:<name>. Its first audio stream is processed. |
| preset | string |  |  | Name of a preset under presets/audio-process/ (deep-hero, uncanny-villain) whose values are merged under this request. Your own fields win; your own steps replace the preset's steps. |
| steps | array |  | [] | Processing steps, applied in order. Each step object holds exactly one operation. Empty means: just decode and re-encode. |
| steps[].filter | string |  |  | An ffmpeg -af chain applied as-is, e.g. "highpass=f=90,acompressor=threshold=0.06" or "bass=g=5:f=110,volume=6dB". File-reading filters (movie, amovie, sendcmd, zmq) are refused. |
| steps[].pitch_semitones | number |  |  | Shift the pitch by this many semitones (negative = deeper) while keeping the duration. Runs as asetrate + aresample + atempo. |
| steps[].tempo | number |  |  | Speed factor with the pitch kept: 2 plays twice as fast, 0.5 half as fast. Duration is divided by it. |
| steps[].gain_db | number |  |  | Multiply the amplitude by this many dB (positive louder, negative quieter). No limiter: integer output formats clip above 0 dBFS. |
| steps[].trim_silence | object |  |  | Remove leading and/or trailing audio below threshold_db, judged by the peak over all channels, keeping keep_s of it. |
| steps[].trim_silence.threshold_db | number |  | -50 | Frames whose peak over all channels is at or below this dBFS count as silence. |
| steps[].trim_silence.start | boolean |  | true | Trim the silent head of the file. |
| steps[].trim_silence.end | boolean |  | true | Trim the silent tail of the file. |
| steps[].trim_silence.keep_s | number |  | 0.03 | Seconds of the silence to keep at each trimmed edge (30 ms by default). |
| steps[].tighten_pauses | object |  |  | Shorten every internal pause longer than max_pause_s to exactly max_pause_s, keeping half of it on each side of the cut. Leading and trailing silence are left alone. |
| steps[].tighten_pauses.max_pause_s | number | yes |  | Longest pause to keep, in seconds. Every longer internal silence is cut down to this. Required. |
| steps[].tighten_pauses.threshold_db | number |  | -40 | A window is silent when its peak over all channels is below this dBFS. |
| steps[].tighten_pauses.window_ms | number |  | 10 | Length of the analysis window in milliseconds. 10 ms is the dialogue-editor default. |
| steps[].fade_in_s | number |  |  | Linear fade in from silence over this many seconds at the start. |
| steps[].fade_out_s | number |  |  | Linear fade out to silence over this many seconds at the end. |
| steps[].normalize_peak_db | number |  |  | Scale the whole file so its absolute sample peak lands exactly at this dBFS (0 = full scale). Rounded/actual peak may differ by the rounding of the output format. |
| format | enum |  | "wav" | Output format: wav = 16-bit, wav24, wav32f = 32-bit float (no clipping), flac, mp3 (192 kbit/s). |
| sample_rate | integer |  |  | Convert the output to this sample rate in Hz. Omit to keep the input rate. |
| channels | enum |  |  | Convert the output to this channel count (1 = mono, 2 = stereo). Omit to keep the input's channel count. |

### Example: Pitch down 2.6 semitones and tighten long pauses

```json
{
  "inputs": [
    "take.wav"
  ],
  "steps": [
    {
      "pitch_semitones": -2.6
    },
    {
      "tighten_pauses": {
        "max_pause_s": 0.35
      }
    }
  ]
}
```

### Example: Deep hero voice preset, mono 48 kHz output

```json
{
  "inputs": [
    "take.wav"
  ],
  "preset": "deep-hero",
  "channels": 1,
  "sample_rate": 48000
}
```

## audio.silence

**Silence map**: Finds silences (including leading and trailing) and where speech ends in an audio or video file, using 10 ms windows and a peak threshold.

Decodes the first audio stream at its native rate and channel count and reports every run of near-silent 10 ms windows at least min_duration_s long, plus leading_s (a silence starting at 0), trailing_s (a silence ending at the file end) and speech_end_s (the last sample above -40 dBFS plus a 30 ms tail). Use it to trim dead air, place voice-over or find gaps. It measures; it never changes anything.

class: audio · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| input | ref | yes |  | Audio or video file: a workspace path, job:<id>/<output> or pin:<name>. The first audio stream is analysed at its native rate and channel count. |
| threshold_db | number |  | -50 | A 10 ms window counts as silent when its peak absolute sample over all channels is below this dBFS level. |
| min_duration_s | number |  | 0.1 | Shortest silence to report, in seconds. Shorter runs are ignored. |

### Example: Silence map of a tone with gaps

```json
{
  "input": "clip.wav"
}
```

## audio.speech-ratio

**Speech-to-background ratio**: How far a voice sits above its background inside the speech band (default 300-3400 Hz), per line or per given window, with the minimum and median ratio.

Both signals are downmixed to mono at 48 kHz and band-limited with one RBJ high-pass and one RBJ low-pass. 100 ms frames whose band-limited voice power is below -45 dBFS are dropped, then voice, background and their ratio are averaged over the same frames. Analysis only; it changes nothing.

class: audio · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| voice | ref | yes |  | Voice (dialogue) file: a workspace path, job:<id>/<output> or pin:<name>. |
| background | ref | yes |  | Background (music, ambience) file, on the same timeline as the voice. |
| timeline | ref |  |  | Optional timeline JSON (timeline.layout output) used to resolve string times in windows. |
| windows | array |  |  | Explicit windows. Omit to find lines automatically from voice activity. |
| windows[].name | string |  |  | Optional label copied into the result row. |
| windows[].from | number\|string | yes |  | Window start: seconds or a timespec (scene id, cue, bar:n, beat:n). |
| windows[].to | number\|string | yes |  | Window end: seconds or a timespec (scene id, cue, bar:n, beat:n). |
| band_hz | array |  | [300,3400] | Speech band as [high-pass, low-pass] corner frequencies in Hz. |
| band_hz[] | number |  |  |  |
| activity_threshold_db | number |  | -40 | Automatic windows: a 100 ms unfiltered-voice frame is active when its RMS is above this dBFS level. |
| min_gap_s | number |  | 0.25 | Automatic windows: merge active runs separated by a gap shorter than this many seconds. |

### Example: Voice over a bass bed

```json
{
  "voice": "voice.wav",
  "background": "bed.wav",
  "windows": [
    {
      "name": "line-1",
      "from": 0,
      "to": 2
    }
  ]
}
```

### Example: Lines found automatically

```json
{
  "voice": "lines.wav",
  "background": "bed.wav"
}
```

## audio.stats

**Audio stats (Mucavex analysis)**: Peak, RMS, crest, clipping, DC offset, stereo width, band energy, silence percentage and per-cycle loudness of an audio or video file.

Runs the vendored Mucavex analyzer over the first audio stream and returns its report unchanged: overall levels (peakDb, rmsDb, crestDb), clippedSamples, dcOffset, silencePct, stereoWidth, a low/mid/high band split, a per-cycle loudness breakdown (when a cycle rate is given) and human-readable warnings. Use it to catch silence, clipping, mud, harshness, a dead stereo field or a section that drops out. It measures; it never changes anything.

class: audio · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| input | ref | yes |  | Audio or video file: a workspace path, job:<id>/<output> or pin:<name>. The first audio stream is analysed at 48 kHz stereo. |
| cps | number |  |  | Cycles per second used to break the report down per cycle. Give at most one of cps, bpm or window_s. |
| bpm | number |  |  | Tempo in beats per minute. Converted to cps as bpm / 60 / beats_per_cycle. Give at most one of cps, bpm or window_s. |
| beats_per_cycle | integer |  | 4 | Beats per cycle when cps is derived from bpm (4 = one bar in 4/4). Ignored when bpm is absent. |
| window_s | number |  |  | Length of one analysis cycle in seconds; cps becomes 1 / window_s. Give at most one of cps, bpm or window_s. |

### Example: Stats of a 1 kHz tone

```json
{
  "input": "tone.wav"
}
```

### Example: Per-cycle stats of a 120 BPM track

```json
{
  "input": "tone.wav",
  "bpm": 120
}
```

## image.contact-sheet

**Contact sheet**: Lay images out in a grid so a set of stills can be reviewed at a glance.

Scales each image to a fixed width, pads them to the height of the first image, and lays them out with ffmpeg's xstack. Optional labels are drawn with drawtext when that filter is available. A single image is returned as one cell.

class: audio · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| images | array | yes |  | Images to put on the sheet, in reading order. Workspace paths, job:<id>/<output> or pin:<name>. |
| images[] | ref |  |  | An image file reference. |
| columns | integer |  | 4 | Number of columns in the grid. |
| cell_width | integer |  | 480 | Width of each cell in pixels; height follows the image's aspect ratio. |
| labels | array\|string |  |  | Caption for each cell: an array with one string per image, or "auto" for the file basenames. Omit for no labels. |
| labels[] | string |  |  |  |
| gap_px | integer |  | 8 | Gap between cells in pixels. |
| background | string |  | "black" | Background colour for the padding and the gaps, as an ffmpeg colour name or 0xRRGGBB value. |
| format | enum |  | "png" | Output image format; writes sheet.png or sheet.jpg. |

### Example: Six stills in a three-column grid

```json
{
  "images": [
    "a.png",
    "b.png",
    "c.png",
    "d.png",
    "e.png",
    "f.png"
  ],
  "columns": 3,
  "cell_width": 160,
  "gap_px": 8
}
```

## media.concat

**Media concat**: Join two or more clips: stream copy for sections rendered with identical settings, or the concat filter to re-encode across differing sources.

Concatenates video files in order. copy uses the concat demuxer with -c copy (fast, requires identical codecs, resolution and frame rate); reencode uses the concat filter and re-encodes video (and audio when every input has it).

class: encode · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| inputs | array | yes |  | Clips to join, in playback order (2 to 200). |
| inputs[] | ref |  |  | A clip: a workspace path, job:<id>/<output> or pin:<name>. |
| mode | enum |  | "copy" | copy = concat demuxer with stream copy (identical settings); reencode = concat filter that re-encodes. |
| video | object |  | {} | Video encoder settings used by reencode; omit (or leave fields out) to accept ffmpeg defaults. Ignored by copy. |
| video.codec | string |  |  | Video codec for reencode, e.g. libx264 (the default) or libx265. |
| video.preset | string |  |  | Encoder preset for reencode, e.g. veryfast or slow. |
| video.crf | integer |  |  | Constant rate factor for reencode (lower is better quality). |
| video.pix_fmt | string |  |  | Pixel format for reencode, e.g. yuv420p (the default). |
| audio | object |  | {} | Audio encoder settings used by reencode when every input has audio. Ignored by copy. |
| audio.codec | string |  | "aac" | Audio codec for reencode (default aac). |
| audio.bitrate_k | integer |  | 192 | Audio bit rate in kbit/s for reencode (default 192). |
| name | string |  | "concat.mp4" | Output file name inside the job's out folder, e.g. concat.mp4. |

### Example: Copy-concat two clips

```json
{
  "inputs": [
    "part1.mp4",
    "part2.mp4"
  ]
}
```

### Example: Re-encode concat with a scale-friendly preset

```json
{
  "inputs": [
    "part1.mp4",
    "part2.mp4"
  ],
  "mode": "reencode",
  "video": {
    "crf": 20
  }
}
```

## media.encode

**Video encoder (delivery)**: Encode a video with explicit quality, bitrate, size, scaling and audio controls, including fit-to-N-MB two-pass encoding and named delivery presets.

The delivery encoder. It never guesses: quality (crf or bitrate), scale caps, fps, audio codec/bitrate and colour are explicit inputs. Use target_size_mb to hit a byte budget with a two-pass x264/x265 encode, or a preset from presets/encode/ for a known platform. Colour is converted only when asked: with video.color set (the default 'bt709') the scale filter maps in_color_matrix=auto/in_range=auto to the requested matrix and TV range, with matching tags; video.color null leaves colour untouched. Scaling never upscales and keeps the aspect ratio.

class: encode · deterministic: yes · cache: auto · version 1.0.0 · presets: fit-size, instagram-reel, master, telegram-video, web-720p

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| input | ref | yes |  | Video file to encode: a workspace path, job:<id>/<output> or pin:<name>. |
| replace_audio | ref |  |  | Use this file's audio instead of the input's audio. Omit to keep the input audio (if any). |
| preset | string |  |  | Name of an encode preset under presets/encode/ (master, web-720p, fit-size, telegram-video, instagram-reel). Explicit fields in this request override the preset. |
| video | object |  |  | Video stream settings. All optional; absent means the encoder default, except that with no crf, bitrate_k or target_size_mb the tool uses crf 18. |
| video.codec | string |  | "libx264" | Video encoder, e.g. libx264, libx265, libvpx-vp9. Default libx264. |
| video.preset | string |  | "medium" | Encoder speed preset, e.g. ultrafast, slow, veryslow. Default medium. |
| video.crf | number |  |  | Constant quality (lower is better/bigger). Ignored when bitrate_k or target_size_mb is set. |
| video.bitrate_k | number |  |  | Target video bitrate in kbit/s. Overrides crf. |
| video.maxrate_k | number |  |  | Maximum video bitrate in kbit/s. bufsize_k defaults to 2x this. |
| video.maxrate_factor | number |  |  | With target_size_mb, maxrate_k = computed video kbps x this factor. Default 1.75 when omitted. |
| video.bufsize_k | number |  |  | Rate-control buffer in kbit/s. Defaults to 2x maxrate_k. |
| video.profile | string |  |  | H.264/H.265 profile, e.g. high, main. |
| video.level | string |  |  | Codec level, e.g. '4.2'. A string so decimals like 4.2 survive. |
| video.gop | integer |  |  | Maximum keyframe interval in frames (-g). |
| video.keyint_min | integer |  |  | Minimum keyframe interval in frames (-keyint_min). |
| video.sc_threshold | integer |  |  | Scene-change threshold (-sc_threshold). 0 disables scene-cut keyframes. |
| video.closed_gop | boolean |  | false | Close every GOP (-flags +cgop), required by some social platforms. |
| video.pix_fmt | string |  | "yuv420p" | Output pixel format. Default yuv420p. |
| video.tune | string |  |  | Encoder tuning, e.g. film, animation, fastdecode. |
| video.x264_params | string |  |  | Extra -x264-params value, passed through verbatim. |
| video.color | string\|null |  | "bt709" | Output colour matrix, e.g. bt709, bt601, smpte240m. Adds an auto->target colour conversion plus matching tags. null adds no conversion and no tags. |
| audio | object |  |  | Audio stream settings applied to the mapped audio (input or replace_audio). |
| audio.codec | string |  | "aac" | Audio encoder, e.g. aac, libopus, copy. Default aac. |
| audio.bitrate_k | number |  | 192 | Audio bitrate in kbit/s. Default 192. |
| audio.sample_rate | integer |  |  | Output sample rate in Hz (-ar). Omit to keep the source rate. |
| audio.channels | integer |  |  | Output channel count (-ac). Omit to keep the source layout. |
| scale | object |  |  | Scaling. Explicit width/height win; otherwise max_long_side and max_width cap the size, never upscale, and keep the aspect ratio (the unknown side becomes -2). |
| scale.width | integer |  |  | Exact output width. With height omitted, height is derived (-2). |
| scale.height | integer |  |  | Exact output height. With width omitted, width is derived (-2). |
| scale.max_long_side | integer |  |  | Fit the longer side to this many pixels (never upscales). |
| scale.max_width | integer |  |  | Cap the output width to this many pixels (never upscales). |
| fps | number |  |  | Output frame rate (-r). Omit to keep the source rate. |
| two_pass | boolean |  | false | Run a two-pass encode (libx264/libx265 only; ignored for other codecs). Implied by target_size_mb. |
| target_size_mb | number |  |  | Fit the output under this many megabytes (1 MB = 10^6 bytes). Computes a bitrate and runs a two-pass x264/x265 encode. |
| size_margin | number |  | 0.04 | Fraction of the target bitrate held back for container overhead when fitting to a size. Default 0.04. |
| name | string |  | "video.mp4" | Output file name inside the job output, matching ^[\w.-]+$. Default video.mp4. |

### Example: Master preset

```json
{
  "input": "render.mp4",
  "preset": "master"
}
```

### Example: Fit under 1 MB

```json
{
  "input": "render.mp4",
  "target_size_mb": 1,
  "video": {
    "preset": "slow"
  },
  "audio": {
    "bitrate_k": 128
  }
}
```

### Example: Scale to 320 px and replace audio

```json
{
  "input": "render.mp4",
  "replace_audio": "voice.wav",
  "scale": {
    "max_long_side": 320
  }
}
```

## media.ffmpeg

**FFmpeg command**: Run an ffmpeg command on workspace files.

The escape hatch: run any ffmpeg command with your own arguments. Inputs and outputs are workspace files; filters are checked for file-reading filters.

class: encode · deterministic: no · cache: off · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| args | array | yes |  | The ffmpeg arguments, without the program name. Use {in:NAME}, {out:FILE} and {script:NAME} placeholders. |
| args[] | string |  |  |  |
| inputs | object |  | {} | Map of input names to file references. The name is used in {in:NAME} placeholders. |
| outputs | array | yes |  | File names to write into the job's output directory. Every name must exist after the run. |
| outputs[] | string |  |  |  |
| scripts | object |  | {} | Map of script names to their contents. Each script is written to a file in the scratch directory and can be used with {script:NAME}. |

### Example: Volume change

```json
{
  "args": [
    "-i",
    "{in:a}",
    "-af",
    "volume=-3dB",
    "{out:quiet.wav}"
  ],
  "inputs": {
    "a": "tone.wav"
  },
  "outputs": [
    "quiet.wav"
  ]
}
```

## media.frames

**Media frames**: Grab still frames from a video at given times, as PNG or JPEG, optionally scaled to a width, to eyeball or compare an encode.

Seeks to each time and writes one image per timestamp using ffmpeg. Use it to check an encode, a transition or a frame-accurate edit. The output names carry the requested time to three decimals.

class: encode · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| video | ref | yes |  | Video file to grab frames from: a workspace path, job:<id>/<output> or pin:<name>. |
| times | array | yes |  | Timestamps in seconds (>= 0); one output image is written per entry. |
| times[] | number |  |  |  |
| format | enum |  | "png" | Image format: png (lossless) or jpeg. JPEG output uses the .jpg extension. |
| width | integer |  |  | Optional output width in pixels; the height follows the source aspect ratio (scale=W:-2). Omit to keep the source size. |

### Example: Two frames from a clip

```json
{
  "video": "clip.mp4",
  "times": [
    0.5,
    1.5
  ]
}
```

### Example: Scaled JPEG frame

```json
{
  "video": "clip.mp4",
  "times": [
    1
  ],
  "format": "jpeg",
  "width": 320
}
```

## media.mux

**Media mux**: Put an audio track onto a video without re-encoding the video: stream-copy the video and encode (or copy) the audio, with an optional audio delay.

Combines a video file and an audio file into one container. The video stream is always copied; the audio is encoded (aac, opus, mp3) or copied. Use an offset to delay audio and shortest to trim the result to the shorter stream.

class: encode · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| video | ref | yes |  | Video source: a workspace path, job:<id>/<output> or pin:<name>. Its first video stream is copied unchanged. |
| audio | ref | yes |  | Audio source: a workspace path, job:<id>/<output> or pin:<name>. Its first audio stream is mapped. |
| audio_codec | enum |  | "aac" | Audio codec: aac, libopus or libmp3lame re-encode; copy passes the source audio through (use only when the container accepts it). |
| audio_bitrate_k | integer |  | 192 | Audio bit rate in kbit/s when the audio is re-encoded; ignored for copy. |
| audio_sample_rate | integer |  |  | Optional audio sample rate in Hz for re-encoding; omit to keep the source rate. |
| audio_offset_s | number |  | 0 | Seconds to delay the audio relative to the video (ffmpeg -itsoffset); 0 starts both together. |
| shortest | boolean |  | true | Stop at the shorter of the two streams (ffmpeg -shortest); set false to keep the longer one. |
| name | string |  | "video.mp4" | Output file name inside the job's out folder, e.g. video.mp4. |

### Example: Mux a tone onto a clip

```json
{
  "video": "clip.mp4",
  "audio": "tone.wav"
}
```

## media.probe

**Media probe**: Inspect a media file with ffprobe: duration, size, format and bit rate plus a typed per-stream summary of codec, dimensions, frame rate, pixel format, colour tags, sample rate and channels.

Runs ffprobe over a video, audio or image file and returns a compact, machine-friendly summary. Use it to check what a tool produced before muxing, concatenating or encoding. It reads; it never changes anything.

class: light · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| input | ref | yes |  | Media file to inspect: a workspace path, job:<id>/<output> or pin:<name>. |
| raw | boolean |  | false | Also include the raw ffprobe JSON (including the absolute file name) under "raw". |

### Example: Probe a WAV file

```json
{
  "input": "tone.wav"
}
```

### Example: Probe with the raw ffprobe JSON

```json
{
  "input": "tone.wav",
  "raw": true
}
```

## music.render

**Music render (Strudel)**: Render a Strudel song to audio with the Mucavex engine: seeded deterministic noise, named section markers, optional tempo override and an analysis report.

Evaluates Strudel live-coding JavaScript with the same semantics as the strudel.cc REPL and renders it offline to WAV/MP3/FLAC/OGG/Opus/M4A. Named markers (lines like `let DROP = 34;`) let a build move song sections without regenerating the code. Strudel noise is seeded, so identical input gives byte-identical audio. `max_polyphony` must stay high: the engine's old default of 128 steals voices and fades sample voices in long renders. The tool renders; it never applies loudness normalisation, ducking or limiting.

class: music · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| code | string |  |  | Strudel source as a string. Exactly one of `code` and `file` is required. |
| file | ref |  |  | A workspace `.strudel` or `.js` file holding the song: a workspace path, job:<id>/<output> or pin:<name>. Exactly one of `code` and `file` is required. |
| markers | object |  |  | Rewrite named marker lines (`let NAME = value;`) before rendering, e.g. {"DROP": 30}. An unknown name is an invalid-input error that lists the markers found in the song. |
| seconds | number |  |  | Render this many seconds. Wins over `cycles`. Omit both for the engine default of 4 cycles. |
| cycles | number |  |  | Render this many Strudel cycles. Omit both `cycles` and `seconds` for the engine default of 4. |
| cps | number |  |  | Cycles per second. Wins over `bpm`. Omit both to let the song's setcps/setcpm decide. |
| bpm | number |  |  | Beats per minute; converted with cps = bpm / 60 / beats_per_cycle. Omit (with `cps`) to let the song decide. |
| beats_per_cycle | integer |  | 4 | Beats in one cycle, used only when `bpm` is given. 4 means one cycle is a 4/4 bar. |
| tail_s | number |  | 0 | Extra seconds after the last cycle so reverb and release tails are not cut off. |
| sample_rate | integer |  | 48000 | Output sample rate in Hz. |
| format | enum |  | "wav" | Output container/codec. wav is 16-bit PCM, wav32 is 32-bit float; flac/ogg/opus/m4a need ffmpeg. |
| bitrate_k | integer |  |  | Bitrate in kbps for lossy formats (mp3, opus, m4a). Omit for the encoder default. |
| max_polyphony | integer |  | 4096 | Maximum simultaneous voices. Keep this high: Strudel's default of 128 steals voices, which fades earlier sample voices in long renders. Raise it further for very dense songs. |
| seed | integer |  | 0 | Seed for the Math.random replacement Strudel noise uses. The same seed gives byte-identical audio; change it for a different noise take. |
| analyze | boolean |  | true | Also measure the render (peak/RMS/crest/clipping/warnings) and write analysis.json. |
| offline | boolean |  | false | Only load samples from the sample cache, never the network. A missing sample then fails the render instead of downloading it. |
| (one of) |  |  |  | code \| file |

### Example: Two cycles of a sawtooth triad, offline

```json
{
  "code": "note(\"c3 e3 g3\").s(\"sawtooth\").lpf(800)",
  "cycles": 2,
  "offline": true
}
```

### Example: Render a file with rewritten section markers

```json
{
  "file": "songs/theme.strudel",
  "markers": {
    "DROP": 30
  },
  "seconds": 60
}
```

## picture.render

**Picture render**: Render an HTML page that exposes window.__motion (ready, seek(t), duration?, size?) to a video, frame by frame, with optional audio muxed in the same pass.

Serves the page over http from the workspace (plus /_mx/lib/... browser libraries), drives window.__motion.seek(t) for every frame in parallel browser pages, and streams the frames in order into ffmpeg. The page contract: window.__motion = {ready: true, seek(t) -> void | Promise, duration?: seconds, size?: {width, height}}. Size comes from width/height or from window.__motion.size; the end time from to_s or window.__motion.duration. Frames go in as JPEG (quality) or PNG, so the page is lossy only if you ask for JPEG. Colour is converted to BT.709 video range because browsers hand back full-range BT.601 JPEG and RGB PNG. Sections rendered with from_s/to_s join seamlessly because frame times are exact multiples of 1/fps. Use picture.stills for review stills.

class: capture · deterministic: no · cache: off · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| page | ref | yes |  | The HTML page to capture: a workspace path, job:<id>/<output> or pin:<name>. It must set window.__motion = {ready: true, seek(t), duration?, size?}. |
| inject | array |  |  | HTML fragments spliced into the page in order: at the first <!--mx:inject--> marker, else right before </body>. Use it to add a shot list or data without editing the page. |
| inject[] | ref |  |  | An HTML fragment file to splice into the page: a workspace path, job:<id>/<output> or pin:<name>. |
| globals | object |  |  | Window globals defined before the page scripts run: NAME -> any JSON value (written as window.NAME = ...). Names must be JS identifiers. |
| globals_files | object |  |  | Window globals read from JSON files: NAME -> a .json file (workspace path, job:<id>/<output> or pin:<name>). An entry in globals wins over the same name here. |
| query | string |  | "render" | Query string appended to the page URL (without the '?'), so a page can tell capture from preview. |
| width | integer |  |  | Viewport width in pixels. Omit to use window.__motion.size.width. |
| height | integer |  |  | Viewport height in pixels. Omit to use window.__motion.size.height. |
| fps | number |  | 30 | Frames per second. Frame i is captured at t = (round(from_s·fps) + i) / fps. |
| from_s | number |  | 0 | First captured time in seconds. Frames are exact multiples of 1/fps, so sections rendered separately join seamlessly. |
| to_s | number |  |  | End time in seconds (exclusive: the last frame is the one before it). Omit to use window.__motion.duration. |
| workers | integer |  | 4 | How many browser pages render in parallel. Each page loads the page once and keeps its own window, and is warmed up before the first frame is taken. |
| intermediate | enum |  | "jpeg" | Format of the frames handed to ffmpeg: jpeg (small, lossy at jpeg_quality) or png (lossless, slower, bigger). |
| jpeg_quality | integer |  | 95 | JPEG quality of the intermediate frames when intermediate is jpeg. Ignored for png. |
| video | object |  | {} | Encoder settings (passed to ffmpeg as-is; libx264 with crf 18 is the default). |
| video.codec | string |  | "libx264" | Video encoder name, e.g. libx264, libx265, libvpx-vp9, h264_nvenc. |
| video.preset | string |  | "medium" | Encoder preset (libx264/libx265: ultrafast .. veryslow). |
| video.crf | integer |  | 18 | Constant quality value; lower is better and bigger. |
| video.pix_fmt | string |  | "yuv420p" | Output pixel format. yuv420p plays everywhere; yuv444p / yuv420p10le need a matching crf and player. |
| video.color | string |  | "bt709" | Colour space tagged on the output (bt709, bt601, bt2020nc). Frames are converted from full-range BT.601 JPEG / RGB PNG to BT.709 video range. |
| audio | ref |  |  | Optional audio file muxed in the same ffmpeg pass: a workspace path, job:<id>/<output> or pin:<name>. Trimmed to [from_s, to_s] and padded with silence when it is shorter than the video. |
| audio_codec | string |  | "aac" | Audio encoder for the muxed audio stream (aac, libmp3lame, alac, ...). |
| audio_bitrate_k | integer |  | 192 | Audio bitrate in kbit/s (ignored by lossless codecs). |
| warmup | boolean |  | true | Take and discard one cheap screenshot per page before the real frames. Headless Chromium stalls for about 15 s on a fresh page's first screenshot, so leave this on unless you know the pages are warm. |
| frame_timeout_s | number |  | 15 | How long one frame (seek + screenshot) may take before it is retried. |
| frame_retries | integer |  | 3 | Attempts per frame; the frame is re-seeked before every retry. All attempts failing fails the job. |
| ready_timeout_s | number |  | 60 | How long a page may take to set window.__motion.ready = true. |
| offline | boolean |  | false | Block every request whose origin is not the local static server (fonts, CDNs, analytics); each block is recorded in page_errors. The page itself is always served. |
| device_scale_factor | number |  | 1 | Device pixel ratio of the browser contexts. Above 1 renders a page designed for CSS pixels at a higher pixel count. |
| name | string |  | "video.mp4" | Output file name inside the job's out folder, e.g. video.mp4 or picture/act1.mp4. The extension follows the codec. |

### Example: Half a second of a tiny page (end time from window.__motion.duration)

```json
{
  "page": "pages/tiny.html",
  "workers": 1,
  "fps": 10
}
```

### Example: A section with an audio file muxed in

```json
{
  "page": "pages/tiny.html",
  "workers": 1,
  "fps": 10,
  "from_s": 0.2,
  "to_s": 0.5,
  "audio": "tone.wav",
  "video": {
    "crf": 28,
    "preset": "ultrafast"
  }
}
```

## picture.stills

**Picture stills**: Write still frames of an HTML page that exposes window.__motion (ready, seek(t), duration?, size?) as PNG or JPEG, at the times you ask for.

Serves the page over http from the workspace (plus /_mx/lib/... browser libraries), opens one browser page, and seeks to each requested time to write one image. Same page contract as picture.render: window.__motion = {ready: true, seek(t) -> void | Promise, duration?, size?: {width, height}}. Size comes from width/height or from window.__motion.size. Output names carry the time to three decimals, so a review folder can be read in order.

class: capture · deterministic: no · cache: off · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| page | ref | yes |  | The HTML page to capture: a workspace path, job:<id>/<output> or pin:<name>. It must set window.__motion = {ready: true, seek(t), duration?, size?}. |
| inject | array |  |  | HTML fragments spliced into the page in order: at the first <!--mx:inject--> marker, else right before </body>. |
| inject[] | ref |  |  | An HTML fragment file to splice into the page: a workspace path, job:<id>/<output> or pin:<name>. |
| globals | object |  |  | Window globals defined before the page scripts run: NAME -> any JSON value (written as window.NAME = ...). Names must be JS identifiers. |
| globals_files | object |  |  | Window globals read from JSON files: NAME -> a .json file (workspace path, job:<id>/<output> or pin:<name>). An entry in globals wins over the same name here. |
| query | string |  | "render" | Query string appended to the page URL (without the '?'), so a page can tell capture from preview. |
| width | integer |  |  | Viewport width in pixels. Omit to use window.__motion.size.width. |
| height | integer |  |  | Viewport height in pixels. Omit to use window.__motion.size.height. |
| times | array | yes |  | Times in seconds (>= 0); one image is written per entry, named still-<t to 3 decimals>.<ext>. |
| times[] | number |  |  |  |
| format | enum |  | "png" | Image format: png (lossless) or jpeg (smaller, quality applies). JPEG output uses the .jpg extension. |
| quality | integer |  | 90 | JPEG quality when format is jpeg. Ignored for png. |
| offline | boolean |  | false | Block every request whose origin is not the local static server (fonts, CDNs, analytics); each block is recorded in page_errors. |
| device_scale_factor | number |  | 1 | Device pixel ratio of the browser context. Above 1 renders a page designed for CSS pixels at a higher pixel count. |
| warmup | boolean |  | true | Take and discard one cheap screenshot before the real stills. Headless Chromium stalls for about 15 s on a fresh page's first screenshot, so leave this on. |
| frame_timeout_s | number |  | 15 | How long one still (seek + screenshot) may take before it is retried. |
| frame_retries | integer |  | 3 | Attempts per still; the page is re-seeked before every retry. All attempts failing fails the job. |
| ready_timeout_s | number |  | 60 | How long the page may take to set window.__motion.ready = true. |

### Example: One still of a tiny page

```json
{
  "page": "pages/tiny.html",
  "times": [
    0.125
  ]
}
```

## sfx.synth

**SFX synthesis**: Synthesize sound effects from a recipe module: a workspace .mjs or the built-in generic recipes. Each sound is finished (trim, fades, normalise), written as a WAV and measured.

Runs a sound-effect recipe and renders each named sound with the shared DSP kit at 48 kHz stereo. A recipe is a workspace .mjs/.js file, or the built-in `generic` recipes. Recipe contract: `export const sounds = { name(kit, params) { /* return [Float32Array, Float32Array] at kit.SR (48000) */ } }` (a sound may be async); optionally `export const finish = { name: { peak_db: -3 } }` for per-sound finish overrides and `export const describe = { name: 'one line' }` for descriptions. `kit` is the DSP kit (osc, noise, filters, envelopes, crush, reverb, echo, pal, rng, ...). `params[name]` is passed through from the request. Every sound is finished with the `finish` options (DC block, head/tail trim, fades, peak normalise), written to `<name>.wav`, and measured. `sounds.json` holds the per-sound results.

class: audio · deterministic: no · cache: off · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| recipe | ref |  |  | Workspace path/ref to a .mjs or .js recipe module exporting `sounds` (and optionally `describe`/`finish`). Exactly one of `recipe` or `builtin` is required. |
| builtin | enum |  |  | Use the built-in generic recipes instead of a workspace module. Exactly one of `recipe` or `builtin` is required. |
| sounds | array |  |  | Sound names to render, in order. Omit to render every sound the recipe exports. |
| sounds[] | string |  |  | A sound name exported by the recipe's `sounds` object. |
| params | object |  |  | Recipe parameters keyed by sound name. Each value is passed to the recipe as its second argument. |
| palette | object |  |  | Named palette audio files that recipes slice with kit.pal(name, k, slot); each is decoded to 48 kHz stereo before the recipe runs. |
| finish | object |  |  | Finish options applied to every sound. These override a recipe's per-sound `finish` export. |
| finish.head | boolean |  | true | Trim leading near-silence (below head_db) before normalising. |
| finish.head_db | number |  | -54 | Head-trim threshold in dBFS (relative to the sound's peak). |
| finish.tail_db | number |  | -62 | Tail-trim threshold in dBFS (relative to the sound's peak). |
| finish.fade_in_s | number |  | 0.002 | Fade-in length in seconds. |
| finish.fade_out_s | number |  | 0.03 | Fade-out length in seconds (capped at a third of the sound). |
| finish.peak_db | number |  | -1 | Target peak in dBFS after normalisation. |
| format | enum |  | "wav24" | WAV bit depth: wav = 16-bit, wav24 = 24-bit, wav32f = 32-bit float. |
| seed | integer |  | 1 | PRNG seed for the kit; the same seed renders the same sound. |
| (one of) |  |  |  | recipe \| builtin |

### Example: Built-in thump

```json
{
  "builtin": "generic",
  "sounds": [
    "thump"
  ]
}
```

### Example: Inline recipe with two sounds

```json
{
  "recipe": "sfx/my.mjs"
}
```

## timeline.layout

**Timeline layout**: Lay scenes out from voice-over lines: cue times, scene lengths, optional beat snapping, music markers and named times. Writes timeline.json and dialogue-clips.json.

A pure layout helper. Each scene is as long as its lines plus the lead, gaps and tail you ask for (all zero by default, nothing snapped), or a fixed duration_s. Audio lines are measured at their speech end (Piper leaves trailing silence), not their file length. Optional beat snapping, markers that align the music grid to a scene (the music_offset_s / beatOffset), named times, and a per-frame voice envelope are available when you want them. It never renders or mixes anything; it only computes numbers.

class: light · deterministic: yes · cache: auto · version 1.0.0 · presets: voice-driven-classic

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| defaults | object |  |  | Layout defaults for every scene. All neutral (0, no snapping) unless set. |
| defaults.lead_s | number |  | 0 | Seconds from the scene start to the first line (default 0). |
| defaults.gap_s | number |  | 0 | Seconds between two lines when a line sets no pause_s (default 0). |
| defaults.tail_s | number |  | 0 | Seconds after the last line before the scene ends (default 0). |
| defaults.min_s | number |  | 0 | Minimum scene length in seconds (default 0). |
| defaults.snap_beats | number\|null |  | null | Round every scene length up to a multiple of this many beats (needs grid). null = no snapping (default). |
| grid | object |  |  | Musical grid. Required for snap_beats, for markers and for bar:/beat: times. |
| grid.bpm | number | yes |  | Beats per minute. |
| grid.beats_per_bar | number |  | 4 | Beats in a bar (default 4). |
| grid.offset_s | number |  | 0 | Seconds from 0 to bar 0 (default 0). |
| preset | string |  |  | Named layout preset from presets/timeline/ (for example voice-driven-classic), merged under this request. |
| scenes | array | yes |  | Scenes in playback order; each starts where the previous one ends. |
| scenes[].id | string | yes |  | Scene id (letters, digits, _ or -), used by times and markers. |
| scenes[].duration_s | number |  |  | Fixed scene length in seconds. Overrides the line-driven length and is used exactly (not snapped). |
| scenes[].lead_s | number |  |  | Overrides defaults.lead_s for this scene. |
| scenes[].gap_s | number |  |  | Overrides defaults.gap_s for this scene. |
| scenes[].tail_s | number |  |  | Overrides defaults.tail_s for this scene. |
| scenes[].min_s | number |  |  | Overrides defaults.min_s for this scene. |
| scenes[].snap_beats | number\|null |  |  | Overrides defaults.snap_beats for this scene (null = do not snap this scene). |
| scenes[].lines | array |  |  | Voice-over lines in order. Omit for an empty scene or a fixed duration_s scene. |
| scenes[].lines[].audio | ref |  |  | Audio for the line: a workspace path, job:<id>/<output> or pin:<name>. Its speech end (threshold speech_end_threshold_db) sets the cue length. |
| scenes[].lines[].dur_s | number |  |  | Cue length in seconds when there is no audio. |
| scenes[].lines[].text | string |  |  | Caption text, kept in the cue. |
| scenes[].lines[].who | string |  |  | Speaker name, used to group the per-speaker voice envelope. |
| scenes[].lines[].pause_s | number |  |  | Seconds before this line; overrides gap_s for this line (ignored on the first line). |
| scenes[].lines[].tempo | number |  | 1 | Playback speed of the line (default 1). The cue lasts speech_end / tempo seconds. |
| (one of) |  |  |  | audio \| dur_s \| text |
| speech_end_threshold_db | number |  | -40 | dBFS threshold that marks the end of speech in an audio line (default -40). |
| markers | object |  |  | Named markers: each names the scene it sits on and what the music grid should align to there. |
| align_to | string |  |  | Name of the marker whose alignment sets the global music_offset_s (beatOffset). Other markers report their bar index with that offset. |
| times | object |  |  | Named times resolved against the computed timeline, e.g. {"hit": "b#0.end-0.1"}. |
| envelope | object |  |  | Optional per-frame voice loudness for the picture to react to. Only audio lines contribute. |
| envelope.fps | number | yes |  | Frames per second of the envelope. |
| envelope.normalize | enum |  | "peak" | peak = scale so the loudest frame is gain; none = raw RMS. Default peak. |
| envelope.gain | number |  | 1.25 | Multiplier applied before clamping to 0..1 (default 1.25). |
| envelope.per_speaker | boolean |  | true | true = voices keyed by who; false = a single voice array. Default true. |
| extra | object |  |  | Fields copied verbatim into the root of timeline.json (name, size, fps, fonts, poster...). |

### Example: Two scenes from explicit line durations, all defaults neutral

```json
{
  "scenes": [
    {
      "id": "intro",
      "lines": [
        {
          "dur_s": 1,
          "text": "One"
        },
        {
          "dur_s": 2,
          "text": "Two"
        }
      ]
    },
    {
      "id": "outro",
      "lines": [
        {
          "dur_s": 1.5,
          "text": "Three"
        }
      ]
    }
  ]
}
```

### Example: Snap a 3 s scene up to a 2 s bar (4 beats at 120 bpm)

```json
{
  "grid": {
    "bpm": 120,
    "beats_per_bar": 4
  },
  "defaults": {
    "snap_beats": 4
  },
  "scenes": [
    {
      "id": "scene",
      "lines": [
        {
          "dur_s": 3
        }
      ]
    }
  ]
}
```

### Example: A drop marker aligns the music grid and a named time points at a cue end

```json
{
  "grid": {
    "bpm": 120
  },
  "scenes": [
    {
      "id": "a",
      "lines": [
        {
          "dur_s": 3
        }
      ]
    },
    {
      "id": "b",
      "lines": [
        {
          "dur_s": 2
        }
      ]
    }
  ],
  "markers": {
    "drop": {
      "scene": "b",
      "align": "bar"
    }
  },
  "align_to": "drop",
  "times": {
    "hit": "b#0.end-0.1"
  }
}
```

### Example: The voice-driven-classic preset

```json
{
  "preset": "voice-driven-classic",
  "grid": {
    "bpm": 120
  },
  "scenes": [
    {
      "id": "a",
      "lines": [
        {
          "dur_s": 1,
          "text": "Hello"
        }
      ]
    }
  ]
}
```

### Example: A cue measured from a WAV's speech end, with a per-speaker voice envelope

```json
{
  "scenes": [
    {
      "id": "s",
      "lines": [
        {
          "audio": "line.wav",
          "text": "hi",
          "who": "narrator"
        }
      ]
    }
  ],
  "envelope": {
    "fps": 10
  }
}
```

## voice.elevenlabs

**Voice (ElevenLabs)**: Synthesize one line of speech with ElevenLabs and write take.mp3 plus take.wav. Optional provider: it needs an elevenlabs_api_key secret file and network access.

Performs a scripted line with an ElevenLabs voice, supporting v3 audio tags such as [whispers] or [excited] inside the text. It writes the raw MP3 response as take.mp3 and always also decodes it to take.wav. The API key is read from the elevenlabs_api_key secret file and never appears in results or logs. Requests are retried on 429, 5xx and network errors.

class: elevenlabs · deterministic: no · cache: reuse · version 1.0.0 · unavailable: secret "elevenlabs_api_key" is missing (file elevenlabs_api_key in the secrets dir)

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| voice_id | string | yes |  | ElevenLabs voice id (for example 21m00Tcm4TlvDq8ikWAM). Use voice.elevenlabs-voices to list ids. |
| text | string | yes |  | The line to speak. May contain v3 audio tags such as [whispers], [excited] or [laughs], which the eleven_v3 model performs. |
| model | string |  | "eleven_v3" | ElevenLabs model id; eleven_v3 acts the tags in the text. |
| stability | number |  |  | Voice stability; eleven_v3 likes 0 (creative), 0.5 (natural) or 1 (robust). |
| similarity | number |  |  | Similarity boost to the original voice (maps to similarity_boost). |
| style | number |  |  | Style exaggeration (maps to style). |
| speed | number |  |  | Speaking rate (maps to voice_settings.speed). |
| seed | integer |  |  | Seed for deterministic generation when the model supports it; omit for varied takes. |
| language | string |  |  | Optional ISO language code (maps to language_code), for example en. |
| output_format | string |  | "mp3_44100_128" | Requested output format; mp3_44100_128 is the best the ElevenLabs Free tier allows. |

### Example: One line with the eleven_v3 model

```json
{
  "voice_id": "21m00Tcm4TlvDq8ikWAM",
  "text": "Hello from motionex."
}
```

### Example: Acted line with an audio tag

```json
{
  "voice_id": "21m00Tcm4TlvDq8ikWAM",
  "text": "[whispers] Meet me at midnight.",
  "model": "eleven_v3",
  "stability": 0.5,
  "seed": 7
}
```

## voice.elevenlabs-voices

**Voices (ElevenLabs)**: List the ElevenLabs voices available to the key, optionally filtered by a search string. Optional provider: it needs an elevenlabs_api_key secret file and network access.

Returns the ElevenLabs voices the key can use, with their ids, names and labels, so an agent can pick a voice_id for voice.elevenlabs. Reads the elevenlabs_api_key secret file; the key is never logged or returned. Retries 429, 5xx and network errors.

class: light · deterministic: no · cache: off · version 1.0.0 · unavailable: secret "elevenlabs_api_key" is missing (file elevenlabs_api_key in the secrets dir)

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| search | string |  |  | Optional search term to filter voices by name or label; omit to list all available voices. |

### Example: List all available voices

```json
{}
```

### Example: Search for a narrator voice

```json
{
  "search": "narrator"
}
```

## voice.phonemize

**Phonemize (IPA)**: Show how a Piper voice will pronounce text as IPA, sentence by sentence, without synthesizing any audio. Use it to check a name, write [[raw phonemes]] lines, or debug odd pronunciation.

Reads only the voice config, never the ONNX model, so it is fast and deterministic. The IPA it returns is exactly what voice.piper will synthesize for the same voice: to force a pronunciation, copy the phonemes into a [[ ... ]] block in the line text.

class: light · deterministic: yes · cache: auto · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| voice | string |  |  | Voice name as installed in the voice folders, e.g. en_US-john-medium. Either voice or voice_file is required. |
| voice_file | ref |  |  | A specific .onnx voice file (workspace path, job:<id>/<output> or pin:<name>) with its .onnx.json config beside it. Use instead of voice to pin an exact model. |
| texts | array | yes |  | The texts to phonemize, in order. |
| texts[] | string |  |  | One text. A sentence split is applied by the phonemizer, so punctuation changes the result. [[ ... ]] blocks are returned as raw phonemes, unchanged. |
| (one of) |  |  |  | voice \| voice_file |

### Example: Two short texts with the John voice

```json
{
  "voice": "en_US-john-medium",
  "texts": [
    "Shapur",
    "Hello there."
  ]
}
```

### Example: Raw phonemes pass through unchanged

```json
{
  "voice": "en_US-norman-medium",
  "texts": [
    "My name is [[ʃˈɒpˌuːə.]]"
  ]
}
```

## voice.piper

**Voice (Piper TTS)**: Synthesize voice-over lines to 16-bit mono WAV files with a local Piper voice, one file per line, with per-line durations and speech-end times.

Speaks each line in `lines` with a Piper voice and writes <name or line-001>.wav into the job's output folder. Every take is different (Piper's VITS sampling), so results are never cached. `speech_end_s` is where the audible speech stops inside the file: useful for snapping cuts without trimming a natural tail. Pass raw IPA inside [[ ... ]] when a name must be pronounced exactly, and raise `length_scale` slightly (about 1.1) for gravitas.

class: voice · deterministic: no · cache: off · version 1.0.0

| field | type | required | default | description |
| --- | --- | --- | --- | --- |
| voice | string |  |  | Voice name as installed in the voice folders, e.g. en_US-norman-medium. Either voice or voice_file is required. |
| voice_file | ref |  |  | A specific .onnx voice file (workspace path, job:<id>/<output> or pin:<name>) with its .onnx.json config beside it. Use instead of voice to pin an exact model. |
| lines | array | yes |  | The lines to speak, in order; each one becomes its own WAV file. |
| lines[].text | string | yes |  | What to say. Text inside [[ ... ]] is passed to Piper as raw IPA phonemes, for example "My name is [[ʃˈɒpˌuːə.]]"; the final punctuation must sit INSIDE the brackets, otherwise the model keeps the raw phonemes going through the next sentence. |
| lines[].name | string |  |  | Output file name without .wav, e.g. who-0 writes who-0.wav. Omit to get line-001, line-002, ... Names must be unique inside one call. |
| length_scale | number |  |  | Speaking rate control: above 1 is slower (about 1.1 for gravitas), below 1 is faster. Omit to use the voice's own setting (1.0). |
| noise_scale | number |  |  | Generator noise; higher is more varied and expressive, lower is flatter. Omit to use the voice's own setting. |
| noise_w_scale | number |  |  | Phoneme-width noise, i.e. timing variation; lower is more metronomic. Omit to use the voice's own setting. |
| speaker | integer |  |  | Speaker id for a multi-speaker voice. Omit for the voice's default speaker. |
| volume | number |  | 1 | Gain multiplier applied to every line (1 = unchanged, 0.5 = quieter, 2 = louder). Applied after normalisation, and the result is clipped to full scale. |
| normalize_audio | boolean |  | true | Scale each line so its loudest sample reaches full scale (Piper's per-sentence normalisation). false keeps the model's raw levels, which vary per line. |
| speech_end_threshold_db | number |  | -40 | Level (dBFS) below which a sample counts as silence when finding speech_end_s. Lower it for quiet voices, raise it to cut more tail. |
| (one of) |  |  |  | voice \| voice_file |

### Example: Two lines with the Norman voice

```json
{
  "voice": "en_US-norman-medium",
  "lines": [
    {
      "text": "Hello there."
    },
    {
      "text": "This is motionex."
    }
  ]
}
```

### Example: Raw IPA phonemes and a named line

```json
{
  "voice": "en_US-norman-medium",
  "lines": [
    {
      "text": "My name is [[ʃˈɒpˌuːə.]]",
      "name": "ipa-name"
    }
  ]
}
```
