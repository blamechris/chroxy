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
import { z } from 'zod';
/** The most requests one reply carries; past it `truncated` is true (oldest first). */
export declare const PRINCIPAL_PENDING_PERMISSIONS_MAX = 100;
export declare const PrincipalPendingPermissionSchema: z.ZodObject<{
    requestId: z.ZodString;
    sessionId: z.ZodString;
    tool: z.ZodString;
    floored: z.ZodBoolean;
    explicitConsent: z.ZodBoolean;
    nonDelegable: z.ZodBoolean;
    origin: z.ZodEnum<{
        hook: "hook";
        in_process: "in_process";
    }>;
    createdAt: z.ZodNullable<z.ZodNumber>;
    expiresAt: z.ZodNullable<z.ZodNumber>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerPrincipalPendingPermissionsResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_pending_permissions_result">;
    requestId: z.ZodString;
    generatedAt: z.ZodNumber;
    permissions: z.ZodArray<z.ZodObject<{
        requestId: z.ZodString;
        sessionId: z.ZodString;
        tool: z.ZodString;
        floored: z.ZodBoolean;
        explicitConsent: z.ZodBoolean;
        nonDelegable: z.ZodBoolean;
        origin: z.ZodEnum<{
            hook: "hook";
            in_process: "in_process";
        }>;
        createdAt: z.ZodNullable<z.ZodNumber>;
        expiresAt: z.ZodNullable<z.ZodNumber>;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    truncated: z.ZodBoolean;
}, z.core.$strip>;
