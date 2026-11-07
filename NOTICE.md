# Notices

motionex is licensed AGPL-3.0-or-later because it includes the AGPL Mucavex/Strudel renderer.

| Component | Licence | Notes |
|---|---|---|
| Mucavex renderer (vendor/mucavex), @strudel/*, superdough | AGPL-3.0-or-later | music rendering |
| Strudel sample banks (fetched at runtime into the sample cache) | mixed (VCSL CC0, Dirt-Samples, drum machines, soundfonts) | not bundled in the image |
| piper-tts 1.8.0 (with espeak-ng) | GPL-3.0 | run as a subprocess |
| Piper voices norman, john, kristin | trained on public-domain LibriVox | see each voice's MODEL_CARD |
| Piper voice joe | CC0 training data | |
| ffmpeg (static build with libx264) | GPL | |
| Chromium headless shell / Playwright | BSD / Apache-2.0 | |
| GSAP 3.15 | GSAP Standard "no charge" licence (Webflow) | optional browser library; installed from npm, not committed here; its licence restricts use in tools that compete with Webflow's visual builder |
| Ajv | MIT | |
| ElevenLabs (optional provider) | ElevenLabs terms | free tier is non-commercial and needs attribution |
