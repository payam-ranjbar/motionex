# motionex

Bare motion-graphics tools for AI agents, in one service: voice (Piper TTS, optional ElevenLabs), picture capture
(any HTML page with `window.__motion` -> video), music (Strudel via the vendored Mucavex renderer), SFX synthesis,
a mixer, loudness and analysis, and encoding. Agents call it over HTTP (`/v1/jobs`) or with the `mx` CLI, and learn it
from the skill in `skill/motionex/`.

Status: under construction. See AGENTS.md for the contracts.
