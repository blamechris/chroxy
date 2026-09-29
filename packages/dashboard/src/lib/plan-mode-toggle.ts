/**
 * plan-mode-toggle — the pure "which permission mode should the toggle set,
 * if any" decision shared by every plan-mode-toggle entry point (#8084 /
 * #8087 review, Critical #2).
 *
 * There are exactly two callers of `setPermissionMode('plan')` in this
 * package: the Shift+Alt+P keyboard shortcut (`useShortcutDispatch.ts`'s
 * `session.togglePlanMode` case) and the Tauri desktop menu's "Toggle Plan
 * Mode" item (`useTauriMenuWiring.ts`'s `menuTogglePlanMode`). Both used to
 * carry their own copy of the same enter/leave logic; the menu copy was
 * never updated when #8084 gated the shortcut on the active provider's
 * `planMode` capability, so a `claude-tui` session (which declares
 * `planMode: false`) could still be pushed into plan mode from the native
 * menu bar. Factoring the decision into one function makes that class of
 * drift structurally impossible: there is nowhere left for a second copy to
 * go stale.
 */

/**
 * Decide the permission mode a plan-mode toggle should switch to.
 *
 * - If the session is already in `'plan'`, always allow LEAVING it —
 *   regardless of `planModeSupported` — back to `previousMode` (or
 *   `'approve'` when none was stored). A session can end up in plan mode on
 *   an unsupported provider (the capability flips mid-session, or a resumed
 *   session carries a stale mode), and must still have a way out.
 * - Otherwise, only ENTER `'plan'` when `planModeSupported` is not `false`
 *   (missing/undefined is treated as capable, matching every other
 *   capability flag in this codebase — see `dropdownFlags` in `App.tsx`).
 * - Returns `null` for "do nothing" — the caller no-ops rather than calling
 *   `setPermissionMode` at all.
 */
export function resolveTogglePlanModeTarget(
  currentMode: string | null | undefined,
  previousMode: string | null | undefined,
  planModeSupported: boolean | undefined,
): string | null {
  if (currentMode === 'plan') {
    return previousMode || 'approve'
  }
  if (planModeSupported !== false) {
    return 'plan'
  }
  return null
}
