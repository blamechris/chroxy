/**
 * Per-session signals: focus/inactivity, multi-question, MCP servers, plan mode, cumulative usage, session list/restore/persist/stopped, provider list, auth bootstrap, tunnel url, skills list + skill-trust handshake.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
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
export declare const ServerMultiQuestionInterventionSchema: z.ZodObject<{
    type: z.ZodLiteral<"multi_question_intervention">;
    toolUseId: z.ZodString;
    questionCount: z.ZodNumber;
    reason: z.ZodLiteral<"multi_question">;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerMcpServersSchema: z.ZodObject<{
    type: z.ZodLiteral<"mcp_servers">;
    sessionId: z.ZodOptional<z.ZodString>;
    servers: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        status: z.ZodString;
        enabled: z.ZodOptional<z.ZodBoolean>;
        canToggle: z.ZodOptional<z.ZodBoolean>;
        authUrl: z.ZodOptional<z.ZodString>;
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
    billingClass: z.ZodOptional<z.ZodEnum<{
        "api-key": "api-key";
        subscription: "subscription";
        "programmatic-credit": "programmatic-credit";
    }>>;
    capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    worktree: z.ZodOptional<z.ZodBoolean>;
    repoCwd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isolation: z.ZodOptional<z.ZodString>;
    promptEvaluator: z.ZodOptional<z.ZodBoolean>;
    promptEvaluatorSkipPattern: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull]>>;
    chroxyContextHint: z.ZodOptional<z.ZodBoolean>;
    sessionPreamble: z.ZodOptional<z.ZodString>;
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
    orchestrationRunId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    orchestrationRole: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    codexSandbox: z.ZodOptional<z.ZodEnum<{
        "read-only": "read-only";
        "workspace-write": "workspace-write";
        "danger-full-access": "danger-full-access";
    }>>;
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
        billingClass: z.ZodOptional<z.ZodEnum<{
            "api-key": "api-key";
            subscription: "subscription";
            "programmatic-credit": "programmatic-credit";
        }>>;
        capabilities: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        worktree: z.ZodOptional<z.ZodBoolean>;
        repoCwd: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isolation: z.ZodOptional<z.ZodString>;
        promptEvaluator: z.ZodOptional<z.ZodBoolean>;
        promptEvaluatorSkipPattern: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull]>>;
        chroxyContextHint: z.ZodOptional<z.ZodBoolean>;
        sessionPreamble: z.ZodOptional<z.ZodString>;
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
        orchestrationRunId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        orchestrationRole: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        codexSandbox: z.ZodOptional<z.ZodEnum<{
            "read-only": "read-only";
            "workspace-write": "workspace-write";
            "danger-full-access": "danger-full-access";
        }>>;
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
/**
 * #5714 / #5701: emitted when a session-list mutation (create / rename / destroy)
 * could not be flushed to disk — disk full, locked file, read-only home. The
 * write is atomic so on-disk state isn't corrupted, but the in-memory change
 * will be lost on the next restart. Clients surface this as an error banner so
 * the operator knows their change wasn't saved (instead of silently believing it
 * was). `name` is null when the entry was already removed before the flush
 * (destroy path) and no label could be resolved.
 */
export declare const ServerSessionPersistFailedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_persist_failed">;
    sessionId: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #4756: user-initiated Stop confirmation broadcast. CliSession emits a
 * `stopped` event from `_handleChildClose` when the child process exits
 * cleanly after a Stop click (interrupt() set `_intentionalStop`). The
 * SessionManager + ws-forwarding paths surface it as this `session_stopped`
 * wire message so clients can render a quiet "Session stopped." confirmation
 * — distinct from `session_error` (crash) which fires for unexpected exits
 * that trigger the auto-respawn path.
 *
 * `sessionId` is injected by `_broadcastToSession` on the multi-session
 * path, so it's optional on the schema for consumers that construct the
 * message without it pre-broadcast (matches the `cost_update` / `session_usage`
 * pattern). The legacy-cli path doesn't carry a sessionId at all.
 *
 * `code` is the child process exit code (number). Typically 0 on a clean
 * SIGINT exit, but kept on the wire so clients can render the numeric code
 * for non-zero exits (e.g. 143 = SIGTERM). Optional because future providers
 * that adopt the `stopped` event for parity (see #4756 follow-up) may not
 * have a meaningful exit code (e.g. in-process SDK session).
 */
export declare const ServerSessionStoppedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_stopped">;
    sessionId: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerConversationIdSchema: z.ZodObject<{
    type: z.ZodLiteral<"conversation_id">;
    sessionId: z.ZodOptional<z.ZodString>;
    conversationId: z.ZodString;
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
            billingClass: z.ZodOptional<z.ZodEnum<{
                "api-key": "api-key";
                subscription: "subscription";
                "programmatic-credit": "programmatic-credit";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerAuthBootstrapSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth_bootstrap">;
    providers: z.ZodDefault<z.ZodArray<z.ZodObject<{
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
            billingClass: z.ZodOptional<z.ZodEnum<{
                "api-key": "api-key";
                subscription: "subscription";
                "programmatic-credit": "programmatic-credit";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    slashCommands: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    agents: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    sessionId: z.ZodOptional<z.ZodString>;
    tunnelUrl: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ServerTunnelUrlChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"tunnel_url_changed">;
    url: z.ZodString;
    previousUrl: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const ServerSkillsListSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_list">;
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodEnum<{
            repo: "repo";
            global: "global";
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
export declare const ServerSessionActivitySchema: z.ZodObject<{
    type: z.ZodLiteral<"session_activity">;
    sessionId: z.ZodString;
    isBusy: z.ZodBoolean;
    lastCost: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerSessionErrorSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_error">;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    recoverable: z.ZodOptional<z.ZodBoolean>;
    reason: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    boundSessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    boundSessionName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    primaryClientId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
export declare const ServerSessionUpdatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_updated">;
    sessionId: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
export declare const ServerCheckpointCreatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkpoint_created">;
    sessionId: z.ZodString;
    checkpoint: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        messageCount: z.ZodNumber;
        createdAt: z.ZodNumber;
        hasGitSnapshot: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ServerCheckpointListSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkpoint_list">;
    sessionId: z.ZodNullable<z.ZodString>;
    checkpoints: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        messageCount: z.ZodNumber;
        createdAt: z.ZodNumber;
        hasGitSnapshot: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerCheckpointRestoredSchema: z.ZodObject<{
    type: z.ZodLiteral<"checkpoint_restored">;
    checkpointId: z.ZodString;
    newSessionId: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    filesOnly: z.ZodOptional<z.ZodBoolean>;
    mode: z.ZodOptional<z.ZodEnum<{
        files: "files";
        conversation: "conversation";
        both: "both";
    }>>;
}, z.core.$strip>;
export declare const ServerSessionWarningSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_warning">;
    sessionId: z.ZodString;
    name: z.ZodString;
    reason: z.ZodLiteral<"idle_timeout">;
    message: z.ZodString;
    remainingMs: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerSessionTimeoutSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_timeout">;
    sessionId: z.ZodString;
    name: z.ZodString;
    idleMs: z.ZodNumber;
}, z.core.$strip>;
