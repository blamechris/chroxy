/**
 * Shared stateless handlers for client-side alert / banner messages
 * (session_cost_threshold_crossed #4075, notification_prefs #4542 / #4544).
 *
 * Extracted from ./misc.ts (issue #6034 — splitting the P2-3 leftover
 * catch-all into cohesively-named slices). Pure move, no logic change.
 * Re-exported from ./index so the public surface is unchanged. These parse a
 * wire payload into the state a dismissible banner / preference snapshot UI
 * consumes; the actual store write + display gating stay at the call site.
 * See ./index.ts for the stateless-handler contract.
 */

// Established Zod-handler pattern (#3138).
import { ServerNotificationPrefsSchema } from '@chroxy/protocol'
import { parseFiniteNumberField, parseRawStringField } from './_shared'

// ---------------------------------------------------------------------------
// session_cost_threshold_crossed (#4075)
// ---------------------------------------------------------------------------

/** Parsed payload from a `session_cost_threshold_crossed` message. */
export interface SessionCostThresholdCrossedPayload {
  /**
   * Explicit sessionId from the message, or null. There is deliberately NO
   * active-session fallback (matches both prior inline impls): the soft
   * "you've spent $X" warning fires once per session and must never be
   * misattributed to whichever session happens to be active.
   */
  sessionId: string | null
  /** Session-state patch that arms the dismissible warning banner. */
  patch: { costThresholdWarning: { costUsd: number; thresholdUsd: number; dismissedAt: null } }
}

/**
 * Parse a `session_cost_threshold_crossed` message into a session patch.
 *
 * `costUsd` / `thresholdUsd` fall back to `0` for missing / non-number /
 * non-finite values — identical to the prior inline guards on both clients.
 * The caller applies the patch only when the target session exists in its
 * store (the server doesn't replay this event, so a missed banner stays
 * missed by design).
 */
export function handleSessionCostThresholdCrossed(
  msg: Record<string, unknown>,
): SessionCostThresholdCrossedPayload {
  const sessionId = parseRawStringField(msg, 'sessionId')
  const costUsd = parseFiniteNumberField(msg, 'costUsd', 0)
  const thresholdUsd = parseFiniteNumberField(msg, 'thresholdUsd', 0)
  return {
    sessionId,
    patch: { costThresholdWarning: { costUsd, thresholdUsd, dismissedAt: null } },
  }
}

// ---------------------------------------------------------------------------
// notification_prefs (#4542 / #4544)
// ---------------------------------------------------------------------------

/**
 * Notification-prefs snapshot shape both clients store (mirrors the
 * `notificationPrefs` state slice that existed verbatim on each side before
 * this extraction).
 */
export interface NotificationPrefsState {
  categories: Record<string, boolean>
  devices: Record<
    string,
    {
      categories?: Record<string, boolean>
      quietHours?: { start: string; end: string; timezone: string } | null
      bypassCategories?: string[]
    }
  >
  quietHours: { start: string; end: string; timezone: string } | null
  /**
   * #4544: optional globally-applied bypass list (categories that fire even
   * during quiet hours). Omitted entirely when the wire payload lacks it —
   * clients fall back to the documented defaults (permission +
   * activity_error).
   */
  bypassCategories?: string[]
}

/** Result of parsing a `notification_prefs` message. */
export interface NotificationPrefsPayload {
  /** Validated snapshot ready to store, or null when validation failed. */
  notificationPrefs: NotificationPrefsState | null
  /** Zod issues when validation failed, else null (for the call-site warn). */
  issues: unknown[] | null
}

/**
 * Validate and extract a `notification_prefs` snapshot.
 *
 * Emitted in response to `notification_prefs_get` and broadcast after every
 * `notification_prefs_set` so multiple connected clients stay in lockstep.
 * Validated against `ServerNotificationPrefsSchema` (the wire schema is
 * permissive — `z.record(string, boolean)` for categories — so adding a
 * category server-side does not require a client rebuild). On failure the
 * caller logs `issues` and leaves existing state alone, exactly as both
 * inline implementations did.
 */
export function handleNotificationPrefs(
  msg: Record<string, unknown>,
): NotificationPrefsPayload {
  const parsed = ServerNotificationPrefsSchema.safeParse(msg)
  if (!parsed.success) {
    return { notificationPrefs: null, issues: parsed.error.issues }
  }
  const prefs = parsed.data.prefs
  // #4544: wire snapshot carries an optional `bypassCategories`. Older
  // servers omit it — spread-include only when it's a real array so the
  // stored object matches the prior inline shape key-for-key.
  const bypassCategories = (prefs as { bypassCategories?: string[] }).bypassCategories
  return {
    notificationPrefs: {
      categories: prefs.categories,
      devices: prefs.devices,
      quietHours: prefs.quietHours,
      ...(Array.isArray(bypassCategories) ? { bypassCategories } : {}),
    },
    issues: null,
  }
}
