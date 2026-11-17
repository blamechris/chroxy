/**
 * Server -> client reply for the agent-principal management surface (#9116).
 *
 * `principal_admin_result` answers `principal_admin_grant`, `principal_admin_list` and
 * `principal_admin_revoke`, `principal_admin_disable` and `principal_admin_enable` (schemas/client.ts). It goes ONLY to the strict-primary,
 * loopback requester that asked, and never to a session-bound client or a principal
 * (outgoing policies drop it for both). It carries no token and no token hash.
 */
import { z } from 'zod';
export const PRINCIPAL_ADMIN_OP_VALUES = ['grant', 'list', 'revoke', 'disable', 'enable'];
export const ServerPrincipalAdminEntrySchema = z.object({
    principalId: z.string().max(64),
    label: z.string().max(32),
    tier: z.string().max(32),
    scope: z.string().max(32),
    constraints: z.object({
        sessionIds: z.array(z.string().max(128)).optional(),
        cwdRoots: z.array(z.string().max(1024)).optional(),
        providers: z.array(z.string().max(1024)).optional(),
        models: z.array(z.string().max(1024)).optional(),
    }),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    revokedAt: z.number().int().nullable(),
    state: z.enum(['live', 'revoked', 'expired', 'invalid', 'disabled']),
});
export const ServerPrincipalAdminResultSchema = z.object({
    type: z.literal('principal_admin_result'),
    requestId: z.string().max(128).nullable(),
    op: z.enum(PRINCIPAL_ADMIN_OP_VALUES),
    ok: z.boolean(),
    /** NOT_AUTHORIZED, PRINCIPALS_NOT_ENABLED, UNAVAILABLE, BAD_REQUEST, NOT_FOUND. */
    code: z.string().max(64).optional(),
    message: z.string().max(500).optional(),
    /** `list`: whether the store is trusted, and why not when it is not. */
    health: z.object({
        ok: z.boolean(),
        status: z.string().max(32),
        reason: z.string().max(500).nullable(),
    }).optional(),
    principals: z.array(ServerPrincipalAdminEntrySchema).optional(),
    /** `revoke`. */
    principalId: z.string().max(64).optional(),
    alreadyRevoked: z.boolean().optional(),
    /** `revoke`: false when the revoke holds in memory but could not be confirmed on disk. */
    durable: z.boolean().optional(),
    /** `disable` / `enable`: what the switch now says (S11). */
    disabled: z.object({ all: z.boolean(), labels: z.array(z.string().max(32)).max(256) }).optional(),
});
