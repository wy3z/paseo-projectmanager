import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PANEL_ID = "project";

const workspaceInput = z.object({ workspaceId: z.string() });

const fileEntry = z.object({
  path: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
});

const projectState = z.object({
  workspaceId: z.string(),
  enabled: z.boolean(),
  contextDir: z.string(),
  coordinatorAgentId: z.string().nullable(),
  enabledAt: z.string().nullable(),
});

export type ProjectState = z.output<typeof projectState>;

const workerInput = z.object({ workspaceId: z.string(), agentId: z.string() });
const workerFile = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
});

export type WorkerFile = z.output<typeof workerFile>;

export const workerChanges = defineRpc({
  name: "project.worker_changes",
  input: workerInput,
  output: z.object({ base: z.string().nullable(), files: z.array(workerFile) }),
});

export const workerDiff = defineRpc({
  name: "project.worker_diff",
  input: workerInput.extend({ path: z.string().min(1) }),
  output: z.object({ diff: z.string(), truncated: z.boolean() }),
});

/** Turns shared context on for a workspace and makes `agentId` its coordinator. */
export const enableProject = defineRpc({
  name: "project.enable",
  input: z.object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    directory: z.string(),
    agentId: z.string(),
  }),
  output: z.object({
    state: projectState,
    outcome: z.enum(["enabled", "coordinator-changed", "unchanged"]),
  }),
});

/** Stops briefing new agents. Context files and history are kept. */
export const disableProject = defineRpc({
  name: "project.disable",
  input: workspaceInput,
  output: z.object({ state: projectState.nullable() }),
});

export const listProjects = defineRpc({
  name: "project.list",
  input: z.object({}),
  output: z.object({ projects: z.array(projectState) }),
});

export const projectStatus = defineRpc({
  name: "project.status",
  input: workspaceInput,
  output: z.object({ state: projectState.nullable(), files: z.array(fileEntry) }),
});

/** Reads a context file, optionally as it was at `commit`. */
export const readContextFile = defineRpc({
  name: "project.read",
  input: z.object({ workspaceId: z.string(), path: z.string(), commit: z.string().optional() }),
  output: z.object({ content: z.string().nullable() }),
});

const historyEntry = z.object({
  commit: z.string(),
  at: z.string(),
  message: z.string(),
  files: z.array(z.string()),
});

export type HistoryEntry = z.output<typeof historyEntry>;

export const contextHistory = defineRpc({
  name: "project.history",
  input: z.object({ workspaceId: z.string(), limit: z.number().int().positive().max(200) }),
  output: z.object({ entries: z.array(historyEntry) }),
});

/** Restores every context file to `commit` as a new commit, so the restore is itself undoable. */
export const restoreContext = defineRpc({
  name: "project.restore",
  input: z.object({ workspaceId: z.string(), commit: z.string() }),
  output: z.object({ commit: z.string().nullable() }),
});

const pullRequest = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  branch: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  group: z.enum([
    "Merged",
    "Closed",
    "Draft",
    "Merge conflicts",
    "Checks failing",
    "Changes requested",
    "Approved",
    "Awaiting review",
  ]),
  /** False when the user unfollowed it, so the coordinator is not told about changes. */
  followed: z.boolean(),
});

export type PullRequest = z.output<typeof pullRequest>;

/** PRs linked from the store, plus the PR for each Project agent's current branch. */
export const projectPrs = defineRpc({
  name: "project.prs",
  input: workspaceInput,
  output: z.object({ prs: z.array(pullRequest) }),
});

/** Follows or unfollows a PR for the coordinator's subscription notifications. */
export const setPrFollowed = defineRpc({
  name: "project.follow",
  input: z.object({ workspaceId: z.string(), url: z.string(), followed: z.boolean() }),
  output: z.object({}),
});

/**
 * Resolves a path from the notes (expanding ~). Directories are opened in the daemon machine's
 * file manager with xdg-open; files are returned so the client can open them in a Paseo tab.
 */
export const openPath = defineRpc({
  name: "project.open_path",
  input: z.object({ path: z.string(), openFolders: z.boolean() }),
  output: z.object({ kind: z.enum(["file", "directory"]), absolutePath: z.string() }),
});

/** The Paseo project's display name and icon, read the way the daemon reads them. */
export const projectIdentity = defineRpc({
  name: "project.identity",
  input: z.object({ projectId: z.string() }),
  output: z.object({
    name: z.string().nullable(),
    icon: z.object({ data: z.string(), mimeType: z.string() }).nullable(),
  }),
});
