# Mint a workspace

A **workspace** is a folder of its own, usually its own git repository, where videos get made with the motionex engine.
The engine is one service with bare tools. Everything about *what* gets made and *how* lives in the workspace: the
user's settings, the skills an agent follows there, and whatever helpers the agent writes for itself. One workspace
holds many projects (one project is one video, or one build of it).

Use this skill when the user asks for a new workspace ("mint a workspace", "set up a studio", "start a new series").

## What this skill decides, and what it does not
- It decides nothing about the films. No look, shape, length, tone, style, pipeline or platform is put into a new
  workspace unless the user said it. Nothing is ruled out either: a rule such as "never vertical" is a direction too.
- What the user has not said stays "not set". An agent working in the workspace asks when a piece of work depends on it.
- The user can change anything later: the settings, the skills, the tools. The workspace says how.

## Steps
1. **Two things you need from the user.** Ask only if they have not said them:
   - **The folder.** Where the workspace goes. Never choose it yourself.
   - **What the workspace is for**, in their own words. One sentence is enough; a page is fine.
   Anything else they say (how things should look or sound, what they will give for each project, where the videos go,
   what you may do without asking) is recorded in step 3. Do not interview them for the rest.
2. **Create it** from the engine's template:
   ```bash
   node bin/mx.mjs workspace init "<folder>" --name "<name>"          # from a checkout of the engine
   docker run --rm -v "<folder>:/new" <engine image> mx workspace init /new --name "<name>"   # with only the image
   ```
   - The command copies `skill/workspace/template/` into the folder and starts a git repository there. It commits
     nothing and overwrites nothing.
   - A folder that already has files is refused. `--add` adds only the template files that are missing, which is also
     how an older workspace picks up new template files.
   - `--dry` prints what it would write.
3. **Write down what the user said**, in the new workspace's `WORKSPACE.md`:
   - their words, as written, as numbered facts under "What the user said";
   - each setting they stated, in the settings table, with the fact it comes from;
   - nothing else. A reading of yours that the work will rest on goes beside their words, in brackets, marked as yours.
4. **Connect it to the engine.** A tool reads files from the folder the engine has mounted.
   - See what is mounted:
     `docker inspect motionex --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`.
   - If the new folder is inside the mounted folder, note its path below the mount in `WORKSPACE.md` ("Engine"): every
     path given to a tool starts with it.
   - If it is not, tell the user the ways there are and let them choose: mount a folder that contains their workspaces
     (one mount then serves all of them); switch the mount to this folder (this restarts the engine and stops every
     running job, so ask first); or leave the mount and send files through the engine's file API.
5. **Hand over.** Say what was created and where, which settings are set and from which words, and what is not set.
   Commit only if the user asks.

## What the template gives a workspace
| Path | Holds |
|---|---|
| `WORKSPACE.md` | The user's words and the settings that follow from them. The one place an agent reads first |
| `AGENTS.md`, `CLAUDE.md` | How to work here, for any agent; `CLAUDE.md` only points at `AGENTS.md` |
| `skills/workspace/SKILL.md` | Keeping the workspace: reading and changing settings, adding skills and tools, the engine |
| `skills/project/SKILL.md` | Starting, resuming and handing over a project |
| `projects/` | One folder per project; `_template/` is an empty one; `README.md` lists them |
| `tools/` | Helpers the agent writes for this workspace |
| `CHANGES.md` | What changed in the workspace, when and why |

The template is a starting point. The skills are plain Markdown that the user or an agent rewrites as the workspace
finds its way of working; new skills, notes, configuration and scripts are added beside them.

## Optional reading
`skill/workspace/experience.md` collects what earlier workspaces learned about running a production (checks, reviews,
keeping decisions). They are options. Copy what the user wants into the workspace; none of it is a rule.
