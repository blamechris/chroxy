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
