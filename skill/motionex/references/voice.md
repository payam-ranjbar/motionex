# Voice

## Piper (local, free, fast)
`voice.piper {voice, lines: [{name, text}] or ["text", ...], length_scale?, noise_scale?, noise_w_scale?}` writes one WAV per line. Each line's result has `speech_start_s` and `speech_end_s`: Piper leaves 0.1–0.25 s of silence around each line, so place lines by their speech, not the file. `timeline.layout` does this for you. `result.warnings` flags a line whose length is far beyond its text (Piper babbling; `norman` did it twice on one-word lines).

**Voices** (see `GET /v1/capabilities`). The four shipped voices have commercially safe training data:

| Voice | Notes |
|---|---|
| `en_US-john-medium` | a deep narrator. British espeak phonemes read by an American speaker (see pronunciation) |
| `en_US-norman-medium` | a warm older male |
| `en_US-kristin-medium` | female, clear; good under heavy fx (a cold AI villain) |
| `en_US-joe-medium` | male, neutral |

Extra voices can be mounted at `/voices`. Avoid `ryan` and `lessac` for commercial work; their licences restrict it.

**Speed and feel**:
- `length_scale` 1.1–1.15 gives gravitas;
- 0.8–0.92 gives energy;
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
It is available when the operator put a key file in the service's secrets. `voice.elevenlabs {voice_id, text, model: "eleven_v3", stability}`:
- **Direction**: v3 takes audio tags in the text, such as `[whispers]`, `[excited]`, `[sighs]` or `[laughs]`.
- **Stability**: 0 is creative, 0.5 natural, 1 robust.
- **Cost**: about 1 credit per character. Identical requests reuse the earlier take (`cache: reuse`) and cost nothing. `result.chars` reports the use.
- **Acted takes run long**: tighten them with `audio.process` `tighten_pauses` and `tempo`.
- **When to use which**: an acted voice won for a comedy ad, but lost for a moody film, where the user preferred the original Piper voice: "it has the charm and character". Offer both rather than swapping.
- **Keys**: some keys are scoped to text-to-speech only, so listing voices fails. Then pass a known `voice_id`.
- **Licence**: the free tier is non-commercial and needs attribution.
