/**
 * Server -> client reply for the agent-principal management surface (#9116).
 *
 * `principal_admin_result` answers `principal_admin_grant`, `principal_admin_list` and
 * `principal_admin_revoke`, `principal_admin_disable` and `principal_admin_enable` (schemas/client.ts). It goes ONLY to the strict-primary,
 * loopback requester that asked, and never to a session-bound client or a principal
 * (outgoing policies drop it for both). It carries no token and no token hash.
 */
import { z } from 'zod';
export declare const PRINCIPAL_ADMIN_OP_VALUES: readonly ["grant", "list", "revoke", "disable", "enable"];
export declare const ServerPrincipalAdminEntrySchema: z.ZodObject<{
    principalId: z.ZodString;
    label: z.ZodString;
    tier: z.ZodString;
    scope: z.ZodString;
    constraints: z.ZodObject<{
        sessionIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cwdRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        providers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        models: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
    createdAt: z.ZodNumber;
    expiresAt: z.ZodNumber;
    revokedAt: z.ZodNullable<z.ZodNumber>;
    state: z.ZodEnum<{
        expired: "expired";
        disabled: "disabled";
        revoked: "revoked";
        invalid: "invalid";
        live: "live";
    }>;
}, z.core.$strip>;
export declare const ServerPrincipalAdminResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_admin_result">;
    requestId: z.ZodNullable<z.ZodString>;
    op: z.ZodEnum<{
        grant: "grant";
        list: "list";
        revoke: "revoke";
        disable: "disable";
        enable: "enable";
    }>;
    ok: z.ZodBoolean;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
    health: z.ZodOptional<z.ZodObject<{
        ok: z.ZodBoolean;
        status: z.ZodString;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    principals: z.ZodOptional<z.ZodArray<z.ZodObject<{
        principalId: z.ZodString;
        label: z.ZodString;
        tier: z.ZodString;
        scope: z.ZodString;
        constraints: z.ZodObject<{
            sessionIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            cwdRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            providers: z.ZodOptional<z.ZodArray<z.ZodString>>;
            models: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
        createdAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        revokedAt: z.ZodNullable<z.ZodNumber>;
        state: z.ZodEnum<{
            expired: "expired";
            disabled: "disabled";
            revoked: "revoked";
            invalid: "invalid";
            live: "live";
        }>;
    }, z.core.$strip>>>;
    principalId: z.ZodOptional<z.ZodString>;
    alreadyRevoked: z.ZodOptional<z.ZodBoolean>;
    durable: z.ZodOptional<z.ZodBoolean>;
    disabled: z.ZodOptional<z.ZodObject<{
        all: z.ZodBoolean;
        labels: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
