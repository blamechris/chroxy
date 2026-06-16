/**
 * Shared stateless handlers for environment messages
 * (environment_list / environment_error).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged.
 * `environment_list` is a flat list-replacement; `environment_error` returns
 * `{error}` for the caller to console-log. Concrete entry types live
 * downstream in the app/dashboard. See ./index.ts for the handler contract.
 */

// ---------------------------------------------------------------------------
// environment_list / environment_error
//
// `environment_list` is a flat list-replacement (matches `handleSlashCommands`
// shape from #3127). `environment_error` is a console-side-effect-only
// message; the handler returns `{error}` so the caller can `console.error`.
//
// `environment_created/destroyed/info` are no-ops in the dashboard (handled
// implicitly via the broadcast `environment_list` that follows) — no shared
// handler is needed.
// ---------------------------------------------------------------------------

/**
 * Parse an `environment_list` message into the replacement array.
 *
 * Always returns the `{ environments }` shape — defaulting to `[]` when the
 * field is missing or non-array (matches the dashboard's prior inline
 * `Array.isArray(msg.environments) ? msg.environments : []`).
 *
 * Element shape is NOT validated; downstream casts to the concrete
 * `EnvironmentInfo[]` type. No session-id guard — environment lists are
 * server-wide.
 */
export function handleEnvironmentList(
  msg: Record<string, unknown>,
): { environments: unknown[] } {
  const environments: unknown[] = Array.isArray(msg.environments)
    ? (msg.environments as unknown[])
    : []
  return { environments }
}

/**
 * Parse an `environment_error` message into a `{error}` payload.
 *
 * Behaviour-preserving: the prior inline implementation was a single
 * `console.error('[ws] Environment error:', msg.error)` — the value was
 * passed through verbatim. Here the handler returns the value when it's a
 * string (including empty string) and null otherwise; the call site is
 * responsible for the actual `console.error` side-effect.
 */
export function handleEnvironmentError(
  msg: Record<string, unknown>,
): { error: string | null } {
  return {
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}
