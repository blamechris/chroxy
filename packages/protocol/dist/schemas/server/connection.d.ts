/**
 * Connection lifecycle: auth-ok / pairing / background-task / claude-ready, plus the shared MAX_SANE_DURATION_MS and billing-canary shapes the auth handshake carries.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
/**
 * Sanity ceiling for any ms-typed numeric field (#3768).
 *
 * 24 h is well past every legitimate session-timeout / restart-eta /
 * permission TTL we emit today, and tight enough that an env-var typo
 * (`CHROXY_RESULT_TIMEOUT_MS=999999999999999`) gets rejected at the
 * schema boundary instead of corrupting `Date.now() + ms` arithmetic
 * on the client.
 *
 * **Convention for ms-typed fields (#3775):** any field whose value is a
 * duration in milliseconds — timeouts, TTLs, ETAs, intervals — MUST be
 * declared with the required constraint set
 * `z.number().finite().max(MAX_SANE_DURATION_MS)`, plus `.nonnegative()`
 * or `.positive()` chosen by the field's allowed range. Add `.int()` when
 * the field is intended to be a whole number of ms (most ms fields are);
 * omit it only when sub-ms / fractional values are legitimately expected.
 * This applies to both this file and `client.ts`. `client.ts` currently
 * has no ms-typed fields, so the sweep in #3773 was server-only; when the
 * first ms-typed client field is added, import this constant from
 * `./server` (or promote to `../constants.ts` shared module at that
 * point) and apply the same constraint set so server and client agree on
 * the sanity ceiling.
 */
export declare const MAX_SANE_DURATION_MS: number;
export declare const BillingCanaryWarningSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    provider: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    costUsd: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const BillingCanarySnapshotSchema: z.ZodObject<{
    eraStarted: z.ZodBoolean;
    defaultProvider: z.ZodString;
    defaultBillingClass: z.ZodString;
    warnings: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        provider: z.ZodOptional<z.ZodString>;
        sessionId: z.ZodOptional<z.ZodString>;
        costUsd: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerAuthOkSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth_ok">;
    clientId: z.ZodString;
    serverMode: z.ZodLiteral<"cli">;
    serverVersion: z.ZodString;
    latestVersion: z.ZodNullable<z.ZodString>;
    serverCommit: z.ZodString;
    cwd: z.ZodNullable<z.ZodString>;
    connectedClients: z.ZodArray<z.ZodObject<{
        clientId: z.ZodString;
        deviceName: z.ZodNullable<z.ZodString>;
        deviceType: z.ZodEnum<{
            unknown: "unknown";
            phone: "phone";
            tablet: "tablet";
            desktop: "desktop";
        }>;
        platform: z.ZodString;
    }, z.core.$strip>>;
    encryption: z.ZodEnum<{
        required: "required";
        disabled: "disabled";
    }>;
    protocolVersion: z.ZodNumber;
    minProtocolVersion: z.ZodNumber;
    maxProtocolVersion: z.ZodNumber;
    capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    resultTimeoutMs: z.ZodOptional<z.ZodNumber>;
    hardTimeoutMs: z.ZodOptional<z.ZodNumber>;
    streamStallTimeoutMs: z.ZodOptional<z.ZodNumber>;
    exposure: z.ZodOptional<z.ZodObject<{
        lanBind: z.ZodBoolean;
        bindHost: z.ZodNullable<z.ZodString>;
        quickTunnel: z.ZodBoolean;
    }, z.core.$strip>>;
    billingCanary: z.ZodOptional<z.ZodObject<{
        eraStarted: z.ZodBoolean;
        defaultProvider: z.ZodString;
        defaultBillingClass: z.ZodString;
        warnings: z.ZodArray<z.ZodObject<{
            code: z.ZodString;
            message: z.ZodString;
            provider: z.ZodOptional<z.ZodString>;
            sessionId: z.ZodOptional<z.ZodString>;
            costUsd: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    serverPublicKey: z.ZodOptional<z.ZodString>;
    serverKeySig: z.ZodOptional<z.ZodString>;
    newIdentityKey: z.ZodOptional<z.ZodString>;
    rotationCert: z.ZodOptional<z.ZodString>;
    availablePermissionModes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$loose>;
export declare const ServerAuthFailSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth_fail">;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const ServerPairFailSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_fail">;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const ServerPairRequestPendingSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_request_pending">;
    requestId: z.ZodString;
    verifyCode: z.ZodString;
}, z.core.$strip>;
export declare const ServerPairPendingSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_pending">;
    requestId: z.ZodString;
    deviceName: z.ZodString;
    verifyCode: z.ZodString;
    expiresAt: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerPairResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_result">;
    requestId: z.ZodString;
    ok: z.ZodBoolean;
    token: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerPairResolvedSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_resolved">;
    requestId: z.ZodString;
    reason: z.ZodString;
}, z.core.$strip>;
/**
 * #5431 — one outstanding background task surfaced on `claude_ready`.
 *
 * `kind` maps the launching tool: a `run_in_background` Bash call, a
 * `run_in_background` Agent (subagent) call, or a Monitor stream. The
 * task is "outstanding" when its launch has no matching task-notification
 * in the session transcript yet. `startedAt` is epoch ms (the transcript
 * entry's timestamp), matching the `startedAt` convention used by
 * `pendingBackgroundShells` / `activeTools`.
 */
export declare const BackgroundTaskSchema: z.ZodObject<{
    toolUseId: z.ZodString;
    kind: z.ZodEnum<{
        bash: "bash";
        agent: "agent";
        monitor: "monitor";
    }>;
    description: z.ZodString;
    startedAt: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerClaudeReadySchema: z.ZodObject<{
    type: z.ZodLiteral<"claude_ready">;
    backgroundTasks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        toolUseId: z.ZodString;
        kind: z.ZodEnum<{
            bash: "bash";
            agent: "agent";
            monitor: "monitor";
        }>;
        description: z.ZodString;
        startedAt: z.ZodNumber;
    }, z.core.$strip>>>;
    scheduledWakeup: z.ZodOptional<z.ZodObject<{
        at: z.ZodNumber;
        reason: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerClientJoinedSchema: z.ZodObject<{
    type: z.ZodLiteral<"client_joined">;
    client: z.ZodObject<{
        clientId: z.ZodString;
        deviceName: z.ZodNullable<z.ZodString>;
        deviceType: z.ZodEnum<{
            unknown: "unknown";
            phone: "phone";
            tablet: "tablet";
            desktop: "desktop";
        }>;
        platform: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ServerClientLeftSchema: z.ZodObject<{
    type: z.ZodLiteral<"client_left">;
    clientId: z.ZodString;
}, z.core.$strip>;
export declare const ServerKeyExchangeOkSchema: z.ZodObject<{
    type: z.ZodLiteral<"key_exchange_ok">;
    publicKey: z.ZodString;
    serverKeySig: z.ZodOptional<z.ZodString>;
    newIdentityKey: z.ZodOptional<z.ZodString>;
    rotationCert: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerRateLimitedSchema: z.ZodObject<{
    type: z.ZodLiteral<"rate_limited">;
    retryAfterMs: z.ZodNumber;
    message: z.ZodString;
}, z.core.$strip>;
