/**
 * Server -> client frames of the agent-principal event journal (#9118, S3 of #9112;
 * docs/security/agent-principals.md sections 7.1 and 7.2).
 *
 * These go ONLY to the agent principal that asked, and only for sessions its grant
 * covers (principal-policy.js `frameForPrincipal`); the outgoing policies drop them for
 * every other client. The payload of an event is the daemon-normalized, redacted, bounded
 * record, never raw PTY bytes and never thinking text.
 *
 * Order on the wire for one session, per `principal_subscribe`:
 *   principal_subscribed (once, all sessions)
 *   principal_event { replay: true } ... from the cursor up to `headSeq`
 *   principal_live_fence { seq: headSeq }
 *   principal_event (live) ...
 * `principal_gap` reports events the client cannot get (an eviction, a reset, a restart
 * loss, an unknown cursor) and, with `ended: true`, that the subscription is over and the
 * client must subscribe again.
 */
import { z } from 'zod';
/** Why a cursor could not be honored exactly (section 7.1). */
export const PRINCIPAL_GAP_REASON_VALUES = ['evicted', 'journal_reset', 'restart_loss', 'unknown_cursor'];
/** Why a live subscription was ended by the daemon (section 7.2). */
export const PRINCIPAL_SUBSCRIPTION_END_VALUES = ['held_overflow', 'backpressure', 'scope', 'removed'];
export const PrincipalGapSchema = z.object({
    reason: z.enum(PRINCIPAL_GAP_REASON_VALUES),
    /** First and last seq that cannot be served (inclusive); absent when the whole cursor is unusable. */
    fromSeq: z.number().int().nonnegative().optional(),
    toSeq: z.number().int().nonnegative().optional(),
});
export const ServerPrincipalSubscribedSchema = z.object({
    type: z.literal('principal_subscribed'),
    requestId: z.string().max(128),
    sessions: z.array(z.object({
        sessionId: z.string().max(128),
        journalId: z.string().max(64),
        headSeq: z.number().int().nonnegative(),
        gap: PrincipalGapSchema.optional(),
    })).max(32),
});
export const ServerPrincipalEventSchema = z.object({
    type: z.literal('principal_event'),
    /** The subscribe this event belongs to. */
    requestId: z.string().max(128).optional(),
    sessionId: z.string().max(128),
    journalId: z.string().max(64),
    /**
     * The event's position in the journal. Named `journalSeq`, not `seq`: the transport
     * stamps its own per-connection `seq` on EVERY frame (ws-client-sender.js), which would
     * silently overwrite a field of that name.
     */
    journalSeq: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
    /** The normalized event type (`message`, `tool_start`, `assistant_text`, ...). */
    eventType: z.string().max(64),
    data: z.record(z.string(), z.unknown()),
    /** The event was cut to the 4 KiB per-event cap. */
    truncated: z.boolean().optional(),
    /** True for a replayed event, absent for a live one. */
    replay: z.boolean().optional(),
});
export const ServerPrincipalLiveFenceSchema = z.object({
    type: z.literal('principal_live_fence'),
    requestId: z.string().max(128),
    sessionId: z.string().max(128),
    journalId: z.string().max(64),
    /** The head the replay ran up to: every event after this journalSeq is live. (Not `seq`: see principal_event.) */
    journalSeq: z.number().int().nonnegative(),
});
export const ServerPrincipalGapFrameSchema = z.object({
    type: z.literal('principal_gap'),
    requestId: z.string().max(128).optional(),
    sessionId: z.string().max(128),
    journalId: z.string().max(64),
    reason: z.enum([...PRINCIPAL_GAP_REASON_VALUES, ...PRINCIPAL_SUBSCRIPTION_END_VALUES]),
    fromSeq: z.number().int().nonnegative().optional(),
    toSeq: z.number().int().nonnegative().optional(),
    /** True when the subscription is over: subscribe again with the last cursor. */
    ended: z.boolean(),
});
export const ServerPrincipalEventsPageSchema = z.object({
    type: z.literal('principal_events_page'),
    requestId: z.string().max(128),
    sessionId: z.string().max(128),
    journalId: z.string().max(64),
    events: z.array(z.object({
        seq: z.number().int().positive(),
        ts: z.number().int().nonnegative(),
        eventType: z.string().max(64),
        data: z.record(z.string(), z.unknown()),
        truncated: z.boolean().optional(),
    })).max(200),
    headSeq: z.number().int().nonnegative(),
    /** Pass this as `cursor` to read the next page. */
    cursor: z.object({
        sessionId: z.string().max(128),
        journalId: z.string().max(64),
        seq: z.number().int().nonnegative(),
    }),
    /** More events are retained beyond this page. */
    more: z.boolean(),
    gap: PrincipalGapSchema.optional(),
});
