import { execCommand } from "@getpaseo/plugin/server";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HistoryEntry, ProjectState } from "../shared/contracts";

export interface StoredProject extends ProjectState {
  workspaceName: string;
  directory: string;
  /** PR URLs the user unfollowed from the Following pill. */
  mutedPrs?: string[];
}

interface StoreFile {
  version: 1;
  projects: Record<string, StoredProject>;
}

const ROOT = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "paseo-projectmanager");
const STATE_PATH = join(ROOT, "state.json");
const PLUGIN_DIR = ".projectmanager";

const GIT_IDENTITY = [
  "-c", "user.name=Paseo project manager",
  "-c", "user.email=projectmanager@paseo.local",
  "-c", "commit.gpgsign=false",
];

let stateQueue: Promise<unknown> = Promise.resolve();
const gitQueues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task on the same queue, whether or not they failed. */
function enqueue<T>(previous: Promise<unknown>, task: () => Promise<T>): Promise<T> {
  return previous.then(task, task);
}

async function readStore(): Promise<StoreFile> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as StoreFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
    throw error;
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temp = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`);
  await rename(temp, STATE_PATH);
}

export async function listProjects(): Promise<StoredProject[]> {
  return Object.values((await readStore()).projects);
}

export async function getProject(workspaceId: string): Promise<StoredProject | null> {
  return (await readStore()).projects[workspaceId] ?? null;
}

/** Applies `change` to one project record atomically with respect to other state writes. */
export function updateProject(
  workspaceId: string,
  change: (current: StoredProject | null) => StoredProject,
): Promise<StoredProject> {
  const next = enqueue(stateQueue, async () => {
    const store = await readStore();
    const updated = change(store.projects[workspaceId] ?? null);
    store.projects[workspaceId] = updated;
    await writeStore(store);
    return updated;
  });
  stateQueue = next;
  return next;
}

/** The enabled project whose workspace directory contains `cwd`, preferring an exact workspace match. */
export async function findEnabledProject(
  workspaceId: string | null,
  cwd: string | null,
): Promise<StoredProject | null> {
  const enabled = (await listProjects()).filter((project) => project.enabled);
  if (workspaceId) {
    const exact = enabled.find((project) => project.workspaceId === workspaceId);
    if (exact) return exact;
  }
  if (!cwd) return null;
  const within = enabled.find((project) => isWithin(project.directory, cwd));
  if (within) return within;

  // Worktree agents work under ~/.paseo/worktrees, outside the Project's directory, so fall back to
  // the repository both paths belong to.
  const root = await cachedRepoRoot(cwd);
  if (!root) return null;
  for (const project of enabled) {
    if ((await cachedRepoRoot(project.directory)) === root) return project;
  }
  return null;
}

const REPO_ROOT_TTL_MS = 60_000;
const repoRoots = new Map<string, { root: string | null; expiresAt: number }>();

/** The repository `dir` belongs to, shared by its worktrees; null when `dir` is not in a repository. */
async function repoRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execCommand(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: 5_000 },
    );
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    return commonDir.endsWith(`${sep}.git`) ? commonDir.slice(0, -4) : commonDir;
  } catch {
    return null;
  }
}

function cachedRepoRoot(dir: string): Promise<string | null> {
  const cached = repoRoots.get(dir);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.root);
  return repoRoot(dir).then((root) => {
    if (repoRoots.size > 500) repoRoots.clear();
    repoRoots.set(dir, { root, expiresAt: Date.now() + REPO_ROOT_TTL_MS });
    return root;
  });
}

export function contextDirFor(workspaceId: string, workspaceName: string): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return join(ROOT, "workspaces", slug ? `${slug}-${workspaceId}` : workspaceId);
}

export function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Resolves a context-relative path, refusing anything outside the folder or inside `.git`. */
export function resolveContextPath(contextDir: string, path: string): string {
  const absolute = resolve(contextDir, path);
  const rel = relative(contextDir, absolute);
  if (!rel || rel.startsWith("..") || rel.split(sep)[0] === ".git") {
    throw new Error(`Path is outside the shared context folder: ${path}`);
  }
  return absolute;
}

export async function listContextFiles(contextDir: string) {
  const files: { path: string; size: number; modifiedAt: string }[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      // .git holds history and .projectmanager holds plugin-owned files; neither is context.
      if (entry.name === ".git" || entry.name === PLUGIN_DIR) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        files.push({
          path: relative(contextDir, absolute),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }
  }
  await walk(contextDir);
  // notes.md first, then the rest alphabetically.
  return files.sort((a, b) =>
    a.path === "notes.md" ? -1 : b.path === "notes.md" ? 1 : a.path.localeCompare(b.path),
  );
}

/** Writes a plugin-owned file under `.projectmanager/`, hidden from the Context listing. */
export async function writePluginFile(contextDir: string, name: string, content: string) {
  await mkdir(join(contextDir, PLUGIN_DIR), { recursive: true });
  await writeFile(join(contextDir, PLUGIN_DIR, name), content);
}

export async function readContextText(contextDir: string, path: string): Promise<string | null> {
  try {
    return await readFile(resolveContextPath(contextDir, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function git(contextDir: string, args: string[]): Promise<string> {
  const { stdout } = await execCommand("git", [...GIT_IDENTITY, "-C", contextDir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function withGit<T>(contextDir: string, task: () => Promise<T>): Promise<T> {
  const next = enqueue(gitQueues.get(contextDir) ?? Promise.resolve(), task);
  gitQueues.set(contextDir, next);
  return next;
}

export function ensureContextRepo(contextDir: string): Promise<void> {
  return withGit(contextDir, async () => {
    await mkdir(contextDir, { recursive: true });
    try {
      await stat(join(contextDir, ".git"));
    } catch {
      await git(contextDir, ["init", "--quiet", "--initial-branch=main"]);
    }
  });
}

/** Commits every change in the folder. Returns null when there was nothing to record. */
export function snapshot(
  contextDir: string,
  message: string,
): Promise<{ commit: string; files: string[] } | null> {
  return withGit(contextDir, () => commitAll(contextDir, message));
}

async function commitAll(contextDir: string, message: string) {
  await git(contextDir, ["add", "--all"]);
  if (!(await git(contextDir, ["status", "--porcelain"])).trim()) return null;
  await git(contextDir, ["commit", "--quiet", "--allow-empty-message", "-m", message]);
  const commit = (await git(contextDir, ["rev-parse", "HEAD"])).trim();
  const files = (await git(contextDir, ["show", "--name-only", "--format=", "HEAD"]))
    .split("\n")
    .filter(Boolean);
  return { commit, files };
}

export async function history(contextDir: string, limit: number): Promise<HistoryEntry[]> {
  let output: string;
  try {
    output = await git(contextDir, [
      "log", `-n${limit}`, "--name-only", "--format=%x1e%H%x1f%aI%x1f%s",
    ]);
  } catch {
    // No commits yet.
    return [];
  }
  return output
    .split("\x1e")
    .filter((record) => record.trim())
    .map((record) => {
      const [header, ...files] = record.split("\n");
      const [commit, at, message] = header.split("\x1f");
      return { commit, at, message, files: files.filter(Boolean) };
    });
}

export async function readAtCommit(contextDir: string, path: string, commit: string) {
  assertCommit(commit);
  const rel = relative(contextDir, resolveContextPath(contextDir, path)).split(sep).join("/");
  try {
    return await git(contextDir, ["show", `${commit}:${rel}`]);
  } catch {
    return null;
  }
}

/** Puts the folder back to `commit` as a new commit; the current state is snapshotted first. */
export function restore(contextDir: string, commit: string, label: string) {
  assertCommit(commit);
  return withGit(contextDir, async () => {
    await commitAll(contextDir, "Snapshot before restore");
    await git(contextDir, ["restore", `--source=${commit}`, "--staged", "--worktree", "--", "."]);
    return commitAll(contextDir, `Restored to ${commit.slice(0, 8)} (${label})`);
  });
}

function assertCommit(commit: string) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`Not a commit id: ${commit}`);
}
