/**
 * Error envelope + credentials/notification-prefs + shutdown/pong + cost/budget/billing-canary + web-task + extension + evaluate-draft/evaluator-rewrite shapes.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
export declare const ServerErrorEnvelopeSchema: z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
    fatal: z.ZodOptional<z.ZodBoolean>;
    correlationId: z.ZodOptional<z.ZodString>;
    details: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ServerByokCredentialsStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_credentials_status">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodEnum<{
        set: "set";
        missing: "missing";
    }>;
    source: z.ZodEnum<{
        file: "file";
        none: "none";
        env: "env";
    }>;
    masked: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    fileExists: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export declare const ServerCredentialsStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"credentials_status">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    credentials: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        provider: z.ZodString;
        label: z.ZodString;
        kind: z.ZodEnum<{
            "api-key": "api-key";
            "oauth-token": "oauth-token";
        }>;
        status: z.ZodEnum<{
            set: "set";
            missing: "missing";
        }>;
        source: z.ZodEnum<{
            none: "none";
            store: "store";
            env: "env";
            oauth: "oauth";
        }>;
        masked: z.ZodOptional<z.ZodString>;
        oauth: z.ZodBoolean;
    }, z.core.$loose>>;
    fileExists: z.ZodOptional<z.ZodBoolean>;
    fileError: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const ServerCredentialTestResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"credential_test_result">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    key: z.ZodString;
    ok: z.ZodBoolean;
    error: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    latencyMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
export declare const ServerStdinDroppedTotalsSchema: z.ZodObject<{
    type: z.ZodLiteral<"stdin_dropped_totals">;
    sessionId: z.ZodNullable<z.ZodString>;
    bytes: z.ZodNumber;
    count: z.ZodNumber;
    reason: z.ZodString;
    escalated: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerErrorSchema: z.ZodObject<{
    type: z.ZodLiteral<"server_error">;
    category: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
    recoverable: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerPushTokenErrorSchema: z.ZodObject<{
    type: z.ZodLiteral<"push_token_error">;
    message: z.ZodString;
}, z.core.$strip>;
export declare const ServerNotificationPrefsSchema: z.ZodObject<{
    type: z.ZodLiteral<"notification_prefs">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    prefs: z.ZodObject<{
        categories: z.ZodRecord<z.ZodString, z.ZodBoolean>;
        devices: z.ZodRecord<z.ZodString, z.ZodObject<{
            categories: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
            quietHours: z.ZodOptional<z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
                start: z.ZodString;
                end: z.ZodString;
                timezone: z.ZodString;
            }, z.core.$strip>]>>;
            bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        quietHours: z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
            start: z.ZodString;
            end: z.ZodString;
            timezone: z.ZodString;
        }, z.core.$strip>]>;
        bypassCategories: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>;
}, z.core.$loose>;
export declare const ServerShutdownSchema: z.ZodObject<{
    type: z.ZodLiteral<"server_shutdown">;
    reason: z.ZodEnum<{
        restart: "restart";
        shutdown: "shutdown";
        crash: "crash";
    }>;
    restartEtaMs: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerPongSchema: z.ZodObject<{
    type: z.ZodLiteral<"pong">;
    serverTs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerCostUpdateSchema: z.ZodObject<{
    type: z.ZodLiteral<"cost_update">;
    sessionCost: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    totalCost: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    budget: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.core.$strip>;
export declare const ServerSessionUsageSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_usage">;
    sessionId: z.ZodOptional<z.ZodString>;
    cumulativeUsage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        turnsBilled: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ServerSessionCostThresholdCrossedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_cost_threshold_crossed">;
    sessionId: z.ZodOptional<z.ZodString>;
    costUsd: z.ZodNumber;
    thresholdUsd: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerBudgetWarningSchema: z.ZodObject<{
    type: z.ZodLiteral<"budget_warning">;
    sessionCost: z.ZodNumber;
    budget: z.ZodNumber;
    percent: z.ZodNumber;
    message: z.ZodString;
}, z.core.$strip>;
export declare const ServerBudgetExceededSchema: z.ZodObject<{
    type: z.ZodLiteral<"budget_exceeded">;
    sessionCost: z.ZodNumber;
    budget: z.ZodNumber;
    percent: z.ZodNumber;
    message: z.ZodString;
}, z.core.$strip>;
export declare const ServerBillingCanarySchema: z.ZodObject<{
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
    type: z.ZodLiteral<"billing_canary">;
}, z.core.$strip>;
export declare const ServerBudgetResumeAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"budget_resume_ack">;
    sessionId: z.ZodOptional<z.ZodString>;
    wasPaused: z.ZodBoolean;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ServerMonthlyBudgetSchema: z.ZodObject<{
    type: z.ZodLiteral<"monthly_budget">;
    month: z.ZodString;
    spentUsd: z.ZodNumber;
    turnsBilled: z.ZodNumber;
    budgetUsd: z.ZodNullable<z.ZodNumber>;
    warningPercent: z.ZodNumber;
    percent: z.ZodNullable<z.ZodNumber>;
    warning: z.ZodBoolean;
    exceeded: z.ZodBoolean;
    justWarned: z.ZodOptional<z.ZodBoolean>;
    justExceeded: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ServerWebFeatureStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"web_feature_status">;
    available: z.ZodBoolean;
    remote: z.ZodBoolean;
    teleport: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerWebTaskCreatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"web_task_created">;
    task: z.ZodObject<{
        taskId: z.ZodString;
        prompt: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
            pending: "pending";
            completed: "completed";
        }>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        result: z.ZodNullable<z.ZodString>;
        error: z.ZodNullable<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ServerWebTaskUpdatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"web_task_updated">;
    task: z.ZodObject<{
        taskId: z.ZodString;
        prompt: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
            pending: "pending";
            completed: "completed";
        }>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        result: z.ZodNullable<z.ZodString>;
        error: z.ZodNullable<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * Emitted when a web (cloud) task command fails. Two failure shapes share this
 * envelope:
 *
 * 1. **Generic task failure** — only `taskId` and `message` are populated
 *    (e.g. missing prompt, validation error, downstream task error).
 * 2. **`SESSION_TOKEN_MISMATCH` rejection** — emitted when a client bound to
 *    one session attempts a `web_task_*` command against a different session.
 *    In this case the payload also carries the canonical four-field contract
 *    documented in `docs/error-taxonomy.md`: `code`, `message`, `boundSessionId`,
 *    `boundSessionName`. The same four fields appear on every envelope that
 *    can carry SESSION_TOKEN_MISMATCH (`session_error`, `error`, this schema,
 *    and the HTTP 403 body) and originate from
 *    `buildSessionTokenMismatchPayload()` in `packages/server/src/handler-utils.js`.
 *
 * Note that `code` is generic — it may also be populated for non-bound-session
 * web-task failures (e.g. `WEB_TASK_PROMPT_TOO_LARGE`). The two fields that
 * are *only* populated on SESSION_TOKEN_MISMATCH are `boundSessionId` and
 * `boundSessionName`.
 */
export declare const ServerWebTaskErrorSchema: z.ZodObject<{
    type: z.ZodLiteral<"web_task_error">;
    taskId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    boundSessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    boundSessionName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const ServerWebTaskListSchema: z.ZodObject<{
    type: z.ZodLiteral<"web_task_list">;
    tasks: z.ZodArray<z.ZodObject<{
        taskId: z.ZodString;
        prompt: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
            pending: "pending";
            completed: "completed";
        }>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
        result: z.ZodNullable<z.ZodString>;
        error: z.ZodNullable<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerExtensionMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"extension_message">;
    provider: z.ZodString;
    subtype: z.ZodString;
    data: z.ZodUnknown;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerEvaluateDraftResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"evaluate_draft_result">;
    requestId: z.ZodNullable<z.ZodString>;
    verdict: z.ZodEnum<{
        forward: "forward";
        rewrite: "rewrite";
        clarify: "clarify";
    }>;
    rewritten: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    clarification: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reasoning: z.ZodString;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"evaluate_draft_result">;
    requestId: z.ZodNullable<z.ZodString>;
    error: z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        status: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    verdict: z.ZodOptional<z.ZodNever>;
    rewritten: z.ZodOptional<z.ZodNever>;
    clarification: z.ZodOptional<z.ZodNever>;
    reasoning: z.ZodOptional<z.ZodNever>;
}, z.core.$strip>]>;
export declare const ServerEvaluatorRewriteSchema: z.ZodObject<{
    type: z.ZodLiteral<"evaluator_rewrite">;
    sessionId: z.ZodString;
    originalDraft: z.ZodString;
    rewritten: z.ZodString;
    reasoning: z.ZodString;
    evaluatorIterationId: z.ZodString;
}, z.core.$strip>;
export declare const ServerEvaluatorClarifySchema: z.ZodObject<{
    type: z.ZodLiteral<"evaluator_clarify">;
    sessionId: z.ZodString;
    originalDraft: z.ZodString;
    clarification: z.ZodString;
    reasoning: z.ZodString;
    evaluatorIterationId: z.ZodString;
    evaluatorIteration: z.ZodNumber;
}, z.core.$strip>;
