/**
 * `permission_resolved` reasons that mean NOBODY decided, and the record each
 * becomes (#8952) -- the ONE table both the server journal and the clients read.
 *
 * The server resolves these prompts with `decision: 'deny'` because the provider
 * needs a verdict, so the decision alone cannot tell them from a user Deny; the
 * `reason` is the only discriminator. History journals the outcome named here
 * (`permission_outcome`), and a live client must stamp the same record, or a
 * prompt reads "Denied" live and "expired" after a reload.
 *
 *   - `stopped`: the user pressed Stop with the prompt open.
 *   - `timeout`: the per-request timer ran out.
 *   - `aborted`: any other abort of the turn's controller (dead provider, stall).
 *   - `cleared`: the turn ended with the prompt still open.
 *
 * A reason added here without a client mapping is impossible (the client reads
 * this table); a server emitter of a new no-decision reason that is NOT added
 * here is the remaining gap, so add it here in the same change.
 *
 * Zod-free on purpose (like `./auth-causes.ts`).
 */
export const PERMISSION_NO_DECISION_REASON_OUTCOMES = Object.freeze({
  stopped: 'stopped',
  timeout: 'expired',
  aborted: 'expired',
  cleared: 'expired',
} as const)

export type PermissionNoDecisionReason = keyof typeof PERMISSION_NO_DECISION_REASON_OUTCOMES
export type PermissionNoDecisionOutcome =
  (typeof PERMISSION_NO_DECISION_REASON_OUTCOMES)[PermissionNoDecisionReason]

/** The no-decision outcome a `permission_resolved` reason maps to, or `null` (a real decision). */
export function permissionOutcomeForReason(reason: unknown): PermissionNoDecisionOutcome | null {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_NO_DECISION_REASON_OUTCOMES, reason)
    ? PERMISSION_NO_DECISION_REASON_OUTCOMES[reason as PermissionNoDecisionReason]
    : null
}
