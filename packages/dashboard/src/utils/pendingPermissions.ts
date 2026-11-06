/**
 * #5667 / #5693 — pending-permission derivation for the per-tab "permission
 * waiting" indicator and the "jump to next pending" control.
 *
 * #5759 — the predicate + derivations now live in `@chroxy/store-core` as the
 * single source of truth shared with the mobile app (they all operate on the
 * same `ChatMessage`), so this module is a thin re-export. Import sites and
 * tests in the dashboard keep working unchanged; the rule can no longer drift
 * between the two clients.
 */
export {
  isLivePermissionPrompt,
  firstLivePermissionPrompt,
  livePermissionPrompts,
  countLivePermissionPrompts,
  derivePendingPermissionCounts,
  derivePendingPermissionSessions,
  totalPendingPermissions,
  selectNextPendingSession,
} from '@chroxy/store-core'


import type { ActivityState } from '@chroxy/store-core'

/** Add session decisions to the existing attention count without counting
 * permission/question activity a second time. */
export function withDecisionCounts(counts: Record<string, number>, activity?: ActivityState): Record<string, number> {
  const result = { ...counts }
  for (const [sessionId, session] of Object.entries(activity?.bySession ?? {})) {
    const decisions = Object.values(session.byId).filter((entry) => entry.kind === 'decision' && entry.status === 'blocked').length
    if (decisions) result[sessionId] = (result[sessionId] ?? 0) + decisions
  }
  return result
}
