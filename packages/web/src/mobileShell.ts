// Mobile shell adapter for the zh web UI. The upstream workspace shell has no
// touch layout: the sidebar renders inline (capped at 50% width) and its only
// toggle entry points are desktop-app window chrome and the Ctrl/⌘+B
// shortcut, so on a phone it either covers the conversation or, once hidden,
// cannot be reopened at all. This module layers drawer behavior onto the
// shell DOM (styles in mobileShell.css):
//   - html.zh-mobile (viewports < 768px) enables the drawer/scrim rules.
//   - The patched DesktopTopOverlay in @zcode/ui reports sidebar visibility
//     through "zh:sidebar-visibility" window events (on mount and on every
//     change); the scrim mirrors that into html.zh-sidebar-open. The panel
//     element itself cannot be watched: the web reconnect remount replaces
//     the whole React tree, so a DOM observer would keep watching a detached
//     element and leave the scrim stuck on (mask over the page) or stuck off
//     (drawer that nothing can close).
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
const SIDEBAR_VISIBILITY_EVENT = "zh:sidebar-visibility";

// Sidebar entries whose tap navigates away from the list. Task rows carry the
// test id on the <li> itself, so taps on the row's inner action buttons
// (pin/archive/menu) must be filtered out separately. The settings gear opens
// the settings layer above the workspace while the workspace shell (drawer
// included) stays mounted underneath — and the scrim stacks above that
// layer — so the drawer must close with the navigation or the settings page
// renders under the scrim mask.
const NAVIGATING_SELECTOR = [
  '[data-testid^="task-item-"]',
  '[data-testid="conversation-new-task"]',
  '[data-testid="automations-open"]',
  '[data-testid="plugin-store-sidebar-open"]',
  '[data-testid="task-settings-button"]',
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

  // The scrim follows the patched DesktopTopOverlay's reported visibility
  // instead of watching the panel DOM: the reconnect remount replaces the
  // panel element, so a MutationObserver would end up observing a detached
  // node and freeze the scrim's last state.
  const applySidebarVisibility = (visible: boolean) => {
    document.documentElement.classList.toggle("zh-sidebar-open", visible);
  };
  window.addEventListener(SIDEBAR_VISIBILITY_EVENT, (event) => {
    applySidebarVisibility((event as CustomEvent<boolean>).detail === true);
  });
}
