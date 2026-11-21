# Keeping the workspace

For reading and changing what this workspace is: its settings, its skills, its tools, and its link to the engine.

## The settings
- `WORKSPACE.md` holds the user's words (W1, W2, …) and a table of settings. Each setting names the fact it comes from.
- **When the user says something about the workspace**, add it under a dated heading in "What the user said", in their
  words, and change the table rows it settles. If it can be read two ways, write the reading you took in brackets and
  tell them which it was.
- **When the user changes their mind**, add the new words; mark the old fact as replaced, do not delete it. Then look
  at the projects: say which ones were made under the old setting, and ask whether any should be redone. A finished
  project is not changed without being asked.
- **When a setting is "not set" and work depends on it**, ask the user. Their answer goes in as a fact.
- A project can differ from the workspace: its `brief.md` has its own settings table.

## The skills
- A skill is a folder under `skills/` with a `SKILL.md`: plain Markdown that says when it applies and what to do.
- Add one when a way of working has been done more than once and should be done the same way next time. Write what
  was learned, as steps and as things to check. Add its row to the table in `AGENTS.md`.
- Change or remove one when the user asks, or when it led the work wrong. Write what changed and why in `CHANGES.md`.
- A skill describes how this workspace works. What the films look or sound like belongs in `WORKSPACE.md`, in the
  user's words, so that changing it does not mean rewriting skills.

## The tools
- `tools/` is for helpers written for this workspace: scripts that submit engine jobs, checks, converters.
- Each helper says at its top what it does and how to run it. List it in `tools/README.md`.
- Numbers that are a matter of taste (a loudness target, a size, a length) are read from `WORKSPACE.md` or a project's
  brief, or passed in. They are not written into a helper.

## The engine
- The service is at the address in `WORKSPACE.md`. Is it up: `curl -s <address>/readyz`.
- A tool reads files from the folder the engine has mounted. What is mounted:
  `docker inspect motionex --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`.
- **This workspace is inside the mounted folder:** give every tool path from the mount down. Record the prefix in
  `WORKSPACE.md`, "Engine".
- **It is not:** ask the user which they want. Mounting a folder that contains their workspaces serves all of them at
  once. Switching the mount to this folder restarts the engine and stops every running job. Leaving the mount as it is
  works too: send files in with `PUT /v1/files/<path>`, run the job, and fetch results with
  `GET /v1/jobs/<id>/outputs/<name>`.
- Job outputs are kept under `.mx/` in the mounted folder. They are not part of the workspace's repository.

## The record
`CHANGES.md` gets a line for every change to the workspace itself (a setting, a skill, a tool): the date, what
changed, and the user's words or the reason behind it.
