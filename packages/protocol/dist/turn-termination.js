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
 *  - `user_stop_before_run`   -- the user pressed Stop while the tool's
 *                                permission prompt was still pending (#8363).
 *                                Unlike every other reason the server KNOWS the
 *                                tool never ran: it was never approved.
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
export const TURN_TERMINATION_REASONS = [
    'permission_mode_switch',
    'model_switch',
    'user_stop',
    'user_stop_before_run',
    'process_exit',
    'hard_timeout',
    'stream_stall',
    'first_output_timeout',
    'auth_required',
    'sink_base_compromised',
    'daemon_restart',
];
const REASON_SET = new Set(TURN_TERMINATION_REASONS);
/** Narrow an arbitrary value to a known {@link TurnTerminationReason}. */
export function isTurnTerminationReason(value) {
    return typeof value === 'string' && REASON_SET.has(value);
}
const CAUSE = {
    permission_mode_switch: 'permission-mode switch',
    model_switch: 'model switch',
    user_stop: 'Stop',
    user_stop_before_run: 'Stop',
    process_exit: 'session process exit',
    hard_timeout: 'turn timeout',
    stream_stall: 'stream stall',
    first_output_timeout: 'no response from the provider',
    auth_required: 'sign-in required',
    sink_base_compromised: 'hook sink integrity check',
    daemon_restart: 'daemon restart',
};
/**
 * What the user should do next. The server cannot know whether the tool took
 * effect: some paths clear local state WITHOUT killing the provider child (a
 * hard timeout, a stream stall), so a real result can still follow, and even a
 * confirmed kill does not undo a side effect that completed before the result
 * was delivered. So the wording never asserts "did not run" and never tells
 * the user to blindly retry -- it says no result arrived and to check first.
 */
const CHECK = 'Check whether it took effect before retrying.';
/**
 * Wording for a terminated tool. `reason` may be any string (a newer server's
 * value, or absent): anything unrecognised gets the generic sentence, which is
 * still the right thing to tell the user -- it just does not name the cause.
 */
export function describeTurnTermination(reason) {
    if (!isTurnTerminationReason(reason)) {
        return {
            cause: 'turn terminated',
            label: 'terminated',
            summary: `Turn ended before this tool returned a result. ${CHECK}`,
        };
    }
    const cause = CAUSE[reason];
    if (reason === 'user_stop') {
        return { cause, label: 'stopped', summary: `Stopped before this tool returned a result. ${CHECK}` };
    }
    if (reason === 'user_stop_before_run') {
        // #8363: the prompt was still pending when Stop was pressed, so the tool was
        // never approved and never started. This is the one reason that can say so;
        // it must not read as the user refusing it (the provider's own text for the
        // cancelled prompt says exactly that).
        return {
            cause,
            label: 'stopped',
            summary: 'Stopped before this tool ran — you pressed Stop while it was waiting for approval, so it was never approved.',
        };
    }
    if (reason === 'daemon_restart') {
        return {
            cause,
            label: 'terminated',
            summary: 'Interrupted by a daemon restart — this tool may or may not have finished. Check before re-sending.',
        };
    }
    return {
        cause,
        label: 'terminated',
        summary: `Turn ended (${cause}) before this tool returned a result. ${CHECK}`,
    };
}
