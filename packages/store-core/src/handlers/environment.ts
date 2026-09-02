/**
 * Shared stateless handlers for environment messages
 * (environment_list / environment_error).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged.
 * `environment_list` is a flat list-replacement; `environment_error` returns
 * the parsed `{ error, code, sessions }` for the caller to surface. Concrete
 * entry types live downstream in the app/dashboard. See ./index.ts for the
 * handler contract.
 */

import { parseRawStringField, parseUnknownArrayField } from './_shared'

// ---------------------------------------------------------------------------
// environment_list / environment_error
//
// `environment_list` is a flat list-replacement (matches `handleSlashCommands`
// shape from #3127). `environment_error` carries the operation failure; the
// handler parses `{ error, code, sessions }` so the caller can surface it
// (a user-visible notification, and — for the #7562 live-session destroy
// refusal — the `force` escalation prompt naming the attached session ids).
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
  const environments = parseUnknownArrayField(msg, 'environments')
  return { environments }
}

/**
 * Parse an `environment_error` message into an `{ error, code, sessions }`
 * payload.
 *
 * `error` is the human message (passed through verbatim when a string,
 * including empty string; null otherwise — the original console-log
 * behaviour). `code` is the optional stable discriminator the server attaches
 * to some failures — `'DOCKER_IMAGE_NOT_ALLOWED'`, the #7562 live-session
 * destroy refusal `'ENVIRONMENT_HAS_LIVE_SESSIONS'`, the bound-client refusal,
 * etc. — parsed loosely so a new code cannot make this stale. `sessions`
 * accompanies the live-session refusal: the ids still running inside the
 * environment, so a client can NAME them in the surfaced error and offer the
 * `force` escalation instead of showing a bare string. It is `null` when the
 * wire payload carries no `sessions` array (every non-refusal error), and the
 * string-only filter drops any malformed element defensively.
 *
 * The call site owns the actual surface (notification / force-confirm prompt).
 */
export function handleEnvironmentError(
  msg: Record<string, unknown>,
): { error: string | null; code: string | null; sessions: string[] | null } {
  const sessions = Array.isArray(msg.sessions)
    ? parseUnknownArrayField(msg, 'sessions').filter(
        (id): id is string => typeof id === 'string',
      )
    : null
  return {
    error: parseRawStringField(msg, 'error'),
    code: parseRawStringField(msg, 'code'),
    sessions,
  }
}
