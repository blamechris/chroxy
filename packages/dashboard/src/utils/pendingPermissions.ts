import type { ChatMessage } from '@chroxy/store-core'

/**
 * #5667 — derive which sessions have an unanswered, still-live permission
 * prompt, across ALL sessions. Drives the per-tab "permission waiting"
 * indicator so a background session's request is visible without switching to
 * it (the server now routes a prompt to its owning session, so it no longer
 * lands in the focused tab).
 *
 * A session counts as pending iff it has a `type: 'prompt'` message with a
 * `requestId`, a future `expiresAt`, and no `answered` decision:
 *   - `requestId` + `expiresAt` distinguishes a *permission* prompt from an
 *     AskUserQuestion prompt (which is `type: 'prompt'` but carries neither),
 *     so questions never trip the indicator.
 *   - `expiresAt > now` clears the indicator once the prompt has timed out or
 *     expired — the `permission_expired` / `permission_timeout` handlers clear
 *     the prompt's `options` but do NOT set `answered`, so without the expiry
 *     check an ignored background prompt would leave the indicator stuck on.
 *   - `!answered` clears it the moment the user allows/denies.
 *
 * Returns a plain `Record<sessionId, true>` (only pending sessions present) so
 * a `useShallow` selector re-renders a tab only when its pending state flips.
 * Scans each session newest-first and early-exits at the first live prompt; a
 * pending permission blocks its session, so it is at/near the tail in practice.
 */
/** True iff `m` is a live, unanswered permission prompt (not an AskUserQuestion). */
function isLivePermissionPrompt(m: ChatMessage, now: number): boolean {
  return (
    m.type === 'prompt' &&
    !!m.requestId &&
    !!m.expiresAt &&
    m.expiresAt > now &&
    !m.answered
  )
}

/**
 * #5693 (PR-3) — count the live, unanswered permission prompts in EACH session.
 * Generalizes {@link derivePendingPermissionSessions} from a boolean to a count
 * so the SessionBar can show a per-tab number (`!2`) and an aggregate "N
 * pending" badge. Sessions with zero pending are omitted (so a `useShallow`
 * selector re-renders a tab only when its count changes).
 *
 * Unlike the boolean derive, this does NOT early-exit — a session can hold more
 * than one pending permission (e.g. parallel SDK tool calls), and the count is
 * the point. Pending permissions are few, so the full scan is cheap.
 */
export function derivePendingPermissionCounts(
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id in sessionStates) {
    const msgs = sessionStates[id]!.messages
    let count = 0
    for (let i = 0; i < msgs.length; i++) {
      if (isLivePermissionPrompt(msgs[i]!, now)) count++
    }
    if (count > 0) out[id] = count
  }
  return out
}

/**
 * #5667 — which sessions have at least one live unanswered permission prompt.
 * Thin boolean view over {@link derivePendingPermissionCounts} (single source of
 * truth for the "is this a live permission prompt" predicate). Drives the
 * per-tab attention dot.
 */
export function derivePendingPermissionSessions(
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): Record<string, true> {
  const counts = derivePendingPermissionCounts(sessionStates, now)
  const out: Record<string, true> = {}
  for (const id in counts) out[id] = true
  return out
}

/** Total live pending permissions across all sessions. */
export function totalPendingPermissions(counts: Record<string, number>): number {
  let total = 0
  for (const id in counts) total += counts[id]!
  return total
}

/**
 * #5693 (PR-3) — pick the next session (in visual tab order) that has a pending
 * permission, scanning cyclically AFTER the active tab so repeated "jump to
 * pending" clicks cycle through every waiting session. Returns null when none
 * are pending. If the active tab is the only one pending, returns it (a no-op
 * focus). If `activeSessionId` isn't in the list, scans from the start.
 */
export function selectNextPendingSession(
  orderedSessionIds: string[],
  counts: Record<string, number>,
  activeSessionId: string | null,
): string | null {
  const hasPending = (id: string) => (counts[id] ?? 0) > 0
  const n = orderedSessionIds.length
  if (n === 0 || !orderedSessionIds.some(hasPending)) return null
  const activeIndex = activeSessionId ? orderedSessionIds.indexOf(activeSessionId) : -1
  const from = activeIndex < 0 ? -1 : activeIndex
  for (let step = 1; step <= n; step++) {
    const id = orderedSessionIds[(from + step + n) % n]!
    if (hasPending(id)) return id
  }
  return null
}
