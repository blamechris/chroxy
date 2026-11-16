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
export declare const PRINCIPAL_GAP_REASON_VALUES: readonly ["evicted", "journal_reset", "restart_loss", "unknown_cursor"];
/** Why a live subscription was ended by the daemon (section 7.2). */
export declare const PRINCIPAL_SUBSCRIPTION_END_VALUES: readonly ["held_overflow", "backpressure"];
export declare const PrincipalGapSchema: z.ZodObject<{
    reason: z.ZodEnum<{
        evicted: "evicted";
        journal_reset: "journal_reset";
        restart_loss: "restart_loss";
        unknown_cursor: "unknown_cursor";
    }>;
    fromSeq: z.ZodOptional<z.ZodNumber>;
    toSeq: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerPrincipalSubscribedSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_subscribed">;
    requestId: z.ZodString;
    sessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        journalId: z.ZodString;
        headSeq: z.ZodNumber;
        gap: z.ZodOptional<z.ZodObject<{
            reason: z.ZodEnum<{
                evicted: "evicted";
                journal_reset: "journal_reset";
                restart_loss: "restart_loss";
                unknown_cursor: "unknown_cursor";
            }>;
            fromSeq: z.ZodOptional<z.ZodNumber>;
            toSeq: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerPrincipalEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_event">;
    requestId: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodString;
    journalId: z.ZodString;
    journalSeq: z.ZodNumber;
    ts: z.ZodNumber;
    eventType: z.ZodString;
    data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    truncated: z.ZodOptional<z.ZodBoolean>;
    replay: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ServerPrincipalLiveFenceSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_live_fence">;
    requestId: z.ZodString;
    sessionId: z.ZodString;
    journalId: z.ZodString;
    journalSeq: z.ZodNumber;
}, z.core.$strip>;
export declare const ServerPrincipalGapFrameSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_gap">;
    requestId: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodString;
    journalId: z.ZodString;
    reason: z.ZodEnum<{
        evicted: "evicted";
        journal_reset: "journal_reset";
        restart_loss: "restart_loss";
        unknown_cursor: "unknown_cursor";
        held_overflow: "held_overflow";
        backpressure: "backpressure";
    }>;
    fromSeq: z.ZodOptional<z.ZodNumber>;
    toSeq: z.ZodOptional<z.ZodNumber>;
    ended: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerPrincipalEventsPageSchema: z.ZodObject<{
    type: z.ZodLiteral<"principal_events_page">;
    requestId: z.ZodString;
    sessionId: z.ZodString;
    journalId: z.ZodString;
    events: z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        ts: z.ZodNumber;
        eventType: z.ZodString;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        truncated: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    headSeq: z.ZodNumber;
    cursor: z.ZodObject<{
        sessionId: z.ZodString;
        journalId: z.ZodString;
        seq: z.ZodNumber;
    }, z.core.$strip>;
    more: z.ZodBoolean;
    gap: z.ZodOptional<z.ZodObject<{
        reason: z.ZodEnum<{
            evicted: "evicted";
            journal_reset: "journal_reset";
            restart_loss: "restart_loss";
            unknown_cursor: "unknown_cursor";
        }>;
        fromSeq: z.ZodOptional<z.ZodNumber>;
        toSeq: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
