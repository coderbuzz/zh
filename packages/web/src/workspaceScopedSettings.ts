// zh web serves exactly one workspace (server-info workspaces[0]), but the
// settings file it reads through the RPC setting service is shared by every
// zh instance on the machine (~/.zcode/v2/setting.json). Restoring the raw
// persisted session therefore opens other instances' workspace tabs, and the
// first shell to mount consumes the one-shot pane-session restore (the
// "returned to an empty new session" bug that made v0.5.11 disable session
// restore entirely — which in turn dropped every other project from the
// sidebar on refresh).
//
// The wrapper below gives the web UI a per-instance view of that shared
// file instead: reads expose only workspace-session entries inside the
// server workspace scope (with the server workspace itself as the restored
// active tab), and writes merge the scoped UI state back into the raw
// snapshot without clobbering entries owned by other instances. Everything
// else (locale, provider settings, …) passes through untouched.
import type {
  AppSettings,
  LocalWorkspaceSessionEntry,
  PersistedWorkspaceSessionEntry,
} from "@zcode/shared";

/** Structural view of ISettingService — keeps @zcode/web decoupled from @zcode/services. */
export interface SettingServiceLike {
  get(): Promise<AppSettings>;
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      "providerFamilyDomain" | "providerFamilyConnectionSelections"
    >,
  ): Promise<void>;
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
}

/**
 * The app-owned "conversation" workspace (Tasks section: tasks without a
 * project) lives outside the server workspace but is shared by design, so the
 * scoped view keeps it.
 */
export function isConversationEntry(entry: PersistedWorkspaceSessionEntry): boolean {
  return entry.kind === "local" && entry.workspacePurpose === "conversation";
}

/** A path is in scope when it is the scope root itself or lives underneath it. */
export function isWorkspacePathInScope(path: string, scopePath: string): boolean {
  if (path === scopePath) {
    return true;
  }
  const prefix = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  return path.startsWith(prefix);
}

function readSessionEntries(settings: AppSettings): PersistedWorkspaceSessionEntry[] {
  return Array.isArray(settings.lastWorkspaceSession) ? settings.lastWorkspaceSession : [];
}

/**
 * The read view the web UI restores from: local workspace tabs inside the
 * scope (remote targets are not restorable on web), deduped, with the server
 * workspace guaranteed to exist. The active tab is forced to `activePath`
 * (the workspace the shell bootstraps: the URL's session, else the server
 * workspace) — the workspace shell that mounts first is the one allowed to
 * consume the one-shot pane-session restore, so it must be the bootstrapped tab.
 */
export function scopeSettingsForRestore(
  settings: AppSettings,
  scopePath: string,
  activePath: string = scopePath,
): AppSettings {
  const scoped: LocalWorkspaceSessionEntry[] = [];
  let scopeEntry: LocalWorkspaceSessionEntry | null = null;
  let activeEntry: LocalWorkspaceSessionEntry | null = null;
  for (const entry of readSessionEntries(settings)) {
    if (
      entry.kind !== "local" ||
      !(isWorkspacePathInScope(entry.workspacePath, scopePath) || isConversationEntry(entry))
    ) {
      continue;
    }
    if (!scoped.some((existing) => existing.workspacePath === entry.workspacePath)) {
      scoped.push(entry);
    }
    if (entry.workspacePath === scopePath) {
      // Later duplicates lose to the first scope-root entry.
      scopeEntry = scopeEntry ?? entry;
    }
    if (entry.workspacePath === activePath) {
      activeEntry = activeEntry ?? entry;
    }
  }
  if (!scopeEntry) {
    // Anchor tab: a fresh or foreign-written settings file must still open
    // this instance's own workspace.
    scopeEntry = { kind: "local", workspacePath: scopePath, workspacePurpose: "project" };
    scoped.unshift(scopeEntry);
  }
  const recentProjects = (Array.isArray(settings.recentProjects) ? settings.recentProjects : []).filter(
    (path) => isWorkspacePathInScope(path, scopePath),
  );
  return {
    ...settings,
    lastWorkspaceSession: scoped,
    lastActiveTabIndex: Math.max(scoped.indexOf(activeEntry ?? scopeEntry), 0),
    recentProjects,
  };
}

/**
 * The write side of the scoped view: upstream persists the UI's tab list as a
 * full replacement, which on a shared settings file would erase every other
 * instance's entries. Merge the scoped UI state (authoritative for in-scope
 * paths — a closed tab must stay closed) with raw entries the UI view does
 * not manage (remote snapshots and other instances' local entries), and map
 * the UI-relative active index back into the merged list.
 */
export function mergeScopedWorkspaceSessionPatch(
  raw: AppSettings,
  patch: Partial<AppSettings>,
  scopePath: string,
): Partial<AppSettings> {
  const merged: Partial<AppSettings> = { ...patch };
  const rawEntries = readSessionEntries(raw);
  if (patch.lastWorkspaceSession !== undefined) {
    const local = patch.lastWorkspaceSession.filter(
      (entry): entry is LocalWorkspaceSessionEntry => entry.kind === "local",
    );
    // Dedupe by path: earlier merges stacked copies of the conversation entry.
    const written = local.filter(
      (entry, index) => local.findIndex((o) => o.workspacePath === entry.workspacePath) === index,
    );
    // In-scope raw entries are never preserved: the written list is the
    // instance's full current tab set, so an in-scope entry missing from it
    // was closed by the user and must not resurrect from the stale snapshot.
    const preserved = rawEntries.filter(
      (entry) =>
        entry.kind !== "local" ||
        !(isWorkspacePathInScope(entry.workspacePath, scopePath) || isConversationEntry(entry)),
    );
    merged.lastWorkspaceSession = [...written, ...preserved];
    if (patch.lastActiveTabIndex !== undefined && written.length > 0) {
      const activeIndex = Math.min(Math.max(patch.lastActiveTabIndex, 0), local.length - 1);
      const activePath = local[activeIndex]?.workspacePath;
      const mergedIndex = merged.lastWorkspaceSession.findIndex(
        (entry) => entry.kind === "local" && entry.workspacePath === activePath,
      );
      merged.lastActiveTabIndex = Math.max(mergedIndex, 0);
    }
  }
  if (patch.recentProjects !== undefined) {
    const rawRecent = Array.isArray(raw.recentProjects) ? raw.recentProjects : [];
    const preservedForeign = rawRecent.filter((path) => !isWorkspacePathInScope(path, scopePath));
    merged.recentProjects = [...patch.recentProjects, ...preservedForeign].slice(0, 10);
  }
  return merged;
}

/**
 * Wrap the raw RPC setting service so the web UI only ever sees (and writes)
 * its own instance's workspace session. No scope passthrough happens in the
 * caller: web always boots with exactly one workspace or opts out of session
 * restore entirely.
 */
export function createWorkspaceScopedSettingService(
  inner: SettingServiceLike,
  scopePath: string,
  activePath?: string,
): SettingServiceLike {
  return {
    async get() {
      return scopeSettingsForRestore(await inner.get(), scopePath, activePath);
    },
    async update(patch, expectedAccountSettings) {
      const raw = await inner.get();
      await inner.update(mergeScopedWorkspaceSessionPatch(raw, patch, scopePath), expectedAccountSettings);
    },
    updateDataBaseDir(newDir) {
      return inner.updateDataBaseDir(newDir);
    },
    ensureDefaultProject(homedir) {
      return inner.ensureDefaultProject(homedir);
    },
  };
}

/**
 * Override `settingService` on the service accessor for the web UI without
 * rebuilding the ~40-field interface: lookups fall through to the original
 * accessor, only the overridden service is shadowed.
 */
export function withWorkspaceScopedSettings<ServicesT extends object>(
  services: ServicesT & { settingService: SettingServiceLike },
  scopePath: string | undefined,
  activePath?: string,
): ServicesT {
  if (!scopePath) {
    return services;
  }
  const scoped = Object.create(services) as ServicesT & { settingService: SettingServiceLike };
  Object.defineProperty(scoped, "settingService", {
    value: createWorkspaceScopedSettingService(services.settingService, scopePath, activePath),
    enumerable: true,
  });
  return scoped;
}
