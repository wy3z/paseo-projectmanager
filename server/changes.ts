import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { execCommand, type PluginHandlerContext } from "@getpaseo/plugin/server";
import { createReadStream } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkerFile, workerChanges, workerDiff } from "../shared/contracts";
import { findEnabledProject, getProject } from "./store";

const DIFF_LIMIT = 200 * 1024;
const DEFAULT_BRANCHES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

async function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await execCommand("git", [
    "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args,
  ], {
    cwd,
    timeout: 15_000,
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

async function checkout(cwd: string) {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  for (const branch of DEFAULT_BRANCHES) {
    try {
      const base = (await git(root, ["merge-base", "HEAD", branch])).trim();
      if (base) return { root, base };
    } catch {
      // A checkout may have no remote or use a different default branch.
    }
  }
  return null;
}

async function workerCwd(
  { workspaceId, agentId }: RpcInput<typeof workerChanges>,
  { paseo }: PluginHandlerContext,
) {
  const project = await getProject(workspaceId);
  if (!project?.enabled) throw new Error("Shared context is not enabled for this workspace.");
  const ref = paseo.agents.ref(agentId);
  await ref.refresh();
  const agent = ref.current();
  if (!agent || (await findEnabledProject(agent.workspaceId ?? null, agent.cwd))?.workspaceId !== project.workspaceId) {
    throw new Error("This agent does not belong to the Project.");
  }
  return agent.cwd;
}

export async function changes(input: RpcInput<typeof workerChanges>, context: PluginHandlerContext) {
  return readWorkerChanges(await workerCwd(input, context));
}

export async function diff(input: RpcInput<typeof workerDiff>, context: PluginHandlerContext) {
  return readWorkerDiff(await workerCwd(input, context), input.path);
}

/** Includes everything since the branch point, whether committed, staged or still in the worktree. */
export async function readWorkerChanges(cwd: string): Promise<RpcOutput<typeof workerChanges>> {
  const repo = await checkout(cwd);
  if (!repo) return { base: null, files: [] };
  const { root, base } = repo;
  const args = ["diff", "--no-ext-diff", "--no-textconv", "-M", base];
  const [numstat, names, untracked] = await Promise.all([
    git(root, [...args, "--numstat", "-z"]),
    git(root, [...args, "--name-status", "-z"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const statuses = new Map<string, WorkerFile["status"]>();
  const entries = names.split("\0");
  for (let i = 0; i < entries.length - 1;) {
    const status = entries[i++];
    let path = entries[i++];
    if (status.startsWith("R") || status.startsWith("C")) path = entries[i++];
    statuses.set(path, status.startsWith("R") ? "renamed" : status === "A" ? "added" : status === "D" ? "deleted" : "modified");
  }

  const files: WorkerFile[] = [];
  const counts = numstat.split("\0");
  for (let i = 0; i < counts.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(counts[i]);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      i++;
      path = counts[++i];
    }
    files.push({
      path,
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
      status: statuses.get(path) ?? "modified",
    });
  }
  for (const path of untracked.split("\0").filter(Boolean)) {
    files.push({ path, additions: await untrackedLines(resolve(root, path)), deletions: 0, status: "untracked" });
  }
  return { base, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function untrackedLines(path: string) {
  if ((await lstat(path)).isSymbolicLink()) return 1;
  let lines = 0;
  let last = -1;
  for await (const chunk of createReadStream(path)) {
    if (chunk.includes(0)) return 0;
    for (const byte of chunk) if (byte === 10) lines++;
    if (chunk.length) last = chunk[chunk.length - 1];
  }
  return lines + (last !== -1 && last !== 10 ? 1 : 0);
}

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function checkoutPath(root: string, path: string) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!path || path.includes("\0") || !rel || !within(root, absolute) || rel.split(sep).includes(".git")) {
    throw new Error("Path is outside the checkout.");
  }
  const actualRoot = await realpath(root);
  let existing = absolute;
  for (;;) {
    try {
      if (!within(actualRoot, await realpath(existing))) throw new Error("Path is outside the checkout.");
      return { absolute, path: rel.split(sep).join("/") };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      existing = dirname(existing);
    }
  }
}

function capped(diff: string, truncated = false): RpcOutput<typeof workerDiff> {
  const bytes = Buffer.from(diff);
  return {
    diff: bytes.length > DIFF_LIMIT
      ? new TextDecoder().decode(bytes.subarray(0, DIFF_LIMIT), { stream: true })
      : diff,
    truncated: truncated || bytes.length > DIFF_LIMIT,
  };
}

export async function readWorkerDiff(cwd: string, path: string): Promise<RpcOutput<typeof workerDiff>> {
  const repo = await checkout(cwd);
  const file = await checkoutPath(repo?.root ?? cwd, path);
  if (!repo) return { diff: "", truncated: false };
  const untracked = await git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", file.path]);
  if (untracked.split("\0").includes(file.path)) {
    const info = await lstat(file.absolute);
    if (info.isSymbolicLink()) return capped(`--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1 @@\n+${await readlink(file.absolute)}\n`);
    const handle = await open(file.absolute, "r");
    try {
      const buffer = Buffer.alloc(DIFF_LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return { diff: `Binary file: ${file.path}`, truncated: false };
      const content = new TextDecoder().decode(bytes, { stream: bytesRead > DIFF_LIMIT });
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const body = content ? lines.map((line) => `+${line}`).join("\n") : "";
      return capped(`--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${body}`, info.size > bytesRead);
    } finally {
      await handle.close();
    }
  }
  try {
    return capped(await git(repo.root, ["diff", "--no-ext-diff", "--no-textconv", "-M", repo.base, "--", file.path], DIFF_LIMIT));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
      "stdout" in error && typeof error.stdout === "string") {
      return capped(error.stdout, true);
    }
    throw error;
  }
}
