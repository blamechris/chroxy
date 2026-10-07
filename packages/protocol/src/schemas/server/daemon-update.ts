/**
 * Server -> client schemas for the daily-daemon update banner (#8331).
 *
 * `daemon_update_status` is sent ONLY to strict-primary, unbound clients (on auth,
 * and whenever the deploy script's files change). It is the daemon's own reading
 * of `pending-update.json` / `last-deploy.json` / `deploy-postpone.json` /
 * `deploy-request.json`, validated and size-capped on the server, so a client
 * renders it and never re-derives anything.
 *
 * The three reply frames answer `daemon_update_action` (schemas/client.ts):
 *   - `daemon_update_confirm_required` — restart-now with busy sessions and no
 *     confirmation; nothing was written. The client shows the listed reasons and
 *     re-sends with `confirmBusy: true`.
 *   - `daemon_update_action_result` — the outcome, ok or a `code`
 *     (NOT_AUTHORIZED, STALE_TARGET, NO_PENDING_UPDATE, APPLYING, WRITE_FAILED, UNAVAILABLE,
 *     UNSUPPORTED_ACTION).
 */

import { z } from 'zod'

const Sha = z.string().regex(/^[0-9a-f]{40}$/)

/** `applying`: the script has passed its gates and is building / restarting; no button can take effect. */
export const DAEMON_UPDATE_PENDING_REASON_VALUES = ['busy', 'unknown', 'postponed', 'applying'] as const

export const DaemonUpdatePendingSchema = z.object({
  target: Sha,
  from: Sha.nullable(),
  subject: z.string().max(300),
  commitsAhead: z.number().int().nonnegative().nullable(),
  queuedAt: z.string().datetime(),
  reason: z.enum(DAEMON_UPDATE_PENDING_REASON_VALUES),
})

export const DaemonUpdateLastDeploySchema = z.object({
  from: Sha.nullable(),
  to: Sha,
  at: z.string().datetime(),
  result: z.string().min(1).max(64),
  subject: z.string().max(300),
})

export const ServerDaemonUpdateStatusSchema = z.object({
  type: z.literal('daemon_update_status'),
  /** The commit this daemon process started from (null when it cannot say). */
  running: Sha.nullable(),
  pending: DaemonUpdatePendingSchema.nullable(),
  lastDeploy: DaemonUpdateLastDeploySchema.nullable(),
  /** Set only while a postpone for the pending target is in force. */
  postponedUntil: z.string().datetime().nullable(),
  /** A fresh restart request for the pending target is waiting for the script. */
  requestPending: z.boolean(),
  /** The queued update is being applied right now (build / restart); Restart now and Postpone are refused. */
  applying: z.boolean(),
})

export const ServerDaemonUpdateConfirmRequiredSchema = z.object({
  type: z.literal('daemon_update_confirm_required'),
  requestId: z.string().max(128).nullable(),
  target: Sha,
  reasons: z.array(z.string().max(300)).max(50),
  sessions: z
    .array(
      z.object({
        sessionId: z.string().max(128),
        name: z.string().max(200).nullable(),
        busyReason: z.string().max(200).nullable(),
      }),
    )
    .max(50),
})

export const ServerDaemonUpdateActionResultSchema = z.object({
  type: z.literal('daemon_update_action_result'),
  requestId: z.string().max(128).nullable(),
  action: z.string().max(64).nullable(),
  ok: z.boolean(),
  /** restart-now: true when the idle check was skipped because the owner confirmed busy sessions. */
  force: z.boolean().optional(),
  /** postpone: when the hold ends. */
  postponedUntil: z.string().datetime().optional(),
  code: z.string().max(64).optional(),
  message: z.string().max(300).optional(),
})

export type DaemonUpdatePending = z.infer<typeof DaemonUpdatePendingSchema>
export type DaemonUpdateLastDeploy = z.infer<typeof DaemonUpdateLastDeploySchema>
export type ServerDaemonUpdateStatusMessage = z.infer<typeof ServerDaemonUpdateStatusSchema>
export type ServerDaemonUpdateConfirmRequiredMessage = z.infer<typeof ServerDaemonUpdateConfirmRequiredSchema>
export type ServerDaemonUpdateActionResultMessage = z.infer<typeof ServerDaemonUpdateActionResultSchema>
