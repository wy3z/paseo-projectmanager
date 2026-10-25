import type { PluginClientContext } from "@getpaseo/plugin/client";
import { runProjectManager } from "./client/actions";
import { ProjectPanel } from "./client/panel";
import { contributePills } from "./client/pills";
import { PANEL_ID } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const pills = contributePills(client);
  const refresh = () => void pills.refresh();

  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Project",
    icon: "NotebookPen",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ProjectPanel,
  });
  client.addSlashCommand({
    name: "projectmanager",
    description: "Make this chat the Project coordinator",
    argumentHint: "[off]",
    context: "agent",
    onSubmit: (context) => runProjectManager(context, context.args, refresh),
  });
  client.addCommandCenterItem({
    id: "make-coordinator",
    title: "Project manager: make this chat the coordinator",
    icon: "NotebookPen",
    keywords: ["projectmanager", "project", "notes", "context"],
    context: "agent",
    onSelect: (context) => runProjectManager(context, "", refresh),
  });
  client.addCommandCenterItem({
    id: "open-project",
    title: "Project manager: open Project panel",
    icon: "NotebookPen",
    keywords: ["projectmanager", "notes", "context"],
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel(PANEL_ID),
  });

  return () => pills.cleanup();
}
