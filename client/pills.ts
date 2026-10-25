import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { PANEL_ID, type ProjectState, listProjects, projectPrs } from "../shared/contracts";
import { FollowingTray } from "./following";
import { PR_POLL_MS, PrsTray, isOpenPr } from "./prs-tray";

interface PillTarget {
  workspaceId: string;
}

interface CoordinatorPills {
  target: PillTarget;
  project: PluginButtonRegistration;
  prs: PluginButtonRegistration;
  following: PluginButtonRegistration;
}

/**
 * Gives the coordinator chat three composer pills: "Project", which opens the Project panel, and
 * the "PRs N" and "Following" trays, which appear once the Project has pull requests.
 * Returns a `refresh` to call after enabling or disabling, plus cleanup.
 */
export function contributePills(client: PluginClientContext) {
  const lifetime = new AbortController();
  const agents = new Map<string, string>();
  const projects = new Map<string, ProjectState>();
  const pills = new Map<string, CoordinatorPills>();

  function targetFor(agentId: string, workspaceId: string): PillTarget | null {
    const project = projects.get(workspaceId);
    if (!project?.enabled || project.coordinatorAgentId !== agentId) return null;
    return { workspaceId };
  }

  function sync() {
    if (lifetime.signal.aborted) return;
    for (const [agentId, pill] of pills) {
      const workspaceId = agents.get(agentId);
      const target = workspaceId ? targetFor(agentId, workspaceId) : null;
      if (!target || target.workspaceId !== pill.target.workspaceId) {
        removePills(pill);
        pills.delete(agentId);
      }
    }
    for (const [agentId, workspaceId] of agents) {
      if (pills.has(agentId)) continue;
      const target = targetFor(agentId, workspaceId);
      if (!target) continue;
      const project = client.addComposerPill({
        id: "project",
        workspaceId,
        agentId,
        button: {
          title: "Open the Project panel",
          icon: "NotebookPen",
          label: "Project",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel(PANEL_ID, { workspaceId });
            },
          },
        },
      });
      const prs = client.addComposerPill({
        id: "prs",
        workspaceId,
        agentId,
        button: {
          title: "Pull requests from this Project",
          icon: "GitPullRequest",
          label: "PRs",
          visible: false,
          behavior: { kind: "popover", Content: PrsTray },
        },
      });
      const following = client.addComposerPill({
        id: "following",
        workspaceId,
        agentId,
        button: {
          title: "Followed PRs",
          icon: "Radio",
          label: "Following",
          visible: false,
          behavior: { kind: "popover", Content: FollowingTray },
        },
      });
      pills.set(agentId, { target, project, prs, following });
      void updatePrCount(agentId);
    }
  }

  async function updatePrCount(agentId: string) {
    const pill = pills.get(agentId);
    if (!pill) return;
    try {
      const { prs } = await client.rpc(projectPrs, { workspaceId: pill.target.workspaceId });
      const open = prs.filter(isOpenPr).length;
      const following = prs.filter((pr) => pr.followed).length;
      const current = pills.get(agentId);
      // No count at zero, and the Following pill shows only once something is followed.
      current?.prs.update({ visible: prs.length > 0, label: open ? `PRs ${open}` : "PRs" });
      current?.following.update({ visible: following > 0, title: `Followed PRs (${following})` });
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("[projectmanager] Could not load PRs", error);
    }
  }

  const prTimer = setInterval(() => {
    for (const agentId of pills.keys()) void updatePrCount(agentId);
  }, PR_POLL_MS);

  async function refresh() {
    try {
      const { projects: next } = await client.rpc(listProjects, {});
      projects.clear();
      for (const project of next) projects.set(project.workspaceId, project);
      sync();
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("[projectmanager] Could not load projects", error);
    }
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          agents.clear();
          for (const { agent } of entries) {
            if (agent.workspaceId) agents.set(agent.id, agent.workspaceId);
          }
          void refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            const isNew = !agents.has(update.agent.id);
            if (update.agent.workspaceId) agents.set(update.agent.id, update.agent.workspaceId);
            // A new agent is a cheap moment to pick up changes made from another client.
            if (isNew) return void refresh();
          } else {
            agents.delete(update.agentId);
          }
          sync();
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[projectmanager] Agent observation failed", error);
    });

  return {
    refresh,
    cleanup() {
      lifetime.abort();
      clearInterval(prTimer);
      for (const pill of pills.values()) removePills(pill);
      pills.clear();
    },
  };
}

function removePills({ project, prs, following }: CoordinatorPills) {
  project.remove();
  prs.remove();
  following.remove();
}
