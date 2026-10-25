import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { coordinatorGuide, workerBrief } from "./briefing";
import { PARENT_AGENT_ID_LABEL } from "./project";
import {
  type StoredProject,
  findEnabledProject,
  isWithin,
  listProjects,
  snapshot,
  updateProject,
  writePluginFile,
} from "./store";
import { flushPending } from "./subscriptions";

type Paseo = PluginHandlerContext["paseo"];

/** Tool calls an agent may make inside the store without asking. Shell commands still ask. */
const FILE_TOOLS = new Set(["read", "edit", "write"]);

export function registerHooks(
  server: PluginServerContext,
  rememberPaseo: (paseo: PluginHandlerContext["paseo"]) => void,
) {
  server.before("workspace.create", async ({ request }, { paseo }) => {
    rememberPaseo(paseo);
    let background = false;
    try {
      if (request.background === undefined && request.callerAgentId) {
        const ref = paseo.agents.ref(request.callerAgentId);
        await ref.refresh();
        const caller = ref.current();
        if (caller) {
          const projects = (await listProjects()).filter((project) => project.enabled);
          background = projects.some((project) => project.coordinatorAgentId !== null &&
            (project.coordinatorAgentId === caller.id ||
              project.coordinatorAgentId === caller.labels?.[PARENT_AGENT_ID_LABEL])) ||
            (await findEnabledProject(caller.workspaceId ?? null, caller.cwd)) !== null;
        }
      }
    } catch {
      // A missing caller or failed lookup must not change workspace creation.
    }
    console.info(`[projectmanager] workspace.create caller=${request.callerAgentId ?? "none"} background=${background ? "set" : "unchanged"}`);
    if (background) return { ...request, background: true };
  });

  // Brief every new agent in an enabled workspace and let it write to the store.
  server.before("agent.create", async ({ request }) => {
    const { config } = request;
    if (config.internal) return;
    const project = await findEnabledProject(null, config.cwd);
    if (!project) return;

    const brief = workerBrief(project);
    const providerOptions = config.provider.startsWith("codex")
      ? withCodexWritableRoot(config.providerOptions, project.contextDir)
      : config.providerOptions;

    return {
      ...request,
      config: {
        ...config,
        systemPrompt: config.systemPrompt ? `${config.systemPrompt}\n\n${brief}` : brief,
        providerOptions,
      },
      env: { ...request.env, PASEO_PROJECT_CONTEXT: project.contextDir },
    };
  });

  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    rememberPaseo(paseo);
    const detail = request.detail;
    if (!detail || !FILE_TOOLS.has(detail.type) || !("filePath" in detail)) return;
    const project = await findEnabledProject(agent.workspaceId, agent.cwd);
    if (!project || !isWithin(project.contextDir, detail.filePath)) return;
    await paseo.agents.ref(agent.id).respondToPermission({
      requestId: request.id,
      response: { behavior: "allow" },
    });
  });

  // Snapshot the store after every turn so every version stays recoverable, and hand the
  // coordinator any PR events that arrived while it was busy.
  server.on("agent.turn_ended", async ({ agent }, { paseo }) => {
    rememberPaseo(paseo);
    const project = await findEnabledProject(agent.workspaceId, agent.cwd);
    if (!project) return;
    const isCoordinator = agent.id === project.coordinatorAgentId;
    if (isCoordinator) await renameFromWorkspace(project, paseo);
    const title = await agentTitle(paseo, agent);
    // Other agents may have written to the store during this turn; the snapshot records them too.
    await snapshot(project.contextDir, `After ${isCoordinator ? "Coordinator" : "Worker"} ${title}'s turn`);
    if (isCoordinator) await flushPending(paseo, agent.id);
  });
}

/** The workspace title the user sees, which the workspace name captured at enable can drift from. */
async function renameFromWorkspace(project: StoredProject, paseo: Paseo) {
  try {
    const { entries } = await paseo.workspaces.list();
    const workspace = entries.find((entry) => entry.id === project.workspaceId);
    const name = workspace?.title || workspace?.name;
    if (!name || name === project.workspaceName) return;
    // Only the display name changes; the store folder stays where it is.
    const updated = await updateProject(project.workspaceId, (current) => ({ ...current!, workspaceName: name }));
    await writePluginFile(updated.contextDir, "coordinator.md", coordinatorGuide(updated));
  } catch (error) {
    console.warn("[projectmanager] Could not refresh the Project name", error);
  }
}

async function agentTitle(paseo: Paseo, agent: { id: string; title: string | null }): Promise<string> {
  if (agent.title) return agent.title;
  // The turn_ended event usually has no title; the live agent has the current one.
  try {
    const ref = paseo.agents.ref(agent.id);
    await ref.refresh();
    return ref.current()?.title || agent.id;
  } catch {
    return agent.id;
  }
}

function withCodexWritableRoot(options: Record<string, unknown> | undefined, root: string) {
  const workspaceWrite = (options?.sandbox_workspace_write ?? {}) as { writable_roots?: string[] };
  const roots = workspaceWrite.writable_roots ?? [];
  return {
    ...options,
    sandbox_workspace_write: {
      ...workspaceWrite,
      writable_roots: roots.includes(root) ? roots : [...roots, root],
    },
  };
}
