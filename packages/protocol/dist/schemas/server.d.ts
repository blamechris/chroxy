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
    exposure: z.ZodOptional<z.ZodObject<{
        lanBind: z.ZodBoolean;
        bindHost: z.ZodNullable<z.ZodString>;
        quickTunnel: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$loose>;
export declare const ServerAuthFailSchema: z.ZodObject<{
    type: z.ZodLiteral<"auth_fail">;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const ServerPairFailSchema: z.ZodObject<{
    type: z.ZodLiteral<"pair_fail">;
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
    }, z.core.$strip>>;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/**
 * One surveyed repo in the Integrations snapshot. `repoMemory` is nullable so
 * a future integration can appear without forcing a repo-memory block; a
 * sibling `repoRelay` block lands in the follow-up issue (#5501) as an
 * additive key — consumers must tolerate unknown extra keys per the usual Zod
 * non-strict object semantics.
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
        }, z.core.$strip>>;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
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
            }, z.core.$strip>>;
            reason: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    repoMemoryCli: z.ZodOptional<z.ZodObject<{
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
 */
export declare const ServerIntegrationActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"integration_action_ack">;
    action: z.ZodString;
    repoPath: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    counts: z.ZodNullable<z.ZodObject<{
        scanned: z.ZodNumber;
        summarized: z.ZodNumber;
        fresh: z.ZodNumber;
        skipped: z.ZodNumber;
    }, z.core.$strip>>;
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
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
export type ServerAuthOkMessage = z.infer<typeof ServerAuthOkSchema>;
export type ServerStreamDeltaMessage = z.infer<typeof ServerStreamDeltaSchema>;
export type ServerPermissionRequestMessage = z.infer<typeof ServerPermissionRequestSchema>;
export type ServerErrorMessage = z.infer<typeof ServerErrorSchema>;
export type ServerErrorEnvelopeMessage = z.infer<typeof ServerErrorEnvelopeSchema>;
export type ServerCostUpdateMessage = z.infer<typeof ServerCostUpdateSchema>;
export type CumulativeUsage = z.infer<typeof CumulativeUsageSchema>;
export type ServerSessionUsageMessage = z.infer<typeof ServerSessionUsageSchema>;
export type ServerSessionStoppedMessage = z.infer<typeof ServerSessionStoppedSchema>;
export type ServerSessionCostThresholdCrossedMessage = z.infer<typeof ServerSessionCostThresholdCrossedSchema>;
export type ServerExtensionMessage = z.infer<typeof ServerExtensionMessageSchema>;
export type ServerSkillsListMessage = z.infer<typeof ServerSkillsListSchema>;
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
export type RepoVerdict = z.infer<typeof RepoVerdictSchema>;
export type RepoTree = z.infer<typeof RepoTreeSchema>;
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export type HostStatusSummary = z.infer<typeof HostStatusSummarySchema>;
export type ServerHostStatusSnapshotMessage = z.infer<typeof ServerHostStatusSnapshotSchema>;
export type RunnerVerdict = z.infer<typeof RunnerVerdictSchema>;
export type RunnerServiceState = z.infer<typeof RunnerServiceStateSchema>;
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>;
export type RepoRunners = z.infer<typeof RepoRunnersSchema>;
export type RunnerStatusSummary = z.infer<typeof RunnerStatusSummarySchema>;
export type ServerRunnerStatusSnapshotMessage = z.infer<typeof ServerRunnerStatusSnapshotSchema>;
export type RepoMemoryCache = z.infer<typeof RepoMemoryCacheSchema>;
export type RepoMemoryReport = z.infer<typeof RepoMemoryReportSchema>;
export type RepoMemoryStatus = z.infer<typeof RepoMemoryStatusSchema>;
export type IntegrationRepo = z.infer<typeof IntegrationRepoSchema>;
export type IntegrationStatusSummary = z.infer<typeof IntegrationStatusSummarySchema>;
export type IntegrationCliStatus = z.infer<typeof IntegrationCliStatusSchema>;
export type ServerIntegrationStatusSnapshotMessage = z.infer<typeof ServerIntegrationStatusSnapshotSchema>;
export type IntegrationActionCounts = z.infer<typeof IntegrationActionCountsSchema>;
export type ServerIntegrationActionAckMessage = z.infer<typeof ServerIntegrationActionAckSchema>;
