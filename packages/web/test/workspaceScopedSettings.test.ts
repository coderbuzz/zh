import { describe, expect, test } from "bun:test";
import type { AppSettings, PersistedWorkspaceSessionEntry } from "@zcode/shared";
import {
  createWorkspaceScopedSettingService,
  isWorkspacePathInScope,
  mergeScopedWorkspaceSessionPatch,
  scopeSettingsForRestore,
} from "../src/workspaceScopedSettings.js";

const SCOPE = "/tmp/zh-tab-workspace";

function localEntry(path: string): PersistedWorkspaceSessionEntry {
  return { kind: "local", workspacePath: path, workspacePurpose: "project" };
}

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    recentProjects: [],
    locale: "en",
    ...overrides,
  } as AppSettings;
}

describe("isWorkspacePathInScope", () => {
  test("exact root and nested paths are in scope", () => {
    expect(isWorkspacePathInScope(SCOPE, SCOPE)).toBe(true);
    expect(isWorkspacePathInScope(`${SCOPE}/nalar`, SCOPE)).toBe(true);
    expect(isWorkspacePathInScope(`${SCOPE}/nalar/deep/dir`, SCOPE)).toBe(true);
  });

  test("sibling prefixes and unrelated paths are out of scope", () => {
    // The classic prefix trap: another directory that merely starts with the
    // same text must not match.
    expect(isWorkspacePathInScope(`${SCOPE}2`, SCOPE)).toBe(false);
    expect(isWorkspacePathInScope(`${SCOPE}-other/dir`, SCOPE)).toBe(false);
    expect(isWorkspacePathInScope("/home/ubuntu/workspace", SCOPE)).toBe(false);
    expect(isWorkspacePathInScope("/", SCOPE)).toBe(false);
  });
});

describe("scopeSettingsForRestore", () => {
  test("keeps in-scope tabs in their original order, drops foreign and remote entries", () => {
    const scoped = scopeSettingsForRestore(
      baseSettings({
        lastWorkspaceSession: [
          localEntry(`${SCOPE}/nalar`),
          localEntry("/home/ubuntu/workspace/nalar"),
          localEntry(SCOPE),
          {
            kind: "remote",
            workspacePath: "/remote/path",
            target: {} as never,
            lastOpenedAt: 0,
            lastConnectionStatus: "connected",
          },
          localEntry(`${SCOPE}/zh`),
        ],
        lastActiveTabIndex: 4,
      }),
      SCOPE,
    );
    expect(scoped.lastWorkspaceSession?.map((entry) => entry.workspacePath)).toEqual([
      `${SCOPE}/nalar`,
      SCOPE,
      `${SCOPE}/zh`,
    ]);
  });

  test("forces the server workspace to be the restored active tab", () => {
    const scoped = scopeSettingsForRestore(
      baseSettings({
        lastWorkspaceSession: [localEntry(`${SCOPE}/nalar`), localEntry(SCOPE)],
        lastActiveTabIndex: 1,
      }),
      SCOPE,
    );
    expect(scoped.lastActiveTabIndex).toBe(1);
    expect(scoped.lastWorkspaceSession?.[scoped.lastActiveTabIndex]?.workspacePath).toBe(SCOPE);

    const foreignActive = scopeSettingsForRestore(
      baseSettings({
        lastWorkspaceSession: [localEntry(`${SCOPE}/nalar`), localEntry(SCOPE)],
        lastActiveTabIndex: 0,
      }),
      SCOPE,
    );
    expect(foreignActive.lastActiveTabIndex).toBe(1);
  });

  test("activates the URL's workspace instead when it is a restored tab", () => {
    const settings = baseSettings({
      lastWorkspaceSession: [localEntry(SCOPE), localEntry(`${SCOPE}/nalar`)],
      lastActiveTabIndex: 0,
    });
    expect(scopeSettingsForRestore(settings, SCOPE, `${SCOPE}/nalar`).lastActiveTabIndex).toBe(1);
    // Not restored (the bootstrap addTab opens it): fall back to the root.
    expect(scopeSettingsForRestore(settings, SCOPE, `${SCOPE}/zh`).lastActiveTabIndex).toBe(0);
  });

  test("prepends the scope root when the persisted session lacks it", () => {
    const scoped = scopeSettingsForRestore(
      baseSettings({
        lastWorkspaceSession: [localEntry(`${SCOPE}/nalar`)],
        lastActiveTabIndex: 0,
      }),
      SCOPE,
    );
    expect(scoped.lastWorkspaceSession?.[0]).toEqual({
      kind: "local",
      workspacePath: SCOPE,
      workspacePurpose: "project",
    });
    expect(scoped.lastActiveTabIndex).toBe(0);
  });

  test("handles empty and missing session state", () => {
    const empty = scopeSettingsForRestore(baseSettings(), SCOPE);
    expect(empty.lastWorkspaceSession).toEqual([
      { kind: "local", workspacePath: SCOPE, workspacePurpose: "project" },
    ]);
    expect(empty.lastActiveTabIndex).toBe(0);
    expect(empty.recentProjects).toEqual([]);
  });

  test("filters recentProjects to the scope and preserves unrelated settings", () => {
    const scoped = scopeSettingsForRestore(
      baseSettings({
        recentProjects: [`${SCOPE}/zh`, "/home/ubuntu/workspace/nalar", `${SCOPE}2`],
        locale: "id",
      }),
      SCOPE,
    );
    expect(scoped.recentProjects).toEqual([`${SCOPE}/zh`]);
    expect(scoped.locale).toBe("id");
  });
});

describe("mergeScopedWorkspaceSessionPatch", () => {
  const RAW = baseSettings({
    lastWorkspaceSession: [
      localEntry(`${SCOPE}/nalar`),
      localEntry(SCOPE),
      localEntry("/home/ubuntu/workspace/zh"),
      {
        kind: "remote",
        workspacePath: "/remote/path",
        target: {} as never,
        lastOpenedAt: 0,
        lastConnectionStatus: "connected",
      },
    ],
    recentProjects: [`${SCOPE}/zh`, "/home/ubuntu/workspace/nalar"],
  });

  test("preserves foreign and remote entries while the scoped list is rewritten", () => {
    const merged = mergeScopedWorkspaceSessionPatch(
      RAW,
      {
        lastWorkspaceSession: [localEntry(SCOPE)],
        lastActiveTabIndex: 0,
      },
      SCOPE,
    );
    expect(merged.lastWorkspaceSession?.map((entry) => entry.workspacePath)).toEqual([
      SCOPE,
      "/home/ubuntu/workspace/zh",
      "/remote/path",
    ]);
  });

  test("maps the UI-relative active index into the merged list", () => {
    const merged = mergeScopedWorkspaceSessionPatch(
      RAW,
      {
        lastWorkspaceSession: [localEntry(`${SCOPE}/nalar`), localEntry(SCOPE)],
        lastActiveTabIndex: 0,
      },
      SCOPE,
    );
    expect(merged.lastActiveTabIndex).toBe(0);
    expect(merged.lastWorkspaceSession?.[merged.lastActiveTabIndex ?? 0]?.workspacePath).toBe(
      `${SCOPE}/nalar`,
    );
  });

  test("a closed in-scope tab stays closed; out-of-scope recentProjects survive", () => {
    const merged = mergeScopedWorkspaceSessionPatch(
      RAW,
      {
        lastWorkspaceSession: [localEntry(SCOPE)],
        lastActiveTabIndex: 0,
        recentProjects: [SCOPE],
      },
      SCOPE,
    );
    expect(
      merged.lastWorkspaceSession?.some((entry) => entry.workspacePath === `${SCOPE}/nalar`),
    ).toBe(false);
    expect(merged.recentProjects).toEqual([SCOPE, "/home/ubuntu/workspace/nalar"]);
  });

  test("caps merged recentProjects at 10 entries", () => {
    const raw = baseSettings({
      recentProjects: ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"],
      lastWorkspaceSession: [],
    });
    const merged = mergeScopedWorkspaceSessionPatch(
      raw,
      { recentProjects: [`/x/1`, `/x/2`, `/x/3`] },
      "/x",
    );
    expect(merged.recentProjects).toHaveLength(10);
    expect(merged.recentProjects?.slice(0, 3)).toEqual(["/x/1", "/x/2", "/x/3"]);
  });

  test("leaves unrelated patch keys untouched", () => {
    const merged = mergeScopedWorkspaceSessionPatch(RAW, { locale: "id" }, SCOPE);
    expect(merged.locale).toBe("id");
    expect(merged.lastWorkspaceSession).toBeUndefined();
    expect(merged.recentProjects).toBeUndefined();
  });
});

describe("createWorkspaceScopedSettingService", () => {
  test("get() returns the scoped view; update() merges into the raw snapshot", async () => {
    const raw = baseSettings({
      lastWorkspaceSession: [localEntry(SCOPE), localEntry("/home/ubuntu/workspace/zh")],
      recentProjects: [],
    });
    const updates: Partial<AppSettings>[] = [];
    const inner = {
      get: async () => raw,
      update: async (patch: Partial<AppSettings>) => {
        updates.push(patch);
      },
      updateDataBaseDir: async () => {},
      ensureDefaultProject: async () => ({ path: "/default", created: false }),
    };
    const service = createWorkspaceScopedSettingService(inner, SCOPE);

    const view = await service.get();
    expect(view.lastWorkspaceSession?.map((entry) => entry.workspacePath)).toEqual([SCOPE]);

    await service.update({
      lastWorkspaceSession: [localEntry(SCOPE), localEntry(`${SCOPE}/nalar`)],
      lastActiveTabIndex: 1,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].lastWorkspaceSession?.map((entry) => entry.workspacePath)).toEqual([
      SCOPE,
      `${SCOPE}/nalar`,
      "/home/ubuntu/workspace/zh",
    ]);
    // UI active index 1 (scope root, second in the UI list) resolves to its
    // position in the merged list.
    expect(updates[0].lastActiveTabIndex).toBe(1);
  });

  test("updateDataBaseDir and ensureDefaultProject delegate unchanged", async () => {
    let dirArg: string | undefined = "sentinel";
    const inner = {
      get: async () => baseSettings(),
      update: async () => {},
      updateDataBaseDir: async (newDir: string | undefined) => {
        dirArg = newDir;
      },
      ensureDefaultProject: async () => ({ path: "/default", created: true }),
    };
    const service = createWorkspaceScopedSettingService(inner, SCOPE);
    await service.updateDataBaseDir(undefined);
    expect(dirArg).toBeUndefined();
    await expect(service.ensureDefaultProject("/home/x")).resolves.toEqual({
      path: "/default",
      created: true,
    });
  });
});

describe("conversation workspace (Tasks section)", () => {
  const CONV = "/home/ubuntu/.zcode/workspace/default";
  const convEntry = (): PersistedWorkspaceSessionEntry => ({
    kind: "local",
    workspacePath: CONV,
    workspacePurpose: "conversation",
  });

  test("the scoped view keeps the conversation tab (deduped)", () => {
    const scoped = scopeSettingsForRestore(
      baseSettings({ lastWorkspaceSession: [convEntry(), localEntry(SCOPE), convEntry()] }),
      SCOPE,
    );
    expect(scoped.lastWorkspaceSession?.map((e) => (e as { workspacePath: string }).workspacePath)).toEqual([
      CONV,
      SCOPE,
    ]);
    expect(scoped.lastWorkspaceSession?.[scoped.lastActiveTabIndex]).toMatchObject({ workspacePath: SCOPE });
  });

  test("writes do not stack copies of the conversation entry", () => {
    const raw = baseSettings({ lastWorkspaceSession: [convEntry(), convEntry(), localEntry(SCOPE)] });
    const merged = mergeScopedWorkspaceSessionPatch(
      raw,
      { lastWorkspaceSession: [convEntry(), localEntry(SCOPE)], lastActiveTabIndex: 1 },
      SCOPE,
    );
    const paths = merged.lastWorkspaceSession?.map((e) => (e as { workspacePath: string }).workspacePath);
    expect(paths).toEqual([CONV, SCOPE]);
    expect(merged.lastActiveTabIndex).toBe(1);
  });
});
