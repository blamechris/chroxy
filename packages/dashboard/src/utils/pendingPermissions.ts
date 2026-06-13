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
export function derivePendingPermissionSessions(
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): Record<string, true> {
  const out: Record<string, true> = {}
  for (const id in sessionStates) {
    const msgs = sessionStates[id]!.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      if (
        m.type === 'prompt' &&
        m.requestId &&
        m.expiresAt &&
        m.expiresAt > now &&
        !m.answered
      ) {
        out[id] = true
        break
      }
    }
  }
  return out
}
