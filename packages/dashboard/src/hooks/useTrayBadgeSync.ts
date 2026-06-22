/**
 * useTrayBadgeSync (#6184, Control Room v2 phase 2 / #5964) — reflect the
 * cross-session "needs me" count on the desktop dock badge.
 *
 * BLOCKED is passed in by the caller (#6225). App already derives the
 * cross-session pending-permission total for the header "N pending" indicator
 * (`derivePendingPermissionCounts` → `totalPendingPermissions`), so the badge
 * reuses that single derivation rather than scanning every session's message
 * array a second time. The badge is `blocked + failed`, where FAILED is the
 * activity-rollup crashed-session count (best-effort, still derived here). The
 * header indicator is blocked-only, so the two match exactly only when nothing
 * is failed.
 *
 * Pushes `blocked + failed` to the Tauri `update_tray_badge` command, which sets
 * the macOS dock-tile badge (Tauri v2's tray icon has no badge API; the dock
 * tile is the native count surface). Outside Tauri (a plain browser tab) it's a
 * no-op. Deduped: the command is invoked only when the count actually changes.
 */
import { useEffect, useRef } from 'react'
import { selectCrossSessionActivity } from '@chroxy/store-core'
import { useConnectionStore } from '../store/connection'
import { getTauriInvoke } from '../utils/tauri-bridge'

export function useTrayBadgeSync(blocked: number): void {
  // FAILED = activity-rollup failed sessions (best-effort). This runs at RENDER
  // time, so it must be total over a partially-populated store — an undefined
  // `activity`/`sessions` on an early/transient render must not throw and
  // white-screen the dashboard (selectCrossSessionActivity dereferences
  // `state.bySession`), so default them at the call site.
  const failed = useConnectionStore(
    (s) =>
      selectCrossSessionActivity(
        s.activity ?? { bySession: {} },
        (s.sessions ?? []).map((x) => ({ sessionId: x.sessionId, cwd: x.cwd, name: x.name, worktree: x.worktree })),
      ).total.failed,
  )
  // Last count pushed to the bridge ("blocked:failed"), so we only invoke on a
  // real change. Held in a ref (survives re-renders, no extra render on update).
  const lastSentRef = useRef<string | null>(null)

  useEffect(() => {
    const invoke = getTauriInvoke()
    if (!invoke) return // plain browser tab — no dock/tray to badge.

    const key = `${blocked}:${failed}`
    if (key === lastSentRef.current) return // unchanged — don't spam the bridge.
    lastSentRef.current = key
    // Swallow IPC rejection (backend not ready / command unregistered) so a
    // best-effort cosmetic badge update can't surface an unhandled rejection.
    void Promise.resolve(invoke('update_tray_badge', { blocked, failed })).catch(() => {})
  }, [blocked, failed])
}
