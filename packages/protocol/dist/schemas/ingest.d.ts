/**
 * Event-ingest envelope schema (#5413 Phase 3).
 *
 * `POST /api/events` accepts external Claude Code session events (sessions
 * chroxy did NOT launch) and routes them through the existing notification
 * pipeline. This schema is the single source of truth for the envelope —
 * the server validates inbound bodies with it, and the Phase-4
 * `packages/claude-hooks` emitters will build payloads against it.
 *
 * Deliberately STRICT (unlike the `.passthrough()` WS message schemas):
 * the endpoint is an authenticated but internet-reachable HTTP surface
 * (the daemon may be tunnel-exposed), so unknown keys, unbounded strings,
 * and nested payloads are rejected outright rather than forwarded into the
 * notification pipeline.
 */
import { z } from 'zod';
/**
 * Accepted event types — named after the Claude Code hook events they
 * originate from (SessionStart, SessionEnd, SubagentStart, SubagentStop,
 * Notification, PostToolUse, UserPromptSubmit, Stop), snake_cased to match
 * chroxy's wire style. Unknown types are rejected; add new ones here
 * deliberately.
 *
 * #5541 — turn-edge events: `user_prompt_submit` is the authoritative turn
 * START (carries `{cwd}` only — never the prompt text, for privacy) and
 * `stop` is the authoritative turn END. They let the server track which
 * projects have a turn in flight so the Discord status embed stops showing
 * "Ready for input" while the main agent's subagents are still working.
 * Inert until the hooks package emits them (PR 2 of #5541); old hooks that
 * emit only the original six types remain valid.
 */
export declare const INGEST_EVENT_TYPES: readonly ["session_start", "session_end", "subagent_start", "subagent_stop", "notification", "post_tool_use", "user_prompt_submit", "stop"];
export type IngestEventType = (typeof INGEST_EVENT_TYPES)[number];
/**
 * Sanity bounds for `ts` (epoch milliseconds). Rejects seconds-precision
 * timestamps (would land before 2020), negative/zero values, and
 * far-future garbage. 2020-01-01T00:00:00Z .. 2100-01-01T00:00:00Z.
 */
export declare const INGEST_TS_MIN_MS = 1577836800000;
export declare const INGEST_TS_MAX_MS = 4102444800000;
/** Cap on the number of keys in `data` — a flat, size-capped bag. */
export declare const INGEST_DATA_MAX_KEYS = 32;
export declare const IngestEventDataSchema: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>;
/**
 * The `POST /api/events` envelope: `{ source, project?, sessionId?, type,
 * data?, ts }`.
 *
 * - `source` — who emitted the event (e.g. `claude-hooks`); also the
 *   server-side rate-limit bucket key, hence the tight length cap.
 * - `project` — explicit project name for the per-project status embed.
 *   When absent the server derives it from `data.cwd` (git-root walk). Caveat:
 *   the server-side walk does NOT yet recover the parent project for a chroxy
 *   worktree (it falls back to the opaque hex basename) the way the hook does —
 *   shared-module consolidation is tracked in #5850.
 * - `sessionId` — the EXTERNAL tool's session id (opaque to chroxy).
 * - `ts` — event time, epoch ms, sanity-bounded.
 */
export declare const IngestEventSchema: z.ZodObject<{
    source: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    type: z.ZodEnum<{
        session_start: "session_start";
        session_end: "session_end";
        subagent_start: "subagent_start";
        subagent_stop: "subagent_stop";
        notification: "notification";
        post_tool_use: "post_tool_use";
        user_prompt_submit: "user_prompt_submit";
        stop: "stop";
    }>;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>>;
    ts: z.ZodNumber;
}, z.core.$strict>;
export type IngestEvent = z.infer<typeof IngestEventSchema>;
