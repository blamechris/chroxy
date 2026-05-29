/**
 * Server → Client message Zod schemas.
 *
 * Moved from packages/server/src/ws-schemas.js to enable shared validation
 * across server, app, and dashboard.
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
export declare const ServerToolInputDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_input_delta">;
    messageId: z.ZodString;
    toolUseId: z.ZodString;
    partialJson: z.ZodString;
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
export declare const ServerPromptEvaluatorChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"prompt_evaluator_changed">;
    sessionId: z.ZodString;
    value: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerPromptEvaluatorSkipPatternChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"prompt_evaluator_skip_pattern_changed">;
    sessionId: z.ZodString;
    value: z.ZodUnion<readonly [z.ZodString, z.ZodNull]>;
}, z.core.$strip>;
export declare const ServerChroxyContextHintChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"chroxy_context_hint_changed">;
    sessionId: z.ZodString;
    value: z.ZodBoolean;
}, z.core.$strip>;
/**
 * Schema for one entry of `available_models.models` (#3138).
 *
 * Matches the inferred `ModelInfo` type used by the dashboard / app model
 * picker. `id`, `label`, and `fullId` are required strings; `contextWindow`
 * is an optional positive number. The handler in `@chroxy/store-core` does
 * additional empty-string rejection / capitalisation; this schema is the
 * minimum well-formed shape for a wire-level `passthrough()` parse.
 *
 * **Established Zod-handler pattern (#3138)** — first migrated handler that
 * pulls its element validation up to `@chroxy/protocol`. Future handler
 * migrations should mirror this layout: declare a Zod schema next to the
 * other server schemas, parse with `safeParse` inside the store-core
 * handler, drop malformed entries fail-soft, and retain the handler's
 * existing return shape so call sites need no changes.
 */
export declare const ServerAvailableModelsEntrySchema: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    fullId: z.ZodString;
    contextWindow: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
export declare const ServerAvailableModelsSchema: z.ZodObject<{
    type: z.ZodLiteral<"available_models">;
    models: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    defaultModel: z.ZodOptional<z.ZodString>;
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
    sessionId: z.ZodOptional<z.ZodString>;
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
/**
 * #4307 — one entry per backgrounded `Bash` shell the session is still
 * waiting on. Pushed when the agent dispatches a `Bash` tool call with
 * `run_in_background: true` (the matching tool_result carries the
 * canonical `Command running in background with ID: <id>` text); cleared
 * when the agent calls `BashOutput` (acknowledged) or the session is
 * destroyed.
 *
 * `shellId` is the short alphanumeric token Claude prints (e.g.
 * `brk57kt6pm`). `command` is the original Bash command text the agent
 * dispatched, stashed at tool_use time so the dashboard can render
 * "waiting on `<command>`" without a separate roundtrip. `startedAt` is
 * the server-side wall-clock at the moment the tool_result was parsed —
 * lets the dashboard surface elapsed wait time without trusting the
 * client clock.
 */
export declare const ServerPendingBackgroundShellSchema: z.ZodObject<{
    shellId: z.ZodString;
    command: z.ZodString;
    startedAt: z.ZodNumber;
}, z.core.$strip>;
/**
 * #4307 — transient event: the pending-background-shells snapshot for a
 * session changed. Emitted both on push (a new `run_in_background` shell
 * was registered) and on clear (`BashOutput` acknowledged or the session
 * was destroyed). The full snapshot is on the wire (not a delta) so a
 * late-joining client sees canonical state.
 *
 * Why a full snapshot instead of an event per delta: pending work is a
 * tiny set (typically 0 or 1 entries) and the event fires rarely, so
 * the wire cost is negligible. A delta protocol would force every
 * client to also reconcile against `pendingBackgroundShells` on the
 * `session_list` snapshot — the full-snapshot shape avoids that.
 *
 * Late joiners: `session_list` carries the same `pendingBackgroundShells`
 * field on each entry, so a client that connects between
 * `background_work_changed` events catches up via the next snapshot.
 */
export declare const ServerBackgroundWorkChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"background_work_changed">;
    sessionId: z.ZodString;
    pending: z.ZodArray<z.ZodObject<{
        shellId: z.ZodString;
        command: z.ZodString;
        startedAt: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerClientFocusChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"client_focus_changed">;
    clientId: z.ZodString;
    sessionId: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerInactivityWarningSchema: z.ZodObject<{
    type: z.ZodLiteral<"inactivity_warning">;
    messageId: z.ZodString;
    idleMs: z.ZodNumber;
    prefab: z.ZodString;
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
export declare const CumulativeUsageSchema: z.ZodObject<{
    inputTokens: z.ZodNumber;
    outputTokens: z.ZodNumber;
    cacheReadTokens: z.ZodNumber;
    cacheCreationTokens: z.ZodNumber;
    costUsd: z.ZodNumber;
    turnsBilled: z.ZodNumber;
}, z.core.$strip>;
/**
 * One entry in a `session_list` payload (and the equivalent shape returned
 * by `SessionManager.listSessions()` server-side).
 *
 * `passthrough()` so future field additions don't break older clients that
 * haven't bumped the schema yet — only the keys we care about for cross-
 * package validation are listed explicitly. New clients can rely on the
 * documented optional fields below; older clients see them as `undefined`
 * and fall back to their pre-existing defaults.
 *
 * Documented hydration fields:
 *   - `stdinForwardingDisabled` (#3540): latched stdin_disabled flag so
 *     reconnecting clients see the disabled state without waiting for a
 *     fresh `error` event.
 *   - `stdinDroppedBytes` / `stdinDroppedCount` (#3573): cumulative
 *     `stdin_dropped` byte / drop counters maintained for the session
 *     lifetime by SdkSession. Lets a dashboard / mobile client connecting
 *     after one or more drops happened paint the "X bytes lost over N
 *     drops" indicator immediately, instead of waiting for the next drop
 *     to fire the runtime `stdin_dropped_totals` event. Non-SDK providers
 *     (CliSession, Codex, Gemini) round-trip as `0`.
 */
export declare const ServerSessionListEntrySchema: z.ZodObject<{
    sessionId: z.ZodString;
    name: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    permissionMode: z.ZodOptional<z.ZodString>;
    isBusy: z.ZodOptional<z.ZodBoolean>;
    createdAt: z.ZodOptional<z.ZodNumber>;
    lastActivityAt: z.ZodOptional<z.ZodNumber>;
    conversationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    provider: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    worktree: z.ZodOptional<z.ZodBoolean>;
    repoCwd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isolation: z.ZodOptional<z.ZodString>;
    promptEvaluator: z.ZodOptional<z.ZodBoolean>;
    promptEvaluatorSkipPattern: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull]>>;
    chroxyContextHint: z.ZodOptional<z.ZodBoolean>;
    stdinForwardingDisabled: z.ZodOptional<z.ZodBoolean>;
    stdinDroppedBytes: z.ZodOptional<z.ZodNumber>;
    stdinDroppedCount: z.ZodOptional<z.ZodNumber>;
    cumulativeUsage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheCreationTokens: z.ZodNumber;
        costUsd: z.ZodNumber;
        turnsBilled: z.ZodNumber;
    }, z.core.$strip>>;
    pendingBackgroundShells: z.ZodOptional<z.ZodArray<z.ZodObject<{
        shellId: z.ZodString;
        command: z.ZodString;
        startedAt: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$loose>;
export declare const ServerSessionListSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_list">;
    sessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        name: z.ZodString;
        cwd: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        permissionMode: z.ZodOptional<z.ZodString>;
        isBusy: z.ZodOptional<z.ZodBoolean>;
        createdAt: z.ZodOptional<z.ZodNumber>;
        lastActivityAt: z.ZodOptional<z.ZodNumber>;
        conversationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        provider: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        worktree: z.ZodOptional<z.ZodBoolean>;
        repoCwd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isolation: z.ZodOptional<z.ZodString>;
        promptEvaluator: z.ZodOptional<z.ZodBoolean>;
        promptEvaluatorSkipPattern: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull]>>;
        chroxyContextHint: z.ZodOptional<z.ZodBoolean>;
        stdinForwardingDisabled: z.ZodOptional<z.ZodBoolean>;
        stdinDroppedBytes: z.ZodOptional<z.ZodNumber>;
        stdinDroppedCount: z.ZodOptional<z.ZodNumber>;
        cumulativeUsage: z.ZodOptional<z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheCreationTokens: z.ZodNumber;
            costUsd: z.ZodNumber;
            turnsBilled: z.ZodNumber;
        }, z.core.$strip>>;
        pendingBackgroundShells: z.ZodOptional<z.ZodArray<z.ZodObject<{
            shellId: z.ZodString;
            command: z.ZodString;
            startedAt: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$loose>>;
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
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    permissionMode: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    errorCode: z.ZodString;
    errorMessage: z.ZodString;
    originalHistoryPreserved: z.ZodBoolean;
    historyLength: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerProviderListSchema: z.ZodObject<{
    type: z.ZodLiteral<"provider_list">;
    providers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        auth: z.ZodOptional<z.ZodObject<{
            ready: z.ZodBoolean;
            source: z.ZodEnum<{
                none: "none";
                env: "env";
                oauth: "oauth";
            }>;
            envVar: z.ZodNullable<z.ZodString>;
            envVars: z.ZodArray<z.ZodString>;
            hint: z.ZodString;
            detail: z.ZodString;
        }, z.core.$strip>>;
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
        activation: z.ZodOptional<z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>>;
        active: z.ZodOptional<z.ZodBoolean>;
        version: z.ZodOptional<z.ZodString>;
        hashPrefix: z.ZodOptional<z.ZodString>;
        firstSeen: z.ZodOptional<z.ZodString>;
        lastVerified: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Skill content-hash mismatch event (#3234).
 *
 * Emitted when the loader detects that a skill's body has changed since the
 * SkillsTrustStore (#3204) recorded its first-seen hash. Carries only 8-char
 * hash prefixes on the wire — the full SHA-256 never leaves the server,
 * matching the sanitised warn-log format from #3215.
 *
 * `mode` mirrors the active trust mode at detection time:
 *   - `'warn'`  — the skill still loaded; the dashboard should surface a
 *                 banner / prompt so the operator can `acceptHash` or roll
 *                 the change back.
 *   - `'block'` — the skill was filtered out of the active set; stronger UX
 *                 (modal / red badge) is appropriate.
 *
 * `sessionId` is the session this skill was being loaded for, or `null` for
 * legacy single-CLI mode where there is no per-session scoping. Transient —
 * not replayed on reconnect, since the loader re-checks hashes every time
 * skills are scanned.
 */
export declare const ServerSkillChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_changed">;
    skillName: z.ZodString;
    sessionId: z.ZodNullable<z.ZodString>;
    oldHashPrefix: z.ZodString;
    newHashPrefix: z.ZodString;
    mode: z.ZodEnum<{
        warn: "warn";
        block: "block";
    }>;
}, z.core.$strip>;
export declare const ServerSkillActivatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_activated">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillDeactivatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_deactivated">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustAcceptedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_accepted">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_request">;
    skillName: z.ZodString;
    author: z.ZodString;
    source: z.ZodString;
    description: z.ZodString;
    path: z.ZodString;
    sessionId: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSkillTrustGrantedSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_granted">;
    sessionId: z.ZodString;
    skillName: z.ZodString;
    author: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustGrantOkSchema: z.ZodObject<{
    type: z.ZodLiteral<"skill_trust_grant_ok">;
    requestId: z.ZodNullable<z.ZodString>;
    sessionId: z.ZodString;
    skillName: z.ZodString;
    author: z.ZodString;
}, z.core.$strip>;
export declare const ServerSkillTrustGrantInvalidAuthorSchema: z.ZodObject<{
    type: z.ZodLiteral<"error">;
    requestId: z.ZodNullable<z.ZodString>;
    code: z.ZodLiteral<"INVALID_AUTHOR">;
    message: z.ZodString;
    actualAuthor: z.ZodString;
}, z.core.$strip>;
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
export type ServerAuthOkMessage = z.infer<typeof ServerAuthOkSchema>;
export type ServerStreamDeltaMessage = z.infer<typeof ServerStreamDeltaSchema>;
export type ServerPermissionRequestMessage = z.infer<typeof ServerPermissionRequestSchema>;
export type ServerErrorMessage = z.infer<typeof ServerErrorSchema>;
export type ServerErrorEnvelopeMessage = z.infer<typeof ServerErrorEnvelopeSchema>;
export type ServerCostUpdateMessage = z.infer<typeof ServerCostUpdateSchema>;
export type CumulativeUsage = z.infer<typeof CumulativeUsageSchema>;
export type ServerSessionUsageMessage = z.infer<typeof ServerSessionUsageSchema>;
export type ServerSessionCostThresholdCrossedMessage = z.infer<typeof ServerSessionCostThresholdCrossedSchema>;
export type ServerExtensionMessage = z.infer<typeof ServerExtensionMessageSchema>;
export type ServerSkillsListMessage = z.infer<typeof ServerSkillsListSchema>;
export type ServerEvaluateDraftResultMessage = z.infer<typeof ServerEvaluateDraftResultSchema>;
export type ServerEvaluatorRewriteMessage = z.infer<typeof ServerEvaluatorRewriteSchema>;
export type ServerEvaluatorClarifyMessage = z.infer<typeof ServerEvaluatorClarifySchema>;
export type ServerSkillTrustGrantOkMessage = z.infer<typeof ServerSkillTrustGrantOkSchema>;
export type ServerSkillTrustGrantInvalidAuthorMessage = z.infer<typeof ServerSkillTrustGrantInvalidAuthorSchema>;
export type ServerByokCredentialsStatusMessage = z.infer<typeof ServerByokCredentialsStatusSchema>;
