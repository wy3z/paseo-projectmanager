import type { RpcInput } from "@getpaseo/plugin";
import { spawnProcess } from "@getpaseo/plugin/server";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  contextHistory,
  disableProject,
  enableProject,
  projectPrs,
  projectStatus,
  readContextFile,
  openPath,
  restoreContext,
  setPrFollowed,
} from "../shared/contracts";
import { coordinatorGuide, coordinatorKickoff } from "./briefing";
import { lookupPrDetails, prUrlsIn } from "./prs";
import {
  type StoredProject,
  contextDirFor,
  ensureContextRepo,
  getProject,
  history,
  listContextFiles,
  listProjects,
  readAtCommit,
  readContextText,
  restore,
  snapshot,
  updateProject,
  writePluginFile,
} from "./store";

function toState({ workspaceName, directory, ...state }: StoredProject) {
  return state;
}

async function requireProject(workspaceId: string): Promise<StoredProject> {
  const project = await getProject(workspaceId);
  if (!project) throw new Error("Shared context has never been enabled for this workspace.");
  return project;
}

export async function enable(
  input: RpcInput<typeof enableProject>,
  { paseo }: PluginHandlerContext,
) {
  const existing = await getProject(input.workspaceId);
  if (existing?.enabled && existing.coordinatorAgentId === input.agentId) {
    return { state: toState(existing), outcome: "unchanged" as const };
  }

  // The kickoff arrives as a new message, so it must not land in the middle of a turn.
  const coordinator = paseo.agents.ref(input.agentId);
  await coordinator.refresh();
  if (coordinator.status === "running") {
    throw new Error("Wait for this chat to finish its current turn, then run /projectmanager again.");
  }

  const contextDir = existing?.contextDir ?? contextDirFor(input.workspaceId, input.workspaceName);
  await ensureContextRepo(contextDir);
  const takingOver = (await readContextText(contextDir, "notes.md")) !== null;
  const project = await updateProject(input.workspaceId, (current) => ({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    directory: input.directory,
    contextDir,
    enabled: true,
    coordinatorAgentId: input.agentId,
    enabledAt: current?.enabled ? current.enabledAt : new Date().toISOString(),
  }));
  await writePluginFile(contextDir, "coordinator.md", coordinatorGuide(project));
  await snapshot(contextDir, `Coordinator set to ${input.agentId}`);
  await coordinator.send(coordinatorKickoff(project, takingOver));

  return {
    state: toState(project),
    outcome: existing?.enabled ? ("coordinator-changed" as const) : ("enabled" as const),
  };
}

/** Rewrites every enabled Project's coordinator guide, so prompt changes reach existing coordinators. */
export async function refreshGuides() {
  for (const project of await listProjects()) {
    if (project.enabled) await writePluginFile(project.contextDir, "coordinator.md", coordinatorGuide(project));
  }
}

export async function disable({ workspaceId }: RpcInput<typeof disableProject>) {
  if (!(await getProject(workspaceId))) return { state: null };
  const project = await updateProject(workspaceId, (current) => ({ ...current!, enabled: false }));
  await snapshot(project.contextDir, "Shared context turned off");
  return { state: toState(project) };
}

export async function list() {
  return { projects: (await listProjects()).map(toState) };
}

export async function status({ workspaceId }: RpcInput<typeof projectStatus>) {
  const project = await getProject(workspaceId);
  if (!project) return { state: null, files: [] };
  return { state: toState(project), files: await listContextFiles(project.contextDir) };
}

export async function read({ workspaceId, path, commit }: RpcInput<typeof readContextFile>) {
  const { contextDir } = await requireProject(workspaceId);
  const content = commit
    ? await readAtCommit(contextDir, path, commit)
    : await readContextText(contextDir, path);
  return { content };
}

export async function log({ workspaceId, limit }: RpcInput<typeof contextHistory>) {
  const { contextDir } = await requireProject(workspaceId);
  return { entries: await history(contextDir, limit) };
}

export async function restoreTo({ workspaceId, commit }: RpcInput<typeof restoreContext>) {
  const { contextDir } = await requireProject(workspaceId);
  const result = await restore(contextDir, commit, "restored from the Project panel");
  return { commit: result?.commit ?? null };
}

// Paseo records the creating agent of a subagent in this label.
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** Agents working for the Project: the coordinator's subagents and other agents in the workspace. */
async function workersOf(paseo: PluginHandlerContext["paseo"], project: StoredProject) {
  const { entries } = await paseo.agents.list();
  return entries
    .map(({ agent }) => agent)
    .filter(
      (agent) =>
        agent.id !== project.coordinatorAgentId &&
        (agent.workspaceId === project.workspaceId ||
          (project.coordinatorAgentId !== null && agent.labels?.[PARENT_AGENT_ID_LABEL] === project.coordinatorAgentId)),
    );
}

/** Every PR the Project follows: those linked from the store, plus each Project agent's branch PR. */
export async function projectPrDetails(paseo: PluginHandlerContext["paseo"], project: StoredProject) {
  const files = await listContextFiles(project.contextDir);
  const texts = await Promise.all(
    files
      .filter((file) => file.path.endsWith(".md"))
      .map((file) => readContextText(project.contextDir, file.path)),
  );
  const urls = prUrlsIn(texts.join("\n"));
  const workers = await workersOf(paseo, project);
  const checkouts = [...new Set([project.directory, ...workers.map((agent) => agent.cwd)])];
  return lookupPrDetails(urls, checkouts);
}

export async function prs(
  { workspaceId }: RpcInput<typeof projectPrs>,
  { paseo }: PluginHandlerContext,
) {
  const project = await requireProject(workspaceId);
  const muted = new Set(project.mutedPrs ?? []);
  const details = await projectPrDetails(paseo, project);
  return { prs: details.map(({ pr }) => ({ ...pr, followed: !muted.has(pr.url) })) };
}

export async function follow({ workspaceId, url, followed }: RpcInput<typeof setPrFollowed>) {
  await requireProject(workspaceId);
  await updateProject(workspaceId, (current) => {
    const muted = new Set(current!.mutedPrs ?? []);
    if (followed) muted.delete(url);
    else muted.add(url);
    return { ...current!, mutedPrs: [...muted] };
  });
  return {};
}

export async function openLocalPath({ path, openFolders }: RpcInput<typeof openPath>) {
  const absolutePath = resolve(path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw new Error(`Not found: ${path}`);
  }
  if (info.isFile()) return { kind: "file" as const, absolutePath };
  if (!info.isDirectory()) throw new Error(`Not a file or folder: ${path}`);
  if (!openFolders) throw new Error("Folders open in the file manager from the desktop app.");
  // Only folders go to xdg-open; a file could be a script or .desktop entry that launches something.
  const child = spawnProcess("xdg-open", [absolutePath], { detached: true, stdio: "ignore" });
  await new Promise<void>((done, fail) => {
    child.once("spawn", done);
    child.once("error", fail);
  });
  child.unref();
  return { kind: "directory" as const, absolutePath };
}
