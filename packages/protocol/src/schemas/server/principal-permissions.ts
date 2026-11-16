/**
 * Server -> client frame of the agent principal's pending-permission snapshot (#9119, S4 of
 * #9112; docs/security/agent-principals.md section 7.3, advancing #7860).
 *
 * `principal_pending_permissions_result` answers `principal_pending_permissions`. It is the
 * CANONICAL current state of both permission pipelines (the in-process PermissionManager of
 * the SDK, BYOK and Codex sessions, and the hook-routed requests the claude CLI / TUI raise
 * over HTTP), read at `generatedAt`. It grants no decision authority: seeing a request is not
 * being able to answer it.
 *
 * What a request carries, and what it never does:
 *   - `floored`, `explicitConsent`, `nonDelegable`: the inputs a daemon-side answer policy
 *     needs (the floor has one implementation, permission-floor.md).
 *   - `description`: the existing bounded, sanitised description, and ONLY when
 *     `floored === false`. A floored request carries none.
 *   - never the tool `input`, in any form (the S3 journal narrowing).
 *   - `createdAt` / `expiresAt`: epoch milliseconds, the real deadline of the request's own
 *     timer. Resolved and expired requests are not listed.
 */

import { z } from 'zod'

/** The most requests one reply carries; past it `truncated` is true (oldest first). */
export const PRINCIPAL_PENDING_PERMISSIONS_MAX = 100

export const PrincipalPendingPermissionSchema = z.object({
  requestId: z.string().max(256),
  sessionId: z.string().max(128),
  tool: z.string().max(200),
  floored: z.boolean(),
  explicitConsent: z.boolean(),
  nonDelegable: z.boolean(),
  /** Which pipeline holds it: the in-process manager or the hook-routed store. */
  origin: z.enum(['in_process', 'hook']),
  /** Epoch ms the request was raised; null when the daemon cannot say (fails closed elsewhere). */
  createdAt: z.number().int().nonnegative().nullable(),
  /** Epoch ms the request's own timer expires it; null when the daemon cannot say. */
  expiresAt: z.number().int().nonnegative().nullable(),
  /** Bounded, sanitised; present only when `floored` is false. */
  description: z.string().max(200).optional(),
})

export const ServerPrincipalPendingPermissionsResultSchema = z.object({
  type: z.literal('principal_pending_permissions_result'),
  requestId: z.string().max(128),
  /** Epoch ms the snapshot was read. Every `expiresAt` at or before it is already excluded. */
  generatedAt: z.number().int().nonnegative(),
  permissions: z.array(PrincipalPendingPermissionSchema).max(PRINCIPAL_PENDING_PERMISSIONS_MAX),
  /** More requests were pending than this reply carries. */
  truncated: z.boolean(),
})
