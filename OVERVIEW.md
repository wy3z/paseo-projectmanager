Project manager turns a Paseo chat into a Project coordinator, modelled on Cursor Projects. The coordinator delegates work to worker agents and tracks it in a shared store. The Project panel shows that work, the agents doing it, and their pull requests.

It is off by default. Run `/projectmanager` in a chat to make it the coordinator for that chat's workspace. The chat keeps its conversation. It is asked to seed the store from the conversation so far, then plan, delegate and keep `notes.md` current. Running the command in another chat hands the role over. `/projectmanager off` stops briefing new agents and keeps the store.

## The store

Each Project has a store outside the repository, under `$XDG_DATA_HOME/paseo-projectmanager/workspaces/` (usually `~/.local/share`). It uses this layout:

- `notes.md`: a short checklist of current work. Rows link to agents or PRs and carry a brief note.
- `docs/`: lasting context. Agreed decisions go in `docs/decisions.md`, where they are superseded rather than deleted, and unconfirmed points are marked as assumptions.
- `plans/` and `media/`: plans and other files for you.
- `internal/`: agent reports and scratch files.
- `preferences.md`: lasting preferences you state.

The store is a git repository, snapshotted after every agent turn. You can view any earlier version in the panel, and restoring one adds a new snapshot rather than discarding anything.

## Coordinator and workers

The coordinator follows a coordinator guide mapped to Paseo's agent tools. It starts workers with `create_agent`, is notified when they finish, and links them in `notes.md`. The guide is saved in the store, so the coordinator can re-read it after its conversation is compacted. It also points the coordinator at Paseo's orchestration skills: `paseo-advisor` for second opinions, `paseo-committee` when stuck, and `paseo-handoff` to pass the Project to a fresh chat.

## Subscriptions

The coordinator follows the Project's pull requests: every PR linked in the store and every PR opened from a Project agent's branch. About once a minute the plugin checks them with `gh`. When one changes, the coordinator gets a short notification and decides whether to act, delegate or stay quiet. Changes include CI starting to fail, conflicts, new reviews or comments, approval, merge and close. Notifications wait until the coordinator's current turn ends. For timed check-ins, the coordinator sets a Paseo heartbeat on itself.

Every new agent in the workspace gets a worker brief in its system prompt. It tells the agent where the store is and to read only what it needs, and not to edit the coordinator's files. Deliverables go in `docs/` and everything else in `internal/`. The brief also covers how to report back.

## The Project panel

The panel opens as a workspace tab or in the Explorer, with two tabs:

- **Notes** shows `notes.md` as a checklist, with a Focus card when the coordinator sets one. Agent links show each agent's live status, and PR links show whether the PR is open, draft, merged or closed. On desktop, links to store files, and file paths written in the notes, open as tabs in the Paseo workspace. Folder paths such as `~/Projects/app` open in your file manager. On phones, store files open in the panel.
- **Context** shows recent files, the full file tree with `internal/` dimmed, a Markdown viewer, and the snapshot history.

The coordinator chat gets three composer pills:

- **Project** opens the panel.
- **PRs N** appears once the Project has pull requests. It lists them grouped by what they need: merge conflicts, checks failing, changes requested, approved, awaiting review, or draft. Merged and closed PRs collapse under Done. It covers PRs from workers in other worktrees, which Paseo's per-checkout PR view doesn't combine.

- **Following** appears once the coordinator follows something. It lists the followed PRs, and you can unfollow or re-follow each one.

Workers started by the coordinator are its subagents, so they appear in Paseo's own Subagents tray on the same chat. Worktree workspaces created for workers are kept out of the sidebar because the coordinator is instructed to pass `background: true` when it creates them. An explicit background setting is kept.

Worker checklist rows in Notes show a **Review +A −D** chip when their checkout has changes. It opens a file list and expandable diffs inside the Project panel, so you can review work without leaving the coordinator's workspace. Counts include committed, uncommitted and untracked files since the merge base with the default branch. Diffs are limited to 200 KB per file.

## Data and access

- The store contents and the briefs go to whichever agent providers run the coordinator and its workers.
- PR details are fetched from GitHub with the daemon user's `gh` login. The plugin looks up PRs linked from the store and the PR for each Project agent's current branch.
- The plugin reads Paseo's own files under `~/.paseo/projects` for the project name and icon.
- Folder paths in notes open with `xdg-open` on the daemon machine. Files are never passed to it.
- File reads and writes inside the store are approved automatically. Shell commands still ask.
- Codex agents get the store as a writable root. This replaces any `writable_roots` in Codex's own config for those agents.

## Limits

- Agents are briefed when their working directory is inside the workspace. Agents the coordinator starts in a different worktree or workspace aren't briefed automatically; the coordinator is told to pass them the store path.
- Agents that existed before the Project was turned on aren't briefed either.
- Subscriptions cover GitHub pull requests only; Slack and other sources are not implemented. PR state is remembered in memory, so changes made while the plugin is stopped aren't reported.
- The project icon lookup and opening store files as workspace tabs rely on Paseo internals and may break on Paseo updates.

Requires Paseo 0.12.0 or later, with `git` and, for pull requests, `gh` on the daemon machine.
