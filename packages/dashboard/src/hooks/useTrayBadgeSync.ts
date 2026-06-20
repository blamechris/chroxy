/**
 * useTrayBadgeSync (#6184, Control Room v2 phase 2 / #5964) — reflect the
 * cross-session "needs me" count on the desktop dock badge.
 *
 * Data-source decision (settled in #6184): dashboard-derived. The dashboard
 * already owns the session list + activity reducer state and computes the
 * cross-session rollup via `selectCrossSessionActivity` (#6182); rather than add
 * a parallel server-side aggregation, this hook reads that same rollup and pushes
 * `blocked + failed` to the Tauri `update_tray_badge` command, which sets the
 * macOS dock-tile badge (Tauri v2's tray icon has no badge API; the dock tile is
 * the native count surface). Outside Tauri (a plain browser tab) it's a no-op.
 *
 * Deduped: the command is invoked only when the count actually changes, so a busy
 * stream of activity deltas that doesn't move the blocked/failed totals doesn't
 * spam the bridge.
 */
import { useEffect, useRef } from 'react'
import { selectCrossSessionActivity } from '@chroxy/store-core'
import { useConnectionStore } from '../store/connection'
import { getTauriInvoke } from '../utils/tauri-bridge'

export function useTrayBadgeSync(): void {
  const activity = useConnectionStore((s) => s.activity)
  const sessions = useConnectionStore((s) => s.sessions)
  // Last count pushed to the bridge ("blocked:failed"), so we only invoke on a
  // real change. Held in a ref (survives re-renders, no extra render on update).
  const lastSentRef = useRef<string | null>(null)

  useEffect(() => {
    const invoke = getTauriInvoke()
    if (!invoke) return // plain browser tab — no dock/tray to badge.

    const { total } = selectCrossSessionActivity(
      activity,
      sessions.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, name: s.name, worktree: s.worktree })),
    )
    const key = `${total.blocked}:${total.failed}`
    if (key === lastSentRef.current) return // unchanged — don't spam the bridge.
    lastSentRef.current = key
    void invoke('update_tray_badge', { blocked: total.blocked, failed: total.failed })
  }, [activity, sessions])
}
