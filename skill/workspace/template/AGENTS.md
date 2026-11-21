# {{name}}: how to work here

This is a motionex workspace: a folder where videos are made with the motionex engine. The engine is a service with
bare tools; it has no opinion about the films. What gets made, and how, is decided here.

## Before anything
1. Read `WORKSPACE.md`: the user's words and the settings that follow from them.
2. For work on a project, read that project's `brief.md` and `notes.md`.
3. Read the skill for what you are about to do (the table below).

## Skills
| Skill | For |
|---|---|
| `skills/workspace/SKILL.md` | Reading and changing the workspace's settings, adding skills and tools, the engine |
| `skills/project/SKILL.md` | Starting, resuming and handing over a project |
| The engine's own skill | Every tool and how to call it: `curl -s {{engine_url}}/v1/skill/SKILL.md`, or `skill/motionex/` in a checkout of the engine |

Skills added later are listed here, one row each.

## How decisions are made
- **The user decides what the films are.** Shape, length, look, sound, tone, pace, platform, what is in and what is out
  come from their words, in `WORKSPACE.md` and in each project's `brief.md`.
- **Nothing is assumed and nothing is ruled out.** A setting the user has not given is "not set". When the work
  depends on it, ask. Do not fill it with a default, and do not decide that some option is off the table.
- **Their words are kept as written.** A reading of yours goes beside them, marked as yours, never in their place.
- **A choice you make without them is written where they can see it** (the project's `notes.md`), with the reason, so
  they can overturn it.

## The workspace is yours to build on
- One folder per project under `projects/`. A project takes nothing from another project's folder.
- Notes, configuration, scripts and tools that help the work belong here: `tools/` for helpers, a new folder under
  `skills/` for a way of working that has proved itself. Say what you added in `CHANGES.md`.
- The skills are plain Markdown. Rewrite them when the user wants a different way of working, or when one has proved
  wrong; `CHANGES.md` records what changed and why.
