# Suggested skills

motionex is a toolbox and enforces nothing. The skills here are opinions that sit on top of it: ways of
working that one production found useful. They are optional, the service does not serve them, and they
need the `motionex` skill next to them.

| Skill | What it gives |
|---|---|
| [`beat-film-quality`](beat-film-quality/SKILL.md) | Numbered quality rules for short films cut to music, how each rule is checked, and `scripts/gate.mjs`, which measures a finished cut through the service (motion, beat hits, loudness, drop, silences, cue levels). |
| [`beat-film-workflow`](beat-film-workflow/SKILL.md) | A working path of seven stages with a checkpoint after each. It fixes the checkpoints and leaves the method to the builder, so several agents can work the same way without a shared build script. |

To use one, copy its folder next to the `motionex` skill, for example into `~/.claude/skills/`, or pass it
to your agent the way you pass any skill (`pi --skill <repo>/skill/suggested/beat-film-quality`).
