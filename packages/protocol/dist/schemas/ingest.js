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
 * Notification, PostToolUse), snake_cased to match chroxy's wire style.
 * Unknown types are rejected; add new ones here deliberately.
 */
export const INGEST_EVENT_TYPES = [
    'session_start',
    'session_end',
    'subagent_start',
    'subagent_stop',
    'notification',
    'post_tool_use',
];
/**
 * Sanity bounds for `ts` (epoch milliseconds). Rejects seconds-precision
 * timestamps (would land before 2020), negative/zero values, and
 * far-future garbage. 2020-01-01T00:00:00Z .. 2100-01-01T00:00:00Z.
 */
export const INGEST_TS_MIN_MS = 1_577_836_800_000;
export const INGEST_TS_MAX_MS = 4_102_444_800_000;
/** Cap on the number of keys in `data` — a flat, size-capped bag. */
export const INGEST_DATA_MAX_KEYS = 32;
/**
 * `data` values are flat primitives only (string / finite number / boolean /
 * null) — no nested objects or arrays, so a hook can never smuggle an
 * unbounded structure past the per-value string cap.
 */
const IngestDataValueSchema = z.union([
    z.string().max(4096),
    z.number().finite(),
    z.boolean(),
    z.null(),
]);
export const IngestEventDataSchema = z
    .record(z.string().min(1).max(128), IngestDataValueSchema)
    .refine((obj) => Object.keys(obj).length <= INGEST_DATA_MAX_KEYS, {
    message: `data must have at most ${INGEST_DATA_MAX_KEYS} keys`,
});
/**
 * The `POST /api/events` envelope: `{ source, project?, sessionId?, type,
 * data?, ts }`.
 *
 * - `source` — who emitted the event (e.g. `claude-hooks`); also the
 *   server-side rate-limit bucket key, hence the tight length cap.
 * - `project` — explicit project name for the per-project status embed.
 *   When absent the server derives it from `data.cwd` (git-root walk).
 * - `sessionId` — the EXTERNAL tool's session id (opaque to chroxy).
 * - `ts` — event time, epoch ms, sanity-bounded.
 */
export const IngestEventSchema = z
    .object({
    // Charset-restricted (#5432 review S3): `source` is the rate-limit
    // bucket key AND appears in server log lines — newlines/ANSI in it
    // would be log-line injection, and arbitrary bytes would inflate
    // bucket cardinality for free.
    source: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'source must be alphanumeric with ._- separators'),
    project: z.string().min(1).max(256).optional(),
    sessionId: z.string().min(1).max(256).optional(),
    type: z.enum(INGEST_EVENT_TYPES),
    data: IngestEventDataSchema.optional(),
    ts: z.number().int().min(INGEST_TS_MIN_MS).max(INGEST_TS_MAX_MS),
})
    .strict();
