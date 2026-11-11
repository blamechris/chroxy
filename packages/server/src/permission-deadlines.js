/**
 * The deadlines on a hook-routed permission request, in one place (#8529).
 *
 * Three clocks run on one request. They start at different moments and each is
 * owned by a different program, so they are only ever correct RELATIVE to each
 * other:
 *
 *   | layer     | owner                                 | clock starts               | on expiry                                  |
 *   |-----------|---------------------------------------|----------------------------|--------------------------------------------|
 *   | host      | Claude Code, from the `timeout` chroxy | when it spawns the hook    | the hook is cancelled: it returns NO       |
 *   |           | writes into the hook registration     | (earliest)                 | decision at all (as read from Claude Code  |
 *   |           |                                       |                            | 2.1.x; a real host is not exercised here)  |
 *   | transport | `curl --max-time` in                  | when curl starts, after    | curl exit 28: the hook denies and says no  |
 *   |           | hooks/permission-hook.sh              | the hook's own preamble    | complete response arrived                  |
 *   | decision  | the daemon's timer in ws-permissions  | once the request body has  | 200 {decision:'deny', reason:'timeout'}:   |
 *   |           |                                       | been read (latest)         | the hook denies and says nobody answered   |
 *
 * Only the last row is an ANSWER. So the layers must expire innermost first:
 *
 *   decision window  <  transport timeout  <  host timeout
 *
 * All three used to be 300 s. The clock that starts first then expires first,
 * which is exactly backwards: the daemon's reply was written a few milliseconds
 * after curl had already given up, and the hook reported that the request never
 * reached the phone about a prompt that had been on screen for five minutes.
 *
 * The decision window is what the user sees counting down and is NOT shortened;
 * the two outer layers are widened by a stated budget each, and no further.
 *
 * WHAT THE BUDGETS ARE NOT. They are an envelope, sized from measurement plus
 * the two finite curl deadlines, not a guarantee. Only curl's waits are bounded
 * by a number here. Reading stdin, the filesystem, starting bash / python3 /
 * node, the scheduler, and the daemon's event loop are not: a stall in any of
 * them longer than its allowance still lets an outer clock expire first. When
 * that happens the result is the outer layer's (a transport-timeout deny, or a
 * hook the host cancelled), not the daemon's answer.
 */

/**
 * How long a hook-routed prompt waits for an answer before the daemon denies it.
 * Also the `remainingMs` clients count down from, so the two cannot disagree.
 */
export const HOOK_PERMISSION_DECISION_WINDOW_MS = 300_000

/**
 * `--max-time` of the hook's `POST /permission-floor` probe, in seconds. It runs
 * BEFORE the long poll in the lenient modes, so it is part of what the host
 * timeout has to cover.
 */
export const HOOK_FLOOR_PROBE_TIMEOUT_S = 10

/**
 * Room for the daemon's timeout reply to reach curl. Measured on loopback, the
 * daemon arms its timer about 20 ms after the hook is spawned and its reply
 * reaches the hook under 20 ms after it is written; the rest covers a busy
 * event loop firing the timer late and a slow container bridge.
 */
export const HOOK_TRANSPORT_MARGIN_S = 10

/** `--max-time` of the hook's `POST /permission` long poll, in seconds. */
export const HOOK_TRANSPORT_TIMEOUT_S =
  HOOK_PERMISSION_DECISION_WINDOW_MS / 1000 + HOOK_TRANSPORT_MARGIN_S

/**
 * An allowance for everything the hook does outside its two curl calls:
 * starting bash, reading stdin, the AskUserQuestion parse (python3), the floor
 * probe's verdict parse (node) and writing the result. Measured, that is under
 * 100 ms even with the floor probe's round trip included; nothing enforces the
 * allowance. The floor probe itself is budgeted separately, at its full
 * `--max-time`.
 */
export const HOOK_LOCAL_WORK_BUDGET_S = 10

/**
 * The `timeout` (seconds) written into BOTH Claude Code registrations of
 * permission-hook.sh: the user-level entry (permission-hook.js) and the
 * per-session `--settings` file (claude-tui/pty-driver.js). It covers the
 * script's budgeted envelope (both curl deadlines plus the local-work
 * allowance), so that in that envelope the host is not what ends the wait.
 */
export const HOOK_HOST_TIMEOUT_S =
  HOOK_TRANSPORT_TIMEOUT_S + HOOK_FLOOR_PROBE_TIMEOUT_S + HOOK_LOCAL_WORK_BUDGET_S
