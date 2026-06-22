/**
 * Control Room activity tree (#5159/#5161): activity_snapshot / activity_delta and the entry/kind/status/output-ref shapes, plus message queued/dequeued.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */

import { z } from 'zod'

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
export const ACTIVITY_SCHEMA_VERSION = 1

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
export const ActivityKindSchema = z.enum(['agent', 'shell', 'tool'])

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
export const ActivityStatusSchema = z.enum(['running', 'blocked', 'done', 'failed'])

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
export const ACTIVITY_OUTPUT_REF_KINDS = ['tool_use', 'shell', 'message'] as const

export const ActivityOutputRefSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
})

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
  const terminal = entry.status === 'done' || entry.status === 'failed'
  if (terminal && entry.endedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['endedAt'],
      message: 'endedAt is required when status is "done" or "failed"',
    })
  }
  if (!terminal && entry.endedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['endedAt'],
      message: 'endedAt must be absent while status is "running" or "blocked"',
    })
  }
  if (entry.endedAt !== undefined && entry.endedAt < entry.startedAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['endedAt'],
      message: 'endedAt must be >= startedAt',
    })
  }
})

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
})

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
    const terminal = msg.entry.status === 'done' || msg.entry.status === 'failed'
    if (!terminal) {
      ctx.addIssue({
        code: 'custom',
        path: ['entry', 'status'],
        message: 'an "ended" delta must carry a terminal entry status ("done" or "failed")',
      })
    }
  }
})

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
}).passthrough()

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
export const ServerMessageQueuedSchema = z.object({
  type: z.literal('message_queued'),
  sessionId: z.string(),
  // Echoed when the sender supplied a well-formed clientMessageId so the
  // originating client can match this queued entry to its optimistic copy.
  clientMessageId: z.string().optional(),
  text: z.string(),
  queueLength: z.number().int().nonnegative(),
}).passthrough()

/**
 * `message_dequeued` — a queued message left the queue. `reason` distinguishes
 * the exit paths: `'flush'` (auto-sent on turn-complete — the client should
 * transition the bubble from queued → sent), `'interrupted'` (the whole queue
 * was cancelled by an interrupt — the client should remove the queued bubble),
 * and `'cancelled'` (#5943 — the owner cancelled this ONE entry via
 * `cancel_queued` — the client removes just this bubble, leaving the rest of the
 * queue intact). The `queueLength` is the count remaining AFTER this item left.
 */
export const ServerMessageDequeuedSchema = z.object({
  type: z.literal('message_dequeued'),
  sessionId: z.string(),
  clientMessageId: z.string().optional(),
  queueLength: z.number().int().nonnegative(),
  reason: z.enum(['flush', 'interrupted', 'cancelled']),
}).passthrough()
