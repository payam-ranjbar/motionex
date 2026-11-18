# CLAUDE.md

This file is for Claude Code sessions started in this repo. It covers two jobs:

1. **Using motionex** to make videos.
2. **Scaffolding a series studio**: a separate workspace that turns fixed inputs into one episode of a series, step by
   step, on top of motionex.

To **change motionex itself** (its tools, server, tests), `AGENTS.md` is the contract: read all of it first.

## What motionex is
- One Docker service, loopback only, at `http://127.0.0.1:8095` (`MX_URL` overrides it).
- Agents call bare tools over HTTP (`POST /v1/jobs`) or with the `mx` CLI.
- The tool areas are voice, picture capture, music (Strudel), SFX synthesis, mixing, analysis and encoding.
- **Do not enforce.** Tools are primitives; every opinion is a parameter or a named preset; defaults are neutral.
  Opinions belong in the studio that uses motionex, not in motionex.
- The usage guide is the skill below. Its references are in `skill/motionex/references/` (`api.md`, `tools.md`,
  `picture.md`, `music.md`, `sound.md`, `voice.md`, `pacing.md`, `review-and-delivery.md`, `collaboration.md`,
  `extending.md`, `example-tiny-film.md`). Read one when you need it.

@skill/motionex/SKILL.md

## The workspace: one folder at a time
- The service mounts exactly one host folder at `/workspace`, chosen by `MX_WORKSPACE_HOST` when the container starts.
  Every path a tool takes is relative to that folder.
- Check what is mounted before you start work:
  `docker inspect motionex --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`
- Switching the workspace restarts the container, so it stops every job that is running or queued. Other sessions
  may be using it. Ask the user before you switch.
- Switch with: `MX_WORKSPACE_HOST=<folder> docker compose up -d`. Add `-f compose.yaml -f compose.local.yaml` when
  the local secrets file exists.
- Captures run one at a time. A queued render is normal: poll with `?wait=300` and never re-submit a job that is
  still queued or running.

## Scaffolding a series studio
A studio is its own folder and its own git repo, outside this repo. motionex mounts it as the workspace. A studio
fixes how an episode is made, so that an agent with no other context can make episode N the same way as episode 1.

### First, settle these with the user
- **The inputs**: what the author gives for each episode and nothing else. Examples: a script and a voice recording;
  a one-page brief; a song.
- **The output**: size, fps, length range, loudness target, size cap and platform.
- **The identity**: the look, the type, the colours and what they mean, and the sound. These are series defaults that
  a note in one episode's input can override.
- **What is the author's**: the content. The agent interprets it and writes the choices it made where the author can
  see them. It never changes the author's inputs.
- **What the agent must never do**: for example, make a voice, call paid providers, post or commit.

### Layout
| Path | Holds |
|---|---|
| `AGENTS.md` | Instructions for every agent and harness: what the studio makes, the skills table, how the pipeline works, tool commands, the "Never" list |
| `CLAUDE.md` | `@AGENTS.md` and nothing else, so there is one source |
| `skills/<name>/SKILL.md` | At least: workspace setup and check, start or resume a project, make an episode. `.claude/skills/` holds copies written by a tool; edit `skills/` only |
| `docs/PIPELINE.md` | The map: the steps table (number, step, guide, who, result file), the pipeline version, what is fixed, default or the author's, the loops, the commands, render times |
| `docs/pipeline/<n>-<step>.md` | One guide per step: what it needs, what to do, the check, and what must be true before the next step |
| `docs/STYLE.md`, `docs/SOUND.md`, … | The identity defaults |
| `docs/HEALING.md` | The change log: each pipeline change with its cause, its proof and the new version |
| `kit/` | The shared picture library that every episode's page uses; it exposes `window.__motion` |
| `tools/` | `studio.py` (`check`, `skills`, `list`, `new <id>`) and `make.py` (one subcommand per step, each submitting motionex jobs and printing `ok` / `WRONG` / `LOOK` lines) |
| `assets/` | Fonts, icons and samples, with their sources and licences |
| `episodes/_template/` | An empty project: the input placeholders and a starter page |
| `episodes/<id>/` | One episode: its inputs, what was made from them, `review.md`. It takes nothing from another episode |
| `.gitignore` | `out/`, `jobs/`, `.mx/`, `.secrets/`, `.venv/` |

### Rules that worked in practice
- **Every step ends on a check, not on a file.** Write checks as code that prints `ok`, `WRONG` (fix it) or `LOOK`
  (a person or a second agent decides). Each loop is make, check, fix, check again, with a round limit.
- **Measure what you cannot see or hear.** For the picture: lint the page (overlaps, cut-off parts, small text, the
  safe area) and look at stills full size before any full render. For the sound: loudness, true peak, speech ratio,
  levels per section. The human listens; when the numbers and the human disagree, the human wins.
- **Iterate cheaply.** Use `picture.stills`, a draft at low resolution, or a `from_s`/`to_s` section. Render the full
  resolution once.
- **Fixed, default, the author's.** The structure (inputs, steps, checks, format) changes only through the heal
  step. The identity is a default. The content is the author's.
- **A heal step closes the loop.** After the author's feedback on a result: sort the items, find where the pipeline
  failed, change the smallest thing, prove it on an episode, log it in `HEALING.md` and raise the version. Larger
  changes wait for the author.
- **The hand-over names the pipeline version** and lists the agent's bumps, so the next heal can fix them.
- **Prove the scaffold.** Run the studio on one test episode end to end from a fresh session before calling it done.
  Read what that agent tripped on and fix the docs or tools.

## This repo
- motionex is a **public** repo. Commits, docs and comments carry no local paths, no names of private repos or
  projects, and no personal data. The commit author is the no-reply address set in the local git config.
- Commit or push only when the user asks. Never push branches other than `main`.
- Secrets are files in `secrets/` and are git-ignored. Never read or print them.
- Paid providers (ElevenLabs) spend real credits. Use them only when the user asks.
- Machine-specific notes for this checkout, if present: @CLAUDE.local.md
