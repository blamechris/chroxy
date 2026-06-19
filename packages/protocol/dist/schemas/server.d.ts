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
export declare const ServerStreamStartSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_start">;
    messageId: z.ZodString;
    serverTs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerStreamDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_delta">;
    messageId: z.ZodString;
    delta: z.ZodString;
    serverTs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerStreamEndSchema: z.ZodObject<{
    type: z.ZodLiteral<"stream_end">;
    messageId: z.ZodString;
    serverTs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"message">;
    messageType: z.ZodString;
    content: z.ZodString;
    tool: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    options: z.ZodOptional<z.ZodAny>;
    timestamp: z.ZodNumber;
    code: z.ZodOptional<z.ZodString>;
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
}, z.core.$strip>;
export declare const ServerToolInputDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_input_delta">;
    messageId: z.ZodString;
    toolUseId: z.ZodString;
    partialJson: z.ZodString;
}, z.core.$strip>;
export declare const ServerResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"result">;
    cost: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
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
/**
 * Current schema version for the activity-tree wire contract. Carried on both
 * `activity_snapshot` and `activity_delta` so consumers can branch on it if a
 * future, additive field-set revision lands. Bump only for a deliberate shape
 * change; additive optional fields do NOT require a bump (Zod strips unknowns,
 * so older clients stay compatible).
 */
export declare const ACTIVITY_SCHEMA_VERSION = 1;
/**
 * Kind of activity entry. The session→agent→tool hierarchy is expressed via
 * `parentId`, but `kind` lets a consumer pick an icon / renderer without
 * walking the tree:
 *   - `'agent'` — a Task subagent (the `Task` tool's spawned worker). Maps to
 *     the existing `agent_spawned` / `agent_event` signal (#5016/#5060/#5061).
 *   - `'shell'` — a backgrounded `Bash` shell (`run_in_background: true`). Maps
 *     to the existing `pendingBackgroundShells` model (#4307).
 *   - `'tool'` — any other long-running tool call surfaced as its own node.
 *
 * Declared as a named enum (not inlined) so #5162/#5163 can import it for
 * exhaustive switch handling.
 */
export declare const ActivityKindSchema: z.ZodEnum<{
    tool: "tool";
    agent: "agent";
    shell: "shell";
}>;
/**
 * Lifecycle status of an activity entry:
 *   - `'running'` — actively executing.
 *   - `'blocked'` — alive but waiting on something (e.g. a pending permission
 *     prompt or user input). Distinct from `running` so the Control Room can
 *     flag "needs attention" without inferring it from elapsed time.
 *   - `'done'`   — finished successfully.
 *   - `'failed'` — finished with an error / non-zero exit.
 *
 * `done` and `failed` are terminal; `endedAt` MUST be set once an entry reaches
 * either (enforced by `ActivityEntrySchema` below).
 */
export declare const ActivityStatusSchema: z.ZodEnum<{
    running: "running";
    blocked: "blocked";
    done: "done";
    failed: "failed";
}>;
/**
 * Reference that lets a consumer locate the live output stream for an entry so
 * the Control Room can drill into it. Optional because not every entry has a
 * separately-addressable stream (a synthetic grouping node may not), and absent
 * on older servers.
 *
 * Modelled as a `{ kind, id }` pair rather than a bare string so the consumer
 * knows WHICH existing stream channel to subscribe against without parsing the
 * id:
 *   - `'tool_use'` — `id` is the tool_use id; output arrives as the existing
 *     `agent_event` stream keyed by `parentToolUseId` (#5016).
 *   - `'shell'` — `id` is the short shell token (e.g. `brk57kt6pm`); output is
 *     fetched via the existing `BashOutput` / background-shell path (#4307).
 *   - `'message'` — `id` is a `stream_start` messageId; output arrives as the
 *     existing `stream_delta` stream for that message.
 *
 * `kind` is an OPEN, non-empty string — deliberately NOT a closed `z.enum`. A
 * future server may introduce a new channel kind additively, and a strict enum
 * would reject the WHOLE activity message at an older client's schema boundary
 * (the exact opposite of this contract's forward-compat intent). With an open
 * string, an unrecognised kind parses cleanly and the consumer switches on the
 * known values below, treating anything else as "no drill-in available". The
 * three values defined today are:
 *   - `'tool_use'` — `id` is the tool_use id; output arrives as the existing
 *     `agent_event` stream keyed by `parentToolUseId` (#5016).
 *   - `'shell'` — `id` is the short shell token (e.g. `brk57kt6pm`); output is
 *     fetched via the existing `BashOutput` / background-shell path (#4307).
 *   - `'message'` — `id` is a `stream_start` messageId; output arrives as the
 *     existing `stream_delta` stream for that message.
 *
 * `ACTIVITY_OUTPUT_REF_KINDS` exports the known set so #5162/#5163 can branch
 * exhaustively without re-declaring the literals.
 */
export declare const ACTIVITY_OUTPUT_REF_KINDS: readonly ["tool_use", "shell", "message"];
export declare const ActivityOutputRefSchema: z.ZodObject<{
    kind: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>;
/**
 * The shared activity-entry shape — one node in the activity tree.
 *
 * Fields:
 *   - `id`        — stable, server-assigned id for this entry. Consumers key the
 *                   tree off it; deltas reference it; it MUST survive status
 *                   flips so an `updated` delta lands on the right node.
 *   - `kind`      — see `ActivityKindSchema`.
 *   - `label`     — human-readable description (e.g. the Task prompt summary,
 *                   the Bash command text, or the tool name). May be empty for
 *                   an entry whose label isn't known yet.
 *   - `status`    — see `ActivityStatusSchema`.
 *   - `startedAt` — server wall-clock (ms epoch) when the entry began. Server
 *                   clock so the Control Room can render elapsed time without
 *                   trusting the client clock (same rationale as #4307's
 *                   `startedAt`). Allowed to be 0 so a clock-skewed dev box
 *                   doesn't bounce the message.
 *   - `endedAt?`  — server wall-clock (ms epoch) when the entry reached a
 *                   terminal status. REQUIRED once `status` is `done`/`failed`
 *                   and FORBIDDEN while `running`/`blocked` (refined below) so
 *                   "ended but no end time" / "running but has end time" can't
 *                   reach a consumer.
 *   - `parentId?` — id of the parent entry, expressing the session→agent→tool
 *                   hierarchy. Absent / undefined for a top-level entry (a child
 *                   of the session root). A consumer MUST treat an unknown
 *                   `parentId` (parent not in the tree) as a top-level entry
 *                   rather than dropping the node.
 *   - `outputRef?`— see `ActivityOutputRefSchema`.
 *
 * `startedAt` / `endedAt` follow the ms-typed-field discipline at the top of
 * this file (integer, finite, non-negative) but are wall-clock epochs not
 * durations, so they are NOT bounded by `MAX_SANE_DURATION_MS` — a 2026 epoch
 * (~1.7e12) is far past that 24h ceiling.
 */
export declare const ActivityEntrySchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        tool: "tool";
        agent: "agent";
        shell: "shell";
    }>;
    label: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        blocked: "blocked";
        done: "done";
        failed: "failed";
    }>;
    startedAt: z.ZodNumber;
    endedAt: z.ZodOptional<z.ZodNumber>;
    parentId: z.ZodOptional<z.ZodString>;
    outputRef: z.ZodOptional<z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #5161 — full current activity tree for a session. Emitted on subscribe /
 * resync. The complete `entries` array is on the wire (a flat list; the tree is
 * reconstructed from `parentId`) so a late-joining or reconnecting client
 * reaches canonical state in one message without replaying deltas.
 *
 * `entries` is ordered server-side but consumers MUST NOT depend on the order
 * for correctness (they reconstruct the tree from `id`/`parentId`). An empty
 * array is the valid "session has no in-flight activity" state — never omitted.
 */
export declare const ServerActivitySnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"activity_snapshot">;
    sessionId: z.ZodString;
    schemaVersion: z.ZodNumber;
    entries: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            tool: "tool";
            agent: "agent";
            shell: "shell";
        }>;
        label: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            blocked: "blocked";
            done: "done";
            failed: "failed";
        }>;
        startedAt: z.ZodNumber;
        endedAt: z.ZodOptional<z.ZodNumber>;
        parentId: z.ZodOptional<z.ZodString>;
        outputRef: z.ZodOptional<z.ZodObject<{
            kind: z.ZodString;
            id: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #5161 — incremental change to a single activity entry. Emitted as work
 * progresses so subscribed clients don't pay the full-snapshot cost on every
 * status flip.
 *
 * `op` discriminates the change:
 *   - `'started'` — a new entry appeared; `entry` is the full node.
 *   - `'updated'` — an existing entry changed (status / label / endedAt / etc.);
 *     `entry` is the full, current node (not a partial patch) so a consumer that
 *     missed the `started` delta can still upsert by `entry.id`. Upsert-by-id is
 *     the intended reducer behaviour — a `started` for an id already present, or
 *     an `updated` for an id not yet present, both resolve to "replace the node".
 *   - `'ended'`   — the entry reached a terminal status; `entry.status` is
 *     `done`/`failed` and `entry.endedAt` is set (enforced by the entry schema
 *     plus the refinement below).
 *
 * Carrying the full entry on every op (rather than a partial diff) keeps the
 * reducer trivial and makes each delta self-healing against a dropped earlier
 * delta — the deliberate tradeoff for a small, infrequently-changing tree.
 */
export declare const ServerActivityDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"activity_delta">;
    sessionId: z.ZodString;
    schemaVersion: z.ZodNumber;
    op: z.ZodEnum<{
        started: "started";
        updated: "updated";
        ended: "ended";
    }>;
    entry: z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            tool: "tool";
            agent: "agent";
            shell: "shell";
        }>;
        label: z.ZodString;
        status: z.ZodEnum<{
            running: "running";
            blocked: "blocked";
            done: "done";
            failed: "failed";
        }>;
        startedAt: z.ZodNumber;
        endedAt: z.ZodOptional<z.ZodNumber>;
        parentId: z.ZodOptional<z.ZodString>;
        outputRef: z.ZodOptional<z.ZodObject<{
            kind: z.ZodString;
            id: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * #5277: positive ack that a `cancel_activity` request was actioned. Success
 * was previously silent — the terminal `activity_delta` was the only signal,
 * which the dashboard couldn't correlate to a specific cancel click (and which
 * could be delayed/dropped). This echoes the request's `activityId` and
 * (when supplied) `requestId` so the caller gets a definite per-request signal.
 * Failures continue to surface as a `CANCEL_ACTIVITY_FAILED` session_error,
 * which also echoes `requestId`.
 */
export declare const ServerCancelActivityAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"cancel_activity_ack">;
    activityId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * #5936 (epic #5935): outgoing-message queue mirror. The server-authoritative
 * send queue holds a follow-up message the OWNER typed while the session was
 * still mid-turn (busy) and flushes it FIFO on the turn-complete `result`
 * event. These two transient events let clients render the queued message in a
 * distinct "queued" state and reconcile it on flush/cancel — they are NOT
 * replayed on reconnect (the live snapshot is authoritative).
 *
 * `message_queued` — a send-while-busy message was accepted into the queue.
 * Carries the queued `text` (so clients can render the bubble), the sender's
 * `clientMessageId` (when supplied, so the sender dedups its optimistic copy),
 * and the post-enqueue `queueLength`.
 */
export declare const ServerMessageQueuedSchema: z.ZodObject<{
    type: z.ZodLiteral<"message_queued">;
    sessionId: z.ZodString;
    clientMessageId: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    queueLength: z.ZodNumber;
}, z.core.$loose>;
/**
 * `message_dequeued` — a queued message left the queue. `reason` distinguishes
 * the exit paths: `'flush'` (auto-sent on turn-complete — the client should
 * transition the bubble from queued → sent), `'interrupted'` (the whole queue
 * was cancelled by an interrupt — the client should remove the queued bubble),
 * and `'cancelled'` (#5943 — the owner cancelled this ONE entry via
 * `cancel_queued` — the client removes just this bubble, leaving the rest of the
 * queue intact). The `queueLength` is the count remaining AFTER this item left.
 */
export declare const ServerMessageDequeuedSchema: z.ZodObject<{
    type: z.ZodLiteral<"message_dequeued">;
    sessionId: z.ZodString;
    clientMessageId: z.ZodOptional<z.ZodString>;
    queueLength: z.ZodNumber;
    reason: z.ZodEnum<{
        flush: "flush";
        interrupted: "interrupted";
        cancelled: "cancelled";
    }>;
}, z.core.$loose>;
/**
 * Verdict for a repo — the survey's classification of "what is this repo's
 * current state". Drives the colour-coded tag in the Control Room table:
 *   - `'live'`        — actively worked (a chroxy session is/was recently running).
 *   - `'investigate'` — ambiguous state worth a human look (e.g. dirty tree on a
 *                       repo with no recent activity).
 *   - `'abandoned'`   — likely abandoned (no recent activity, nothing in flight).
 *   - `'recent'`      — touched recently but not classified as live.
 *   - `'onboarded'`   — set up / onboarded (has the expected chroxy scaffolding)
 *                       but not currently active.
 *
 * Declared as a named enum so downstream consumers can switch exhaustively.
 */
export declare const RepoVerdictSchema: z.ZodEnum<{
    live: "live";
    investigate: "investigate";
    abandoned: "abandoned";
    recent: "recent";
    onboarded: "onboarded";
}>;
/**
 * Working-tree cleanliness summary for a repo:
 *   - `state`     — `'clean'` (nothing to commit) or `'dirty'` (anything staged,
 *                   modified, or untracked).
 *   - `untracked` — count of untracked files.
 *   - `modified`  — count of tracked-but-modified (unstaged) files.
 *   - `staged`    — count of staged (index) changes.
 *
 * Counts are non-negative integers. `state` is carried explicitly (rather than
 * derived from the counts) so the server's notion of clean/dirty is the
 * authority — e.g. a repo may be "dirty" for a reason the three counts don't
 * capture, and the consumer should not re-derive it.
 */
export declare const RepoTreeSchema: z.ZodObject<{
    state: z.ZodEnum<{
        clean: "clean";
        dirty: "dirty";
    }>;
    untracked: z.ZodNumber;
    modified: z.ZodNumber;
    staged: z.ZodNumber;
}, z.core.$strip>;
/**
 * One row in the Host/Repo Status table.
 *
 * Fields:
 *   - `name`        — display name for the repo (typically the directory name).
 *   - `path`        — absolute path on the host.
 *   - `branch`      — current branch (or detached-HEAD description).
 *   - `verdict`     — see `RepoVerdictSchema`.
 *   - `live`        — true while a chroxy session is actively running in this
 *                     repo. Distinct from `verdict === 'live'`: `verdict` is the
 *                     survey's classification (may persist after the session
 *                     ends), `live` is the instantaneous "session running now"
 *                     state that drives the green dot.
 *   - `tree`        — see `RepoTreeSchema`.
 *   - `worktrees`   — count of git worktrees attached to this repo.
 *   - `ahead`       — commits the current branch is AHEAD of its upstream, or
 *                     `null` when there is no upstream / it can't be determined
 *                     (detached HEAD, no tracking branch). `null` ≠ 0.
 *   - `behind`      — commits the current branch is BEHIND its upstream, same
 *                     `null` semantics as `ahead`. `null` ≠ 0.
 *   - `openPRs`     — number of open PRs, or `null` when unknown (e.g. no GitHub
 *                     remote, or the lookup was skipped/failed). `null` ≠ 0.
 *   - `prChecks`    — rollup of CI + review state across this repo's open PRs
 *                     (counts of open PRs that are CI-failing / CI-pending /
 *                     review-approved / changes-requested), or `null` when the
 *                     PR lookup was skipped/failed (same condition as a `null`
 *                     `openPRs`). All-zero counts mean none of the tracked
 *                     signals are present — this covers both "no open PRs" and
 *                     PRs that only carry untracked states (e.g. passing CI with
 *                     a `REVIEW_REQUIRED` decision). `null` ≠ all-zero.
 *   - `prsUrl`      — the repo's GitHub pull-requests URL
 *                     (`https://github.com/<owner>/<repo>/pulls`), derived from
 *                     the `origin` remote, or `null` when there's no GitHub
 *                     `origin` remote / it couldn't be determined. Powers the
 *                     "View PRs" row action.
 *   - `attribution` — whether commits carry the expected author attribution, or
 *                     `null` when not evaluated. `null` ≠ false.
 *   - `onboarding`  — human-readable onboarding state (free-form so the survey
 *                     can describe partial/odd setups without a wire change).
 *   - `lastTouched` — ISO-8601 timestamp of the most recent activity used to
 *                     classify the verdict.
 *   - `note?`       — optional annotation rendered as the `↳` sub-row under the
 *                     repo (e.g. "dirty tree, last touched 3 weeks ago").
 */
export declare const RepoStatusSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    branch: z.ZodString;
    verdict: z.ZodEnum<{
        live: "live";
        investigate: "investigate";
        abandoned: "abandoned";
        recent: "recent";
        onboarded: "onboarded";
    }>;
    live: z.ZodBoolean;
    tree: z.ZodObject<{
        state: z.ZodEnum<{
            clean: "clean";
            dirty: "dirty";
        }>;
        untracked: z.ZodNumber;
        modified: z.ZodNumber;
        staged: z.ZodNumber;
    }, z.core.$strip>;
    worktrees: z.ZodNumber;
    ahead: z.ZodNullable<z.ZodNumber>;
    behind: z.ZodNullable<z.ZodNumber>;
    openPRs: z.ZodNullable<z.ZodNumber>;
    prChecks: z.ZodNullable<z.ZodObject<{
        failing: z.ZodNumber;
        pending: z.ZodNumber;
        approved: z.ZodNumber;
        changesRequested: z.ZodNumber;
    }, z.core.$strip>>;
    prsUrl: z.ZodNullable<z.ZodString>;
    attribution: z.ZodNullable<z.ZodBoolean>;
    onboarding: z.ZodString;
    lastTouched: z.ZodString;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Aggregate counts across the surveyed repos, one per verdict bucket. Carried
 * alongside `repos` so the Control Room's summary chips don't have to re-tally
 * the array (and stay consistent with the server's own count even if a future
 * server truncates the `repos` list). All non-negative integers.
 */
export declare const HostStatusSummarySchema: z.ZodObject<{
    live: z.ZodNumber;
    onboarded: z.ZodNumber;
    abandoned: z.ZodNumber;
    investigate: z.ZodNumber;
    recent: z.ZodNumber;
}, z.core.$strip>;
/**
 * #5171 — full Host/Repo Status snapshot. Emitted in reply to a
 * `host_status_request` (see client.ts). Carries the survey root, the aggregate
 * `summary`, and the per-repo `repos` rows. `generatedAt` is the ISO-8601 time
 * the survey ran so the Control Room can render "generated Nm ago" and detect a
 * stale snapshot. An empty `repos` array is the valid "no repos found under the
 * root" state — never omitted.
 */
export declare const ServerHostStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_status_snapshot">;
    generatedAt: z.ZodString;
    root: z.ZodString;
    summary: z.ZodObject<{
        live: z.ZodNumber;
        onboarded: z.ZodNumber;
        abandoned: z.ZodNumber;
        investigate: z.ZodNumber;
        recent: z.ZodNumber;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        branch: z.ZodString;
        verdict: z.ZodEnum<{
            live: "live";
            investigate: "investigate";
            abandoned: "abandoned";
            recent: "recent";
            onboarded: "onboarded";
        }>;
        live: z.ZodBoolean;
        tree: z.ZodObject<{
            state: z.ZodEnum<{
                clean: "clean";
                dirty: "dirty";
            }>;
            untracked: z.ZodNumber;
            modified: z.ZodNumber;
            staged: z.ZodNumber;
        }, z.core.$strip>;
        worktrees: z.ZodNumber;
        ahead: z.ZodNullable<z.ZodNumber>;
        behind: z.ZodNullable<z.ZodNumber>;
        openPRs: z.ZodNullable<z.ZodNumber>;
        prChecks: z.ZodNullable<z.ZodObject<{
            failing: z.ZodNumber;
            pending: z.ZodNumber;
            approved: z.ZodNumber;
            changesRequested: z.ZodNumber;
        }, z.core.$strip>>;
        prsUrl: z.ZodNullable<z.ZodString>;
        attribution: z.ZodNullable<z.ZodBoolean>;
        onboarding: z.ZodString;
        lastTouched: z.ZodString;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** One live agentCommId → session registration row. */
export declare const MailboxRegistrationSchema: z.ZodObject<{
    agentCommId: z.ZodString;
    sessionId: z.ZodString;
    sessionName: z.ZodNullable<z.ZodString>;
    isBusy: z.ZodBoolean;
    isTui: z.ZodBoolean;
}, z.core.$strip>;
/** One recorded live-interrupt delivery attempt. */
export declare const MailboxDeliveryEventSchema: z.ZodObject<{
    at: z.ZodNumber;
    to: z.ZodString;
    from: z.ZodString;
    unreadCount: z.ZodNullable<z.ZodNumber>;
    outcome: z.ZodEnum<{
        injected: "injected";
        busy: "busy";
        "not-tui": "not-tui";
        "no-session": "no-session";
        "pty-dead": "pty-dead";
    }>;
}, z.core.$strip>;
export declare const ServerMailboxStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"mailbox_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    registrations: z.ZodArray<z.ZodObject<{
        agentCommId: z.ZodString;
        sessionId: z.ZodString;
        sessionName: z.ZodNullable<z.ZodString>;
        isBusy: z.ZodBoolean;
        isTui: z.ZodBoolean;
    }, z.core.$strip>>;
    recentEvents: z.ZodArray<z.ZodObject<{
        at: z.ZodNumber;
        to: z.ZodString;
        from: z.ZodString;
        unreadCount: z.ZodNullable<z.ZodNumber>;
        outcome: z.ZodEnum<{
            injected: "injected";
            busy: "busy";
            "not-tui": "not-tui";
            "no-session": "no-session";
            "pty-dead": "pty-dead";
        }>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerSessionPresetDisclosureSchema: z.ZodObject<{
    source: z.ZodEnum<{
        daemon: "daemon";
        repo: "repo";
    }>;
    active: z.ZodBoolean;
    trustState: z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>;
    enabled: z.ZodBoolean;
    seed: z.ZodString;
    preambleLength: z.ZodNumber;
    seedLength: z.ZodNumber;
    capped: z.ZodBoolean;
    repoPath: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSessionPresetFullSchema: z.ZodObject<{
    source: z.ZodEnum<{
        daemon: "daemon";
        repo: "repo";
    }>;
    active: z.ZodBoolean;
    trustState: z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>;
    enabled: z.ZodBoolean;
    preamble: z.ZodString;
    seed: z.ZodString;
    preambleLength: z.ZodNumber;
    seedLength: z.ZodNumber;
    capped: z.ZodBoolean;
    repoPath: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerSessionPresetSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"session_preset_snapshot">;
    cwd: z.ZodNullable<z.ZodString>;
    preset: z.ZodNullable<z.ZodObject<{
        source: z.ZodEnum<{
            daemon: "daemon";
            repo: "repo";
        }>;
        active: z.ZodBoolean;
        trustState: z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>;
        enabled: z.ZodBoolean;
        preamble: z.ZodString;
        seed: z.ZodString;
        preambleLength: z.ZodNumber;
        seedLength: z.ZodNumber;
        capped: z.ZodBoolean;
        repoPath: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Per-runner verdict — the survey's roll-up of "is this runner healthy" from
 * the LOCAL service state and (when available) GitHub's view. Drives the
 * colour-coded tag in the runner table:
 *   - `'busy'`         — running locally AND GitHub reports a job in progress.
 *   - `'idle'`         — running locally AND GitHub online with no job (healthy,
 *                        ready). Also used when GitHub data is unavailable but
 *                        the local service is running cleanly.
 *   - `'offline'`      — mismatch worth a look: the local service is running but
 *                        GitHub says offline (registration/network problem), or
 *                        GitHub says online but the local service isn't running.
 *   - `'stopped'`      — the service is registered but not running (dead PID or a
 *                        non-zero last exit).
 *   - `'unregistered'` — an install directory with no registered service (the
 *                        runner was configured but never `svc.sh install`-ed, or
 *                        the service was removed).
 */
export declare const RunnerVerdictSchema: z.ZodEnum<{
    busy: "busy";
    idle: "idle";
    offline: "offline";
    stopped: "stopped";
    unregistered: "unregistered";
}>;
/**
 * Local service-manager state for one runner install:
 *   - `manager`       — which service manager was probed (`launchd` on macOS,
 *                       `systemd` on Linux, or `none` when no `.service` file
 *                       was present / the platform is unsupported).
 *   - `label`         — the service label/unit probed (e.g.
 *                       `actions.runner.owner-repo.name`), or `null` when none.
 *   - `running`       — whether the service is currently running (a live PID
 *                       under launchd, `active` under systemd).
 *   - `pid`           — the running process id, or `null` when not running /
 *                       unknown.
 *   - `lastExitCode`  — the service's last exit status, or `null` when unknown.
 *                       A non-zero value on a not-running service is the "it
 *                       crashed" signal.
 */
export declare const RunnerServiceStateSchema: z.ZodObject<{
    manager: z.ZodEnum<{
        none: "none";
        launchd: "launchd";
        systemd: "systemd";
    }>;
    label: z.ZodNullable<z.ZodString>;
    running: z.ZodBoolean;
    pid: z.ZodNullable<z.ZodNumber>;
    lastExitCode: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/**
 * One self-hosted runner installation on the host.
 *
 * Fields:
 *   - `name`        — the runner's agent name (from `.runner` `agentName`), the
 *                     stable identifier GitHub shows for the runner.
 *   - `dir`         — absolute path of the install directory on the host.
 *   - `verdict`     — see `RunnerVerdictSchema`.
 *   - `service`     — local service-manager state (see `RunnerServiceStateSchema`).
 *   - `githubStatus`— GitHub's view of the runner (`'online' | 'offline'`), or
 *                     `null` when the `gh` enrichment was skipped/failed/this
 *                     runner wasn't matched. `null` ≠ offline.
 *   - `busy`        — whether GitHub reports the runner mid-job, or `null` when
 *                     the GitHub view is unavailable. `null` ≠ false.
 *   - `os`          — GitHub-reported OS string (e.g. `macOS`), or `null`.
 *   - `labels`      — GitHub-reported runner labels (self-hosted, OS, arch,
 *                     custom). Empty array when unknown — never null.
 */
export declare const RunnerInfoSchema: z.ZodObject<{
    name: z.ZodString;
    dir: z.ZodString;
    verdict: z.ZodEnum<{
        busy: "busy";
        idle: "idle";
        offline: "offline";
        stopped: "stopped";
        unregistered: "unregistered";
    }>;
    service: z.ZodObject<{
        manager: z.ZodEnum<{
            none: "none";
            launchd: "launchd";
            systemd: "systemd";
        }>;
        label: z.ZodNullable<z.ZodString>;
        running: z.ZodBoolean;
        pid: z.ZodNullable<z.ZodNumber>;
        lastExitCode: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    githubStatus: z.ZodNullable<z.ZodEnum<{
        offline: "offline";
        online: "online";
    }>>;
    busy: z.ZodNullable<z.ZodBoolean>;
    os: z.ZodNullable<z.ZodString>;
    labels: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * The runners serving one repo (or org), grouped under the GitHub target they
 * register against.
 *
 * Fields:
 *   - `name`      — display name (the repo name, or `org:<org>` for an org-level
 *                   target).
 *   - `owner`     — GitHub owner/org login, or `null` when the URL couldn't be
 *                   parsed.
 *   - `repo`      — GitHub repo name, or `null` for an org-level target / an
 *                   unparseable URL.
 *   - `githubUrl` — the raw `gitHubUrl` the runners registered against.
 *   - `runnersUrl`— deep link to the repo/org runner-settings page, or `null`
 *                   when the URL couldn't be derived. Constrained to the GitHub
 *                   settings shape so it's safe to render as an `<a href>`.
 *   - `runners`   — the runner installs serving this target (>= 1).
 */
export declare const RepoRunnersSchema: z.ZodObject<{
    name: z.ZodString;
    owner: z.ZodNullable<z.ZodString>;
    repo: z.ZodNullable<z.ZodString>;
    githubUrl: z.ZodString;
    runnersUrl: z.ZodNullable<z.ZodString>;
    runners: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        dir: z.ZodString;
        verdict: z.ZodEnum<{
            busy: "busy";
            idle: "idle";
            offline: "offline";
            stopped: "stopped";
            unregistered: "unregistered";
        }>;
        service: z.ZodObject<{
            manager: z.ZodEnum<{
                none: "none";
                launchd: "launchd";
                systemd: "systemd";
            }>;
            label: z.ZodNullable<z.ZodString>;
            running: z.ZodBoolean;
            pid: z.ZodNullable<z.ZodNumber>;
            lastExitCode: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        githubStatus: z.ZodNullable<z.ZodEnum<{
            offline: "offline";
            online: "online";
        }>>;
        busy: z.ZodNullable<z.ZodBoolean>;
        os: z.ZodNullable<z.ZodString>;
        labels: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Aggregate runner counts across the host, one per verdict bucket plus a
 * `total`. Carried alongside `repos` so the runner tab's summary chips don't
 * re-tally. All non-negative integers.
 */
export declare const RunnerStatusSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    busy: z.ZodNumber;
    idle: z.ZodNumber;
    offline: z.ZodNumber;
    stopped: z.ZodNumber;
    unregistered: z.ZodNumber;
}, z.core.$strip>;
/**
 * #5253 — full self-hosted runner snapshot. Emitted in reply to a
 * `runner_status_request` (see client.ts). `root` is the scanned runner-install
 * root (default `~/github-runners`). `generatedAt` is the ISO-8601 survey time
 * for the "generated Nm ago" line. An empty `repos` array is the valid "no
 * runners installed under the root" state — never omitted.
 */
export declare const ServerRunnerStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"runner_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        busy: z.ZodNumber;
        idle: z.ZodNumber;
        offline: z.ZodNumber;
        stopped: z.ZodNumber;
        unregistered: z.ZodNumber;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        owner: z.ZodNullable<z.ZodString>;
        repo: z.ZodNullable<z.ZodString>;
        githubUrl: z.ZodString;
        runnersUrl: z.ZodNullable<z.ZodString>;
        runners: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            dir: z.ZodString;
            verdict: z.ZodEnum<{
                busy: "busy";
                idle: "idle";
                offline: "offline";
                stopped: "stopped";
                unregistered: "unregistered";
            }>;
            service: z.ZodObject<{
                manager: z.ZodEnum<{
                    none: "none";
                    launchd: "launchd";
                    systemd: "systemd";
                }>;
                label: z.ZodNullable<z.ZodString>;
                running: z.ZodBoolean;
                pid: z.ZodNullable<z.ZodNumber>;
                lastExitCode: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>;
            githubStatus: z.ZodNullable<z.ZodEnum<{
                offline: "offline";
                online: "online";
            }>>;
            busy: z.ZodNullable<z.ZodBoolean>;
            os: z.ZodNullable<z.ZodString>;
            labels: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Best-effort `docker stats` resource snapshot for one running container. Every
 * field is nullable: `docker stats` may be unavailable (docker absent, daemon
 * down, a stuck probe), in which case the whole `stats` object is null on the
 * entry — `null` means "unknown", never "zero".
 */
export declare const ContainerStatsSchema: z.ZodObject<{
    cpuPercent: z.ZodNullable<z.ZodNumber>;
    memBytes: z.ZodNullable<z.ZodNumber>;
    memPercent: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/**
 * One chroxy-managed container / environment.
 *
 * Fields:
 *   - `id`             — EnvironmentManager environment id.
 *   - `name`           — operator-facing environment name.
 *   - `cwd`            — host working directory mounted as the workspace (the
 *                        repo the environment backs); the dashboard groups by it.
 *   - `image`          — container image, or null when unknown.
 *   - `status`         — lifecycle status string (`running`, `stopped`, `error`,
 *                        `unknown`, …) as the EnvironmentManager reports it.
 *   - `backend`        — `docker` | `compose` | `k8s` | `rancher` | `unknown`.
 *   - `containerId`    — backing container id, or null (compose/k8s/unknown).
 *   - `composeProject` — compose project name, or null.
 *   - `sessionCount`   — number of live chroxy sessions attached.
 *   - `createdAt`      — ISO-8601 creation time, or null.
 *   - `uptimeMs`       — derived ms since `createdAt` at survey time, or null.
 *   - `stats`          — live resource snapshot, or null when unavailable / the
 *                        container isn't running.
 */
export declare const ContainerEntrySchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    cwd: z.ZodString;
    image: z.ZodNullable<z.ZodString>;
    status: z.ZodString;
    backend: z.ZodString;
    containerId: z.ZodNullable<z.ZodString>;
    composeProject: z.ZodNullable<z.ZodString>;
    sessionCount: z.ZodNumber;
    createdAt: z.ZodNullable<z.ZodString>;
    uptimeMs: z.ZodNullable<z.ZodNumber>;
    stats: z.ZodNullable<z.ZodObject<{
        cpuPercent: z.ZodNullable<z.ZodNumber>;
        memBytes: z.ZodNullable<z.ZodNumber>;
        memPercent: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Aggregate container counts so the summary chips don't re-tally. `other`
 * absorbs any status that's neither running nor a known stopped/exited/error
 * state. All non-negative integers.
 */
export declare const ContainersStatusSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    running: z.ZodNumber;
    stopped: z.ZodNumber;
    other: z.ZodNumber;
}, z.core.$strip>;
/**
 * #6133 — full containers & environments snapshot. Emitted in reply to a
 * `containers_status_request` (see client.ts). An empty `containers` array is
 * the valid "no chroxy-managed environments" state — never omitted.
 * `dockerStatsNote` is a snapshot-level degradation annotation set when the
 * `docker stats` enrichment was skipped/failed (the inventory is still present;
 * every entry's `stats` is null).
 */
export declare const ServerContainersStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"containers_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        running: z.ZodNumber;
        stopped: z.ZodNumber;
        other: z.ZodNumber;
    }, z.core.$strip>;
    containers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        cwd: z.ZodString;
        image: z.ZodNullable<z.ZodString>;
        status: z.ZodString;
        backend: z.ZodString;
        containerId: z.ZodNullable<z.ZodString>;
        composeProject: z.ZodNullable<z.ZodString>;
        sessionCount: z.ZodNumber;
        createdAt: z.ZodNullable<z.ZodString>;
        uptimeMs: z.ZodNullable<z.ZodNumber>;
        stats: z.ZodNullable<z.ZodObject<{
            cpuPercent: z.ZodNullable<z.ZodNumber>;
            memBytes: z.ZodNullable<z.ZodNumber>;
            memPercent: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    dockerStatsNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * repo-memory cache file stats for one repo (`.repo-memory/cache.db` plus its
 * `-wal` sidecar). `present` is false when the cache file doesn't exist yet
 * (config without traffic); `sizeBytes` then reports 0. `lastModified` is the
 * newest mtime across the db + wal files (ISO-8601), or null when absent —
 * it doubles as a "last activity" proxy because the telemetry report carries
 * no timestamp of its own.
 */
export declare const RepoMemoryCacheSchema: z.ZodObject<{
    present: z.ZodBoolean;
    sizeBytes: z.ZodNumber;
    lastModified: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * The repo-memory telemetry report for one repo, distilled from
 * `repo-memory report <repoRoot> --json --diagnostics`. Field names follow the
 * CLI's TokenReport shape (verified against `@blamechris/repo-memory` 0.15.0).
 * The diagnostics-derived fields (`cacheEntryCount` / `staleEntryCount`) are
 * nullable because older CLI versions may omit the `diagnostics` block.
 * `lastActivity` is the newest telemetry timestamp when the CLI reports one
 * (current versions don't — then it stays null and consumers fall back to
 * `cache.lastModified`).
 */
export declare const RepoMemoryReportSchema: z.ZodObject<{
    totalEvents: z.ZodNumber;
    cacheHits: z.ZodNumber;
    cacheMisses: z.ZodNumber;
    cacheHitRatio: z.ZodNumber;
    estimatedTokensSaved: z.ZodNumber;
    cacheEntryCount: z.ZodNullable<z.ZodNumber>;
    staleEntryCount: z.ZodNullable<z.ZodNumber>;
    lastActivity: z.ZodNullable<z.ZodString>;
    topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
        query: z.ZodString;
        count: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/**
 * One repo's repo-memory status.
 *
 *   - `configured: false` — no `.repo-memory.json` in the repo root. A quiet
 *     "not configured" row, not an error; every other field is null/empty.
 *   - `configured: true` — `summarizer` + `toolGroups` parsed from the config
 *     (null/empty when the file is unparseable), `cache` always present,
 *     `report` populated from the CLI when it succeeded.
 *   - `reason` — per-repo degradation note: why `report` is null for a
 *     configured repo (CLI missing, CLI failed, unparseable output). Null when
 *     nothing degraded.
 */
export declare const RepoMemoryStatusSchema: z.ZodObject<{
    configured: z.ZodBoolean;
    summarizer: z.ZodNullable<z.ZodString>;
    toolGroups: z.ZodArray<z.ZodString>;
    cache: z.ZodNullable<z.ZodObject<{
        present: z.ZodBoolean;
        sizeBytes: z.ZodNumber;
        lastModified: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    report: z.ZodNullable<z.ZodObject<{
        totalEvents: z.ZodNumber;
        cacheHits: z.ZodNumber;
        cacheMisses: z.ZodNumber;
        cacheHitRatio: z.ZodNumber;
        estimatedTokensSaved: z.ZodNumber;
        cacheEntryCount: z.ZodNullable<z.ZodNumber>;
        staleEntryCount: z.ZodNullable<z.ZodNumber>;
        lastActivity: z.ZodNullable<z.ZodString>;
        topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
            query: z.ZodString;
            count: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5501 — one recent repo-relay workflow run, distilled from
 * `gh run list --workflow=repo-relay.yml --json status,conclusion,event,createdAt,databaseId`.
 * `databaseId` is GitHub's run id — #5502's rerun action consumes it, so it is
 * carried verbatim. `conclusion` is null while the run is still in progress.
 */
export declare const RepoRelayRunSchema: z.ZodObject<{
    databaseId: z.ZodNumber;
    status: z.ZodNullable<z.ZodString>;
    conclusion: z.ZodNullable<z.ZodString>;
    event: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5501 — per-repo repo-relay verdict, mirroring the runner tab's bucket
 * style:
 *
 *   - 'failing'       — the latest CONCLUDED run failed (wins over drift:
 *     a broken relay is more urgent than a stale pin).
 *   - 'drifted'       — pinned version < latest release (sha pins resolve via
 *     their `# vX.Y.Z` comment first).
 *   - 'ok'            — latest concluded run succeeded and no drift.
 *   - 'not_installed' — no `.github/workflows/repo-relay.yml` in the checkout.
 *   - 'unknown'       — installed but unassessable (gh missing / rate-limited /
 *     no GitHub remote / no concluded runs and no drift signal); the row's
 *     `reason` explains why.
 */
export declare const RepoRelayVerdictSchema: z.ZodEnum<{
    unknown: "unknown";
    ok: "ok";
    failing: "failing";
    drifted: "drifted";
    not_installed: "not_installed";
}>;
/**
 * #5501 — one repo's repo-relay status.
 *
 *   - `installed` — answered from the filesystem alone (the workflow file),
 *     so it survives every gh/network degradation.
 *   - `pinnedVersion` / `pinnedSha` — parsed from the workflow's
 *     `uses: blamechris/repo-relay@<ref>` line. A tag pin fills
 *     `pinnedVersion` only; a sha pin fills `pinnedSha` plus `pinnedVersion`
 *     when a `# vX.Y.Z` comment resolves it.
 *   - `driftUnknown` — installed but the pin couldn't be resolved to a
 *     version (bare sha with no comment, branch pin, unparseable uses line)
 *     so drift can't be assessed.
 *   - `latestVersion` — `releases/latest` tag of blamechris/repo-relay,
 *     fetched ONCE per snapshot (and cached briefly across snapshots).
 *   - `runs` — most-recent-first; empty when unavailable (see `reason`).
 *   - `failureStreak` — consecutive failed conclusions from the most recent
 *     run backwards (in-progress runs are skipped, not streak-breaking).
 *   - `workflowUrl` — Actions UI deep link, null without a GitHub remote.
 *   - `reason` — per-repo degradation note (gh missing, rate limit, no
 *     GitHub remote, …). Null when nothing degraded.
 */
export declare const RepoRelayStatusSchema: z.ZodObject<{
    installed: z.ZodBoolean;
    pinnedVersion: z.ZodNullable<z.ZodString>;
    pinnedSha: z.ZodNullable<z.ZodString>;
    latestVersion: z.ZodNullable<z.ZodString>;
    runs: z.ZodArray<z.ZodObject<{
        databaseId: z.ZodNumber;
        status: z.ZodNullable<z.ZodString>;
        conclusion: z.ZodNullable<z.ZodString>;
        event: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    failureStreak: z.ZodNumber;
    verdict: z.ZodEnum<{
        unknown: "unknown";
        ok: "ok";
        failing: "failing";
        drifted: "drifted";
        not_installed: "not_installed";
    }>;
    driftUnknown: z.ZodBoolean;
    workflowUrl: z.ZodNullable<z.ZodString>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * One surveyed repo in the Integrations snapshot. `repoMemory` is nullable so
 * a future integration can appear without forcing a repo-memory block.
 * `repoRelay` (#5501) is additive — optional so #5503-era producers/fixtures
 * stay valid; the current survey always emits it (a repo without the workflow
 * file gets a quiet `installed: false` block, same posture as unconfigured
 * repo-memory).
 */
export declare const IntegrationRepoSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    repoMemory: z.ZodNullable<z.ZodObject<{
        configured: z.ZodBoolean;
        summarizer: z.ZodNullable<z.ZodString>;
        toolGroups: z.ZodArray<z.ZodString>;
        cache: z.ZodNullable<z.ZodObject<{
            present: z.ZodBoolean;
            sizeBytes: z.ZodNumber;
            lastModified: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        report: z.ZodNullable<z.ZodObject<{
            totalEvents: z.ZodNumber;
            cacheHits: z.ZodNumber;
            cacheMisses: z.ZodNumber;
            cacheHitRatio: z.ZodNumber;
            estimatedTokensSaved: z.ZodNumber;
            cacheEntryCount: z.ZodNullable<z.ZodNumber>;
            staleEntryCount: z.ZodNullable<z.ZodNumber>;
            lastActivity: z.ZodNullable<z.ZodString>;
            topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
                query: z.ZodString;
                count: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    repoRelay: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        installed: z.ZodBoolean;
        pinnedVersion: z.ZodNullable<z.ZodString>;
        pinnedSha: z.ZodNullable<z.ZodString>;
        latestVersion: z.ZodNullable<z.ZodString>;
        runs: z.ZodArray<z.ZodObject<{
            databaseId: z.ZodNumber;
            status: z.ZodNullable<z.ZodString>;
            conclusion: z.ZodNullable<z.ZodString>;
            event: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        failureStreak: z.ZodNumber;
        verdict: z.ZodEnum<{
            unknown: "unknown";
            ok: "ok";
            failing: "failing";
            drifted: "drifted";
            not_installed: "not_installed";
        }>;
        driftUnknown: z.ZodBoolean;
        workflowUrl: z.ZodNullable<z.ZodString>;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
/**
 * Aggregate repo-memory counts across the surveyed repos, carried alongside
 * `repos` so the Integrations tab's summary chips don't re-tally. `degraded`
 * counts configured repos whose report cell carries a `reason`.
 */
export declare const IntegrationStatusSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    configured: z.ZodNumber;
    notConfigured: z.ZodNumber;
    degraded: z.ZodNumber;
    relayInstalled: z.ZodOptional<z.ZodNumber>;
    relayFailing: z.ZodOptional<z.ZodNumber>;
    relayDrifted: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/**
 * Snapshot-level note about the `repo-memory` CLI binary, probed ONCE per
 * survey. When `found` is false every configured repo's CLI-derived cells are
 * degraded and `note` explains why (the per-repo `reason` repeats it).
 */
export declare const IntegrationCliStatusSchema: z.ZodObject<{
    found: z.ZodBoolean;
    path: z.ZodNullable<z.ZodString>;
    note: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5499 — full Integrations survey snapshot. Emitted in reply to an
 * `integration_status_request` (see client.ts). `root` is the Control Room
 * discovery root the repo set was resolved under (same as the host survey).
 * An empty `repos` array is the valid "no repos under the root" state.
 * `repoMemoryCli` is optional so the degraded error-snapshot (FORBIDDEN /
 * SURVEY_IN_PROGRESS / SURVEY_FAILED) can reuse the shared error envelope; a
 * successful survey always carries it.
 */
export declare const ServerIntegrationStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    summary: z.ZodObject<{
        total: z.ZodNumber;
        configured: z.ZodNumber;
        notConfigured: z.ZodNumber;
        degraded: z.ZodNumber;
        relayInstalled: z.ZodOptional<z.ZodNumber>;
        relayFailing: z.ZodOptional<z.ZodNumber>;
        relayDrifted: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        repoMemory: z.ZodNullable<z.ZodObject<{
            configured: z.ZodBoolean;
            summarizer: z.ZodNullable<z.ZodString>;
            toolGroups: z.ZodArray<z.ZodString>;
            cache: z.ZodNullable<z.ZodObject<{
                present: z.ZodBoolean;
                sizeBytes: z.ZodNumber;
                lastModified: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            report: z.ZodNullable<z.ZodObject<{
                totalEvents: z.ZodNumber;
                cacheHits: z.ZodNumber;
                cacheMisses: z.ZodNumber;
                cacheHitRatio: z.ZodNumber;
                estimatedTokensSaved: z.ZodNumber;
                cacheEntryCount: z.ZodNullable<z.ZodNumber>;
                staleEntryCount: z.ZodNullable<z.ZodNumber>;
                lastActivity: z.ZodNullable<z.ZodString>;
                topMissedQueries: z.ZodDefault<z.ZodArray<z.ZodObject<{
                    query: z.ZodString;
                    count: z.ZodNumber;
                }, z.core.$strip>>>;
            }, z.core.$strip>>;
            reason: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        repoRelay: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            installed: z.ZodBoolean;
            pinnedVersion: z.ZodNullable<z.ZodString>;
            pinnedSha: z.ZodNullable<z.ZodString>;
            latestVersion: z.ZodNullable<z.ZodString>;
            runs: z.ZodArray<z.ZodObject<{
                databaseId: z.ZodNumber;
                status: z.ZodNullable<z.ZodString>;
                conclusion: z.ZodNullable<z.ZodString>;
                event: z.ZodNullable<z.ZodString>;
                createdAt: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            failureStreak: z.ZodNumber;
            verdict: z.ZodEnum<{
                unknown: "unknown";
                ok: "ok";
                failing: "failing";
                drifted: "drifted";
                not_installed: "not_installed";
            }>;
            driftUnknown: z.ZodBoolean;
            workflowUrl: z.ZodNullable<z.ZodString>;
            reason: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    repoMemoryCli: z.ZodOptional<z.ZodObject<{
        found: z.ZodBoolean;
        path: z.ZodNullable<z.ZodString>;
        note: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    ghCli: z.ZodOptional<z.ZodObject<{
        found: z.ZodBoolean;
        path: z.ZodNullable<z.ZodString>;
        note: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #5500 (epic #5498) — counts distilled from a `repo-memory index` run, as
 * printed by the CLI's human-readable report (field names verified against
 * the IndexReport shape in @blamechris/repo-memory: scanned / summarized /
 * "already fresh" / skipped). All four are required — a partially parsed
 * report is treated as unparseable and the ack carries `counts: null`
 * instead, so the dashboard never renders a half-true breakdown.
 */
export declare const IntegrationActionCountsSchema: z.ZodObject<{
    scanned: z.ZodNumber;
    summarized: z.ZodNumber;
    fresh: z.ZodNumber;
    skipped: z.ZodNumber;
}, z.core.$strip>;
/**
 * #5500 — positive ack that an `integration_action` request completed.
 * Clones the `cancel_activity_ack` correlation contract (#5277): echoes the
 * request's `action` + `repoPath` (and `requestId` when supplied) so the
 * dashboard can clear the exact row's pending state. Failures surface as an
 * `INTEGRATION_ACTION_FAILED` session_error, which also echoes
 * `requestId` / `action` / `repoPath`.
 *
 * `action` is a plain string (not the client enum) so a future action's ack
 * reaches older dashboards without a schema bump — consumers key off
 * `repoPath` and treat unknown actions as opaque. `counts` is the parsed
 * index result for `repo_memory_reindex`, or null when the CLI output
 * couldn't be parsed (the UI then just refreshes the survey for the truth).
 *
 * #5502: `runId` echoes the re-run request's GitHub Actions run id on a
 * `repo_relay_rerun` ack (null/absent on reindex acks). A rerun ack carries
 * `counts: null` — there is nothing to count; the new attempt shows up as
 * in_progress on the next survey refresh.
 */
export declare const ServerIntegrationActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_action_ack">;
    action: z.ZodString;
    repoPath: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    runId: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    counts: z.ZodNullable<z.ZodObject<{
        scanned: z.ZodNumber;
        summarized: z.ZodNumber;
        fresh: z.ZodNumber;
        skipped: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6134 (epic #5530) — ack for a successful `containers_action` (stop / restart
 * / destroy). Echoes `action` + the client-supplied `environmentId` (+ optional
 * `requestId`) so the dashboard can clear the exact row's pending state, and
 * carries the resulting `status` (`stopped` / `running` / `destroyed`). A
 * failure instead replies with a `CONTAINER_ACTION_FAILED` session_error
 * carrying the same correlation fields (mirrors integration_action's contract).
 */
export declare const ServerContainersActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"containers_action_ack">;
    action: z.ZodString;
    environmentId: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
/**
 * #5554 — one skill in the inventory snapshot. Carries only names /
 * descriptions / metadata — never the skill BODY (the security boundary: skill
 * bodies never leave the server). Fields:
 *
 *   - `name` / `description` — from the file + frontmatter (description is the
 *     frontmatter `description:` or the first non-empty body line).
 *   - `source` — which tier this entry came from: `global` (~/.chroxy/skills/)
 *     or `repo` (a repo-local `.chroxy/skills/` overlay).
 *   - `activation` — `auto` (always active) or `manual` (opt-in per session).
 *   - `active` — whether the skill is in the default-active set (a manual skill
 *     not yet activated reports `active: false`).
 *   - `providers` — frontmatter provider scoping (empty = applies to all).
 *   - `version` — frontmatter `version:` if present.
 *   - `trustState` — `trusted` / `pending` for community-namespaced skills;
 *     null for plain skills (implicitly trusted).
 *   - `communityAuthor` — the `community/<author>/` namespace, when applicable.
 *   - `hash` / `installed` — joined from the paired `skills.lock` (null when
 *     the lock has no entry for this skill).
 *   - `overridesGlobal` — set on a repo-tier entry that shadows a global skill
 *     of the same name (the per-session loader's repo-wins precedence).
 *   - `lastUsed` / `useCount` / `usedRepos` — the #5554 Phase 2 usage rollup
 *     (lastUsed null + count 0 when never recorded).
 */
export declare const SkillInventoryEntrySchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    source: z.ZodEnum<{
        repo: "repo";
        global: "global";
    }>;
    activation: z.ZodEnum<{
        auto: "auto";
        manual: "manual";
    }>;
    active: z.ZodBoolean;
    providers: z.ZodArray<z.ZodString>;
    version: z.ZodNullable<z.ZodString>;
    trustState: z.ZodNullable<z.ZodEnum<{
        pending: "pending";
        trusted: "trusted";
    }>>;
    communityAuthor: z.ZodNullable<z.ZodString>;
    hash: z.ZodNullable<z.ZodString>;
    installed: z.ZodNullable<z.ZodString>;
    overridesGlobal: z.ZodOptional<z.ZodBoolean>;
    lastUsed: z.ZodNullable<z.ZodString>;
    useCount: z.ZodNumber;
    usedRepos: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * #5554 — one surveyed repo's skill overlay. `skills` is the repo-local
 * `.chroxy/skills/` overlay (empty when the repo has no overlay — absence is
 * signal, not an error). `error` carries a per-repo scan-failure reason so a
 * single broken overlay degrades to a chip on that card rather than a dead
 * snapshot.
 */
export declare const SkillInventoryRepoSchema: z.ZodObject<{
    name: z.ZodString;
    path: z.ZodString;
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        source: z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>;
        activation: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        active: z.ZodBoolean;
        providers: z.ZodArray<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        trustState: z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>>;
        communityAuthor: z.ZodNullable<z.ZodString>;
        hash: z.ZodNullable<z.ZodString>;
        installed: z.ZodNullable<z.ZodString>;
        overridesGlobal: z.ZodOptional<z.ZodBoolean>;
        lastUsed: z.ZodNullable<z.ZodString>;
        useCount: z.ZodNumber;
        usedRepos: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * #5554 — full Skills inventory snapshot, emitted in reply to a
 * `skills_inventory_request` (see client.ts). `global` is the
 * `~/.chroxy/skills/` tier; `repos` are the per-repo overlays for the surveyed
 * repo set (same set the host / integration surveys resolve). `globalError`
 * degrades the global tier the same way a repo `error` degrades a repo card.
 * `root` is the Control Room discovery root the repo set was resolved under.
 * Same degraded-snapshot-with-`error` posture as the sibling surveys: on a
 * forbidden / in-progress / failed request the handler returns an otherwise
 * valid empty snapshot plus the top-level `error`.
 */
export declare const ServerSkillsInventorySnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"skills_inventory_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    root: z.ZodString;
    global: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        source: z.ZodEnum<{
            repo: "repo";
            global: "global";
        }>;
        activation: z.ZodEnum<{
            auto: "auto";
            manual: "manual";
        }>;
        active: z.ZodBoolean;
        providers: z.ZodArray<z.ZodString>;
        version: z.ZodNullable<z.ZodString>;
        trustState: z.ZodNullable<z.ZodEnum<{
            pending: "pending";
            trusted: "trusted";
        }>>;
        communityAuthor: z.ZodNullable<z.ZodString>;
        hash: z.ZodNullable<z.ZodString>;
        installed: z.ZodNullable<z.ZodString>;
        overridesGlobal: z.ZodOptional<z.ZodBoolean>;
        lastUsed: z.ZodNullable<z.ZodString>;
        useCount: z.ZodNumber;
        usedRepos: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    globalError: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    repos: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        skills: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
            source: z.ZodEnum<{
                repo: "repo";
                global: "global";
            }>;
            activation: z.ZodEnum<{
                auto: "auto";
                manual: "manual";
            }>;
            active: z.ZodBoolean;
            providers: z.ZodArray<z.ZodString>;
            version: z.ZodNullable<z.ZodString>;
            trustState: z.ZodNullable<z.ZodEnum<{
                pending: "pending";
                trusted: "trusted";
            }>>;
            communityAuthor: z.ZodNullable<z.ZodString>;
            hash: z.ZodNullable<z.ZodString>;
            installed: z.ZodNullable<z.ZodString>;
            overridesGlobal: z.ZodOptional<z.ZodBoolean>;
            lastUsed: z.ZodNullable<z.ZodString>;
            useCount: z.ZodNumber;
            usedRepos: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * #5547: reply to a `summarize_session` request — the model-written
 * continuation brief built from the session's persisted history. Sent only to
 * the requesting client. `summary` is the editable brief the dashboard seeds
 * into the create-session composer; `truncated` flags that the history was
 * windowed before summarization (the brief's header also notes this).
 * `sessionId` echoes the source session, `requestId` correlates the click.
 * Failures surface separately as a `SUMMARIZE_FAILED` session_error echoing
 * `sessionId` / `requestId`.
 */
export declare const ServerSummarizeSessionResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"summarize_session_result">;
    sessionId: z.ZodString;
    summary: z.ZodString;
    truncated: z.ZodOptional<z.ZodBoolean>;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
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
            env: "env";
            oauth: "oauth";
            store: "store";
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
            pending: "pending";
            running: "running";
            failed: "failed";
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
            pending: "pending";
            running: "running";
            failed: "failed";
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
            pending: "pending";
            running: "running";
            failed: "failed";
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
export type BillingCanaryWarning = z.infer<typeof BillingCanaryWarningSchema>;
export type BillingCanarySnapshot = z.infer<typeof BillingCanarySnapshotSchema>;
export type ServerBillingCanaryMessage = z.infer<typeof ServerBillingCanarySchema>;
export type ServerAuthOkMessage = z.infer<typeof ServerAuthOkSchema>;
export type ServerPairRequestPendingMessage = z.infer<typeof ServerPairRequestPendingSchema>;
export type ServerPairPendingMessage = z.infer<typeof ServerPairPendingSchema>;
export type ServerPairResultMessage = z.infer<typeof ServerPairResultSchema>;
export type ServerPairResolvedMessage = z.infer<typeof ServerPairResolvedSchema>;
export type ServerStreamDeltaMessage = z.infer<typeof ServerStreamDeltaSchema>;
export type ServerPermissionRequestMessage = z.infer<typeof ServerPermissionRequestSchema>;
export type ServerErrorMessage = z.infer<typeof ServerErrorSchema>;
export type ServerErrorEnvelopeMessage = z.infer<typeof ServerErrorEnvelopeSchema>;
export type ServerCostUpdateMessage = z.infer<typeof ServerCostUpdateSchema>;
export type CumulativeUsage = z.infer<typeof CumulativeUsageSchema>;
export type ServerSessionUsageMessage = z.infer<typeof ServerSessionUsageSchema>;
export type ServerSessionStoppedMessage = z.infer<typeof ServerSessionStoppedSchema>;
export type ServerSessionCostThresholdCrossedMessage = z.infer<typeof ServerSessionCostThresholdCrossedSchema>;
export type ServerMonthlyBudgetMessage = z.infer<typeof ServerMonthlyBudgetSchema>;
export type ServerExtensionMessage = z.infer<typeof ServerExtensionMessageSchema>;
export type ServerSkillsListMessage = z.infer<typeof ServerSkillsListSchema>;
export type ServerAuthBootstrapMessage = z.infer<typeof ServerAuthBootstrapSchema>;
export type ServerTunnelUrlChangedMessage = z.infer<typeof ServerTunnelUrlChangedSchema>;
export type ServerEvaluateDraftResultMessage = z.infer<typeof ServerEvaluateDraftResultSchema>;
export type ServerEvaluatorRewriteMessage = z.infer<typeof ServerEvaluatorRewriteSchema>;
export type ServerEvaluatorClarifyMessage = z.infer<typeof ServerEvaluatorClarifySchema>;
export type ServerSkillTrustGrantOkMessage = z.infer<typeof ServerSkillTrustGrantOkSchema>;
export type ServerSkillTrustGrantInvalidAuthorMessage = z.infer<typeof ServerSkillTrustGrantInvalidAuthorSchema>;
export type ServerByokCredentialsStatusMessage = z.infer<typeof ServerByokCredentialsStatusSchema>;
export type ServerCredentialsStatusMessage = z.infer<typeof ServerCredentialsStatusSchema>;
export type ServerCredentialTestResultMessage = z.infer<typeof ServerCredentialTestResultSchema>;
export type ActivityKind = z.infer<typeof ActivityKindSchema>;
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;
export type ActivityOutputRef = z.infer<typeof ActivityOutputRefSchema>;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type ServerActivitySnapshotMessage = z.infer<typeof ServerActivitySnapshotSchema>;
export type ServerActivityDeltaMessage = z.infer<typeof ServerActivityDeltaSchema>;
export type ServerCancelActivityAckMessage = z.infer<typeof ServerCancelActivityAckSchema>;
export type ServerMessageQueuedMessage = z.infer<typeof ServerMessageQueuedSchema>;
export type ServerMessageDequeuedMessage = z.infer<typeof ServerMessageDequeuedSchema>;
export type ServerBudgetResumeAckMessage = z.infer<typeof ServerBudgetResumeAckSchema>;
export type RepoVerdict = z.infer<typeof RepoVerdictSchema>;
export type RepoTree = z.infer<typeof RepoTreeSchema>;
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export type HostStatusSummary = z.infer<typeof HostStatusSummarySchema>;
export type ServerHostStatusSnapshotMessage = z.infer<typeof ServerHostStatusSnapshotSchema>;
export type ServerMailboxStatusSnapshotMessage = z.infer<typeof ServerMailboxStatusSnapshotSchema>;
export type MailboxRegistration = z.infer<typeof MailboxRegistrationSchema>;
export type MailboxDeliveryEvent = z.infer<typeof MailboxDeliveryEventSchema>;
export type ServerSessionPresetDisclosure = z.infer<typeof ServerSessionPresetDisclosureSchema>;
export type ServerSessionPresetFull = z.infer<typeof ServerSessionPresetFullSchema>;
export type ServerSessionPresetSnapshotMessage = z.infer<typeof ServerSessionPresetSnapshotSchema>;
export type RunnerVerdict = z.infer<typeof RunnerVerdictSchema>;
export type RunnerServiceState = z.infer<typeof RunnerServiceStateSchema>;
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>;
export type RepoRunners = z.infer<typeof RepoRunnersSchema>;
export type RunnerStatusSummary = z.infer<typeof RunnerStatusSummarySchema>;
export type ServerRunnerStatusSnapshotMessage = z.infer<typeof ServerRunnerStatusSnapshotSchema>;
export type ServerContainersStatusSnapshotMessage = z.infer<typeof ServerContainersStatusSnapshotSchema>;
export type RepoMemoryCache = z.infer<typeof RepoMemoryCacheSchema>;
export type RepoMemoryReport = z.infer<typeof RepoMemoryReportSchema>;
export type RepoMemoryStatus = z.infer<typeof RepoMemoryStatusSchema>;
export type RepoRelayRun = z.infer<typeof RepoRelayRunSchema>;
export type RepoRelayVerdict = z.infer<typeof RepoRelayVerdictSchema>;
export type RepoRelayStatus = z.infer<typeof RepoRelayStatusSchema>;
export type IntegrationRepo = z.infer<typeof IntegrationRepoSchema>;
export type IntegrationStatusSummary = z.infer<typeof IntegrationStatusSummarySchema>;
export type IntegrationCliStatus = z.infer<typeof IntegrationCliStatusSchema>;
export type ServerIntegrationStatusSnapshotMessage = z.infer<typeof ServerIntegrationStatusSnapshotSchema>;
export type IntegrationActionCounts = z.infer<typeof IntegrationActionCountsSchema>;
export type ServerIntegrationActionAckMessage = z.infer<typeof ServerIntegrationActionAckSchema>;
export type ServerContainersActionAckMessage = z.infer<typeof ServerContainersActionAckSchema>;
export type SkillInventoryEntry = z.infer<typeof SkillInventoryEntrySchema>;
export type SkillInventoryRepo = z.infer<typeof SkillInventoryRepoSchema>;
export type ServerSkillsInventorySnapshotMessage = z.infer<typeof ServerSkillsInventorySnapshotSchema>;
export type ServerSummarizeSessionResultMessage = z.infer<typeof ServerSummarizeSessionResultSchema>;
