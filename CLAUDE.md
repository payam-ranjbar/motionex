# CLAUDE.md

This file is for Claude Code sessions started in this repo. It covers three jobs:

1. **Using the engine** to make videos: the skill below.
2. **Minting a workspace**: when the user asks for a new workspace (a studio, a new series), use the `mint-workspace`
   skill, which is `skill/workspace/SKILL.md`.
3. **Changing the engine itself** (its tools, server, tests): `AGENTS.md` is the contract. Read all of it first.

## The engine and the workspaces
- **motionex is the engine**: one Docker service, loopback only, at `http://127.0.0.1:8095` (`MX_URL` overrides it).
  Agents call bare tools over HTTP (`POST /v1/jobs`) or with the `mx` CLI: voice, picture capture, music (Strudel),
  SFX, grading, mixing, analysis and encoding.
- **A workspace is where videos are made**: a folder of its own, usually its own git repository, outside this repo. It
  holds the user's settings in their own words, the skills an agent follows there, the helpers the agent writes for
  itself, and its projects. One workspace has as many projects as the user wants; a project is one video or one build.
- **The engine gives a workspace its first skills** as a template (`skill/workspace/template/`), copied by
  `mx workspace init`. After that the workspace belongs to its user and the agents working in it: they rewrite the
  skills and add notes, configuration, scripts and tools.
- **Do not enforce.** Tools are primitives; every opinion is a parameter or a named preset; defaults are neutral. The
  same holds for the template and for this guidance: nothing here says how a film should look, sound or be shaped, and
  nothing here rules an option out. Those are the user's settings, kept in the workspace. What the user has not said
  is not set; an agent asks when the work depends on it.
- The usage guide is the skill below. Its references are in `skill/motionex/references/` (`api.md`, `tools.md`,
  `picture.md`, `music.md`, `sound.md`, `voice.md`, `pacing.md`, `review-and-delivery.md`, `collaboration.md`,
  `extending.md`, `example-tiny-film.md`). Read one when you need it.
- `skill/workspace/experience.md` collects what earlier workspaces learned about running a production. They are
  options for a workspace to take up, not rules.

@skill/motionex/SKILL.md

## The mounted folder
- The service mounts exactly one host folder at `/workspace`, chosen by `MX_WORKSPACE_HOST` when the container starts.
  Every path a tool takes is relative to that folder.
- Check what is mounted before you start work:
  `docker inspect motionex --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`
- **Several workspaces:** mount a folder that contains them, and give each tool path from that folder down
  (`<workspace>/projects/<id>/...`). No restart is needed to move between them.
- **A workspace outside the mounted folder** can still use the engine through the file API: `PUT /v1/files/<path>`,
  run the job, `GET /v1/jobs/<id>/outputs/<name>`, then `DELETE /v1/files/<path>?recursive=1`. Pages are captured from
  the mounted folder, so a page that lives elsewhere is rendered there or copied in.
- Changing the mount restarts the container, so it stops every job that is running or queued. Other sessions may be
  using it. Ask the user before you do it: `MX_WORKSPACE_HOST=<folder> docker compose up -d` (add
  `-f compose.yaml -f compose.local.yaml` when the local secrets file exists).
- Captures run one at a time. A queued render is normal: poll with `?wait=300` and never re-submit a job that is
  still queued or running.

## This repo
- motionex is a **public** repo. Commits, docs and comments carry no local paths, no names of private repos or
  projects, and no personal data. The commit author is the no-reply address set in the local git config.
- Commit or push only when the user asks. Never push branches other than `main`.
- Secrets are files in `secrets/` and are git-ignored. Never read or print them.
- Paid providers (ElevenLabs) spend real credits. Use them only when the user asks.
- Machine-specific notes for this checkout, if present: @CLAUDE.local.md
