/**
 * Server -> client schemas for the daily-daemon update banner (#8331).
 *
 * `daemon_update_status` is sent ONLY to strict-primary, unbound clients (on auth,
 * and whenever the deploy script's files change). It is the daemon's own reading
 * of `pending-update.json` / `last-deploy.json` / `deploy-postpone.json` /
 * `deploy-request.json`, validated and size-capped on the server, so a client
 * renders it and never re-derives anything.
 *
 * The three reply frames answer `daemon_update_action` (schemas/client.ts):
 *   - `daemon_update_confirm_required` — restart-now with busy sessions and no
 *     confirmation; nothing was written. The client shows the listed reasons and
 *     re-sends with `confirmBusy: true`.
 *   - `daemon_update_action_result` — the outcome, ok or a `code`
 *     (NOT_AUTHORIZED, STALE_TARGET, NO_PENDING_UPDATE, WRITE_FAILED, UNAVAILABLE,
 *     UNSUPPORTED_ACTION).
 */
import { z } from 'zod';
export declare const DAEMON_UPDATE_PENDING_REASON_VALUES: readonly ["busy", "unknown", "postponed"];
export declare const DaemonUpdatePendingSchema: z.ZodObject<{
    target: z.ZodString;
    from: z.ZodNullable<z.ZodString>;
    subject: z.ZodString;
    commitsAhead: z.ZodNullable<z.ZodNumber>;
    queuedAt: z.ZodString;
    reason: z.ZodEnum<{
        unknown: "unknown";
        busy: "busy";
        postponed: "postponed";
    }>;
}, z.core.$strip>;
export declare const DaemonUpdateLastDeploySchema: z.ZodObject<{
    from: z.ZodNullable<z.ZodString>;
    to: z.ZodString;
    at: z.ZodString;
    result: z.ZodString;
    subject: z.ZodString;
}, z.core.$strip>;
export declare const ServerDaemonUpdateStatusSchema: z.ZodObject<{
    type: z.ZodLiteral<"daemon_update_status">;
    running: z.ZodNullable<z.ZodString>;
    pending: z.ZodNullable<z.ZodObject<{
        target: z.ZodString;
        from: z.ZodNullable<z.ZodString>;
        subject: z.ZodString;
        commitsAhead: z.ZodNullable<z.ZodNumber>;
        queuedAt: z.ZodString;
        reason: z.ZodEnum<{
            unknown: "unknown";
            busy: "busy";
            postponed: "postponed";
        }>;
    }, z.core.$strip>>;
    lastDeploy: z.ZodNullable<z.ZodObject<{
        from: z.ZodNullable<z.ZodString>;
        to: z.ZodString;
        at: z.ZodString;
        result: z.ZodString;
        subject: z.ZodString;
    }, z.core.$strip>>;
    postponedUntil: z.ZodNullable<z.ZodString>;
    requestPending: z.ZodBoolean;
}, z.core.$strip>;
export declare const ServerDaemonUpdateConfirmRequiredSchema: z.ZodObject<{
    type: z.ZodLiteral<"daemon_update_confirm_required">;
    requestId: z.ZodNullable<z.ZodString>;
    target: z.ZodString;
    reasons: z.ZodArray<z.ZodString>;
    sessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        busyReason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerDaemonUpdateActionResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"daemon_update_action_result">;
    requestId: z.ZodNullable<z.ZodString>;
    action: z.ZodNullable<z.ZodString>;
    ok: z.ZodBoolean;
    force: z.ZodOptional<z.ZodBoolean>;
    postponedUntil: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type DaemonUpdatePending = z.infer<typeof DaemonUpdatePendingSchema>;
export type DaemonUpdateLastDeploy = z.infer<typeof DaemonUpdateLastDeploySchema>;
export type ServerDaemonUpdateStatusMessage = z.infer<typeof ServerDaemonUpdateStatusSchema>;
export type ServerDaemonUpdateConfirmRequiredMessage = z.infer<typeof ServerDaemonUpdateConfirmRequiredSchema>;
export type ServerDaemonUpdateActionResultMessage = z.infer<typeof ServerDaemonUpdateActionResultSchema>;
