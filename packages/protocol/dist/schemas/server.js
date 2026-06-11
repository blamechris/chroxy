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
export const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000;
const ClientInfoSchema = z.object({
    clientId: z.string(),
    deviceName: z.string().nullable(),
    deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
    platform: z.string(),
});
export const ServerAuthOkSchema = z.object({
    type: z.literal('auth_ok'),
    clientId: z.string(),
    serverMode: z.literal('cli'),
    serverVersion: z.string(),
    latestVersion: z.string().nullable(),
    serverCommit: z.string(),
    cwd: z.string().nullable(),
    connectedClients: z.array(ClientInfoSchema),
    encryption: z.enum(['required', 'disabled']),
    protocolVersion: z.number().int().min(1),
    minProtocolVersion: z.number().int().min(1),
    maxProtocolVersion: z.number().int().min(1),
    // #3272: server-advertised capability map. Keyed by feature name,
    // value=boolean. Lets the dashboard gate UI affordances on the
    // server actually supporting the matching WS message — e.g.
    // `skillTrustAccept` was added in #3269 and is needed by the
    // SkillsPanel Accept button (#3270). Older servers that don't
    // emit this field are treated as "no advertised capabilities" by
    // the dashboard, so feature-gated UI hides itself fail-closed.
    capabilities: z.record(z.string(), z.boolean()).optional(),
    // #3760: effective server inactivity timeout in ms. Surfaced so the
    // ActivityIndicator "approaching timeout" warning can render against
    // the real configured value instead of a hardcoded 20-min default.
    // Must be a positive finite int (ms). Optional because servers from
    // before #3763 don't emit it — the dashboard/app handlers fall back
    // to their hardcoded reference (DEFAULT_RESULT_TIMEOUT_MS = 20 min)
    // when absent.
    resultTimeoutMs: z.number().int().positive().finite().max(MAX_SANE_DURATION_MS).optional(),
    // #3905: effective server hard-kill inactivity timeout in ms (the
    // #3899 hard cap that follows the soft `resultTimeoutMs` warning).
    // Surfaced so the check-in chip can render an accurate "kill in Xh"
    // countdown instead of assuming the 2-hour default. Optional because
    // servers from before #3905 don't emit it — clients fall back to a
    // 2h default when absent. (The matching server-side constant is
    // `DEFAULT_HARD_TIMEOUT_MS` exported from `base-session.js` but is
    // not re-exported from this package.)
    hardTimeoutMs: z.number().int().positive().finite().max(MAX_SANE_DURATION_MS).optional(),
    // #4477: stream-stall recovery window in ms surfaced in auth_ok so the
    // dashboard chip (#4476) can render "Stream stalled — no response for
    // ${humanize(streamStallTimeoutMs)}" with the real configured value
    // instead of hardcoding the 5-min default.
    //
    // Semantics differ from resultTimeoutMs / hardTimeoutMs: 0 is a valid
    // emission meaning the operator explicitly disabled stream-stall
    // recovery (CHROXY_STREAM_STALL_TIMEOUT_MS=0). BaseSession's
    // `_armResultTimeout` skips arming the stall timer when
    // `_streamStallTimeoutMs === 0`, so the wire must be able to communicate
    // that state distinctly from "older server" (field absent). Hence
    // `.nonnegative()` not `.positive()`.
    //
    // Optional because servers from before #4477 don't emit it — clients
    // fall back to the 5-min default when absent. The matching server-side
    // constant is `DEFAULT_STREAM_STALL_TIMEOUT_MS` exported from
    // `base-session.js` but is not re-exported from this package.
    streamStallTimeoutMs: z.number().int().nonnegative().finite().max(MAX_SANE_DURATION_MS).optional(),
    // #5356 (visibility layer): exposure snapshot so clients can warn about the
    // server's network posture. `lanBind` = the HTTP/WS socket is bound to a
    // non-loopback interface (the historical 0.0.0.0 default included), so LAN
    // peers can reach the unauthenticated surface (/health fingerprint,
    // dashboard assets, rate-limited auth/pairing attempts). `quickTunnel` =
    // a public trycloudflare quick tunnel is configured, so the server is
    // internet-reachable at a random public URL (bearer-gated). `bindHost` is
    // the literal address passed to listen(). Optional — servers from before
    // #5356 don't emit it, and clients treat absence as "unknown" (no banner).
    exposure: z.object({
        lanBind: z.boolean(),
        bindHost: z.string().nullable(),
        quickTunnel: z.boolean(),
    }).optional(),
}).passthrough();
export const ServerAuthFailSchema = z.object({
    type: z.literal('auth_fail'),
    reason: z.string(),
});
export const ServerPairFailSchema = z.object({
    type: z.literal('pair_fail'),
    reason: z.string(),
});
// -- Pairing-approval primitive (#5510, epic #5509) --
//
// The verify code travels ONLY server→surfaces: the requester receives it on
// `pair_request_pending` to display; the approver receives it on `pair_pending`
// to compare. The requester never sends the code back, so it cannot influence
// the value (mismatch is impossible by construction). The issued token is
// delivered EXACTLY once on `pair_result { ok: true }` — never logged.
// To the requester, immediately after the daemon queues its pair_request.
export const ServerPairRequestPendingSchema = z.object({
    type: z.literal('pair_request_pending'),
    requestId: z.string(),
    // 6-digit human-comparable verification code (string to preserve leading
    // zeros). Constrained to exactly 6 digits so a server-side regression to a
    // different alphabet/length is caught at the validation boundary.
    verifyCode: z.string().regex(/^\d{6}$/),
});
// Fanned out to HOST-LEVEL (unbound) approval surfaces. deviceName is
// attacker-controlled — capped at the schema and rendered as plain text.
export const ServerPairPendingSchema = z.object({
    type: z.literal('pair_pending'),
    requestId: z.string(),
    deviceName: z.string().max(64),
    // Exactly 6 digits — see ServerPairRequestPendingSchema.
    verifyCode: z.string().regex(/^\d{6}$/),
    // epoch ms when this request expires (lets the surface render a countdown
    // and drop the entry on TTL without a separate message).
    expiresAt: z.number().int().nonnegative().finite(),
});
// To the requester over its still-open connection. On approve: { ok: true,
// token }. On deny / timeout / approver-gone: { ok: false, reason }.
export const ServerPairResultSchema = z.object({
    type: z.literal('pair_result'),
    requestId: z.string(),
    ok: z.boolean(),
    token: z.string().optional(),
    reason: z.string().optional(),
});
// Sent to a host-level surface to RETRACT a pending request that has been
// resolved (approved/denied elsewhere, or expired) so every surface can drop
// its banner. No verify code — just the id and why.
export const ServerPairResolvedSchema = z.object({
    type: z.literal('pair_resolved'),
    requestId: z.string(),
    reason: z.string(),
});
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
export const BackgroundTaskSchema = z.object({
    toolUseId: z.string(),
    kind: z.enum(['bash', 'agent', 'monitor']),
    description: z.string(),
    startedAt: z.number().int().nonnegative().finite(),
});
export const ServerClaudeReadySchema = z.object({
    type: z.literal('claude_ready'),
    // #5431: outstanding background work detected from the session
    // transcript when the readiness probe flips to "ready for input".
    // Both fields are OPTIONAL — servers from before #5431 (and session
    // providers without transcript access) never emit them, and clients
    // treat absence exactly like today's plain ready. An explicit empty
    // `backgroundTasks: []` means "previously-reported tasks have all
    // completed" so clients can clear a stale indicator.
    backgroundTasks: z.array(BackgroundTaskSchema).optional(),
    // #5431: a pending ScheduleWakeup — the agent ended its turn but
    // arranged to resume at `at` (epoch ms). Absent when no wakeup is
    // scheduled or it has already fired/been superseded.
    scheduledWakeup: z.object({
        at: z.number().int().nonnegative().finite(),
        reason: z.string(),
    }).optional(),
});
// #5515 (epic #5514): optional, additive wall-clock (ms epoch) timestamp
// stamped on stream messages and the pong reply at broadcast time. Clients use
// it to measure server→render latency (token-to-render) and to split RTT into
// uplink/downlink. Wall-clock (not monotonic) because it crosses machines;
// consumers MUST treat raw cross-machine subtraction as skew-prone and derive
// one-way numbers from the RTT-split method instead (see app/dashboard
// latency-stats). Always optional so older servers/clients interop unchanged.
const ServerTsSchema = z.number().int().nonnegative().finite().optional();
export const ServerStreamStartSchema = z.object({
    type: z.literal('stream_start'),
    messageId: z.string(),
    serverTs: ServerTsSchema,
});
export const ServerStreamDeltaSchema = z.object({
    type: z.literal('stream_delta'),
    messageId: z.string(),
    delta: z.string(),
    serverTs: ServerTsSchema,
});
export const ServerStreamEndSchema = z.object({
    type: z.literal('stream_end'),
    messageId: z.string(),
    serverTs: ServerTsSchema,
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
export const ServerResultSchema = z.object({
    type: z.literal('result'),
    cost: z.number().optional(),
    duration: z.number().optional(),
    usage: z.any().optional(),
    sessionId: z.string().nullable().optional(),
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
// ───────────────────────────────────────────────────────────────────────────
// Control Room activity tree (#5159 epic, #5161 protocol contract)
// ───────────────────────────────────────────────────────────────────────────
//
// Wire contract for the per-session "activity tree": the live map of every
// in-flight process inside a chroxy-managed session — Task subagents, Bash
// `run_in_background` shells, and long-running tool calls — each with a status,
// elapsed time, and a parent→child hierarchy (session → agent → tool).
//
// This file defines ONLY the schemas/types (issue #5161). The server emitter
// (#5160), store-core reducer (#5162), and dashboard panel (#5163) consume
// these. The shape is deliberately minimal-but-complete so all three
// downstream consumers can build on it without a wire change.
//
// Two message types form the contract:
//   - `activity_snapshot` — the full current tree for a session. Emitted on
//     subscribe / resync so a late-joining client gets canonical state in one
//     message (mirrors the `background_work_changed` full-snapshot philosophy:
//     a client never has to reconcile deltas against a separate snapshot to be
//     correct).
//   - `activity_delta` — an incremental change to a single entry (started /
//     updated / ended). Emitted as work progresses so an already-subscribed
//     client doesn't pay the full-snapshot cost on every status flip.
//
// Forward/back compat: both messages carry a `schemaVersion` (currently 1) so a
// future field-set change can be signalled without a wire-shape break, and all
// schemas strip unknown fields (Zod default) so an older client parsing a newer
// server's payload silently ignores fields it doesn't recognise. Older clients
// that predate these message types ignore the unknown `type` entirely at the
// dispatch layer.
/**
 * Current schema version for the activity-tree wire contract. Carried on both
 * `activity_snapshot` and `activity_delta` so consumers can branch on it if a
 * future, additive field-set revision lands. Bump only for a deliberate shape
 * change; additive optional fields do NOT require a bump (Zod strips unknowns,
 * so older clients stay compatible).
 */
export const ACTIVITY_SCHEMA_VERSION = 1;
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
export const ActivityKindSchema = z.enum(['agent', 'shell', 'tool']);
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
export const ActivityStatusSchema = z.enum(['running', 'blocked', 'done', 'failed']);
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
export const ACTIVITY_OUTPUT_REF_KINDS = ['tool_use', 'shell', 'message'];
export const ActivityOutputRefSchema = z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
});
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
export const ActivityEntrySchema = z.object({
    id: z.string().min(1),
    kind: ActivityKindSchema,
    label: z.string(),
    status: ActivityStatusSchema,
    startedAt: z.number().int().nonnegative().finite(),
    endedAt: z.number().int().nonnegative().finite().optional(),
    parentId: z.string().min(1).optional(),
    outputRef: ActivityOutputRefSchema.optional(),
}).superRefine((entry, ctx) => {
    const terminal = entry.status === 'done' || entry.status === 'failed';
    if (terminal && entry.endedAt === undefined) {
        ctx.addIssue({
            code: 'custom',
            path: ['endedAt'],
            message: 'endedAt is required when status is "done" or "failed"',
        });
    }
    if (!terminal && entry.endedAt !== undefined) {
        ctx.addIssue({
            code: 'custom',
            path: ['endedAt'],
            message: 'endedAt must be absent while status is "running" or "blocked"',
        });
    }
    if (entry.endedAt !== undefined && entry.endedAt < entry.startedAt) {
        ctx.addIssue({
            code: 'custom',
            path: ['endedAt'],
            message: 'endedAt must be >= startedAt',
        });
    }
});
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
export const ServerActivitySnapshotSchema = z.object({
    type: z.literal('activity_snapshot'),
    sessionId: z.string(),
    schemaVersion: z.number().int().positive(),
    entries: z.array(ActivityEntrySchema),
});
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
export const ServerActivityDeltaSchema = z.object({
    type: z.literal('activity_delta'),
    sessionId: z.string(),
    schemaVersion: z.number().int().positive(),
    op: z.enum(['started', 'updated', 'ended']),
    entry: ActivityEntrySchema,
}).superRefine((msg, ctx) => {
    if (msg.op === 'ended') {
        const terminal = msg.entry.status === 'done' || msg.entry.status === 'failed';
        if (!terminal) {
            ctx.addIssue({
                code: 'custom',
                path: ['entry', 'status'],
                message: 'an "ended" delta must carry a terminal entry status ("done" or "failed")',
            });
        }
    }
});
/**
 * #5277: positive ack that a `cancel_activity` request was actioned. Success
 * was previously silent — the terminal `activity_delta` was the only signal,
 * which the dashboard couldn't correlate to a specific cancel click (and which
 * could be delayed/dropped). This echoes the request's `activityId` and
 * (when supplied) `requestId` so the caller gets a definite per-request signal.
 * Failures continue to surface as a `CANCEL_ACTIVITY_FAILED` session_error,
 * which also echoes `requestId`.
 */
export const ServerCancelActivityAckSchema = z.object({
    type: z.literal('cancel_activity_ack'),
    activityId: z.string(),
    // #5277: the session the cancelled node belongs to. Activity ids (toolUseIds)
    // are only unique WITHIN a session, so the dashboard scopes its pending-cancel
    // state by sessionId+activityId — the ack echoes the session for that.
    sessionId: z.string().optional(),
    requestId: z.string().max(128).optional(),
}).passthrough();
// ───────────────────────────────────────────────────────────────────────────
// Host/Repo Status Control Room (#5170 epic, #5171 protocol contract)
// ───────────────────────────────────────────────────────────────────────────
//
// Wire contract for the Host/Repo Status survey: a one-shot, pull-driven picture
// of every repo the host knows about — `config.repos` unioned with repos
// auto-discovered under a configurable root (default `~/Projects`). Each repo is
// classified into a `verdict` (live / investigate / abandoned / recent /
// onboarded) so the Control Room can colour-code the table and surface "needs
// attention" repos without the client re-deriving the heuristic.
//
// This file defines ONLY the schemas/types (issue #5171). The server emitter,
// store-core reducer, and dashboard panel consume these in sibling issues of the
// #5170 epic.
//
// Flow: the client sends `host_status_request` (see client.ts) — typically the
// Refresh button — and the server replies with exactly one
// `host_status_snapshot`. There is no delta stream (unlike the activity tree):
// the survey is cheap-enough-to-resend and the table is small, so a full
// snapshot per refresh keeps both sides trivial.
//
// Forward/back compat: all schemas strip unknown fields (Zod default) so an
// older client parsing a newer server's payload silently ignores fields it
// doesn't recognise, and a client predating these message types ignores the
// unknown `type` at the dispatch layer.
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
export const RepoVerdictSchema = z.enum([
    'live',
    'investigate',
    'abandoned',
    'recent',
    'onboarded',
]);
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
export const RepoTreeSchema = z.object({
    state: z.enum(['clean', 'dirty']),
    untracked: z.number().int().nonnegative().finite(),
    modified: z.number().int().nonnegative().finite(),
    staged: z.number().int().nonnegative().finite(),
});
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
export const RepoStatusSchema = z.object({
    name: z.string(),
    path: z.string(),
    branch: z.string(),
    verdict: RepoVerdictSchema,
    live: z.boolean(),
    tree: RepoTreeSchema,
    worktrees: z.number().int().nonnegative().finite(),
    ahead: z.number().int().nonnegative().finite().nullable(),
    behind: z.number().int().nonnegative().finite().nullable(),
    openPRs: z.number().int().nonnegative().finite().nullable(),
    prChecks: z
        .object({
        failing: z.number().int().nonnegative().finite(),
        pending: z.number().int().nonnegative().finite(),
        approved: z.number().int().nonnegative().finite(),
        changesRequested: z.number().int().nonnegative().finite(),
    })
        .nullable(),
    // Constrained to the GitHub pulls-page shape (not a generic URL): this value
    // is rendered into an <a href>, and `z.string().url()` would accept dangerous
    // schemes like `javascript:`. Owner/repo are single path segments.
    prsUrl: z
        .string()
        .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pulls$/, 'must be a GitHub pull-requests URL')
        .nullable(),
    attribution: z.boolean().nullable(),
    onboarding: z.string(),
    lastTouched: z.string().datetime(),
    note: z.string().optional(),
});
/**
 * Aggregate counts across the surveyed repos, one per verdict bucket. Carried
 * alongside `repos` so the Control Room's summary chips don't have to re-tally
 * the array (and stay consistent with the server's own count even if a future
 * server truncates the `repos` list). All non-negative integers.
 */
export const HostStatusSummarySchema = z.object({
    live: z.number().int().nonnegative().finite(),
    onboarded: z.number().int().nonnegative().finite(),
    abandoned: z.number().int().nonnegative().finite(),
    investigate: z.number().int().nonnegative().finite(),
    recent: z.number().int().nonnegative().finite(),
});
/**
 * #5171 — full Host/Repo Status snapshot. Emitted in reply to a
 * `host_status_request` (see client.ts). Carries the survey root, the aggregate
 * `summary`, and the per-repo `repos` rows. `generatedAt` is the ISO-8601 time
 * the survey ran so the Control Room can render "generated Nm ago" and detect a
 * stale snapshot. An empty `repos` array is the valid "no repos found under the
 * root" state — never omitted.
 */
export const ServerHostStatusSnapshotSchema = z.object({
    type: z.literal('host_status_snapshot'),
    generatedAt: z.string().datetime(),
    root: z.string(),
    summary: HostStatusSummarySchema,
    repos: z.array(RepoStatusSchema),
});
// ---------------------------------------------------------------------------
// #5253: Self-hosted runner status Control Room surface.
//
// A second host-level pull survey, sibling to the Host/Repo Status one above.
// The client sends `runner_status_request` (see client.ts — the Refresh button
// on the "Self-hosted runners" Control Room tab) and the server replies with
// exactly one `runner_status_snapshot`: the state of every GitHub Actions
// self-hosted runner installed on the host, grouped by the repo (or org) it
// serves. Same pull-on-Refresh model as host_status — no delta stream.
//
// Same forward/back-compat posture as the host survey: schemas strip unknown
// fields, so an older client ignores newer fields and a client predating these
// types ignores the unknown `type` at dispatch.
// ---------------------------------------------------------------------------
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
export const RunnerVerdictSchema = z.enum([
    'busy',
    'idle',
    'offline',
    'stopped',
    'unregistered',
]);
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
export const RunnerServiceStateSchema = z.object({
    manager: z.enum(['launchd', 'systemd', 'none']),
    label: z.string().nullable(),
    running: z.boolean(),
    pid: z.number().int().nonnegative().finite().nullable(),
    lastExitCode: z.number().int().finite().nullable(),
});
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
export const RunnerInfoSchema = z.object({
    name: z.string(),
    dir: z.string(),
    verdict: RunnerVerdictSchema,
    service: RunnerServiceStateSchema,
    githubStatus: z.enum(['online', 'offline']).nullable(),
    busy: z.boolean().nullable(),
    os: z.string().nullable(),
    labels: z.array(z.string()),
});
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
export const RepoRunnersSchema = z.object({
    name: z.string(),
    owner: z.string().nullable(),
    repo: z.string().nullable(),
    githubUrl: z.string(),
    runnersUrl: z
        .string()
        .regex(/^https:\/\/github\.com\/(?:[^/]+\/[^/]+\/settings\/actions\/runners|organizations\/[^/]+\/settings\/actions\/runners)$/, 'must be a GitHub runner-settings URL')
        .nullable(),
    runners: z.array(RunnerInfoSchema),
});
/**
 * Aggregate runner counts across the host, one per verdict bucket plus a
 * `total`. Carried alongside `repos` so the runner tab's summary chips don't
 * re-tally. All non-negative integers.
 */
export const RunnerStatusSummarySchema = z.object({
    total: z.number().int().nonnegative().finite(),
    busy: z.number().int().nonnegative().finite(),
    idle: z.number().int().nonnegative().finite(),
    offline: z.number().int().nonnegative().finite(),
    stopped: z.number().int().nonnegative().finite(),
    unregistered: z.number().int().nonnegative().finite(),
});
/**
 * #5253 — full self-hosted runner snapshot. Emitted in reply to a
 * `runner_status_request` (see client.ts). `root` is the scanned runner-install
 * root (default `~/github-runners`). `generatedAt` is the ISO-8601 survey time
 * for the "generated Nm ago" line. An empty `repos` array is the valid "no
 * runners installed under the root" state — never omitted.
 */
export const ServerRunnerStatusSnapshotSchema = z.object({
    type: z.literal('runner_status_snapshot'),
    // Echoes the client's `runner_status_request` requestId so the dashboard can
    // correlate a snapshot to the Refresh click that triggered it. Present (null
    // when the client omitted one); the handler always sets it.
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    root: z.string(),
    summary: RunnerStatusSummarySchema,
    repos: z.array(RepoRunnersSchema),
    // Additive degraded-snapshot annotation: on a forbidden/in-progress/failed
    // survey the handler returns an otherwise-valid (empty repos, zeroed summary)
    // snapshot plus this `error`, so consumers can surface the failure typed
    // rather than special-casing a malformed reply.
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
// ---------------------------------------------------------------------------
// #5499 (epic #5498) — Control Room "Integrations" tab: per-repo repo-memory
// observability. Emitted in reply to an `integration_status_request` (see
// client.ts). Same pull-on-Refresh, degraded-snapshot-with-`error` contract as
// the host and runner surveys above.
// ---------------------------------------------------------------------------
/**
 * repo-memory cache file stats for one repo (`.repo-memory/cache.db` plus its
 * `-wal` sidecar). `present` is false when the cache file doesn't exist yet
 * (config without traffic); `sizeBytes` then reports 0. `lastModified` is the
 * newest mtime across the db + wal files (ISO-8601), or null when absent —
 * it doubles as a "last activity" proxy because the telemetry report carries
 * no timestamp of its own.
 */
export const RepoMemoryCacheSchema = z.object({
    present: z.boolean(),
    sizeBytes: z.number().int().nonnegative().finite(),
    lastModified: z.string().datetime().nullable(),
});
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
export const RepoMemoryReportSchema = z.object({
    totalEvents: z.number().int().nonnegative().finite(),
    cacheHits: z.number().int().nonnegative().finite(),
    cacheMisses: z.number().int().nonnegative().finite(),
    cacheHitRatio: z.number().min(0).max(1),
    estimatedTokensSaved: z.number().nonnegative().finite(),
    cacheEntryCount: z.number().int().nonnegative().finite().nullable(),
    staleEntryCount: z.number().int().nonnegative().finite().nullable(),
    lastActivity: z.string().datetime().nullable(),
});
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
export const RepoMemoryStatusSchema = z.object({
    configured: z.boolean(),
    summarizer: z.string().nullable(),
    toolGroups: z.array(z.string()),
    cache: RepoMemoryCacheSchema.nullable(),
    report: RepoMemoryReportSchema.nullable(),
    reason: z.string().nullable(),
});
/**
 * #5501 — one recent repo-relay workflow run, distilled from
 * `gh run list --workflow=repo-relay.yml --json status,conclusion,event,createdAt,databaseId`.
 * `databaseId` is GitHub's run id — #5502's rerun action consumes it, so it is
 * carried verbatim. `conclusion` is null while the run is still in progress.
 */
export const RepoRelayRunSchema = z.object({
    databaseId: z.number().int().nonnegative().finite(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    event: z.string().nullable(),
    createdAt: z.string().datetime().nullable(),
});
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
export const RepoRelayVerdictSchema = z.enum(['ok', 'failing', 'drifted', 'not_installed', 'unknown']);
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
export const RepoRelayStatusSchema = z.object({
    installed: z.boolean(),
    pinnedVersion: z.string().nullable(),
    pinnedSha: z.string().nullable(),
    latestVersion: z.string().nullable(),
    runs: z.array(RepoRelayRunSchema),
    failureStreak: z.number().int().nonnegative().finite(),
    verdict: RepoRelayVerdictSchema,
    driftUnknown: z.boolean(),
    workflowUrl: z.string().nullable(),
    reason: z.string().nullable(),
});
/**
 * One surveyed repo in the Integrations snapshot. `repoMemory` is nullable so
 * a future integration can appear without forcing a repo-memory block.
 * `repoRelay` (#5501) is additive — optional so #5503-era producers/fixtures
 * stay valid; the current survey always emits it (a repo without the workflow
 * file gets a quiet `installed: false` block, same posture as unconfigured
 * repo-memory).
 */
export const IntegrationRepoSchema = z.object({
    name: z.string(),
    path: z.string(),
    repoMemory: RepoMemoryStatusSchema.nullable(),
    repoRelay: RepoRelayStatusSchema.nullable().optional(),
});
/**
 * Aggregate repo-memory counts across the surveyed repos, carried alongside
 * `repos` so the Integrations tab's summary chips don't re-tally. `degraded`
 * counts configured repos whose report cell carries a `reason`.
 */
export const IntegrationStatusSummarySchema = z.object({
    total: z.number().int().nonnegative().finite(),
    configured: z.number().int().nonnegative().finite(),
    notConfigured: z.number().int().nonnegative().finite(),
    degraded: z.number().int().nonnegative().finite(),
    // #5501 (additive — optional so pre-relay snapshots stay valid): repo-relay
    // tallies for the summary chips. `relayFailing` / `relayDrifted` count the
    // verdict buckets; `relayInstalled` counts repos with the workflow file.
    relayInstalled: z.number().int().nonnegative().finite().optional(),
    relayFailing: z.number().int().nonnegative().finite().optional(),
    relayDrifted: z.number().int().nonnegative().finite().optional(),
});
/**
 * Snapshot-level note about the `repo-memory` CLI binary, probed ONCE per
 * survey. When `found` is false every configured repo's CLI-derived cells are
 * degraded and `note` explains why (the per-repo `reason` repeats it).
 */
export const IntegrationCliStatusSchema = z.object({
    found: z.boolean(),
    path: z.string().nullable(),
    note: z.string().nullable(),
});
/**
 * #5499 — full Integrations survey snapshot. Emitted in reply to an
 * `integration_status_request` (see client.ts). `root` is the Control Room
 * discovery root the repo set was resolved under (same as the host survey).
 * An empty `repos` array is the valid "no repos under the root" state.
 * `repoMemoryCli` is optional so the degraded error-snapshot (FORBIDDEN /
 * SURVEY_IN_PROGRESS / SURVEY_FAILED) can reuse the shared error envelope; a
 * successful survey always carries it.
 */
export const ServerIntegrationStatusSnapshotSchema = z.object({
    type: z.literal('integration_status_snapshot'),
    // Echoes the client's `integration_status_request` requestId so the
    // dashboard can correlate a snapshot to the Refresh click that triggered it.
    requestId: z.string().nullable().optional(),
    generatedAt: z.string().datetime(),
    root: z.string(),
    summary: IntegrationStatusSummarySchema,
    repos: z.array(IntegrationRepoSchema),
    repoMemoryCli: IntegrationCliStatusSchema.optional(),
    // #5501: snapshot-level note about the `gh` CLI, probed ONCE per survey —
    // when `found` is false every repo-relay run/release cell degrades and
    // `note` explains why (each installed repo's `reason` repeats it).
    ghCli: IntegrationCliStatusSchema.optional(),
    // Additive degraded-snapshot annotation — same posture as the host/runner
    // snapshots: on a forbidden/in-progress/failed survey the handler returns an
    // otherwise-valid empty snapshot plus this `error`.
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
/**
 * #5500 (epic #5498) — counts distilled from a `repo-memory index` run, as
 * printed by the CLI's human-readable report (field names verified against
 * the IndexReport shape in @blamechris/repo-memory: scanned / summarized /
 * "already fresh" / skipped). All four are required — a partially parsed
 * report is treated as unparseable and the ack carries `counts: null`
 * instead, so the dashboard never renders a half-true breakdown.
 */
export const IntegrationActionCountsSchema = z.object({
    scanned: z.number().int().nonnegative().finite(),
    summarized: z.number().int().nonnegative().finite(),
    fresh: z.number().int().nonnegative().finite(),
    skipped: z.number().int().nonnegative().finite(),
});
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
export const ServerIntegrationActionAckSchema = z.object({
    type: z.literal('integration_action_ack'),
    action: z.string(),
    repoPath: z.string(),
    requestId: z.string().max(128).nullable().optional(),
    runId: z.number().int().nonnegative().finite().nullable().optional(),
    counts: IntegrationActionCountsSchema.nullable(),
}).passthrough();
// ───────────────────────────────────────────────────────────────────────────
// #5554 (epic #5159) — Control Room "Skills" tab: inventory + usage history.
// ───────────────────────────────────────────────────────────────────────────
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
export const SkillInventoryEntrySchema = z.object({
    name: z.string(),
    description: z.string(),
    source: z.enum(['global', 'repo']),
    activation: z.enum(['auto', 'manual']),
    active: z.boolean(),
    providers: z.array(z.string()),
    version: z.string().nullable(),
    trustState: z.enum(['trusted', 'pending']).nullable(),
    communityAuthor: z.string().nullable(),
    hash: z.string().nullable(),
    installed: z.string().nullable(),
    overridesGlobal: z.boolean().optional(),
    lastUsed: z.string().datetime().nullable(),
    useCount: z.number().int().nonnegative().finite(),
    usedRepos: z.array(z.string()),
});
/**
 * #5554 — one surveyed repo's skill overlay. `skills` is the repo-local
 * `.chroxy/skills/` overlay (empty when the repo has no overlay — absence is
 * signal, not an error). `error` carries a per-repo scan-failure reason so a
 * single broken overlay degrades to a chip on that card rather than a dead
 * snapshot.
 */
export const SkillInventoryRepoSchema = z.object({
    name: z.string(),
    path: z.string(),
    skills: z.array(SkillInventoryEntrySchema),
    error: z.string().nullable(),
});
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
export const ServerSkillsInventorySnapshotSchema = z.object({
    type: z.literal('skills_inventory_snapshot'),
    requestId: z.string().max(128).nullable().optional(),
    generatedAt: z.string().datetime(),
    root: z.string(),
    global: z.array(SkillInventoryEntrySchema),
    globalError: z.string().nullable().optional(),
    repos: z.array(SkillInventoryRepoSchema),
    error: z
        .object({
        code: z.string(),
        message: z.string(),
    })
        .optional(),
});
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
export const ServerSummarizeSessionResultSchema = z.object({
    type: z.literal('summarize_session_result'),
    sessionId: z.string(),
    summary: z.string(),
    truncated: z.boolean().optional(),
    requestId: z.string().max(128).nullable().optional(),
}).passthrough();
export const ServerClientFocusChangedSchema = z.object({
    type: z.literal('client_focus_changed'),
    clientId: z.string(),
    sessionId: z.string(),
    timestamp: z.number(),
});
// #3899: soft inactivity warning. Replaces the pre-#3899 kill-on-timeout
// behaviour with a check-in flow — the server fires this event after
// `resultTimeoutMs` of silence (default 30 min), the client renders a
// transient chip with a one-click `prefab` follow-up message ("Status
// update?"). The session stays alive (busy state preserved, pending
// permissions left pending). If silence continues past `hardTimeoutMs`
// (default 2h) with no user check-in, the existing kill path still fires
// — that's the absolute backstop for genuinely stuck sessions.
//
// `idleMs` is the elapsed silence at the moment the soft timer fired —
// equals `resultTimeoutMs` on the first warning but may differ on later
// firings if the server has been adjusted at runtime.
export const ServerInactivityWarningSchema = z.object({
    type: z.literal('inactivity_warning'),
    messageId: z.string(),
    // `idleMs` matches the duration-field discipline in this file: integer,
    // positive (zero is meaningless for an elapsed-silence value), finite,
    // bounded by MAX_SANE_DURATION_MS (24h). The soft window defaults to
    // 30 min and is operator-configurable down to 30s, so positive is the
    // correct floor — never zero, never negative, never NaN/Infinity.
    idleMs: z.number().int().positive().finite().max(MAX_SANE_DURATION_MS),
    prefab: z.string(),
});
// #4653: chroxy-side intervention surfaced to the user. Currently only the
// multi-question AskUserQuestion deny shipped in #4648 fires this event.
// The dashboard / mobile app append a SessionIntervention entry to the
// targeted session's interventions ring and render a FooterBar counter
// chip + (first-time only) inline system ChatMessage so users can tell
// chroxy intervened — without this surface the deny is invisible.
//
// `reason` is a discriminator that lets future intervention kinds land
// without a wire version bump (sibling-deny from #4668 would extend the
// enum here). `questionCount >= 2` because the permission-hook only
// denies multi-question forms — single-question is the happy path.
export const ServerMultiQuestionInterventionSchema = z.object({
    type: z.literal('multi_question_intervention'),
    // Stable id of the tool_use the hook denied. Dashboard dedups by this
    // so a stuck model re-emitting the same payload doesn't inflate the
    // counter falsely (the #4666 / #4668 failure mode).
    toolUseId: z.string(),
    // Question count from the denied AskUserQuestion form. Hook only fires
    // for length > 1, so the floor is 2 — defence-in-depth against a server
    // bug that would otherwise inject a "0 questions" entry into the UI.
    questionCount: z.number().int().min(2).finite(),
    reason: z.literal('multi_question'),
    // Server wall-clock when the deny happened. Allowed to be 0 (epoch) so
    // a clock-skewed dev environment doesn't bounce the event off the wire,
    // but typical values are 1.7e12+ (post-2023). The client renders relative
    // ("3s ago") from this.
    timestamp: z.number().int().min(0).finite(),
});
export const ServerMcpServersSchema = z.object({
    type: z.literal('mcp_servers'),
    servers: z.array(z.object({
        name: z.string(),
        status: z.string(),
    })),
});
export const ServerPlanStartedSchema = z.object({
    type: z.literal('plan_started'),
});
export const ServerPlanReadySchema = z.object({
    type: z.literal('plan_ready'),
    allowedPrompts: z.array(z.any()).optional(),
});
// #4091: cumulative per-session token + cost totals. Emitted by
// _trackUsage on every priced result event; consumed by the dashboard
// sidebar cost badge (#4073) and mobile session-header badge (#4074).
//
// Token counts + turnsBilled are non-negative integers — they are
// monotonic counters that only grow on priced result events. costUsd
// is finite but intentionally kept unconstrained-sign: a refund /
// credit-adjustment turn (#4099) subtracts from the running total,
// and a session that received only refunds could legitimately end up
// with a negative cumulative.
//
// Declared up here (and not next to the other event-emit schemas
// further down the file) so it can be reused inline by
// `ServerSessionListEntrySchema` below — keeps the snapshot field and
// the event-emit shape in lockstep when either changes.
export const CumulativeUsageSchema = z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    costUsd: z.number().finite(),
    turnsBilled: z.number().int().nonnegative(),
});
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
export const ServerSessionListEntrySchema = z.object({
    sessionId: z.string(),
    name: z.string(),
    // cwd is conventionally always set by the server, but the schema accepts
    // it as optional so test fixtures and minimal mock managers (which omit
    // it for brevity) still validate. Real session_list payloads always carry
    // a string `cwd`.
    cwd: z.string().optional(),
    model: z.string().nullable().optional(),
    permissionMode: z.string().optional(),
    isBusy: z.boolean().optional(),
    createdAt: z.number().optional(),
    lastActivityAt: z.number().optional(),
    conversationId: z.string().nullable().optional(),
    provider: z.string().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    worktree: z.boolean().optional(),
    repoCwd: z.string().nullable().optional(),
    isolation: z.string().optional(),
    promptEvaluator: z.boolean().optional(),
    // #3639: per-session skip-pattern source (or null when unset). The
    // dashboard can show / edit this; the server falls back to
    // `config.promptEvaluatorSkipPattern` when null.
    promptEvaluatorSkipPattern: z.union([z.string(), z.null()]).optional(),
    // #3805: per-session opt-in Chroxy context hint flag. Optional because
    // older servers (pre-#3805) omit the field; the dashboard treats
    // `undefined` as `false` (toggle off).
    chroxyContextHint: z.boolean().optional(),
    // #4660: per-session user-authored preamble (free text prepended to
    // the system prompt every turn). Optional because older servers
    // (pre-#4660) omit the field; the dashboard treats `undefined` as
    // empty string (no preamble injected).
    sessionPreamble: z.string().optional(),
    stdinForwardingDisabled: z.boolean().optional(),
    // #3573: cumulative stdin_dropped totals seeded into the handshake so a
    // late-joining client sees the running counter without waiting for the
    // next drop. SDK-backed sessions report real values; non-SDK providers
    // serialize as 0.
    stdinDroppedBytes: z.number().int().nonnegative().optional(),
    stdinDroppedCount: z.number().int().nonnegative().optional(),
    // #4091: per-session running token + cost totals included in the
    // session_list snapshot (#4072 / #4088). Optional because older
    // servers omit it entirely; consumers should treat `undefined` as
    // "no data yet" and an all-zero block as "session has had no priced
    // turns yet" (e.g. subscription-billed providers).
    //
    // Token counts + turnsBilled are non-negative integers; cumulative
    // costUsd is finite but intentionally allowed to be negative — a
    // refund / credit-adjustment turn (#4099) can subtract from the
    // running total, and a session that received only refunds could
    // legitimately end up with a negative cumulative.
    cumulativeUsage: CumulativeUsageSchema.optional(),
    // #4307: pending backgrounded shells. Empty array when no work is
    // pending — never `undefined` from a #4307-aware server (mirrors the
    // `cumulativeUsage` shape, which always carries a zero block once
    // present). Optional in the schema so pre-#4307 servers that omit
    // the field still parse; consumers should treat `undefined` as `[]`.
    pendingBackgroundShells: z.array(ServerPendingBackgroundShellSchema).optional(),
}).passthrough();
export const ServerSessionListSchema = z.object({
    type: z.literal('session_list'),
    sessions: z.array(ServerSessionListEntrySchema),
});
/**
 * Emitted when a session in the persisted state file could not be restored
 * at server startup (e.g. missing env var for a Codex/Gemini provider).
 *
 * History on disk is preserved (`originalHistoryPreserved: true`) so the user
 * can retry after fixing the underlying issue. Dashboards / mobile UIs should
 * surface the failed session in a "needs attention" state with the reported
 * error and a retry affordance. See issue #2954 (Guardian FM-01).
 */
export const ServerSessionRestoreFailedSchema = z.object({
    type: z.literal('session_restore_failed'),
    sessionId: z.string(),
    name: z.string(),
    provider: z.string(),
    cwd: z.string().optional(),
    model: z.string().nullable().optional(),
    permissionMode: z.string().nullable().optional(),
    errorCode: z.string(),
    errorMessage: z.string(),
    originalHistoryPreserved: z.boolean(),
    historyLength: z.number().optional(),
});
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
export const ServerSessionStoppedSchema = z.object({
    type: z.literal('session_stopped'),
    sessionId: z.string().optional(),
    code: z.number().int().optional(),
});
// #3404 audit (F1+F5): per-provider auth/billing summary so clients can
// grey-out unusable providers and surface billing-identity confidence.
// Optional on the wire so older servers stay parseable.
const ProviderAuthSchema = z.object({
    ready: z.boolean(),
    source: z.enum(['env', 'oauth', 'none']),
    envVar: z.string().nullable(),
    envVars: z.array(z.string()),
    hint: z.string(),
    detail: z.string(),
});
export const ServerProviderListSchema = z.object({
    type: z.literal('provider_list'),
    providers: z.array(z.object({
        name: z.string(),
        capabilities: z.record(z.string(), z.boolean()).optional(),
        auth: ProviderAuthSchema.optional(),
    })),
});
export const ServerSkillsListSchema = z.object({
    type: z.literal('skills_list'),
    skills: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        // #3067: 'global' for ~/.chroxy/skills, 'repo' for <cwd>/.chroxy/skills.
        // Optional so v1 clients keep parsing pre-#3067 payloads cleanly.
        source: z.enum(['global', 'repo']).optional(),
        // #3209: activation mode + per-session active state. Optional so
        // older servers (pre-#3209) without these fields still parse —
        // the dashboard treats absence as `auto`/`active=true`.
        activation: z.enum(['auto', 'manual']).optional(),
        active: z.boolean().optional(),
        // #3205: skills metadata UI fields. All optional — `version` is
        // emitted only when the skill's frontmatter declared one;
        // `hashPrefix`, `firstSeen`, `lastVerified` come from the
        // SkillsTrustStore and are present only when trust is enabled
        // (`trustMismatchMode` set to 'warn' / 'block' on the session)
        // and the skill has been seen at least once. Pre-#3205 servers
        // omit them entirely; the dashboard renders the panel without
        // those columns rather than showing fake data.
        version: z.string().optional(),
        hashPrefix: z.string().length(8).regex(/^[0-9a-f]{8}$/).optional(),
        // #3250: ISO-8601 strings emitted by SkillsTrustStore.getRecord().
        // Tightened from `z.string()` to `z.string().datetime()` so a future
        // serialization drift (e.g. someone passing `Date.toString()` instead
        // of `Date.toISOString()`) fails fast at the schema layer rather
        // than reaching the dashboard's `formatTimestamp` defensive fallback,
        // which would render the malformed string verbatim with no error
        // signal — the regression would silently slip past review.
        //
        // The producer (settings-handlers.handleListSkills) validates each
        // trust-ledger timestamp against `Number.isFinite(Date.parse(...))`
        // before forwarding so a hand-edited or corrupted
        // `~/.chroxy/skills-trust.json` cannot fail the entire `skills_list`
        // payload — malformed values are dropped from the per-skill entry
        // and the response still parses.
        firstSeen: z.string().datetime().optional(),
        lastVerified: z.string().datetime().optional(),
    })),
});
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
export const ServerSkillChangedSchema = z.object({
    type: z.literal('skill_changed'),
    skillName: z.string(),
    sessionId: z.string().nullable(),
    // 8-char prefixes of the recorded vs. new SHA-256 (lower-case hex).
    oldHashPrefix: z.string().length(8).regex(/^[0-9a-f]{8}$/),
    newHashPrefix: z.string().length(8).regex(/^[0-9a-f]{8}$/),
    mode: z.enum(['warn', 'block']),
});
// #3209: runtime manual-skill toggle broadcast. Sent to every client
// bound to `sessionId` whenever a `skill_activate` / `skill_deactivate`
// flips the session's active set. Idempotent — only emitted on actual
// state change (the handler returns early on no-op).
export const ServerSkillActivatedSchema = z.object({
    type: z.literal('skill_activated'),
    sessionId: z.string(),
    skillName: z.string(),
});
export const ServerSkillDeactivatedSchema = z.object({
    type: z.literal('skill_deactivated'),
    sessionId: z.string(),
    skillName: z.string(),
});
// #3235: operator confirmed re-trust of a skill after a content-hash
// mismatch. Broadcast to every client bound to `sessionId` so any
// mismatch badge in the dashboard can clear in lock-step. Pairs with
// the `skill_changed` event from #3234 — where `skill_changed` says
// "the content drifted from the recorded hash", `skill_trust_accepted`
// says "the operator accepted the new content as the source of truth".
export const ServerSkillTrustAcceptedSchema = z.object({
    type: z.literal('skill_trust_accepted'),
    sessionId: z.string(),
    skillName: z.string(),
});
// #3297: community skill pending first-activation trust grant. Transient.
export const ServerSkillTrustRequestSchema = z.object({
    type: z.literal('skill_trust_request'),
    skillName: z.string(),
    author: z.string(),
    source: z.string(),
    description: z.string(),
    path: z.string(),
    sessionId: z.string().nullable(),
});
// #3297: community skill trust granted by operator.
export const ServerSkillTrustGrantedSchema = z.object({
    type: z.literal('skill_trust_granted'),
    sessionId: z.string(),
    skillName: z.string(),
    author: z.string(),
});
// #3297: ack sent to the requesting client after a successful skill_trust_grant.
export const ServerSkillTrustGrantOkSchema = z.object({
    type: z.literal('skill_trust_grant_ok'),
    requestId: z.string().nullable(),
    sessionId: z.string(),
    skillName: z.string(),
    author: z.string(),
});
// #3538: structured error response for `skill_trust_grant` when the per-author
// resolve lands on a different community author than the caller claims (the
// #3307 symlink branch and the #3500 shallow-scan branch). The wire shape is
// the canonical handler error (`type: 'error'`, `code`, `message`) plus an
// `actualAuthor` field carrying the real owner so dashboard clients can branch
// on `code === 'INVALID_AUTHOR'` and read the field directly instead of
// regex-parsing the human-readable `message` (which is intentionally not
// stable wording). Other `INVALID_AUTHOR` causes (empty `author` validation)
// do NOT include `actualAuthor` — the field is only present for the
// cross-author variants.
export const ServerSkillTrustGrantInvalidAuthorSchema = z.object({
    type: z.literal('error'),
    requestId: z.string().nullable(),
    code: z.literal('INVALID_AUTHOR'),
    message: z.string(),
    actualAuthor: z.string(),
});
// #4178: generic server `error` envelope shape — the catch-all schema for
// `type: 'error'` messages that aren't covered by a code-specific variant
// like `ServerSkillTrustGrantInvalidAuthorSchema`. `fatal: false` was
// introduced by #4145 (MAX_TOOL_ROUNDS_REACHED) and is consumed by
// #4176's warning-toast branch in the dashboard. Declaring it here lets
// other clients (mobile app, future tools) consume the same shape via
// the shared store-core `handleError` parser. `fatal` defaults unset
// (treated as `true` by consumers) so omitting it preserves the
// pre-#4145 contract.
//
// `correlationId` + `details` are emitted by the server's INVALID_MESSAGE
// schema-rejection path (`ws-server.js:1314`) and any handler that calls
// `handler-utils.sendError(ws, requestId, code, message, data)` — the
// `data` arg is merged onto the envelope (`handler-utils.js:420-435`)
// after a reserved-field guard. `.passthrough()` matches the wire and
// preserves code-specific fields (e.g. `actualAuthor` on INVALID_AUTHOR,
// `boundSessionId` on SESSION_TOKEN_MISMATCH) so future consumers parsing
// against this generic schema don't silently lose context.
export const ServerErrorEnvelopeSchema = z.object({
    type: z.literal('error'),
    requestId: z.string().nullable().optional(),
    code: z.string().optional(),
    message: z.string(),
    fatal: z.boolean().optional(),
    correlationId: z.string().optional(),
    details: z.string().optional(),
}).passthrough();
// #4141: BYOK credentials status — emitted by handleByokGetCredentialsStatus /
// handleByokSetCredentials / handleByokClearCredentials and broadcast to all
// connected clients on set/clear (#4142). Dashboard previously type-cast the
// payload with raw `as` casts at message-handler.ts:2660 which accepted any
// status/source string from the wire — a malformed server could store
// `status: 'unknown'` into the store. This schema constrains the shape.
//
// fileExists: tracks the on-disk credentials file presence (#4144). When
// status === 'missing' but fileExists === true, the dashboard shows the
// stale-file notice (#4175) — broaden contract handled separately.
export const ServerByokCredentialsStatusSchema = z.object({
    type: z.literal('byok_credentials_status'),
    requestId: z.string().nullable().optional(),
    status: z.enum(['set', 'missing']),
    source: z.enum(['env', 'file', 'none']),
    masked: z.string().optional(),
    reason: z.string().optional(),
    fileExists: z.boolean().optional(),
}).passthrough();
// #3855: generalized provider-credential status. One entry per known
// credential env var. The raw value is NEVER on the wire — only `masked`
// (a redacted preview) when status === 'set'. `source` adds 'store' (the
// ~/.chroxy/credentials.json store) and 'oauth' (a detected OAuth credential
// for the provider) to the BYOK set. Sent only to the requesting client
// (admin state, no broadcast) plus a no-requestId broadcast after set/delete
// so additional dashboards stay in sync.
const ServerCredentialEntrySchema = z.object({
    key: z.string(),
    provider: z.string(),
    label: z.string(),
    kind: z.enum(['api-key', 'oauth-token']),
    status: z.enum(['set', 'missing']),
    source: z.enum(['env', 'store', 'oauth', 'none']),
    masked: z.string().optional(),
    oauth: z.boolean(),
}).passthrough();
export const ServerCredentialsStatusSchema = z.object({
    type: z.literal('credentials_status'),
    requestId: z.string().nullable().optional(),
    credentials: z.array(ServerCredentialEntrySchema),
    fileExists: z.boolean().optional(),
    fileError: z.string().nullable().optional(),
}).passthrough();
// #3855: result of a `test_credential` ping. `ok` true means the provider
// accepted the credential. Never carries the raw value.
export const ServerCredentialTestResultSchema = z.object({
    type: z.literal('credential_test_result'),
    requestId: z.string().nullable().optional(),
    key: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    model: z.string().optional(),
    latencyMs: z.number().optional(),
}).passthrough();
// #3544: cumulative stdin_dropped totals broadcast to clients bound to the
// session whenever a SidecarProcess pre-dial-cap drop occurs. Operators not
// tailing the server log (mobile users, dashboard-only operators) see a live
// "X bytes lost over N drops" indicator instead of a hung turn. Emitted on
// every drop (not only the loud-signal escalations) so the counter stays
// fresh; `escalated` mirrors the server-side log level so the UI can
// differentiate routine warn-level updates from first-drop / threshold-cross
// / every-Nth error-level moments. `sessionId` is null for legacy single-CLI
// mode where there is no per-session scoping. Transient — not replayed on
// reconnect, but the cumulative counters are session-lifetime so the next
// drop re-publishes the running total.
export const ServerStdinDroppedTotalsSchema = z.object({
    type: z.literal('stdin_dropped_totals'),
    sessionId: z.string().nullable(),
    bytes: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    reason: z.string(),
    escalated: z.boolean(),
});
export const ServerErrorSchema = z.object({
    type: z.literal('server_error'),
    category: z.string().optional(),
    message: z.string(),
    recoverable: z.boolean(),
});
export const ServerPushTokenErrorSchema = z.object({
    type: z.literal('push_token_error'),
    message: z.string(),
});
// #4541: notification preferences snapshot. Emitted by
// `handleNotificationPrefsGet` and again after every `notification_prefs_set`.
// Mirrors the on-disk shape (~/.chroxy/notification-prefs.json) without the
// header — the wire payload IS the prefs object.
//
// `categories` is an open-ended map keyed by RATE_LIMITS category names from
// `push.js`. The server-side loader sanitises unknown keys at the storage
// boundary, so the wire shape stays permissive — adding a new push category
// in `push.js` does not require a protocol bump.
//
// `requestId` is echoed on the response to the originating client; the
// broadcast variant emitted after a set carries no requestId so all
// connected clients update in lockstep.
const NotificationPrefsCategoriesSchema = z.record(z.string().min(1).max(64), z.boolean());
// #4544: quiet-hours window carries an IANA timezone; per-device entries
// may also carry their own `quietHours` and `bypassCategories` (the
// device-level fields REPLACE the global value, see `notification-prefs.js`).
const NotificationPrefsQuietHoursSchema = z.union([
    z.null(),
    z.object({
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1).max(64),
    }),
]);
const NotificationPrefsBypassListSchema = z.array(z.string().min(1).max(64)).max(64);
const NotificationPrefsDevicesSchema = z.record(z.string().min(1).max(512), z.object({
    categories: NotificationPrefsCategoriesSchema.optional(),
    quietHours: NotificationPrefsQuietHoursSchema.optional(),
    bypassCategories: NotificationPrefsBypassListSchema.optional(),
}).passthrough());
export const ServerNotificationPrefsSchema = z.object({
    type: z.literal('notification_prefs'),
    requestId: z.string().nullable().optional(),
    prefs: z.object({
        categories: NotificationPrefsCategoriesSchema,
        devices: NotificationPrefsDevicesSchema,
        quietHours: NotificationPrefsQuietHoursSchema,
        // #4544: globally-applied bypass list. Optional in the wire schema so
        // older servers that omit the field still parse — clients should treat
        // `undefined` as "use the documented defaults" (permission + activity_error).
        bypassCategories: NotificationPrefsBypassListSchema.optional(),
    }).passthrough(),
}).passthrough();
export const ServerShutdownSchema = z.object({
    type: z.literal('server_shutdown'),
    // 'crash' is emitted from uncaughtException/unhandledRejection handlers in
    // server-cli.js / server-cli-child.js via broadcastShutdown('crash', 0).
    reason: z.enum(['restart', 'shutdown', 'crash']),
    restartEtaMs: z.number().int().nonnegative().finite().max(MAX_SANE_DURATION_MS),
});
export const ServerPongSchema = z.object({
    type: z.literal('pong'),
    // #5515: optional wall-clock stamp so clients can split the ping/pong RTT
    // into uplink (ping send → serverTs) and downlink (serverTs → pong recv)
    // halves. See ServerStreamDeltaSchema for the wall-clock/skew caveat.
    serverTs: z.number().int().nonnegative().finite().optional(),
});
export const ServerCostUpdateSchema = z.object({
    type: z.literal('cost_update'),
    sessionCost: z.number().nullable().optional(),
    totalCost: z.number().nullable().optional(),
    budget: z.number().nullable().optional(),
});
export const ServerSessionUsageSchema = z.object({
    type: z.literal('session_usage'),
    // sessionId is injected by _broadcastToSession; optional in the schema
    // so consumers can construct the message without it pre-broadcast.
    sessionId: z.string().optional(),
    cumulativeUsage: CumulativeUsageSchema,
});
// #4075: soft per-session cost-threshold crossing. Fires ONCE per
// session when cumulativeUsage.costUsd >= the configured threshold.
//
// costUsd is finite but kept unconstrained-sign: in practice it's the
// running cumulative at the crossing point so always positive, but the
// schema doesn't enforce that to stay consistent with CumulativeUsage
// where refunds (#4099) can in principle drive the cumulative
// negative. thresholdUsd is non-negative by setter contract.
export const ServerSessionCostThresholdCrossedSchema = z.object({
    type: z.literal('session_cost_threshold_crossed'),
    sessionId: z.string().optional(),
    costUsd: z.number().finite(),
    thresholdUsd: z.number().finite().nonnegative(),
});
export const ServerBudgetWarningSchema = z.object({
    type: z.literal('budget_warning'),
    sessionCost: z.number(),
    budget: z.number(),
    percent: z.number(),
    message: z.string(),
});
export const ServerBudgetExceededSchema = z.object({
    type: z.literal('budget_exceeded'),
    sessionCost: z.number(),
    budget: z.number(),
    percent: z.number(),
    message: z.string(),
});
// -- Web task schemas --
const WebTaskSchema = z.object({
    taskId: z.string(),
    prompt: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    createdAt: z.number(),
    updatedAt: z.number(),
    result: z.string().nullable(),
    error: z.string().nullable(),
    cwd: z.string().optional(),
});
export const ServerWebFeatureStatusSchema = z.object({
    type: z.literal('web_feature_status'),
    available: z.boolean(),
    remote: z.boolean(),
    teleport: z.boolean(),
});
export const ServerWebTaskCreatedSchema = z.object({
    type: z.literal('web_task_created'),
    task: WebTaskSchema,
});
export const ServerWebTaskUpdatedSchema = z.object({
    type: z.literal('web_task_updated'),
    task: WebTaskSchema,
});
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
export const ServerWebTaskErrorSchema = z.object({
    type: z.literal('web_task_error'),
    taskId: z.string().nullable().optional(),
    message: z.string(),
    /**
     * Machine-readable error code. May be set for specific web-task failures
     * — e.g. `'SESSION_TOKEN_MISMATCH'` (bound-session rejections, paired with
     * `boundSessionId`/`boundSessionName`) or `'WEB_TASK_PROMPT_TOO_LARGE'`
     * (prompt-size guard in `feature-handlers.js`) — and absent for generic
     * task failures. Clients may branch on this field; the bound-session
     * recovery context is carried in `boundSessionId`/`boundSessionName`. See
     * `docs/error-taxonomy.md` § SESSION_TOKEN_MISMATCH. Bounded to 64 chars
     * to mirror `ServerMessageSchema.code`.
     */
    code: z.string().max(64).optional(),
    /**
     * The session ID the client's auth token is bound to. Populated on
     * `SESSION_TOKEN_MISMATCH` rejections so the client can surface which
     * session the device is paired to. `null` when the caller has no binding
     * (HTTP fallback path); a stale or unresolvable session ID is preserved
     * as-is. Sourced from `buildSessionTokenMismatchPayload()`.
     */
    boundSessionId: z.string().nullable().optional(),
    /**
     * Display name of the bound session, looked up at emit time via
     * `sessionManager.getSession()`. `null` when `boundSessionId` is null or
     * the session can no longer be resolved. Used by clients to render
     * actionable messages like "Device paired to _My Project_". Sourced from
     * `buildSessionTokenMismatchPayload()`.
     */
    boundSessionName: z.string().nullable().optional(),
});
export const ServerWebTaskListSchema = z.object({
    type: z.literal('web_task_list'),
    tasks: z.array(WebTaskSchema),
});
// -- Extension message (server → client) --
export const ServerExtensionMessageSchema = z.object({
    type: z.literal('extension_message'),
    provider: z.string().min(1),
    subtype: z.string().min(1),
    data: z.unknown(),
    sessionId: z.string().optional(),
});
// -- Prompt evaluator result (#3068, manual on-demand variant) --
//
// Modelled as a union of two mutually-exclusive shapes so clients can rely on
// the contract: a parsed value either carries a `verdict` (and verdict-specific
// fields) OR an `error`, never both. The `z.never().optional()` guards on each
// branch reject payloads that try to set both — earlier permissive shape would
// happily parse mixed payloads and let bugs slip through.
const ServerEvaluateDraftSuccessSchema = z.object({
    type: z.literal('evaluate_draft_result'),
    // Echoes the client's requestId so the dashboard can correlate to the click
    // that triggered evaluation. Always present (null when client omitted it).
    requestId: z.string().nullable(),
    verdict: z.enum(['forward', 'rewrite', 'clarify']),
    // Populated when verdict === 'rewrite'
    rewritten: z.string().nullable().optional(),
    // Populated when verdict === 'clarify'
    clarification: z.string().nullable().optional(),
    // 1-2 sentence explanation, always set on success
    reasoning: z.string(),
    error: z.never().optional(),
});
const ServerEvaluateDraftErrorSchema = z.object({
    type: z.literal('evaluate_draft_result'),
    requestId: z.string().nullable(),
    error: z.object({
        code: z.string(),
        message: z.string(),
        // #3100: numeric upstream HTTP status, present only for API errors
        // where the Anthropic SDK exposed a status (401/403/429/5xx etc.).
        // Omitted for network errors, NO_API_KEY, BAD_RESPONSE, etc.
        status: z.number().int().optional(),
    }),
    verdict: z.never().optional(),
    rewritten: z.never().optional(),
    clarification: z.never().optional(),
    reasoning: z.never().optional(),
});
export const ServerEvaluateDraftResultSchema = z.union([
    ServerEvaluateDraftSuccessSchema,
    ServerEvaluateDraftErrorSchema,
]);
// -- Auto-evaluator broadcast events (#3208) --
//
// Unlike `evaluate_draft_result` (request/response, manual flow), these two
// events are broadcast to clients bound to `sessionId` WITHOUT a triggering
// client request. They fire when the auto-evaluation hook (#3186) lands on
// a `rewrite` or `clarify` verdict for a `user_input` message that was
// gated through `session.config.promptEvaluator`.
//
// `evaluatorIterationId` is a server-generated monotonic-per-session id
// used by the dashboard to dedup events received over a reconnect replay.
// `evaluatorIteration` (clarify only) is the 1-based clarify-loop counter.
// The server clamps it to its configured `maxIterations` (currently 3, see
// #3186) before emit; the wire schema enforces a 10-iteration sanity ceiling
// so a misconfiguration or counter overflow can't surface as e.g.
// "Iteration 999/3" in the dashboard. Tighten the ceiling in lock-step if
// future server-side caps land below 10.
export const ServerEvaluatorRewriteSchema = z.object({
    type: z.literal('evaluator_rewrite'),
    sessionId: z.string(),
    originalDraft: z.string(),
    rewritten: z.string(),
    reasoning: z.string(),
    evaluatorIterationId: z.string(),
});
export const ServerEvaluatorClarifySchema = z.object({
    type: z.literal('evaluator_clarify'),
    sessionId: z.string(),
    originalDraft: z.string(),
    clarification: z.string(),
    reasoning: z.string(),
    evaluatorIterationId: z.string(),
    evaluatorIteration: z.number().int().min(1).max(10),
});
