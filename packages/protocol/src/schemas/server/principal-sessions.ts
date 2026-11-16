/**
 * Server -> client frame of the agent principal's session roster snapshot (#9120, S5 of
 * #9112; docs/security/agent-principals.md sections 4 and 7.3).
 *
 * `principal_sessions_snapshot_result` answers `principal_sessions_snapshot`: one minimal row
 * per granted session, read at `generatedAt`. It is read only and grants no authority.
 *
 * What a row carries, and what it never does:
 *   - `status`: the OBSERVED state (busy or not, why, still starting). `declaredStatus`: what
 *     the agent in the session said about itself; it is a claim, not a fact, and the two are
 *     kept apart on purpose.
 *   - `model`: `requested` is the model the daemon resolved for the session (at create or the
 *     last model switch), which includes an applied daemon default; null only when none was
 *     resolved (the provider's own default applies). An explicit override cannot be told from an
 *     applied default yet. `observed` is the model actually running (null when the daemon
 *     cannot say). Both are redacted free text.
 *   - `blockers`: why a handoff must not start from this session right now (#8281). An EMPTY
 *     list means nothing can still act. A row whose read failed carries `[{ code:
 *     'unavailable' }]`, never an empty list. `code` is an open string: a code a newer daemon
 *     adds is still a blocker. `detail` is present only for the codes that define one.
 *   - `leaseHolder`: the label of the principal that holds the lease, null until S8 (leases).
 *   - never a cwd, history, cost, billing or capability field.
 */

import { z } from 'zod'

/** The most sessions one reply carries; past it `truncated` is true. */
export const PRINCIPAL_SESSIONS_SNAPSHOT_MAX = 100

export const PrincipalSessionStatusSchema = z.object({
  isBusy: z.boolean(),
  /** Why it is busy: mid-turn, or idle with background shells still tracked. Null when not busy. */
  busyReason: z.enum(['turn', 'background-shells']).nullable(),
  /** The provider's async start has not settled yet. */
  starting: z.boolean(),
})

export const PrincipalSessionDeclaredStatusSchema = z.object({
  state: z.string().max(32),
  summary: z.string().max(280),
  next: z.string().max(280).optional(),
  blockedOn: z.string().max(280).optional(),
  etaMinutes: z.number().nonnegative().optional(),
  decision: z.string().max(280).optional(),
  updatedAt: z.number().int().nonnegative(),
  source: z.string().max(32),
})

export const PrincipalSessionModelSchema = z.object({
  requested: z.string().max(200).nullable(),
  observed: z.string().max(200).nullable(),
})

export const PrincipalSessionBlockerSchema = z.object({
  /** Open string: a code this schema does not list is still a blocker. */
  code: z.string().min(1).max(64),
  /** queued_prompts / pending_question / active_agents / background_shells: count (+ soft); pending_permission: requestIds; automation_owned: the owning task or run id. */
  detail: z.object({
    count: z.number().int().nonnegative().optional(),
    soft: z.boolean().optional(),
    requestIds: z.array(z.string().max(256)).max(100).optional(),
    scheduledTaskId: z.string().max(256).optional(),
    orchestrationRunId: z.string().max(256).optional(),
  }).optional(),
})

export const PrincipalSessionRowSchema = z.object({
  sessionId: z.string().max(128),
  name: z.string().max(300).nullable(),
  provider: z.string().max(300).nullable(),
  /** Null only when the row's read failed (then `blockers` is `[{ code: 'unavailable' }]`). */
  status: PrincipalSessionStatusSchema.nullable(),
  declaredStatus: PrincipalSessionDeclaredStatusSchema.nullable(),
  model: PrincipalSessionModelSchema.nullable(),
  blockers: z.array(PrincipalSessionBlockerSchema).max(32),
  /** The lease holder's label; always null until S8 (leases). */
  leaseHolder: z.string().max(300).nullable(),
  lastActivityAt: z.number().int().nonnegative().nullable(),
})

export const ServerPrincipalSessionsSnapshotResultSchema = z.object({
  type: z.literal('principal_sessions_snapshot_result'),
  requestId: z.string().max(128),
  /** Epoch ms the snapshot was read. */
  generatedAt: z.number().int().nonnegative(),
  sessions: z.array(PrincipalSessionRowSchema).max(PRINCIPAL_SESSIONS_SNAPSHOT_MAX),
  /** More granted sessions existed than this reply carries. */
  truncated: z.boolean(),
})
