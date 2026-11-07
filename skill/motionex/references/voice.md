# Voice

## One contract, several providers
`voice.speak` is a contract, not a single tool: `{"tool": "voice.speak", "input": {"provider": "piper" | "elevenlabs", "voice", "lines", "speed"?, ...}}`.
- **Every provider** takes `voice` (its own voice id), `lines` (strings or `{text, name}`), `speed` (1 = the voice's pace) and `speech_end_threshold_db`, and writes `<name>.wav` per line with the same result: `{voice, sample_rate, lines: [{name, file, text, seconds, speech_start_s, speech_end_s, speech_s}], warnings}`. So a draft in Piper and a final in ElevenLabs use the same refs (`job:<id>/intro.wav`) and the same timing fields.
- **Provider extras** pass straight through: Piper's `length_scale`, `noise_scale`, `speaker`; ElevenLabs' `model`, `stability`, `similarity`, `style`, `seed`, `language`, `output_format`. Each provider's tool (`voice.piper`, `voice.elevenlabs`) documents them.
- **List voices** with `voice.list {provider, search?}`: `{voices: [{id, name, language, labels}]}`. Pass an `id` as `voice`.
- **Which providers can run here**: `GET /v1/contracts/voice.speak` (or `capabilities.contracts`). ElevenLabs needs its key file.
- You can still call `voice.piper` or `voice.elevenlabs` by name; the contract only routes.

## Piper (local, free, fast)
`voice.speak` with `provider: "piper"`, or `voice.piper {voice, lines: [{name, text}] or ["text", ...], speed? or length_scale?, noise_scale?, noise_w_scale?}`, writes one WAV per line. Each line's result has `speech_start_s` and `speech_end_s`: Piper leaves 0.1–0.25 s of silence around each line, so place lines by their speech, not the file. `timeline.layout` does this for you. `result.warnings` flags a line whose length is far beyond its text (Piper babbling; `norman` did it twice on one-word lines).

**Voices** (see `GET /v1/capabilities`). The four shipped voices have commercially safe training data:

| Voice | Notes |
|---|---|
| `en_US-john-medium` | a deep narrator. British espeak phonemes read by an American speaker (see pronunciation) |
| `en_US-norman-medium` | a warm older male |
| `en_US-kristin-medium` | female, clear; good under heavy fx (a cold AI villain) |
| `en_US-joe-medium` | male, neutral |

Extra voices can be mounted at `/voices`. Avoid `ryan` and `lessac` for commercial work; their licences restrict it.

**Speed and feel**:
- `length_scale` 1.1–1.15 (`speed` about 0.9) gives gravitas;
- 0.8–0.92 (`speed` about 1.1–1.25) gives energy; `speed` sets `length_scale = 1/speed`, so give one or the other;
- for a very fast read (a legal disclaimer, for example), speed it up afterwards with `audio.process {steps: [{tempo: 1.8}]}`, which keeps the pitch.

**Piper is non-deterministic.** Two runs never sound the same. Generate 2–3 takes of important lines, let the human pick, and PIN the pick.

## Pronunciation
1. Check first: `voice.phonemize {voice, texts: ["Shapur", "Contavex"]}` shows the IPA Piper will speak.
2. Respelling sometimes works ("Contavex" became "Kontavvex"), and captions keep the real spelling if you put the respelling only in the voice text.
3. Respelling can backfire. With `john`, "Shah" turned into "sharp": the British phoneme /ɑː/ read by an American speaker comes out as "ar". **Raw IPA is the reliable fix**: put phonemes in double brackets inside the text, as in `"My name is [[ʃˈɒpˌuːə.]]"`. The final punctuation must be INSIDE the brackets.
4. Render 2–3 takes of a hard name and keep them all. `audio.levels` or your own analysis can compare them, but the human's ear decides.

## Character: post-processing with `audio.process`
- **Deeper**: `{pitch_semitones: -2.6}`. This is `asetrate·k, aresample, atempo 1/k`, so the duration stays the same. Add a low shelf near 110 Hz, warmth around 220 Hz and a softer top. The preset `deep-hero` does all of this.
- **Uncanny or AI**: `afreqshift` plus a short echo. The preset `uncanny-villain`.
- **Space**: `aecho`. **Radio**: a band-pass.
- **Watch the peak**: fx chains can push a take over 0 dBFS. Check `peak_db` and the warnings, and lower the gain in the chain.
- **Trim and tighten**: `trim_silence` removes the silence around a take; `tighten_pauses {max_pause_s: 0.4}` shortens long internal pauses (useful for acted takes that run long).

## Vocal cues (shouts, counts, laughs; not narration)
Short lines, treated like instruments. Raw IPA keeps non-English words right, e.g. Persian `[[jˈɛk!]]` (one), `[[dʒˈɑːːːn!]]` (jaan), `[[hˈɑː!]]` (ha). Recipes that worked, as `audio.process` steps after `trim_silence`:
- **Megaphone count**: `pitch_semitones -2`, then `highpass=f=380,lowpass=f=3600,acrusher=bits=9:mix=0.3,volume=5dB,alimiter=limit=0.9,apad=pad_dur=0.9,aecho=0.8:0.6:234|468:0.38|0.18` (echo throws on the half beat at 128 bpm).
- **Shout stack**: the same word from 3–4 voices, each `highpass=f=160,acompressor=…,apad=pad_dur=0.6,aecho=0.8:0.5:31|57:0.3|0.2`, panned apart and offset by about 12 ms in the mix.
- **Demon**: a main layer at `pitch_semitones -5` with `lowshelf=g=4:f=180`, a compressor, `asoftclip=type=tanh` and a 6-tap hall (`aecho` 61–521 ms), plus an octave-down layer (`-12`, `lowpass=f=1600`, `asoftclip=type=atan`) about 5 dB under it.
Measure `onset_s` on the processed clip and place it that much early when it must land on a frame.

## ElevenLabs (optional, paid, acted reads)
Available when the operator put a key file in the service's secrets (`secrets/elevenlabs_api_key`).
`voice.speak {provider: "elevenlabs", voice: "<voice id>", lines, model: "eleven_v3", stability?, seed?}` writes `<name>.wav` and keeps ElevenLabs' original `<name>.mp3` beside it.
- **Direction**: v3 performs audio tags in the text, such as `[whispers]`, `[excited]`, `[sighs]` or `[laughs]`; CAPS stress a word and "..." adds a beat. Other models may read the tags out loud (the result warns).
- **Stability**: 0 is creative, 0.5 natural, 1 robust. **Speed** 0.7–1.2 only; go further with `audio.process` `tempo`.
- **Cost**: about 1 credit per character on `eleven_v3`, half on `eleven_flash_v2_5`. `result.chars` and `result.credits` report the spend. Identical requests reuse the earlier take (`cache: reuse`) and cost nothing; send `"cache": "off"` for a new take.
- **Voices**: a key scoped to text-to-speech cannot list voices, so `voice.list` returns a catalogue of premade voices that worked in real productions:

| Voice | id | Character |
|---|---|---|
| Brian | `nPczCjzI2devNBz1zQrb` | deep, resonant and comforting (a trustworthy Santa; fast and hyped, an influencer) |
| George | `JBFqnCBsd6RMkjVDRZzb` | warm British storyteller, the classic announcer; at stability 1 and ×1.8 tempo, a legal read |
| Laura | `FGY2WhTYpPnrIDTdsKH5` | upbeat and quirky; +2 semitones made an elf |
| Liam | `TX3LPaxmHKxFdv7VOQHJ` | energetic, social media |
| Will | `bIHbv24MWmeRgasZH58o` | young and relaxed |

  Any other premade or library voice id works too.
- **Acted takes run long**: tighten them with `audio.process` `tighten_pauses` and `tempo`.
- **When to use which**: an acted voice won for a comedy ad, but lost for a moody film, where the user preferred the original Piper voice: "it has the charm and character". Offer both rather than swapping; with `voice.speak` the two takes are drop-in replacements.
- **Licence**: the free tier is non-commercial and needs attribution.
