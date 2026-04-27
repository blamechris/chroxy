/**
 * Server → Client message Zod schemas.
 *
 * Moved from packages/server/src/ws-schemas.js to enable shared validation
 * across server, app, and dashboard.
 */
import { z } from 'zod';
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
}, z.core.$loose>;
export declare const ServerAuthFailSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth_fail">;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const ServerPairFailSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_fail">;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const ServerClaudeReadySchema: z.ZodObject<{
    type: z.ZodLiteral<"claude_ready">;
}, z.core.$strip>;
export declare const ServerStreamStartSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_start">;
    messageId: z.ZodString;
}, z.core.$strip>;
export declare const ServerStreamDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_delta">;
    messageId: z.ZodString;
    delta: z.ZodString;
}, z.core.$strip>;
export declare const ServerStreamEndSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_end">;
    messageId: z.ZodString;
}, z.core.$strip>;
export declare const ServerMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"message">;
    messageType: z.ZodString;
    content: z.ZodString;
    tool: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    options: z.ZodOptional<z.ZodAny>;
    timestamp: z.ZodNumber;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerToolStartSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_start">;
    messageId: z.ZodString;
    toolUseId: z.ZodString;
    tool: z.ZodString;
    input: z.ZodAny;
    serverName: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerToolResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    result: z.ZodAny;
    truncated: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ServerResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"result">;
    cost: z.ZodOptional<z.ZodNumber>;
    duration: z.ZodOptional<z.ZodNumber>;
    usage: z.ZodOptional<z.ZodAny>;
    sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const ServerModelChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"model_changed">;
    model: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerPermissionModeChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"permission_mode_changed">;
    mode: z.ZodString;
}, z.core.$strip>;
export declare const ServerPermissionRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"permission_request">;
    requestId: z.ZodString;
    tool: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    input: z.ZodAny;
    remainingMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerUserQuestionSchema: z.ZodObject<{
    type: z.ZodLiteral<"user_question">;
    toolUseId: z.ZodString;
    questions: z.ZodArray<z.ZodAny>;
}, z.core.$strip>;
export declare const ServerAgentBusySchema: z.ZodObject<{
    type: z.ZodLiteral<"agent_busy">;
}, z.core.$strip>;
export declare const ServerAgentIdleSchema: z.ZodObject<{
    type: z.ZodLiteral<"agent_idle">;
}, z.core.$strip>;
export declare const ServerAgentSpawnedSchema: z.ZodObject<{
    type: z.ZodLiteral<"agent_spawned">;
    toolUseId: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    startedAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerAgentCompletedSchema: z.ZodObject<{
    type: z.ZodLiteral<"agent_completed">;
    toolUseId: z.ZodString;
}, z.core.$strip>;
export declare const ServerClientFocusChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"client_focus_changed">;
    clientId: z.ZodString;
    sessionId: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerMcpServersSchema: z.ZodObject<{
    type: z.ZodLiteral<"mcp_servers">;
    servers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        status: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerPlanStartedSchema: z.ZodObject<{
    type: z.ZodLiteral<"plan_started">;
}, z.core.$strip>;
export declare const ServerPlanReadySchema: z.ZodObject<{
    type: z.ZodLiteral<"plan_ready">;
    allowedPrompts: z.ZodOptional<z.ZodArray<z.ZodAny>>;
}, z.core.$strip>;
export declare const ServerSessionListSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_list">;
    sessions: z.ZodArray<z.ZodAny>;
}, z.core.$strip>;
/**
 * Emitted when a session in the persisted state file could not be restored
 * at server startup (e.g. missing env var for a Codex/Gemini provider).
 *
 * History on disk is preserved (`originalHistoryPreserved: true`) so the user
 * can retry after fixing the underlying issue. Dashboards / mobile UIs should
 * surface the failed session in a "needs attention" state with the reported
 * error and a retry affordance. See issue #2954 (Guardian FM-01).
 */
export declare const ServerSessionRestoreFailedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_restore_failed">;
    sessionId: z.ZodString;
    name: z.ZodString;
    provider: z.ZodString;
    errorCode: z.ZodString;
    errorMessage: z.ZodString;
    originalHistoryPreserved: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerProviderListSchema: z.ZodObject<{
    type: z.ZodLiteral<"provider_list">;
    providers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerSkillsListSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_list">;
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodEnum<{
            global: "global";
            repo: "repo";
        }>>;
    }, z.core.$strip>>;
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
export declare const ServerShutdownSchema: z.ZodObject<{
    type: z.ZodLiteral<"server_shutdown">;
    reason: z.ZodEnum<{
        restart: "restart";
        shutdown: "shutdown";
    }>;
    restartEtaMs: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerPongSchema: z.ZodObject<{
    type: z.ZodLiteral<"pong">;
}, z.core.$strip>;
export declare const ServerCostUpdateSchema: z.ZodObject<{
    type: z.ZodLiteral<"cost_update">;
    sessionCost: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    totalCost: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    budget: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
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
            pending: "pending";
            running: "running";
            completed: "completed";
            failed: "failed";
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
            pending: "pending";
            running: "running";
            completed: "completed";
            failed: "failed";
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
            pending: "pending";
            running: "running";
            completed: "completed";
            failed: "failed";
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
export type ServerAuthOkMessage = z.infer<typeof ServerAuthOkSchema>;
export type ServerStreamDeltaMessage = z.infer<typeof ServerStreamDeltaSchema>;
export type ServerPermissionRequestMessage = z.infer<typeof ServerPermissionRequestSchema>;
export type ServerErrorMessage = z.infer<typeof ServerErrorSchema>;
export type ServerCostUpdateMessage = z.infer<typeof ServerCostUpdateSchema>;
export type ServerExtensionMessage = z.infer<typeof ServerExtensionMessageSchema>;
export type ServerSkillsListMessage = z.infer<typeof ServerSkillsListSchema>;
