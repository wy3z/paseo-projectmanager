import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { registerHooks } from "./server/hooks";
import { changes, diff } from "./server/changes";
import {
  disable,
  enable,
  follow,
  list,
  log,
  openLocalPath,
  prs,
  read,
  refreshGuides,
  restoreTo,
  status,
} from "./server/project";
import { readProjectIdentity } from "./server/project-identity";
import { startWatcher } from "./server/subscriptions";
import {
  contextHistory,
  disableProject,
  enableProject,
  listProjects,
  openPath,
  projectIdentity,
  projectPrs,
  projectStatus,
  readContextFile,
  restoreContext,
  setPrFollowed,
  workerChanges,
  workerDiff,
} from "./shared/contracts";

type Paseo = PluginHandlerContext["paseo"];

export default function contribute(server: PluginServerContext) {
  // The server context has no SDK handle of its own. Every handler and hook receives the same
  // subprocess-lifetime PaseoApi, so keep the first one for the PR watcher's timer.
  let paseo: Paseo | null = null;
  const remember = <Input, Output>(handler: (input: Input, context: PluginHandlerContext) => Output) =>
    (input: Input, context: PluginHandlerContext) => {
      paseo = context.paseo;
      return handler(input, context);
    };

  server.handle(enableProject, remember(enable));
  server.handle(disableProject, remember(disable));
  server.handle(listProjects, remember(list));
  server.handle(projectStatus, remember(status));
  server.handle(readContextFile, remember(read));
  server.handle(contextHistory, remember(log));
  server.handle(restoreContext, remember(restoreTo));
  server.handle(projectPrs, remember(prs));
  server.handle(setPrFollowed, remember(follow));
  server.handle(openPath, remember(openLocalPath));
  server.handle(projectIdentity, ({ projectId }) => readProjectIdentity(projectId));
  server.handle(workerChanges, remember(changes));
  server.handle(workerDiff, remember(diff));
  registerHooks(server, (context) => {
    paseo = context;
  });
  refreshGuides().catch((error) => console.error("[projectmanager] Could not refresh coordinator guides", error));
  return startWatcher(() => paseo);
}
