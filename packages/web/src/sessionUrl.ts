// The URL hash mirrors the session the user has open, so a browser refresh,
// a phone tab restore, or a WebSocket reconnect lands on the same session
// instead of whatever the tab/pane restore heuristics pick:
//
//   #ws=nalar&task=sess_…   task in <server workspace>/nalar
//   #ws=nalar               draft (new task) in that project
//   #task=sess_…            task in the server workspace itself
//
// `ws` is relative to the server workspace so the URL never points outside it.
import { isWorkspacePathInScope } from "./workspaceScopedSettings.js";

export interface SessionUrlTarget {
  workspacePath: string;
  taskId?: string;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/gu, "");
}

export function parseSessionHash(hash: string, scopePath: string): SessionUrlTarget | null {
  const params = new URLSearchParams(hash.replace(/^#/u, ""));
  const relative = trimSlashes(params.get("ws") ?? "");
  const taskId = params.get("task") || undefined;
  if (!relative && !taskId) {
    return null;
  }
  if (relative.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const root = scopePath.replace(/\/+$/u, "");
  return {
    workspacePath: relative ? `${root}/${relative}` : scopePath,
    ...(taskId ? { taskId } : {}),
  };
}

/** Hash for the active workspace/task, or null when the workspace is outside the scope. */
export function formatSessionHash(
  scopePath: string,
  workspacePath: string,
  taskId: string | null,
): string | null {
  if (!isWorkspacePathInScope(workspacePath, scopePath)) {
    return null;
  }
  const params = new URLSearchParams();
  const relative = trimSlashes(workspacePath.slice(scopePath.length));
  if (relative) {
    params.set("ws", relative);
  }
  if (taskId) {
    params.set("task", taskId);
  }
  const query = params.toString().replaceAll("%2F", "/");
  return query ? `#${query}` : "";
}

/** Rewrite the hash in place (no history entry, no hashchange event). */
export function writeSessionHash(hash: string): void {
  if (window.location.hash === hash || (!hash && !window.location.hash)) {
    return;
  }
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
}
