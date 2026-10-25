import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: {
  history: { pushState(data: unknown, unused: string, url: string): void };
  dispatchEvent(event: unknown): boolean;
};
declare const PopStateEvent: new (type: string, init?: { state?: unknown }) => unknown;
declare function btoa(data: string): string;

/** base64url without padding, as Paseo encodes route segments. */
function base64Url(text: string) {
  const bytes = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Opens a file as a tab in a Paseo workspace. The plugin API has no call for this, so on web and
 * desktop it uses the app's own workspace route (`/h/<server>/workspace/<id>?open=file:<base64url>`),
 * which the router picks up from a popstate event. Returns false where that is unavailable.
 */
export function openFileInWorkspace(input: { serverId: string; workspaceId: string; path: string }) {
  if (Platform.OS !== "web") return false;
  const workspace = /^[A-Za-z0-9._~-]+$/.test(input.workspaceId)
    ? input.workspaceId
    : `b64_${base64Url(input.workspaceId)}`;
  const route =
    `/h/${encodeURIComponent(input.serverId)}/workspace/${encodeURIComponent(workspace)}` +
    `?open=${encodeURIComponent(`file:${base64Url(input.path)}`)}`;
  window.history.pushState({}, "", route);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  return true;
}
