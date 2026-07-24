/**
 * Streaming + tool-call wire: stream start/delta/end, tool start/result/input-delta, model/evaluator/preamble changes, agent lifecycle, background-work snapshots.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
import type { ServerPermissionRequestMessage } from './messages.ts';
export declare const ServerStreamStartSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_start">;
    messageId: z.ZodString;
    serverTs: z.ZodOptional<z.ZodNumber>;
    thinking: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ServerStreamDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_delta">;
    messageId: z.ZodString;
    delta: z.ZodString;
    serverTs: z.ZodOptional<z.ZodNumber>;
    thinking: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ServerStreamEndSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_end">;
    messageId: z.ZodString;
    serverTs: z.ZodOptional<z.ZodNumber>;
    thinking: z.ZodOptional<z.ZodBoolean>;
    thinkingDurationMs: z.ZodOptional<z.ZodNumber>;
    thinkingTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/**
 * #6768 — structured payload for a `compact_boundary` system event (the
 * Agent SDK/CLI's compaction-boundary marker, emitted on both auto-compact
 * near the context limit and a manual `/compact`). By producer convention
 * (not a schema-enforced constraint — see the sibling `subtype` field's
 * comment on `ServerMessageSchema`), carried on
 * `ServerMessageSchema.compactMetadata` alongside `messageType === 'system'`
 * and `subtype === 'compact_boundary'`. Mirrors
 * the SDK's `SDKCompactBoundaryMessage.compact_metadata` shape (camelCased),
 * minus `preserved_segment` (an internal resume-relink detail with no
 * client-facing use).
 *
 * `preTokens`/`postTokens`/`durationMs` are nullable rather than optional:
 * the server always emits the field once it recognizes a compact_boundary
 * event, using `null` for any sub-field the SDK/CLI itself omitted, so
 * clients get a stable shape to pattern-match against instead of needing an
 * `in` check per field.
 */
export declare const ServerCompactMetadataSchema: z.ZodObject<{
    trigger: z.ZodEnum<{
        auto: "auto";
        manual: "manual";
    }>;
    preTokens: z.ZodNullable<z.ZodNumber>;
    postTokens: z.ZodNullable<z.ZodNumber>;
    durationMs: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/**
 * #6845 — structured payload for an `mcp_prompt_expansion` system event. When a
 * user sends `/mcp__<server>__<prompt>`, the server intercepts it, calls the
 * MCP server's `prompts/get`, and injects the returned SERVER-CONTROLLED
 * messages as the user turn to the model — but the transcript only shows the
 * raw slash command the user typed. This marker surfaces what was ACTUALLY sent
 * so the transcript is honest, with explicit provenance (`server`/`prompt`) so
 * the content is never mistaken for user-typed text (a trusted-but-verbose, or
 * later-compromised, MCP server could inject surprising content).
 *
 * Carried on `ServerMessageSchema.mcpPromptExpansion` alongside
 * `messageType === 'system'` and `subtype === 'mcp_prompt_expansion'` — the
 * same optional-field-on-the-existing-`message`-envelope convention as
 * `compactMetadata` (no new wire message type). `text` is the (bounded) injected
 * content; `truncated` flags that the producer capped a larger expansion for
 * display (the FULL text still reached the model). Name fields are length-capped
 * and `text` bounded so a malformed producer can't flood the wire.
 */
export declare const ServerMcpPromptExpansionSchema: z.ZodObject<{
    server: z.ZodString;
    prompt: z.ZodString;
    text: z.ZodString;
    truncated: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"message">;
    messageType: z.ZodString;
    content: z.ZodString;
    tool: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    options: z.ZodOptional<z.ZodAny>;
    timestamp: z.ZodNumber;
    code: z.ZodOptional<z.ZodString>;
    subtype: z.ZodOptional<z.ZodString>;
    compactMetadata: z.ZodOptional<z.ZodObject<{
        trigger: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        preTokens: z.ZodNullable<z.ZodNumber>;
        postTokens: z.ZodNullable<z.ZodNumber>;
        durationMs: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    mcpPromptExpansion: z.ZodOptional<z.ZodObject<{
        server: z.ZodString;
        prompt: z.ZodString;
        text: z.ZodString;
        truncated: z.ZodBoolean;
    }, z.core.$strip>>;
    attemptedResumeId: z.ZodOptional<z.ZodString>;
    stdout: z.ZodOptional<z.ZodString>;
    stderr: z.ZodOptional<z.ZodString>;
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
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ServerToolInputDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_input_delta">;
    messageId: z.ZodString;
    toolUseId: z.ZodString;
    partialJson: z.ZodString;
}, z.core.$strip>;
/**
 * #6769: end-of-turn context-window OCCUPANCY snapshot — how many tokens the
 * conversation currently occupies in the model's context window.
 *
 * Named `contextOccupancy` on the wire deliberately: the sibling `usage`
 * field (client-side `contextUsage` state) is the per-turn BILLING aggregate
 * summed across every agent-loop round (a 5-round tool-use turn re-reads the
 * history from cache 5×, so its `cache_read` is ≈5× the real window fill —
 * see byok-session.js #4056). `contextOccupancy` is a snapshot of the window
 * state after the turn, safe to meter against the window; sharing the
 * `contextUsage` name across those two different quantities was a naming trap
 * (#6816 review).
 *
 * Sources (`source`):
 *   - 'context-usage-api'   — claude-sdk: the Agent SDK's `getContextUsage()`
 *     control response (the same number Claude Code's own /context shows).
 *     Carries `maxTokens` (raw window) and the real `autoCompactThreshold`
 *     (in TOKENS) + `isAutoCompactEnabled`.
 *   - 'final-round-prompt'  — the byok agent loop: the FINAL round's
 *     individual `input_tokens + cache_read_input_tokens +
 *     cache_creation_input_tokens`, which is that round's true prompt size
 *     (= conversation size). No threshold — clients apply a documented
 *     presentation reserve and label the value as estimated. Emitted by
 *     ClaudeByokSession AND the subclasses that reuse its agent loop
 *     (docker-byok, deepseek, ollama, anthropic-compatible) WHENEVER their
 *     endpoint reports per-round usage — an endpoint that reports none
 *     omits the field.
 *
 * Providers with no occupancy signal at all (claude-cli, claude-tui, codex,
 * gemini, …) omit the field entirely; clients render their unknown/dash
 * state rather than a fabricated number.
 */
export declare const ServerContextOccupancySnapshotSchema: z.ZodObject<{
    totalTokens: z.ZodNumber;
    maxTokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    autoCompactThreshold: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    isAutoCompactEnabled: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    source: z.ZodOptional<z.ZodEnum<{
        "context-usage-api": "context-usage-api";
        "final-round-prompt": "final-round-prompt";
    }>>;
}, z.core.$strip>;
export declare const ServerResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"result">;
    cost: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    duration: z.ZodOptional<z.ZodNumber>;
    usage: z.ZodOptional<z.ZodAny>;
    sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    queueLength: z.ZodOptional<z.ZodNumber>;
    contextOccupancy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        totalTokens: z.ZodNumber;
        maxTokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        autoCompactThreshold: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        isAutoCompactEnabled: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        source: z.ZodOptional<z.ZodEnum<{
            "context-usage-api": "context-usage-api";
            "final-round-prompt": "final-round-prompt";
        }>>;
    }, z.core.$strip>>>;
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
export declare const ServerSessionPreambleChangedSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preamble_changed">;
    sessionId: z.ZodString;
    value: z.ZodString;
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
    provider: z.ZodOptional<z.ZodNullable<z.ZodString>>;
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
export declare const ServerPermissionExpiredSchema: z.ZodObject<{
    type: z.ZodLiteral<"permission_expired">;
    requestId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
}, z.core.$strip>;
export declare const ServerPermissionResolvedSchema: z.ZodObject<{
    type: z.ZodLiteral<"permission_resolved">;
    requestId: z.ZodString;
    decision: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * #6543 (IDE P3, feature B) — reply to a `get_permission_input`. The
 * `permission_request` broadcast truncates `input` at ~10K (secret-safe), so a
 * client building a per-hunk pre-write diff PULLS the full (still
 * secret-redacted) tool input by requestId. `found` is false when the request
 * is unknown, already resolved, or belongs to another session (with `error`);
 * `input`/`tool` are present only when `found`. Session-bound: the server only
 * returns input for a permission the requesting client's session owns.
 */
export declare const ServerPermissionInputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"permission_input">;
    requestId: z.ZodString;
    found: z.ZodLiteral<true>;
    tool: z.ZodOptional<z.ZodString>;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"permission_input">;
    requestId: z.ZodString;
    found: z.ZodLiteral<false>;
    error: z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>], "found">;
/**
 * #6772 — one entry in the server's permission audit trail (permission-audit.js
 * ring buffer). Heterogeneous shapes share a `type` discriminator; the per-type
 * fields are all optional so a single object covers every kind. Known kinds:
 *   - `mode_change`      — previousMode / newMode
 *   - `whitelist_change` — rules (the new session-rule set)
 *   - `decision`         — requestId / decision (allow|deny|allowAlways) / reason
 *     (`reason:'persisted_rule'` — #6830 — is a decision entry with NO human
 *     responder: a durable project rule auto-approved the tool with no prompt
 *     ever shown; `clientId` is null and there is no requestId. These are
 *     COALESCED server-side per (sessionId, tool, projectKey) — `count` is
 *     the number of coalesced approvals, `firstAt` the first one's time,
 *     `timestamp` the latest — so a rule matching at machine speed can never
 *     flood the audit ring; see permission-audit.js logPersistedRuleApproval)
 * The entry `type` is a PLAIN `z.string()` (PR #6836 review), for two reasons:
 *   1. Forward compatibility — a closed enum would fail the WHOLE payload parse
 *      the moment the server adds a new audit kind; clients render unknown kinds
 *      generically instead. (NOT `z.enum(...).catch(...)` — the repo's #6436 rule:
 *      `.catch` on a strict-reject field swallows ALL field errors.)
 *   2. It is not `z.literal`, so the protocol type-coverage lint — which greps
 *      `type: z.literal('…')` for server→client MESSAGE types — does not mistake
 *      an audit-entry kind for a wire message type.
 * `.passthrough()` tolerates future audit fields without a schema bump; consumers
 * read defensively.
 */
export declare const ServerPermissionAuditEntrySchema: z.ZodObject<{
    type: z.ZodString;
    clientId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    timestamp: z.ZodNumber;
    previousMode: z.ZodOptional<z.ZodString>;
    newMode: z.ZodOptional<z.ZodString>;
    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
        tool: z.ZodString;
        decision: z.ZodString;
    }, z.core.$loose>>>;
    requestId: z.ZodOptional<z.ZodString>;
    decision: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    tool: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    persist: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    projectKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    count: z.ZodOptional<z.ZodNumber>;
    firstAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
/**
 * #6772 — reply to a `query_permission_audit` pull: the recent permission audit
 * entries (mode changes, session-rule changes, allow/deny decisions) matching
 * the query's optional sessionId / auditType / since / limit filters. First
 * client caller is the dashboard's per-session "Permission history" view;
 * dashboard-only for v1 (the mobile app's PermissionHistory screen derives its
 * summary from the live chat transcript, not this wire query).
 */
export declare const ServerPermissionAuditResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"permission_audit_result">;
    entries: z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        clientId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        sessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timestamp: z.ZodNumber;
        previousMode: z.ZodOptional<z.ZodString>;
        newMode: z.ZodOptional<z.ZodString>;
        rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
            tool: z.ZodString;
            decision: z.ZodString;
        }, z.core.$loose>>>;
        requestId: z.ZodOptional<z.ZodString>;
        decision: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        tool: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        persist: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        projectKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        count: z.ZodOptional<z.ZodNumber>;
        firstAt: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$strip>;
/**
 * Single validated builder for the `permission_request` wire message (#6031).
 *
 * `permission_request` is the most security-relevant message on the wire — a
 * dropped/misnamed binding field (e.g. `sessionId`) routes a prompt to the
 * wrong session or strands it on the legacy resolver. It used to be hand-built
 * as a raw object literal at 4+ emit sites (ws-permissions.js HTTP-fallback +
 * two resend paths, event-normalizer.js), each free to drift its field set.
 *
 * This factory is the one place those sites construct the message, and it
 * `safeParse`-validates against `ServerPermissionRequestSchema` so field drift
 * (a missing required field, a wrong type) is caught instead of silently
 * shipping a malformed prompt.
 *
 * Field hygiene:
 *  - `type` is always set here — callers never pass it.
 *  - Optional fields (`description`, `remainingMs`, `sessionId`) are omitted
 *    entirely (absent, not `null`/`undefined`) when not provided, matching the
 *    existing wire shape (clients fall back to the active session when
 *    `sessionId` is absent).
 *  - `input` is passed through as-is. Callers are responsible for redaction
 *    (#6038: `description: redactValue(...)`, `input: sanitizeToolInput(...)`)
 *    BEFORE handing values to this builder — it is a shape guard, not a
 *    redaction layer, and must not re-process already-redacted values.
 *
 * Validation failures throw a descriptive `Error` (with the Zod issues) rather
 * than returning a partial object, so a drift bug surfaces loudly at the emit
 * site in dev/test/CI instead of corrupting the client prompt.
 */
export declare function buildPermissionRequestMessage(fields: {
    requestId: string;
    tool: string;
    input: unknown;
    description?: string;
    remainingMs?: number;
    sessionId?: string;
}): ServerPermissionRequestMessage;
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
 * #5016 — Task subagent intermediate progress event.
 *
 * Carries a re-emit of a Task subagent's intermediate wire event
 * (`tool_start` / `tool_result` / `tool_input_delta` / `stream_delta`)
 * tagged with the parent Task tool_use id so the dashboard can render
 * the child's progress as nested sub-bubbles inside the parent's Task
 * tool_call bubble.
 *
 * `parentToolUseId` — the id of the parent's `Task` tool_use block
 *   (same id used for `agent_spawned` / `agent_completed`). Consumers
 *   key the nested sub-bubble container off this id.
 * `eventType` — the child's original event name (e.g. `'tool_start'`).
 *   Consumers switch on this to render the wire event in the same
 *   shape they would for a top-level event.
 * `payload` — the verbatim child event payload. Fields are best-effort;
 *   renderers MUST treat absence as a no-op.
 *
 * Nested Task: when a Task subagent itself dispatches a Task, the
 * grand-child's events are forwarded up the chain re-tagged with the
 * IMMEDIATE parent's `toolUseId`. The dashboard sees a flat stream
 * — nested-nested rendering is intentionally not in v2.
 */
export declare const ServerAgentEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"agent_event">;
    parentToolUseId: z.ZodString;
    eventType: z.ZodString;
    payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
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
export declare const ServerShellPendingApprovalSchema: z.ZodObject<{
    type: z.ZodLiteral<"shell_pending_approval">;
    approvalId: z.ZodString;
    hint: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerTerminalOutputSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_output">;
    sessionId: z.ZodString;
    data: z.ZodString;
}, z.core.$strip>;
export declare const ServerTerminalSizeSchema: z.ZodObject<{
    type: z.ZodLiteral<"terminal_size">;
    sessionId: z.ZodString;
    cols: z.ZodNumber;
    rows: z.ZodNumber;
}, z.core.$strip>;
