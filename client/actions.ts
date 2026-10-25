import type { PluginAgentCommandContext } from "@getpaseo/plugin/client";
import { PANEL_ID, disableProject, enableProject } from "../shared/contracts";

/** Shared by the slash command and the Command Center item. */
export async function runProjectManager(
  { rpc, workspace, agent, openPanel }: PluginAgentCommandContext,
  args: string,
  onChange: () => void,
) {
  const command = args.trim().toLowerCase();
  if (command === "off") {
    await rpc(disableProject, { workspaceId: workspace.id });
    onChange();
    openPanel(PANEL_ID);
    return;
  }
  if (command && command !== "on") {
    throw new Error(`Unknown option "${args}". Use /projectmanager, or /projectmanager off.`);
  }
  await rpc(enableProject, {
    workspaceId: workspace.id,
    workspaceName: workspace.title || workspace.name,
    directory: workspace.directory,
    agentId: agent.id,
  });
  onChange();
  openPanel(PANEL_ID);
}
