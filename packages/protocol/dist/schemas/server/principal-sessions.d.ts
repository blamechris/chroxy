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
import { z } from 'zod';
/** The most sessions one reply carries; past it `truncated` is true. */
export declare const PRINCIPAL_SESSIONS_SNAPSHOT_MAX = 100;
export declare const PrincipalSessionStatusSchema: z.ZodObject<{
    isBusy: z.ZodBoolean;
    busyReason: z.ZodNullable<z.ZodEnum<{
        turn: "turn";
        "background-shells": "background-shells";
    }>>;
    starting: z.ZodBoolean;
}, z.core.$strip>;
export declare const PrincipalSessionDeclaredStatusSchema: z.ZodObject<{
    state: z.ZodString;
    summary: z.ZodString;
    next: z.ZodOptional<z.ZodString>;
    blockedOn: z.ZodOptional<z.ZodString>;
    etaMinutes: z.ZodOptional<z.ZodNumber>;
    decision: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodNumber;
    source: z.ZodString;
}, z.core.$strip>;
export declare const PrincipalSessionModelSchema: z.ZodObject<{
    requested: z.ZodNullable<z.ZodString>;
    observed: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const PrincipalSessionBlockerSchema: z.ZodObject<{
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodObject<{
        count: z.ZodOptional<z.ZodNumber>;
        soft: z.ZodOptional<z.ZodBoolean>;
        requestIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        scheduledTaskId: z.ZodOptional<z.ZodString>;
        orchestrationRunId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const PrincipalSessionRowSchema: z.ZodObject<{
    sessionId: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    provider: z.ZodNullable<z.ZodString>;
    status: z.ZodNullable<z.ZodObject<{
        isBusy: z.ZodBoolean;
        busyReason: z.ZodNullable<z.ZodEnum<{
            turn: "turn";
            "background-shells": "background-shells";
        }>>;
        starting: z.ZodBoolean;
    }, z.core.$strip>>;
    declaredStatus: z.ZodNullable<z.ZodObject<{
        state: z.ZodString;
        summary: z.ZodString;
        next: z.ZodOptional<z.ZodString>;
        blockedOn: z.ZodOptional<z.ZodString>;
        etaMinutes: z.ZodOptional<z.ZodNumber>;
        decision: z.ZodOptional<z.ZodString>;
        updatedAt: z.ZodNumber;
        source: z.ZodString;
    }, z.core.$strip>>;
    model: z.ZodNullable<z.ZodObject<{
        requested: z.ZodNullable<z.ZodString>;
        observed: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    blockers: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodOptional<z.ZodObject<{
            count: z.ZodOptional<z.ZodNumber>;
            soft: z.ZodOptional<z.ZodBoolean>;
            requestIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            scheduledTaskId: z.ZodOptional<z.ZodString>;
            orchestrationRunId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    leaseHolder: z.ZodNullable<z.ZodString>;
    lastActivityAt: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerPrincipalSessionsSnapshotResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_sessions_snapshot_result">;
    requestId: z.ZodString;
    generatedAt: z.ZodNumber;
    sessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        status: z.ZodNullable<z.ZodObject<{
            isBusy: z.ZodBoolean;
            busyReason: z.ZodNullable<z.ZodEnum<{
                turn: "turn";
                "background-shells": "background-shells";
            }>>;
            starting: z.ZodBoolean;
        }, z.core.$strip>>;
        declaredStatus: z.ZodNullable<z.ZodObject<{
            state: z.ZodString;
            summary: z.ZodString;
            next: z.ZodOptional<z.ZodString>;
            blockedOn: z.ZodOptional<z.ZodString>;
            etaMinutes: z.ZodOptional<z.ZodNumber>;
            decision: z.ZodOptional<z.ZodString>;
            updatedAt: z.ZodNumber;
            source: z.ZodString;
        }, z.core.$strip>>;
        model: z.ZodNullable<z.ZodObject<{
            requested: z.ZodNullable<z.ZodString>;
            observed: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        blockers: z.ZodArray<z.ZodObject<{
            code: z.ZodString;
            detail: z.ZodOptional<z.ZodObject<{
                count: z.ZodOptional<z.ZodNumber>;
                soft: z.ZodOptional<z.ZodBoolean>;
                requestIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                scheduledTaskId: z.ZodOptional<z.ZodString>;
                orchestrationRunId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        leaseHolder: z.ZodNullable<z.ZodString>;
        lastActivityAt: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    truncated: z.ZodBoolean;
}, z.core.$strip>;
