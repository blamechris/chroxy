/**
 * Streaming + tool-call wire: stream start/delta/end, tool start/result/input-delta, model/evaluator/preamble changes, agent lifecycle, background-work snapshots.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
import { MAX_SANE_DURATION_MS } from "./connection.js";
// #5515 (epic #5514): optional, additive wall-clock (ms epoch) timestamp
// stamped on stream messages and the pong reply at broadcast time. Clients use
// it to measure server→render latency (token-to-render) and to split RTT into
// uplink/downlink. Wall-clock (not monotonic) because it crosses machines;
// consumers MUST treat raw cross-machine subtraction as skew-prone and derive
// one-way numbers from the RTT-split method instead (see app/dashboard
// latency-stats). Always optional so older servers/clients interop unchanged.
const ServerTsSchema = z.number().int().nonnegative().finite().optional();
// #6756: an optional flag marking a stream_start/delta/end as carrying the
// model's extended-thinking (reasoning) content rather than the visible
// response text. Providers that surface thinking (claude SDK, BYOK) emit these
// with a DISTINCT `messageId` (e.g. `<turnId>-thinking-<n>`) so a thinking
// stream never collides with the response stream, and clients route them to a
// `type: 'thinking'` chat bubble instead of the response slot. Always optional
// so older servers/clients interop unchanged (absent === not thinking). Because
// the id is distinct from the ephemeral placeholder id `'thinking'`, the
// client's `filterThinking` still only strips the placeholder.
const ThinkingFlagSchema = z.boolean().optional();
export const ServerStreamStartSchema = z.object({
    type: z.literal('stream_start'),
    messageId: z.string(),
    serverTs: ServerTsSchema,
    thinking: ThinkingFlagSchema,
});
export const ServerStreamDeltaSchema = z.object({
    type: z.literal('stream_delta'),
    messageId: z.string(),
    delta: z.string(),
    serverTs: ServerTsSchema,
    thinking: ThinkingFlagSchema,
});
export const ServerStreamEndSchema = z.object({
    type: z.literal('stream_end'),
    messageId: z.string(),
    serverTs: ServerTsSchema,
    thinking: ThinkingFlagSchema,
});
export const ServerMessageSchema = z.object({
    type: z.literal('message'),
    messageType: z.string(),
    content: z.string(),
    tool: z.string().nullable().optional(),
    options: z.any().optional(),
    timestamp: z.number(),
    code: z.string().max(64).optional(),
    // #4947 / #5006: only set on `messageType: 'error'` envelopes whose
    // `code` is one of the two resume-failure codes emitted by CliSession's
    // `_handleChildClose` resume-failure path:
    //   - `'resume_unknown'` (server PR #4944) — recoverable; CliSession has
    //     already auto-fallen-back to a fresh conversation.
    //   - `'resume_unknown_exhausted'` (server PR #5004) — terminal; the
    //     post-fallback retry ALSO matched the unknown-resume pattern, the
    //     server has stopped auto-respawning, and the user must start a
    //     fresh session manually.
    //   - `'cli_respawn_exhausted'` (#5698) — terminal; CliSession's bounded
    //     auto-respawn budget (rolling rate cap or the consecutive max of 5) is
    //     spent, the server has stopped respawning, and the session is being
    //     dropped. Distinct from a transient error toast so the client can
    //     render a final "session ended (flapping)" state. DockerSession (the
    //     only CliSession subclass) inherits it; the other subprocess providers
    //     have no auto-respawn loop, and the claude-tui PTY mirror emits the
    //     sibling `pty_respawn_exhausted` / `resume_unknown_exhausted` codes for
    //     the same terminal condition.
    // Carries the conversation id chroxy passed to `claude --resume <id>`
    // before the CLI rejected it; dashboards surface it under the affordance
    // for operator correlation against the persisted state file
    // (`resumeConversationId` in `~/.chroxy/session-state.json`). Optional +
    // length-capped so a malformed producer can't pollute the wire with
    // megabyte payloads.
    attemptedResumeId: z.string().max(256).optional(),
    // #5067: captured stdout/stderr from a failed docker-byok
    // postCreateCommand. Only set on `messageType: 'error'` envelopes
    // whose `code` is `'post_create_command_failed'`; the session layer
    // (docker-byok-session.js) tail-caps each stream to 4 KiB before
    // emitting, and event-normalizer.js re-caps at 8 KiB at the wire
    // boundary. The 8192 ceiling here is the wire-schema bound;
    // producers (the session layer) apply a tighter cap. Optional so
    // existing error envelopes (resume_unknown, generic crashes) stay
    // shape-compatible.
    stdout: z.string().max(8192).optional(),
    stderr: z.string().max(8192).optional(),
});
export const ServerToolStartSchema = z.object({
    type: z.literal('tool_start'),
    messageId: z.string(),
    toolUseId: z.string(),
    tool: z.string(),
    input: z.any(),
    serverName: z.string().optional(),
});
export const ServerToolResultSchema = z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    result: z.any(),
    truncated: z.boolean().optional(),
    // #6712: whether the result represents a FAILED tool execution (a failed codex
    // mcpToolCall, or a synthetic orphan-sweep result), so clients can render an
    // error affordance. Optional: only `true` is meaningful — clients treat a
    // missing value as false. Older servers and non-mcp tools omit it; codex
    // mcpToolCall emits it explicitly (`false` on success).
    isError: z.boolean().optional(),
});
// #4080 / #4081: incremental partial-JSON chunk for a streaming tool_use
// `input`. Emitted between `tool_start` and `tool_result` while the
// SDK's `input_json_delta` chunks arrive. `partialJson` is the raw
// JSON fragment from that single SDK chunk — clients concatenate it
// onto a per-toolUseId accumulator. Mid-stream partials are inherently
// unparseable JSON; clients render verbatim until a chunk completes
// the document or `tool_result` lands.
export const ServerToolInputDeltaSchema = z.object({
    type: z.literal('tool_input_delta'),
    messageId: z.string(),
    toolUseId: z.string(),
    partialJson: z.string(),
});
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
export const ServerContextOccupancySnapshotSchema = z.object({
    totalTokens: z.number().nonnegative(),
    maxTokens: z.number().positive().nullable().optional(),
    autoCompactThreshold: z.number().positive().nullable().optional(),
    isAutoCompactEnabled: z.boolean().nullable().optional(),
    source: z.enum(['context-usage-api', 'final-round-prompt']).optional(),
});
export const ServerResultSchema = z.object({
    type: z.literal('result'),
    // #5630: `null` means "cost unknown" (pricing/usage couldn't be computed) —
    // distinct from a genuine $0 turn. Subscription runs and any turn whose model
    // pricing is unknown emit `null`; the dashboard renders "n/a" for it.
    cost: z.number().nullable().optional(),
    duration: z.number().optional(),
    usage: z.any().optional(),
    sessionId: z.string().nullable().optional(),
    // #6627: the session's authoritative outgoing-queue length at turn end, so
    // clients reconcile a stale "Queued" bubble on the turn boundary (self-heals a
    // dropped/late message_dequeued). Absent from older servers.
    queueLength: z.number().int().nonnegative().optional(),
    // #6769: occupancy snapshot (see ServerContextOccupancySnapshotSchema).
    // Absent from older servers and from providers with no occupancy signal.
    contextOccupancy: ServerContextOccupancySnapshotSchema.nullable().optional(),
});
export const ServerModelChangedSchema = z.object({
    type: z.literal('model_changed'),
    model: z.string().nullable(),
});
// #3185: per-session promptEvaluator toggle changed. Broadcast to every
// client bound to `sessionId` whenever the value actually flips. Clients
// re-render the toggle and can refetch session_list for confirmation.
export const ServerPromptEvaluatorChangedSchema = z.object({
    type: z.literal('prompt_evaluator_changed'),
    sessionId: z.string(),
    value: z.boolean(),
});
// #3639: per-session promptEvaluatorSkipPattern changed. Broadcast to
// every client bound to `sessionId` whenever the stored source string
// actually changes (set, cleared, or rewritten). `value` is the
// normalised stored value: a non-empty string source, or `null` when
// the override is cleared. Empty string is normalised to null on the
// server before broadcast.
export const ServerPromptEvaluatorSkipPatternChangedSchema = z.object({
    type: z.literal('prompt_evaluator_skip_pattern_changed'),
    sessionId: z.string(),
    value: z.union([z.string(), z.null()]),
});
// #3805: per-session Chroxy context hint toggle changed. Broadcast to
// every client bound to `sessionId` whenever the value actually flips.
// Mirrors ServerPromptEvaluatorChangedSchema — clients re-render the
// toggle and may refetch session_list for confirmation.
export const ServerChroxyContextHintChangedSchema = z.object({
    type: z.literal('chroxy_context_hint_changed'),
    sessionId: z.string(),
    value: z.boolean(),
});
// #4660: per-session preamble changed. Broadcast to every client bound to
// `sessionId` whenever the trimmed value actually differs from the
// previous stored value. Multi-client UIs use this to keep their text
// areas in sync without re-fetching session_list. Value is the stored
// (post-trim) string the server actually injects, not the raw input —
// matters when the client typed leading/trailing whitespace.
export const ServerSessionPreambleChangedSchema = z.object({
    type: z.literal('session_preamble_changed'),
    sessionId: z.string(),
    value: z.string(),
});
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
export const ServerAvailableModelsEntrySchema = z.object({
    id: z.string(),
    label: z.string(),
    fullId: z.string(),
    // `contextWindow` accepts any value at the schema level — the handler
    // applies an additional `typeof === 'number' && > 0` filter so a bad
    // value drops the field but does NOT reject the whole entry. Preserves
    // prior behaviour: malformed `contextWindow` is tolerated, not fatal.
    contextWindow: z.unknown().optional(),
});
export const ServerAvailableModelsSchema = z.object({
    type: z.literal('available_models'),
    models: z.array(z.unknown()).optional(),
    defaultModel: z.string().optional(),
    // #6370: every `available_models` sender tags the roster with the provider it
    // came from (ws-history multi/legacy/refresh/switch, server-cli overlay
    // re-broadcast, ws-forwarding, session-handlers) and the wire contract
    // documents it — declare it so the schema matches. Nullable: several senders
    // pass an explicit `provider: null` for the default/unscoped roster.
    // Non-breaking — the handler reads models/defaultModel off the envelope and
    // ignored the undeclared key before.
    provider: z.string().nullable().optional(),
});
export const ServerPermissionModeChangedSchema = z.object({
    type: z.literal('permission_mode_changed'),
    mode: z.string(),
});
export const ServerPermissionRequestSchema = z.object({
    type: z.literal('permission_request'),
    requestId: z.string(),
    tool: z.string(),
    description: z.string().optional(),
    input: z.any(),
    remainingMs: z.number().int().nonnegative().finite().max(MAX_SANE_DURATION_MS).optional(),
    // #2832/#2905: server includes the chroxy sessionId on permission_request
    // payloads so the dashboard can route the prompt to the right session tab.
    // Emitted by ws-permissions.js (resendPendingPermissions + HTTP fallback).
    sessionId: z.string().optional(),
});
/**
 * #6543 (IDE P3, feature B) — reply to a `get_permission_input`. The
 * `permission_request` broadcast truncates `input` at ~10K (secret-safe), so a
 * client building a per-hunk pre-write diff PULLS the full (still
 * secret-redacted) tool input by requestId. `found` is false when the request
 * is unknown, already resolved, or belongs to another session (with `error`);
 * `input`/`tool` are present only when `found`. Session-bound: the server only
 * returns input for a permission the requesting client's session owns.
 */
export const ServerPermissionInputSchema = z.discriminatedUnion('found', [
    // found:true carries the redacted input (a string-keyed object) + tool name,
    // and NEVER an `error`.
    z.object({
        type: z.literal('permission_input'),
        requestId: z.string(),
        found: z.literal(true),
        /** The tool name (e.g. 'Write' / 'Edit'). */
        tool: z.string().optional(),
        /** The full secret-redacted tool input. */
        input: z.record(z.string(), z.unknown()),
    }),
    // found:false carries an `error` and NEVER `input`/`tool` — a security message,
    // so the "unavailable" shape can't accidentally ship any tool input.
    z.object({
        type: z.literal('permission_input'),
        requestId: z.string(),
        found: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
    }),
]);
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
export const ServerPermissionAuditEntrySchema = z
    .object({
    type: z.string(),
    clientId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    timestamp: z.number(),
    // mode_change
    previousMode: z.string().optional(),
    newMode: z.string().optional(),
    // whitelist_change
    rules: z.array(z.object({ tool: z.string(), decision: z.string() }).passthrough()).optional(),
    // decision
    requestId: z.string().optional(),
    decision: z.string().optional(),
    reason: z.string().optional(),
    // #6830 — decision enrichment: the tool the decision applied to, and (for
    // an `allowAlways` that actually persisted, or a `persisted_rule`
    // auto-approve) the durable-rule marker + the project cwd it's scoped to.
    // Nullable (not just optional): existing callers explicitly pass `null`
    // for "known absent" rather than omitting the key (permission-audit.js
    // `logDecision` defaults).
    tool: z.string().nullable().optional(),
    persist: z.string().nullable().optional(),
    projectKey: z.string().nullable().optional(),
    // #6830 — coalesced persisted-rule entries only: number of approvals
    // folded into this entry, and the first approval's timestamp.
    count: z.number().optional(),
    firstAt: z.number().optional(),
})
    .passthrough();
/**
 * #6772 — reply to a `query_permission_audit` pull: the recent permission audit
 * entries (mode changes, session-rule changes, allow/deny decisions) matching
 * the query's optional sessionId / auditType / since / limit filters. First
 * client caller is the dashboard's per-session "Permission history" view;
 * dashboard-only for v1 (the mobile app's PermissionHistory screen derives its
 * summary from the live chat transcript, not this wire query).
 */
export const ServerPermissionAuditResultSchema = z.object({
    type: z.literal('permission_audit_result'),
    entries: z.array(ServerPermissionAuditEntrySchema),
});
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
export function buildPermissionRequestMessage(fields) {
    const msg = {
        type: 'permission_request',
        requestId: fields.requestId,
        tool: fields.tool,
        input: fields.input,
    };
    // Omit optional fields when absent so the wire shape stays identical to the
    // hand-built literals (clients fall back to the active session when
    // `sessionId` is absent, not null).
    if (fields.description !== undefined)
        msg.description = fields.description;
    if (fields.remainingMs !== undefined)
        msg.remainingMs = fields.remainingMs;
    if (fields.sessionId !== undefined)
        msg.sessionId = fields.sessionId;
    const result = ServerPermissionRequestSchema.safeParse(msg);
    if (!result.success) {
        throw new Error(`buildPermissionRequestMessage: invalid permission_request (${result.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')})`);
    }
    return result.data;
}
export const ServerUserQuestionSchema = z.object({
    type: z.literal('user_question'),
    toolUseId: z.string(),
    questions: z.array(z.any()),
});
export const ServerAgentBusySchema = z.object({
    type: z.literal('agent_busy'),
});
export const ServerAgentIdleSchema = z.object({
    type: z.literal('agent_idle'),
});
export const ServerAgentSpawnedSchema = z.object({
    type: z.literal('agent_spawned'),
    toolUseId: z.string(),
    description: z.string().optional(),
    startedAt: z.number().optional(),
});
export const ServerAgentCompletedSchema = z.object({
    type: z.literal('agent_completed'),
    toolUseId: z.string(),
});
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
export const ServerAgentEventSchema = z.object({
    type: z.literal('agent_event'),
    parentToolUseId: z.string(),
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
});
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
export const ServerPendingBackgroundShellSchema = z.object({
    shellId: z.string(),
    command: z.string(),
    startedAt: z.number().int().nonnegative(),
});
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
export const ServerBackgroundWorkChangedSchema = z.object({
    type: z.literal('background_work_changed'),
    sessionId: z.string(),
    pending: z.array(ServerPendingBackgroundShellSchema),
});
// #6277 — host-local user-shell approval. Sent to the REQUESTING client when a
// user-shell spawn is HELD pending the host operator's out-of-band approval
// (loopback `chroxy shell approve <id>`). Informational: the client shows a
// "waiting for host approval" banner; on approval the normal `session_switched`
// confirms the create, on deny/expiry a `session_error` arrives. Dashboard-only
// for v1 — mobile parity is deferred. `approvalId` is the one-time id the host
// operator reads from the daemon log to approve.
export const ServerShellPendingApprovalSchema = z.object({
    type: z.literal('shell_pending_approval'),
    approvalId: z.string(),
    hint: z.string().optional(),
});
// #6323 (batch 1 of #6314): the live PTY mirror channel (#5835). `terminal_output`
// is raw coalesced ANSI bytes (transient — no history/replay); `terminal_size` is
// the authoritative grid the server broadcasts so observers letterbox to it.
export const ServerTerminalOutputSchema = z.object({
    type: z.literal('terminal_output'),
    sessionId: z.string(),
    data: z.string(),
});
export const ServerTerminalSizeSchema = z.object({
    type: z.literal('terminal_size'),
    sessionId: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
});
