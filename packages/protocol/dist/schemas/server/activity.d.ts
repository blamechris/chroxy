/**
 * Control Room activity tree (#5159/#5161): activity_snapshot / activity_delta and the entry/kind/status/output-ref shapes, plus message queued/dequeued.
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Split per #6201 Tier-3.
 */
import { z } from 'zod';
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
