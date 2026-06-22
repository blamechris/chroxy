/**
 * useTrayBadgeSync (#6184, Control Room v2 phase 2 / #5964) — reflect the
 * cross-session "needs me" count on the desktop dock badge.
 *
 * Data source (#6184 fix, 2026-06-21): the BLOCKED count is the cross-session
 * pending-permission total — the SAME signal that drives the header "N pending"
 * indicator (`derivePendingPermissionCounts` → `totalPendingPermissions` over
 * `sessionStates`). The original implementation read the Control Room
 * activity-tree `blocked` status (`selectCrossSessionActivity().total.blocked`),
 * but that slice does not reliably carry a `blocked` entry for a live permission
 * prompt, so the dock badge never lit up even with prompts pending. The
 * pending-permission derivation is proven to fire (it powers the visible
 * "N pending" header), so the badge now keys off it. FAILED/crashed sessions
 * still come from the activity rollup (best-effort).
 *
 * Pushes `blocked + failed` to the Tauri `update_tray_badge` command, which sets
 * the macOS dock-tile badge (Tauri v2's tray icon has no badge API; the dock
 * tile is the native count surface). Outside Tauri (a plain browser tab) it's a
 * no-op. Deduped: the command is invoked only when the count actually changes.
 */
import { useEffect, useRef } from 'react'
import {
  selectCrossSessionActivity,
  derivePendingPermissionCounts,
  totalPendingPermissions,
} from '@chroxy/store-core'
import { useConnectionStore } from '../store/connection'
import { getTauriInvoke } from '../utils/tauri-bridge'

export function useTrayBadgeSync(): void {
  // Compute the counts as REACTIVE selectors (recomputed on every store change,
  // like the header "N pending" indicator) rather than inside an effect keyed on
  // a store-slice reference. The permission-resolution update does not reliably
  // change the `sessionStates` reference, so an effect dep'd on it never re-fired
  // to push `blocked:0` — leaving the dock badge stuck (#6184). Selecting the
  // derived numbers fixes the clear path: the effect below fires whenever the
  // numbers change, including back to zero.
  // BLOCKED = cross-session pending permissions (the signal that drives "N pending").
  const blocked = useConnectionStore((s) =>
    totalPendingPermissions(derivePendingPermissionCounts(s.sessionStates, Date.now())),
  )
  // FAILED = activity-rollup failed sessions (best-effort).
  const failed = useConnectionStore(
    (s) =>
      selectCrossSessionActivity(
        s.activity,
        s.sessions.map((x) => ({ sessionId: x.sessionId, cwd: x.cwd, name: x.name, worktree: x.worktree })),
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
