// Manual-claim free offer banner for zh web mode, layered onto the shell DOM
// the same way mobileShell is (no upstream React changes). On every page load
// (browser refresh included) it asks the zh server for claimable free plans —
// GET /api/coding-plan/manual-claim/previews, backed by the desktop app's
// zcode-plan billing preview API — and renders a Claim banner when one exists.
// Claiming goes through POST /api/coding-plan/manual-claim/claim; the server
// adds the captcha/app-version/platform headers, the browser only supplies the
// Aliyun captchaVerifyParam when the server-side captcha config asks for it.
// Everything here is best-effort: failures log and stay silent so the banner
// can never block the app.
import "./offerBanner.css";
import { isConversationSharePath } from "./share/conversationShareRoute.js";

// Mirrors of the server payloads; kept local because the CI web build
// resolves @zcode/shared from the upstream checkout, which has no
// manual-claim types.
interface ManualClaimPlanEntitlement {
  showName: string;
  grantUnits: number;
  unitType: string;
}

interface ManualClaimPlanPreview {
  planId: string;
  name: string;
  description: string;
  entitlements: ManualClaimPlanEntitlement[];
}

interface ManualClaimPlanPreviewsResponse {
  plans: ManualClaimPlanPreview[];
}

interface ZCodeCaptchaConfig {
  region?: string;
  prefix?: string;
  sceneId?: string;
  mode?: string;
  enabled?: boolean;
  skipModelRequest?: boolean;
}

interface ManualClaimPlanClaimResult {
  success: boolean;
  code: number;
  message: string;
  plan?: { name?: string; status?: string };
}

// Aliyun captcha 2.0 (script below exposes window.initAliyunCaptcha), bound to
// the Claim button in popup mode; captchaVerifyParam comes back through
// captchaVerifyCallback and is validated server-side during the claim POST.
const ALIYUN_CAPTCHA_SCRIPT_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
// Terminal claim failures (already claimed, offer ended, ...): retrying from
// the banner cannot succeed, so the error closes the banner instead.
// 1001-1004 end the offer for this account (missing/unavailable/claimed/
// ineligible). 1005 is quota exhaustion — the offer returns when the server
// quota resets (failureEndsAt), so the banner must stay.
const TERMINAL_CLAIM_CODES = new Set([1001, 1002, 1003, 1004]);
const QUOTA_EXHAUSTED_CODE = 1005;
// v2: v1 stored 1005 dismissals permanently, hiding the banner after a quota
// reset; the new key drops those stale entries.
const DISMISS_STORAGE_KEY = "zh:manual-claim-dismissed-plans-v2";
// Docking anchors from the upstream shell: the sidebar footer holds the
// account/avatar row (data-testid="login-trigger"), and the offer card docks
// right above it, mirroring the desktop app layout.
const SIDEBAR_PANEL_SELECTOR = '[data-workspace-sidebar-panel="true"]';
const SIDEBAR_FOOTER_SELECTOR = `${SIDEBAR_PANEL_SELECTOR} footer`;
const LOGIN_TRIGGER_SELECTOR = '[data-testid="login-trigger"]';

interface AliyunCaptchaInstance {
  destroy?: () => void;
}

interface AliyunCaptchaInitOptions {
  SceneId: string;
  prefix: string;
  mode: string;
  element: string;
  button: string;
  language?: string;
  captchaVerifyCallback: (
    captchaVerifyParam: string,
  ) => Promise<{ captchaResult: boolean }>;
  getInstance: (instance: AliyunCaptchaInstance) => void;
}

declare global {
  interface Window {
    initAliyunCaptcha?: (options: AliyunCaptchaInitOptions) => AliyunCaptchaInstance;
    AliyunCaptchaConfig?: { region: string; prefix: string };
  }
}

let aliyunCaptchaScriptPromise: Promise<void> | null = null;
// Only one claim dialog (and therefore one SDK instance) exists at a time;
// tracked so closing or reopening the dialog destroys the old binding.
let activeCaptchaInstance: AliyunCaptchaInstance | null = null;

function loadAliyunCaptchaScript(config: { region: string; prefix: string }): Promise<void> {
  aliyunCaptchaScriptPromise ??= new Promise((resolvePromise, rejectPromise) => {
    if (typeof window.initAliyunCaptcha === "function") {
      resolvePromise();
      return;
    }
    // AliyunCaptcha.js reads its regional endpoint from this global at load
    // time (the desktop app sets it the same way before injecting the
    // script); a param issued against the wrong region never passes the
    // server-side verification.
    window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
    const script = document.createElement("script");
    script.src = ALIYUN_CAPTCHA_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => resolvePromise(), { once: true });
    script.addEventListener(
      "error",
      () => {
        script.remove();
        aliyunCaptchaScriptPromise = null;
        rejectPromise(new Error("Failed to load captcha script."));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
  return aliyunCaptchaScriptPromise;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    ...init,
  });
  if (!response.ok) {
    // Error bodies carry the server-side reason ({error}: the provider's
    // message); showing it beats a bare "responded 502".
    let reason: string | null = null;
    try {
      const body = (await response.json()) as { error?: unknown };
      reason = typeof body.error === "string" ? body.error : null;
    } catch {
      // Non-JSON error body; fall through to the status-only message.
    }
    throw new Error(reason || `${url} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

function readDismissedPlans(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function persistDismissedPlans(planIds: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify([...planIds]));
  } catch {
    // Storage can be unavailable (private mode); dismissal just won't persist.
  }
}

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function formatGrantUnits(value: number): string {
  return new Intl.NumberFormat(isZhLocale() ? "zh-CN" : "en-US").format(value);
}

type UsableCaptchaConfig = ZCodeCaptchaConfig & {
  region: string;
  prefix: string;
  sceneId: string;
};

// Claim captcha gate mirrors the desktop renderer's Nnn: unlike the model
// request path (Lnn), the claim path ignores enabled/skipModelRequest and
// runs the captcha whenever a config with region+prefix+sceneId exists. The
// SDK resolves traceless (no UI) when the risk engine passes the request.
function usableCaptchaConfig(config: ZCodeCaptchaConfig | null): config is UsableCaptchaConfig {
  return Boolean(config?.region?.trim() && config.prefix?.trim() && config.sceneId?.trim());
}

export function setupOfferBanner(): void {
  if (typeof window === "undefined") {
    return;
  }
  // Share landing and OAuth callback pages render instead of the app shell;
  // the offer banner only belongs to the app itself.
  if (isConversationSharePath(window.location.pathname)) {
    return;
  }
  void refreshOfferBanner();
}

async function refreshOfferBanner(): Promise<void> {
  let previews: ManualClaimPlanPreviewsResponse;
  try {
    previews = await fetchJson<ManualClaimPlanPreviewsResponse>(
      "/api/coding-plan/manual-claim/previews",
    );
  } catch (error) {
    console.info("[zh-offer] preview check skipped", error);
    return;
  }
  const plan = previews.plans?.find(
    (candidate) => candidate.planId && !readDismissedPlans().has(candidate.planId),
  );
  if (plan) {
    renderBanner(plan);
  }
}

function renderBanner(plan: ManualClaimPlanPreview): void {
  document.getElementById("zh-offer-banner")?.remove();
  const isZh = isZhLocale();
  const entitlement = plan.entitlements?.[0];
  const banner = document.createElement("aside");
  banner.id = "zh-offer-banner";
  banner.className = "zh-offer-banner";
  banner.innerHTML = `
    <div class="zh-offer-brand-row">
      <span class="zh-offer-badge">Z</span>
      <span class="zh-offer-title">ZCODE</span>
      <button type="button" class="zh-offer-close" aria-label="${isZh ? "Tutup" : "Close"}">×</button>
    </div>
    <div class="zh-offer-tokens">
      ${entitlement ? formatGrantUnits(entitlement.grantUnits) : ""}
      ${entitlement ? `<span class="zh-offer-token-unit">${escapeHtml(entitlement.unitType || (isZh ? "token" : "tokens"))}</span>` : ""}
    </div>
    <div class="zh-offer-subtitle">${escapeHtml(entitlement?.showName || plan.description || plan.name)}</div>
    <div class="zh-offer-actions">
      <button type="button" class="zh-offer-claim-button" id="zh-offer-claim-button">
        ${isZh ? "Klaim" : "Claim"}
      </button>
    </div>
    <div class="zh-offer-error" hidden></div>
  `;
  banner.querySelector(".zh-offer-close")?.addEventListener("click", () => {
    dismissPlan(plan.planId);
    closeOfferBanner();
  });
  mountOfferBanner(banner);
  banner
    .querySelector<HTMLButtonElement>("#zh-offer-claim-button")
    ?.addEventListener("click", () => {
      openClaimDialog(plan);
    });
}

/**
 * Placement follows the shell, which mounts asynchronously (websocket boot can
 * take a while): the banner starts floating so it is always visible, and one
 * persistent observer moves it into the sidebar footer — right above the
 * account/avatar row, the desktop-app placement — as soon as that footer
 * exists. The same loop re-docks after a React re-render drops the foreign
 * node and re-floats it if the sidebar goes away, so placement is eventually
 * correct on every page load with no deadline.
 */
let offerClosed = false;
let offerPlacementObserver: MutationObserver | null = null;

function mountOfferBanner(banner: HTMLElement): void {
  offerClosed = false;
  offerPlacementObserver?.disconnect();
  const ensurePlacement = (): void => {
    if (offerClosed) {
      return;
    }
    const footer = Array.from(document.querySelectorAll<HTMLElement>(SIDEBAR_FOOTER_SELECTOR)).find(
      (candidate) => candidate.querySelector(LOGIN_TRIGGER_SELECTOR),
    );
    const inFooter = footer ? footer.contains(banner) : false;
    if (footer && !inFooter) {
      banner.classList.add("zh-offer-docked");
      // First child of the footer = directly above the avatar row.
      footer.insertBefore(banner, footer.firstChild);
      return;
    }
    if (!footer && !banner.isConnected) {
      banner.classList.remove("zh-offer-docked");
      document.body.appendChild(banner);
    }
  };
  // Visible immediately, then the observer corrects the placement as the
  // shell mounts and re-renders.
  ensurePlacement();
  offerPlacementObserver = new MutationObserver(ensurePlacement);
  offerPlacementObserver.observe(document.documentElement, { subtree: true, childList: true });
}

function closeOfferBanner(): void {
  offerClosed = true;
  offerPlacementObserver?.disconnect();
  offerPlacementObserver = null;
  document.getElementById("zh-offer-banner")?.remove();
}

/**
 * The desktop app claims from a dialog too, and the Aliyun SDK needs a stable
 * button to bind its popup challenge to: the dialog's Claim button is that
 * anchor, so the banner button only opens this dialog. The captcha is bound
 * while the dialog opens — the SDK fires from clicks on that button, so the
 * binding must exist before the first Claim click, and the button must stay
 * clickable or the challenge can never trigger.
 */
function openClaimDialog(plan: ManualClaimPlanPreview): void {
  // A previous dialog's captcha instance would hold the recycled element ids;
  // destroy it and clear the container the way the desktop's controller
  // reset does before a fresh init.
  activeCaptchaInstance?.destroy?.();
  activeCaptchaInstance = null;
  document.querySelector(".zh-offer-dialog")?.remove();
  const isZh = isZhLocale();
  const entitlement = plan.entitlements?.[0];
  const dialog = document.createElement("div");
  dialog.className = "zh-offer-dialog";
  dialog.innerHTML = `
    <div class="zh-offer-dialog-card" role="dialog" aria-modal="true">
      <div class="zh-offer-dialog-title">${escapeHtml(plan.name)}</div>
      <div class="zh-offer-dialog-body">
        ${entitlement ? `<strong>${formatGrantUnits(entitlement.grantUnits)}</strong> ${escapeHtml(entitlement.unitType || (isZh ? "token" : "tokens"))}<br />` : ""}
        ${escapeHtml(plan.description || entitlement?.showName || "")}
      </div>
      <div class="zh-offer-error" hidden></div>
      <div id="zh-offer-captcha-element"></div>
      <div class="zh-offer-dialog-actions">
        <button type="button" data-zh-offer-cancel>${isZh ? "Batal" : "Cancel"}</button>
        <button type="button" id="zh-offer-dialog-claim-button">${isZh ? "Klaim" : "Claim"}</button>
      </div>
    </div>
  `;
  const closeDialog = () => {
    activeCaptchaInstance?.destroy?.();
    activeCaptchaInstance = null;
    dialog.remove();
  };
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });
  dialog.querySelector("[data-zh-offer-cancel]")?.addEventListener("click", closeDialog);
  document.body.appendChild(dialog);
  const claimButton = dialog.querySelector<HTMLButtonElement>("#zh-offer-dialog-claim-button");
  if (!claimButton) {
    return;
  }
  // "bound" means the SDK owns the button: its own click listener shows the
  // challenge (or passes traceless) and runs the claim through
  // captchaVerifyCallback — this handler must then stay out of the way.
  let captchaState: "preparing" | "bound" | "unusable" | "failed" = "preparing";
  const errorRow = dialog.querySelector<HTMLElement>(".zh-offer-error");
  const showError = (message: string) => {
    if (errorRow) {
      errorRow.textContent = message;
      errorRow.hidden = false;
    }
  };
  claimButton.addEventListener("click", () => {
    // While preparing there is nothing to show yet; once bound the SDK's own
    // button listener runs the challenge and this handler stays out of the
    // way. Only the dead-end states explain themselves on click.
    if (captchaState === "bound" || captchaState === "preparing") {
      return;
    }
    showError(
      captchaState === "unusable"
        ? isZhLocale()
          ? "Verifikasi captcha gagal, silakan coba lagi."
          : "Captcha verification failed. Please try again."
        : isZhLocale()
          ? "Verifikasi captcha tidak tersedia, coba lagi nanti."
          : "Captcha verification is unavailable, try again later.",
    );
  });
  void prepareClaimCaptcha(claimButton, plan).then((state) => {
    captchaState = state;
    if (state === "failed") {
      console.warn("[zh-offer] captcha prepare failed");
    }
  });
}

/**
 * Fetches the captcha config and binds the SDK to the Claim button while the
 * dialog is opening. The button is only held disabled during this setup and
 * is re-enabled in every exit path — a disabled button cannot receive the
 * click that triggers the Aliyun challenge, which silently dead-ended the
 * whole claim.
 */
async function prepareClaimCaptcha(
  button: HTMLButtonElement,
  plan: ManualClaimPlanPreview,
): Promise<"bound" | "unusable" | "failed"> {
  button.disabled = true;
  try {
    let captchaConfig: ZCodeCaptchaConfig | null = null;
    try {
      captchaConfig = await fetchJson<ZCodeCaptchaConfig | null>(
        "/api/coding-plan/captcha-config",
      );
    } catch {
      // The desktop treats a missing/invalid captcha config as a claim blocker.
    }
    if (!usableCaptchaConfig(captchaConfig)) {
      return "unusable";
    }
    try {
      await loadAliyunCaptchaScript(captchaConfig);
    } catch (error) {
      console.warn("[zh-offer] captcha script failed to load", error);
      return "failed";
    }
    if (typeof window.initAliyunCaptcha !== "function") {
      return "failed";
    }
    const region = captchaConfig.region.trim();
    try {
      window.initAliyunCaptcha({
        SceneId: captchaConfig.sceneId.trim(),
        prefix: captchaConfig.prefix.trim(),
        mode: captchaConfig.mode?.trim() || "popup",
        element: "#zh-offer-captcha-element",
        button: "#zh-offer-dialog-claim-button",
        language: isZhLocale() ? "cn" : "en",
        captchaVerifyCallback: async (captchaVerifyParam) => {
          button.disabled = true;
          const result = await postClaim(plan.planId, {
            captchaVerifyParam,
            ...(region ? { captchaRegion: region } : {}),
          });
          finishClaim(button, plan, result);
          // false resets the widget so a failed claim can be retried.
          return { captchaResult: result.success };
        },
        getInstance: (instance) => {
          activeCaptchaInstance = instance;
        },
      });
    } catch (error) {
      console.warn("[zh-offer] captcha init failed", error);
      return "failed";
    }
    return "bound";
  } finally {
    // The SDK now owns the button (or there is no usable captcha path); either
    // way the click handler takes over from here and the button must listen.
    button.disabled = false;
  }
}

function finishClaim(
  button: HTMLButtonElement,
  plan: ManualClaimPlanPreview,
  result: ManualClaimPlanClaimResult,
): void {
  if (result.success) {
    dismissPlan(plan.planId);
    closeOfferBanner();
    activeCaptchaInstance?.destroy?.();
    activeCaptchaInstance = null;
    document.querySelector(".zh-offer-dialog")?.remove();
    showSuccessDialog(plan, result);
    return;
  }
  button.disabled = false;
  if (TERMINAL_CLAIM_CODES.has(result.code)) {
    dismissPlan(plan.planId);
  }
  const errorRow =
    document
      .querySelector(".zh-offer-dialog")
      ?.querySelector<HTMLElement>(".zh-offer-error") ?? null;
  if (errorRow) {
    // Quota exhaustion is temporary (resets at failureEndsAt); name it as
    // such instead of the generic failure wording.
    errorRow.textContent =
      result.code === QUOTA_EXHAUSTED_CODE && isZhLocale()
        ? "Kuota klaim hari ini sudah habis, silakan coba lagi besok."
        : claimFailureMessage(result);
    errorRow.hidden = false;
  }
}

async function postClaim(
  planId: string,
  extra: { captchaVerifyParam?: string; captchaRegion?: string },
): Promise<ManualClaimPlanClaimResult> {
  try {
    return await fetchJson<ManualClaimPlanClaimResult>("/api/coding-plan/manual-claim/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, ...extra }),
    });
  } catch (error) {
    return {
      success: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function claimFailureMessage(result: ManualClaimPlanClaimResult): string {
  const message = result.message?.trim();
  if (message) {
    return message;
  }
  return isZhLocale()
    ? `Klaim gagal (kode ${result.code}), coba lagi nanti.`
    : `Claim failed (code ${result.code}), try again later.`;
}

function showSuccessDialog(plan: ManualClaimPlanPreview, result: ManualClaimPlanClaimResult): void {
  const isZh = isZhLocale();
  const dialog = document.createElement("div");
  dialog.className = "zh-offer-dialog";
  dialog.innerHTML = `
    <div class="zh-offer-dialog-card" role="dialog" aria-modal="true">
      <div class="zh-offer-dialog-title">${escapeHtml(plan.name)}</div>
      <div class="zh-offer-dialog-body">
        ${isZh ? "Sekarang kamu punya akses ke" : "You now have access to"} <strong>${escapeHtml(plan.name)}</strong>.
        ${result.plan?.status ? `<br />${escapeHtml(result.plan.status)}` : ""}
      </div>
      <div class="zh-offer-dialog-actions">
        <button type="button" data-zh-offer-ok>${isZh ? "Siap" : "Got it"}</button>
      </div>
    </div>
  `;
  dialog.querySelector("[data-zh-offer-ok]")?.addEventListener("click", () => {
    dialog.remove();
  });
  document.body.appendChild(dialog);
}

function dismissPlan(planId: string): void {
  const dismissed = readDismissedPlans();
  dismissed.add(planId);
  persistDismissedPlans(dismissed);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
