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
//   - Tapping a sidebar entry that navigates (task row, New task, Automations,
//     Plugin Marketplace) dispatches the same event, so the drawer closes the
//     way upstream 3.14.4's WebRemoteControlMobileShell closes its task list.
//     Workspace rows are deliberately not triggers: their tap expands the
//     workspace task list, which the user still needs on screen.
import "./mobileShell.css";

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";
const SIDEBAR_PANEL_SELECTOR = '[data-workspace-sidebar-panel="true"]';
const CLOSE_SIDEBAR_EVENT = "zh:close-sidebar";

// Sidebar entries whose tap navigates away from the list. Task rows carry the
// test id on the <li> itself, so taps on the row's inner action buttons
// (pin/archive/menu) must be filtered out separately.
const NAVIGATING_SELECTOR = [
  '[data-testid^="task-item-"]',
  '[data-testid="conversation-new-task"]',
  '[data-testid="automations-open"]',
  '[data-testid="plugin-store-sidebar-open"]',
].join(", ");
const TASK_ROW_INTERACTIVE_CHILD_SELECTOR =
  "button, a, input, textarea, select, [role='menuitem'], [data-radix-popper-content-wrapper]";

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

  // Capture phase, so a drawer close is decided before any app handler can
  // stop propagation; the request itself stays a no-op while the drawer is
  // closed because the patched DesktopTopOverlay only listens when visible.
  const handleDocumentClick = (event: MouseEvent) => {
    if (!mediaQuery.matches) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const sidebarPanel = document.querySelector(SIDEBAR_PANEL_SELECTOR);
    if (!sidebarPanel || !sidebarPanel.contains(target)) {
      return;
    }
    const trigger = target.closest(NAVIGATING_SELECTOR);
    if (!trigger) {
      return;
    }
    if (
      trigger.matches('[data-testid^="task-item-"]') &&
      target.closest(TASK_ROW_INTERACTIVE_CHILD_SELECTOR)
    ) {
      return;
    }
    window.dispatchEvent(new CustomEvent(CLOSE_SIDEBAR_EVENT));
  };
  document.addEventListener("click", handleDocumentClick, true);

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
