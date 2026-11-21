# {{name}}

Created {{date}} from the motionex workspace template. This file is the one place that says what this workspace is for
and what has been decided for it. Read it before any work. The user can change any line of it at any time.

## What the user said
Their words, as written, one fact per line. A reading the agent took of an unclear line goes after it in brackets,
marked as the agent's. Later notes are added under a dated heading; nothing here is rewritten.

<!-- - **W1** "…"  -->

## Settings
A setting is here only because the user said it; the last column names the fact (W1, W2, …). "not set" means the user
has not said. When a piece of work depends on a setting that is not set, ask the user; do not fill it in. A project
may set its own value in its `brief.md`, which then holds for that project only.

| Setting | Value | From |
|---|---|---|
| **Output** | | |
| Frame shape and size | not set | |
| Frame rate | not set | |
| Length | not set | |
| Loudness | not set | |
| File size or platform | not set | |
| **Identity** | | |
| Look, and any references for it | not set | |
| Sound and music | not set | |
| Tone | not set | |
| **Each project** | | |
| What the user gives to start a project | not set | |
| What the user wants to see before the final video | not set | |
| **What the agent may do without asking** | | |
| Spend on paid providers | ask each time | template |
| Commit or push | ask each time | template |
| Restart or re-mount the engine | ask each time | template |

Add rows for anything else the user settles. Remove rows that never matter here.

## Engine
- Service: `{{engine_url}}` (check: `curl -s {{engine_url}}/readyz`).
- This workspace below the engine's mounted folder: not recorded yet. Fill it in from `skills/workspace/SKILL.md`,
  "The engine".

## Projects
Listed in `projects/README.md`.
