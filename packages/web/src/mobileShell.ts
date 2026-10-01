// Mobile shell adapter for the zh web UI. The upstream workspace shell has no
// touch layout: the sidebar renders inline (capped at 50% width) and its only
// toggle entry points are desktop-app window chrome and the Ctrl/⌘+B
// shortcut, so on a phone it either covers the conversation or, once hidden,
// cannot be reopened at all. This module layers drawer behavior onto the
// shell DOM (styles in mobileShell.css):
//   - html.zh-mobile (viewports < 768px) enables the drawer/scrim rules.
//   - The sidebar panel signals visibility with the opacity-100 / opacity-0
//     utility classes; a MutationObserver mirrors that into
//     html.zh-sidebar-open to show the scrim.
//   - Tapping the scrim dispatches "zh:close-sidebar", which the patched
//     DesktopTopOverlay in @zcode/ui translates into the app's own
//     toggleSidebar action.
import "./mobileShell.css";

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";
const SIDEBAR_PANEL_SELECTOR = '[data-workspace-sidebar-panel="true"]';
const CLOSE_SIDEBAR_EVENT = "zh:close-sidebar";

export function setupMobileShell(): void {
  if (typeof window === "undefined") {
    return;
  }

  const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
  const applyMobileClass = () => {
    document.documentElement.classList.toggle("zh-mobile", mediaQuery.matches);
  };
  applyMobileClass();
  mediaQuery.addEventListener("change", applyMobileClass);

  const scrim = document.createElement("div");
  scrim.className = "zh-mobile-scrim";
  scrim.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent(CLOSE_SIDEBAR_EVENT));
  });
  document.body.appendChild(scrim);

  const mirrorSidebarVisibility = () => {
    const sidebarPanel = document.querySelector(SIDEBAR_PANEL_SELECTOR);
    const isOpen = Boolean(sidebarPanel?.classList.contains("opacity-100"));
    document.documentElement.classList.toggle("zh-sidebar-open", isOpen);
  };

  // The sidebar panel mounts with the React tree, so discover it from a
  // subtree observer first, then watch only its class attribute.
  const visibilityObserver = new MutationObserver(mirrorSidebarVisibility);
  const mountObserver = new MutationObserver(() => {
    const sidebarPanel = document.querySelector(SIDEBAR_PANEL_SELECTOR);
    if (!sidebarPanel) {
      return;
    }
    mountObserver.disconnect();
    visibilityObserver.observe(sidebarPanel, {
      attributes: true,
      attributeFilter: ["class"],
    });
    mirrorSidebarVisibility();
  });
  mountObserver.observe(document.documentElement, { subtree: true, childList: true });
}
