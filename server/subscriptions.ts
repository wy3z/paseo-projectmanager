import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PullRequest } from "../shared/contracts";
import type { PrDetail } from "./prs";
import { projectPrDetails } from "./project";
import { type StoredProject, listProjects } from "./store";

// The coordinator follows the PRs its workers open and is woken when one changes. This watcher
// covers every PR the Project follows (see `projectPrDetails`) and delivers changes to the
// coordinator as a <system_notification>.

type Paseo = PluginHandlerContext["paseo"];

const POLL_MS = 60_000;

interface Seen {
  group: PullRequest["group"];
  feedbackCount: number;
}

/** Last seen state per workspace. Lost on restart, so changes while the plugin is stopped are missed. */
const baselines = new Map<string, Map<string, Seen>>();
/** Events waiting for a busy coordinator, keyed by agent id, then PR URL so only the latest survives. */
const pending = new Map<string, Map<string, string>>();
let ticking = false;

export function startWatcher(getPaseo: () => Paseo | null) {
  const timer = setInterval(() => {
    const paseo = getPaseo();
    if (paseo && !ticking) {
      ticking = true;
      void tick(paseo).finally(() => {
        ticking = false;
      });
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}

async function tick(paseo: Paseo) {
  for (const project of await listProjects()) {
    if (!project.enabled || !project.coordinatorAgentId) {
      baselines.delete(project.workspaceId);
      continue;
    }
    try {
      const details = await projectPrDetails(paseo, project);
      const events = diffPrs(project, details);
      // Also retries events held while the coordinator was busy.
      await deliver(paseo, project.coordinatorAgentId, events);
    } catch (error) {
      console.error(`[projectmanager] PR watch failed for ${project.workspaceId}`, error);
    }
  }
}

export function diffPrs(project: StoredProject, details: readonly PrDetail[]) {
  const previous = baselines.get(project.workspaceId);
  const next = new Map<string, Seen>();
  const events = new Map<string, string>();
  const muted = new Set(project.mutedPrs ?? []);
  for (const { pr, feedbackCount, latestFeedback } of details) {
    next.set(pr.url, { group: pr.group, feedbackCount });
    // The first poll after start only records a baseline.
    if (!previous || muted.has(pr.url)) continue;
    const seen = previous.get(pr.url);
    const changes: string[] = [];
    if (!seen) {
      if (pr.state === "open" || pr.state === "draft") changes.push(`now followed (${pr.group})`);
    } else {
      if (seen.group !== pr.group) changes.push(`${pr.group} (was ${seen.group})`);
      if (feedbackCount > seen.feedbackCount) {
        const count = feedbackCount - seen.feedbackCount;
        changes.push(`${count} new comment${count === 1 ? "" : "s"} or review${count === 1 ? "" : "s"}`);
      }
    }
    if (changes.length) events.set(pr.url, renderEvent(pr, changes, latestFeedback));
  }
  baselines.set(project.workspaceId, next);
  return events;
}

function renderEvent(pr: PrDetail["pr"], changes: string[], latestFeedback: string | null) {
  return [
    "<task>",
    "kind: pull_request",
    `pr: #${pr.number} ${pr.title}`,
    `url: ${pr.url}`,
    `branch: ${pr.branch}`,
    `change: ${changes.join("; ")}`,
    ...(latestFeedback ? [`latest: ${latestFeedback}`] : []),
    "</task>",
  ].join("\n");
}

export async function deliver(paseo: Paseo, coordinatorId: string, events: Map<string, string>) {
  const queue = pending.get(coordinatorId) ?? new Map<string, string>();
  for (const [url, event] of events) queue.set(url, event);
  pending.set(coordinatorId, queue);
  await flushPending(paseo, coordinatorId);
}

/** Sends queued events if the coordinator is idle. Called after each poll and when its turn ends. */
export async function flushPending(paseo: Paseo, coordinatorId: string) {
  const queue = pending.get(coordinatorId);
  if (!queue?.size) return;
  const coordinator = paseo.agents.ref(coordinatorId);
  await coordinator.refresh();
  if (coordinator.status === "running" || coordinator.status === "initializing") return;
  if (coordinator.archivedAt || coordinator.status === "closed") {
    pending.delete(coordinatorId);
    return;
  }
  pending.delete(coordinatorId);
  await coordinator.send(
    `<system_notification source="pr_subscription">\n${[...queue.values()].join("\n")}\n` +
      "A followed PR changed; if it needs action, such as fixing CI, answering review feedback, resolving " +
      "conflicts or updating notes.md, act now or delegate to the worker that owns the PR. " +
      "If no action is needed, finish the turn without a message to the user.\n</system_notification>",
  );
}
