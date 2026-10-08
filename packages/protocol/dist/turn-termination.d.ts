/**
 * Turn-termination reasons (#7376).
 *
 * A tool call can be cut off because the TURN it belonged to was ended
 * underneath it -- a permission-mode switch respawned the provider child, the
 * user pressed Stop, the child crashed, a watchdog fired, the daemon restarted.
 * Those are not "the command ran and failed": the command never reported a
 * result, and whether it took effect is unknown -- the right next step is to
 * check, then retry if needed. The server stamps the synthetic
 * `tool_result` it fabricates for such a tool with `terminatedReason`, and the
 * clients render a distinct state instead of the failure styling.
 *
 * Single-sourced here so the server (which picks the reason and words the
 * fallback result text), the dashboard and the mobile app (which word the
 * state) cannot drift. Zod-free on purpose: the wire field is a plain
 * optional string (`ServerToolResultSchema.terminatedReason`) so a reason added
 * by a newer server degrades to the generic copy on an older client instead of
 * failing the whole `tool_result` parse.
 */
/**
 * Why a turn was terminated under an in-flight tool call. Append-only: every
 * value is a wire contract.
 *
 *  - `permission_mode_switch` -- switching to Auto respawned the provider child.
 *  - `model_switch`           -- a mid-turn model change respawned it.
 *  - `user_stop`              -- the user pressed Stop.
 *  - `process_exit`           -- the provider process exited (crash/kill).
 *  - `hard_timeout`           -- the absolute turn cap fired.
 *  - `stream_stall`           -- the provider went silent past the stall window.
 *  - `first_output_timeout`   -- the provider never produced output.
 *  - `auth_required`          -- the provider demanded a sign-in mid-turn.
 *  - `sink_base_compromised`  -- the hook sink was tampered with; turn aborted.
 *  - `daemon_restart`         -- the daemon restarted with the tool in flight
 *                                (restore-time history sweep). Unlike the
 *                                others the outcome is genuinely unknown.
 */
export declare const TURN_TERMINATION_REASONS: readonly ["permission_mode_switch", "model_switch", "user_stop", "process_exit", "hard_timeout", "stream_stall", "first_output_timeout", "auth_required", "sink_base_compromised", "daemon_restart"];
export type TurnTerminationReason = (typeof TURN_TERMINATION_REASONS)[number];
/** Narrow an arbitrary value to a known {@link TurnTerminationReason}. */
export declare function isTurnTerminationReason(value: unknown): value is TurnTerminationReason;
/** What a client shows for a tool cut off by a terminated turn. */
export interface TurnTerminationDescription {
    /** Short noun phrase for the cause, e.g. `permission-mode switch`. */
    cause: string;
    /** One sentence for the tool row: what happened and the right next step. */
    summary: string;
}
/**
 * Wording for a terminated tool. `reason` may be any string (a newer server's
 * value, or absent): anything unrecognised gets the generic sentence, which is
 * still the right thing to tell the user -- it just does not name the cause.
 */
export declare function describeTurnTermination(reason?: unknown): TurnTerminationDescription;
