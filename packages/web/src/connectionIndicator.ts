/*
 * Connection-state pill for the zh web UI, layered onto the shell DOM the
 * same way mobileShell is (no upstream React changes). Shows a small
 * top-center pill while the WebSocket channel is reconnecting so a dead
 * socket is never silent: the frozen conversation stays on screen and the
 * pill explains why nothing responds. Hidden while connected.
 */
import "./connectionIndicator.css";

const TEXT = {
  reconnecting: { en: "Connection lost — reconnecting…", zh: "连接断开，正在重连…" },
  authExpired: { en: "Sign-in expired — reloading…", zh: "登录已过期，正在重新加载…" },
  authRequired: { en: "Sign-in required — reload the page", zh: "需要重新登录，请刷新页面" },
};

export type IndicatorState = "hidden" | "reconnecting" | "authExpired" | "authRequired";

let pill: HTMLDivElement | null = null;
let label: HTMLSpanElement | null = null;

function locale(): "en" | "zh" {
  return /^zh\b/i.test(navigator.language) ? "zh" : "en";
}

function ensurePill(): HTMLDivElement {
  if (pill) {
    return pill;
  }
  pill = document.createElement("div");
  pill.className = "zh-conn-pill";
  pill.setAttribute("role", "status");
  const dot = document.createElement("span");
  dot.className = "zh-conn-pill-dot";
  label = document.createElement("span");
  label.className = "zh-conn-pill-label";
  pill.append(dot, label);
  document.body.appendChild(pill);
  return pill;
}

export function setConnectionIndicator(state: IndicatorState): void {
  if (typeof document === "undefined") {
    return;
  }
  if (state === "hidden") {
    pill?.classList.remove("zh-conn-pill-visible", "zh-conn-pill-error");
    if (label) {
      label.textContent = "";
    }
    return;
  }
  const element = ensurePill();
  const lang = locale();
  element.classList.add("zh-conn-pill-visible");
  element.classList.toggle(
    "zh-conn-pill-error",
    state === "authExpired" || state === "authRequired",
  );
  label!.textContent =
    state === "authExpired"
      ? TEXT.authExpired[lang]
      : state === "authRequired"
        ? TEXT.authRequired[lang]
        : TEXT.reconnecting[lang];
}
