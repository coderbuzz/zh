/*
 * Seamless remount on WebSocket reconnect. The reconnect re-renders Root
 * (fresh service stack), which would blank the screen while the new tree
 * loads. coverForRemount() puts a frozen, inert copy of the current UI on top
 * and drops it once the new tree stops changing, so the user sees the old
 * screen until the new one is ready (no flash, no lost context).
 */
import "./reconnectCover.css";

const SETTLE_MS = 350;
const MAX_COVER_MS = 4_000;

let cover: HTMLDivElement | null = null;
let release: (() => void) | null = null;

function copyScroll(from: Element, to: Element): void {
  const a = from.querySelectorAll("*");
  const b = to.querySelectorAll("*");
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    const el = a[i] as HTMLElement;
    if (el.scrollTop || el.scrollLeft) {
      (b[i] as HTMLElement).scrollTo(el.scrollLeft, el.scrollTop);
    }
  }
}

export function coverForRemount(rootEl: HTMLElement): void {
  if (!cover) {
    // Keep the first (original) screen when reconnects stack up.
    cover = document.createElement("div");
    cover.className = "zh-remount-cover";
    cover.style.background = getComputedStyle(document.body).backgroundColor;
    cover.setAttribute("aria-hidden", "true");
    cover.setAttribute("inert", "");
    const copy = rootEl.cloneNode(true) as HTMLElement;
    // Duplicate ids/test ids would confuse selector-based shell code.
    copy.removeAttribute("id");
    copy.querySelectorAll("[id],[data-testid]").forEach((el) => {
      el.removeAttribute("id");
      el.removeAttribute("data-testid");
    });
    cover.appendChild(copy);
    document.body.appendChild(cover);
    copyScroll(rootEl, copy);
  }
  release?.();
  let settleTimer = 0;
  const done = () => {
    observer.disconnect();
    window.clearTimeout(settleTimer);
    window.clearTimeout(maxTimer);
    release = null;
    const el = cover;
    cover = null;
    if (el) {
      el.classList.add("zh-remount-cover-out");
      window.setTimeout(() => el.remove(), 200);
    }
  };
  const observer = new MutationObserver(() => {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(done, SETTLE_MS);
  });
  observer.observe(rootEl, { childList: true, subtree: true, attributes: true });
  settleTimer = window.setTimeout(done, SETTLE_MS * 2);
  const maxTimer = window.setTimeout(done, MAX_COVER_MS);
  release = done;
}
