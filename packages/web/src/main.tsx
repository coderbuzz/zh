/* eslint-disable max-lines -- Web 入口集中编排启动、路由与 workspace shell wiring，与 Root.tsx 同样先保持入口收口，避免跨层状态拆散。 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  playTaskNotificationSound,
  setStreamClientId,
  type Theme,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { ReconnectingWebChannel } from "@zcode/client";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { withWorkspaceScopedSettings } from "./workspaceScopedSettings.js";
import {
  CONVERSATION_WS,
  formatSessionHash,
  parseSessionHash,
  writeSessionHash,
} from "./sessionUrl.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import { setConnectionIndicator } from "./connectionIndicator.js";
import { coverForRemount } from "./reconnectCover.js";
import type { IPlatformService, RemoteTarget, ServerRemoteInfo } from "@zcode/shared";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "./webThemeSeed.js";
import { setupMobileShell } from "./mobileShell.js";
import { setupOfferBanner } from "./offerBanner.js";

function resolveWebThemePreference(defaultTheme: Theme = WEB_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const saved = resolveWebThemePreference(
    isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
  );
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();

// Drawer/scrim behavior for phones; a no-op on wide viewports.
setupMobileShell();

// Manual-claim free offer check: runs on every page load (browser refresh
// included); a no-op without a claimable offer or on share/callback pages.
setupOfferBanner();

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  allowOpenWorkspace?: boolean;
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "zh - Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/");
      }}
    />,
  );
}

async function renderConversationSharePage(): Promise<void> {
  // 页面语言跟随路径前缀：/cn/share 中文，裸 /share 英文。
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
  document.documentElement.lang = routeLocale;
  // 分享页必须设置 title：否则浏览器标签只显示 index.html 的通用标题。
  // 会话标题要等 preview 加载完，先给一个语言正确的兜底。
  document.title = routeLocale === "zh-CN" ? "zh 会话分享" : "zh Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // Share 加载失败不能只有通用 network 文案：需要区分 mock、endpoint 配置或跨域 fetch。
  // 这里只记录运行时路由与 endpoint，不记录完整 pathname，避免把 share code 写入日志。
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        webAuthService.startLogin({
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG),
        });
      }}
      onLogout={onLogout}
      locale={routeLocale}
      theme={resolveWebThemePreference("zai-light")}
    />,
  );
}

function createWebPlatform(sessionScopePath?: string): IPlatformService {
  return {
    canSelectFilePath: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
    // 远程 WebSocket 只暴露部分 service，与 Root/RemoteServiceAccess 需要的完整
    // accessor 不匹配，直接打开 ?remote=<id> 会在项目向导或首屏卡住。
    connectRemote(options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      });
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: async () => {},
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    // Mirror the open session into the URL hash (sessionUrl.ts) so a refresh
    // or reconnect reopens it. No tab yet = boot transient; leave the URL be.
    syncActiveWorkspaceTask: (workspacePath, taskId, workspacePurpose) => {
      if (!sessionScopePath || !workspacePath) {
        return;
      }
      const hash = formatSessionHash(sessionScopePath, workspacePath, taskId, workspacePurpose);
      if (hash !== null) {
        writeSessionHash(hash);
      }
    },
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}

function WebBootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {/^zh\b/i.test(navigator.language) ? "Web 启动失败" : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {/^zh\b/i.test(navigator.language) ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = "zh - Web";
  root.render(
    <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />,
  );
}

// Full page reloads are reserved for the auth wall (reloadForAuthFailure). A
// failed boot connect must not reload: on phones the tab that just came back
// from the background is exactly the case where the boot WebSocket races the
// still-waking network stack, so an auto reload would only stack full page
// reloads (and discards already look like one) while the channel below is
// perfectly capable of retrying at the WebSocket level.

// Sign-in walls (an expired Cloudflare Access session answers the WebSocket
// upgrade with a redirect instead of 101) make retrying pointless: reload so
// the browser performs the login dance and lands back on the app. Budgeted
// like the bootstrap reload so a misconfigured wall cannot loop forever.
const AUTH_RELOAD_GUARD_KEY = "zh:ws-auth-reloads";
const AUTH_RELOAD_BUDGET = 3;
const AUTH_RELOAD_WINDOW_MS = 60_000;

function reloadForAuthFailure(): boolean {
  try {
    const now = Date.now();
    const raw = window.sessionStorage.getItem(AUTH_RELOAD_GUARD_KEY);
    const state = raw ? (JSON.parse(raw) as { count: number; startedAt: number }) : null;
    const active = state && now - state.startedAt <= AUTH_RELOAD_WINDOW_MS ? state : null;
    const count = active?.count ?? 0;
    if (count >= AUTH_RELOAD_BUDGET) {
      return false;
    }
    window.sessionStorage.setItem(
      AUTH_RELOAD_GUARD_KEY,
      JSON.stringify({ count: count + 1, startedAt: active?.startedAt ?? now }),
    );
  } catch {
    // Without sessionStorage the budget cannot persist across the reload;
    // reloading anyway is still better than a stuck reconnect pill.
  }
  setConnectionIndicator("authExpired");
  window.location.reload();
  return true;
}

// Set right before a reconnect re-render so the patched
// isRendererReloadNavigation (ui-patches) treats the fresh Root mount like a
// renderer reload: the pane-session restore reselects the active session and
// its conversation resubscribes, instead of dropping the user on a draft.
declare global {
  interface Window {
    __zhWebReconnectRestore?: boolean;
  }
}

// Marks this tab as having had the app open. sessionStorage survives reloads
// and Chrome Android's tab-discard restores within the same tab, so the
// pane-session restore can treat a restored tab like a renderer reload even
// when the navigation entry type is "navigate" (what Chrome reports after a
// discard and after the Cloudflare Access redirect chain). The value is the
// marker timestamp; the restore gate in @zcode/ui accepts it while it is
// fresh (12 h — keep in sync with ui-patches/web-soft-reload-restore.patch).
// A genuinely new tab starts with empty sessionStorage and still opens a
// draft. Refreshed on foreground events so a long-lived tab never ages out.
const WEB_TAB_LIVE_KEY = "zh:web-tab-live";

function markWebTabLive(): void {
  try {
    window.sessionStorage.setItem(WEB_TAB_LIVE_KEY, String(Date.now()));
  } catch {
    // Restore then falls back to navigation-type detection without the marker.
  }
}

function WebConnectingScreen({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);
  const isZhLocale = /^zh\b/i.test(navigator.language);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            <h1 className="text-ui-xs font-medium">
              {isZhLocale ? "正在连接 zh 服务器…" : "Connecting to the zh server…"}
            </h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">
            {isZhLocale
              ? "连接会在 WebSocket 通道上自动重试。"
              : "The connection keeps retrying on the WebSocket channel."}
          </p>
          {slow ? (
            <>
              <p className="mt-1 text-ui-xs/relaxed text-foreground-subtle">
                {isZhLocale
                  ? "仍然失败 — zh 服务器可能暂时不可用。"
                  : "Still failing — the zh server may be down."}
              </p>
              <button
                type="button"
                className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
                onClick={onRetry}
              >
                {isZhLocale ? "重试" : "Retry"}
              </button>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function renderWebConnectingScreen(onRetry: () => void): void {
  document.title = "zh - Web";
  root.render(<WebConnectingScreen onRetry={onRetry} />);
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  // The channel owns the WebSocket for the whole page lifetime: dead-socket
  // detection, fail-fast RPC, backoff reconnect, and the auth-expired reload.
  // Every successful connection renders a fresh Root keyed by generation, so
  // a reconnect re-subscribes everything from the new service stack (the
  // pane-session restore brings the active conversation back).
  markWebTabLive();
  let mountGeneration = 0;
  let firstConnectSettled = false;
  const channel = new ReconnectingWebChannel({
    wsUrl: bootstrap.wsUrl,
    probeUrl: `${window.location.origin}/api/server-info`,
    onStateChange: (state) => {
      if (state === "connected") {
        setConnectionIndicator("hidden");
        return;
      }
      setConnectionIndicator("reconnecting");
      if (!firstConnectSettled) {
        // Boot connect failed: keep retrying at the channel level over a
        // neutral connecting card (manual retry = channel poke, no reload).
        renderWebConnectingScreen(() => channel.poke());
      }
    },
    onConnected: async (services) => {
      const isReconnect = firstConnectSettled;
      firstConnectSettled = true;
      const scopePath = bootstrap.initialWorkspaceAbsPath;
      const platform = createWebPlatform(scopePath);
      // Read on every mount: a reconnect reopens whatever the user has open
      // now, not what the page was first loaded with.
      // The Tasks workspace lives outside the scope; its path comes from the
      // persisted session (the settings entry with purpose "conversation").
      let conversationPath: string | undefined;
      if (scopePath && window.location.hash.includes(CONVERSATION_WS)) {
        try {
          const saved = (await services.settingService.get()).lastWorkspaceSession ?? [];
          conversationPath = saved.find(
            (entry) => entry.kind === "local" && entry.workspacePurpose === "conversation",
          )?.workspacePath;
        } catch {
          // Unreadable settings: fall through to the plain server workspace.
        }
      }
      const urlTarget = scopePath
        ? parseSessionHash(window.location.hash, scopePath, conversationPath)
        : null;
      const initialWorkspaceAbsPath = urlTarget?.workspacePath ?? scopePath;
      document.title = "zh - Web + Server";
      setConnectionIndicator("hidden");

      mountGeneration += 1;
      if (isReconnect) {
        window.__zhWebReconnectRestore = true;
        coverForRemount(document.getElementById("root")!);
      }
      // The web UI gets a workspace-scoped view of the shared settings file
      // (see workspaceScopedSettings.ts): session restore only ever sees this
      // instance's workspace tabs, with the bootstrapped workspace (the URL's
      // session, else the server workspace) as the active tab — so the shell
      // that consumes the one-shot pane-session restore is always the
      // bootstrapped one (the v0.5.10 regression), while every
      // previously opened project still comes back after a refresh (the
      // v0.5.11 regression, caused by disabling restore altogether).
      const scopedServices = withWorkspaceScopedSettings(
        services,
        scopePath,
        initialWorkspaceAbsPath,
      );
      root.render(
        <AppErrorBoundary key={`mount-${mountGeneration}`}>
          <ZCodeIntlProvider
            key={`mount-${mountGeneration}`}
            settingService={scopedServices.settingService}
            broadcastService={scopedServices.broadcastService}
          >
            <Root
              services={scopedServices}
              platform={platform}
              initialWorkspaceAbsPath={initialWorkspaceAbsPath}
              initialWorkspaceIdentity={
                initialWorkspaceAbsPath === scopePath ? bootstrap.initialWorkspaceIdentity : undefined
              }
              initialWorkspacePurpose={
                urlTarget && urlTarget.workspacePath === conversationPath ? "conversation" : undefined
              }
              initialTaskId={urlTarget?.taskId}
              // Without a bootstrapped workspace (remote/attach mode) there is
              // no scope to restore into; keep restore off there.
              restoreSession={Boolean(scopePath)}
              allowOpenWorkspace={bootstrap.allowOpenWorkspace}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </ZCodeIntlProvider>
        </AppErrorBoundary>,
      );
      if (isReconnect) {
        // The restore consumers read the flag on their first mount, which
        // happens within this render commit; clear it so nothing later in
        // the app's lifetime mistakes itself for a reload.
        window.setTimeout(() => {
          delete window.__zhWebReconnectRestore;
        }, 5_000);
      }
    },
    onAuthExpired: () => {
      channel.dispose();
      if (!reloadForAuthFailure()) {
        setConnectionIndicator("authRequired");
      }
    },
  });
  channel.start();

  // Wake the channel up the moment the environment changes instead of
  // waiting out the backoff: tab returns to the foreground (also the moment
  // mobile browsers unfreeze their socket), network comes back, or the page
  // is restored from the back/forward cache.
  const pokeChannel = () => {
    markWebTabLive();
    channel.poke();
  };
  window.addEventListener("online", pokeChannel);
  window.addEventListener("pageshow", pokeChannel);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      pokeChannel();
    }
  });
}

void bootstrapWebApp();
