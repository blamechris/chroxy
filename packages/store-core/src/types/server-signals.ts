/**
 * Server-pushed signals surfaced in client UI: errors, web tasks, feature status.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

/**
 * Optional one-click recovery action attached to a ServerError.
 *
 * #3587: surfaces an actionable button inside the toast so the operator can
 * recover from a structured error (e.g. INVALID_AUTHOR with a corrected
 * `actualAuthor`) without leaving the toast and hunting for the matching
 * row in another panel. The callback is invoked at click time, then the
 * notification is dismissed by the consumer regardless of whether the
 * callback returned cleanly or threw — see contract on `onClick` below.
 */
export interface ServerErrorAction {
  /** Short button label, e.g. "Try as alice". Rendered verbatim. */
  label: string;
  /**
   * Click handler. Synchronous; void return.
   *
   * Throwing is permitted but the consumer (e.g. the dashboard Toast)
   * MUST swallow the exception (logging it for diagnostics) and dismiss
   * the toast anyway, so a buggy callback can't strand a notification on
   * screen. Async work should be fired-and-forgotten — the action is
   * intended for store calls (`grantCommunitySkillTrust`, etc.) that
   * don't need to await a result before the toast disappears.
   */
  onClick: () => void;
}

/**
 * Server-emitted error captured for the notification/toast UI.
 *
 * Produced by the shared `handleServerError` helper from a `server_error`
 * message. Callers slice an array of these into their `serverErrors` state
 * (typically capped at the most recent 10 entries).
 */
/** Closed union of `ServerError` categories (#5618 Batch 3 — shared by the
 * dispatch-table `addServerError` hook so callers can't pass an unsupported
 * category that would break UI styling/filters). */
export type ServerErrorCategory = 'tunnel' | 'session' | 'permission' | 'general';

export interface ServerError {
  id: string;
  category: ServerErrorCategory;
  message: string;
  recoverable: boolean;
  timestamp: number;
  /** Set when the server scoped the error to a specific session. */
  sessionId?: string;
  /**
   * #3587: optional inline action rendered as a button inside the toast.
   * When unset (the common path) the toast renders message-only as before.
   * Not part of the wire shape — populated client-side by handlers that
   * have enough context to offer a one-click recovery (e.g. INVALID_AUTHOR
   * suggesting a retry with the correct author).
   */
  action?: ServerErrorAction;
  /**
   * #4148: severity used by the toast UI to differentiate non-fatal
   * server signals (e.g. MAX_TOOL_ROUNDS_REACHED) from destructive
   * STREAM_ERROR / ABORT events. Defaults to 'error' when unset so
   * existing callers continue to render as red error toasts.
   */
  severity?: 'error' | 'warning';
  /**
   * #5039: optional partial-cost sub-line surfaced when PR #5037 folded
   * any parent + Task subagent rounds onto an error envelope before the
   * error fired. Rendered as a small secondary text under the main
   * toast message; absent for every error path that didn't carry a
   * usable partial snapshot. Pre-formatted (via
   * `formatPartialCostLine`) so the dashboard and mobile surfaces can
   * share copy without re-implementing the cost/token formatting.
   */
  partialCostLine?: string;
}

export interface WebTask {
  taskId: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  result: string | null;
  error: string | null;
}

export interface WebFeatureStatus {
  available: boolean;
  remote: boolean;
  teleport: boolean;
}
