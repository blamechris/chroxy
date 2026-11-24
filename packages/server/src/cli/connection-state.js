/**
 * Shared by the CLIs that read connection.json (#9229). Gives each one the reason a
 * record was withheld, without changing what is allowed: `info` is non-null only for a
 * verified-alive pid, exactly as `readConnectionInfo()` (see ../connection-info.js).
 */
import { CONNECTION_ALIVE, CONNECTION_NO_RECORD, CONNECTION_LIVENESS_UNVERIFIED } from '../connection-info.js'

export const LIVENESS_UNVERIFIED_REASON = CONNECTION_LIVENESS_UNVERIFIED

export const LIVENESS_UNVERIFIED_MESSAGE =
  'Could not verify that the Chroxy daemon in connection.json is running: the record has no valid pid, '
  + 'or that pid could not be inspected from here (for example inside a sandbox). '
  + 'Its token was not used, and the record was left in place.'

/**
 * Test seams, in priority order: `deps.readConnectionState` (returns `{ info, reason }`),
 * then the legacy `deps.readConnectionInfo` (null reads as `no_record`; it cannot say
 * "unverified"). Production uses the real `readConnectionState`.
 *
 * @returns {Promise<{ info: object|null, reason: string }>}
 */
export async function readCliConnectionState(deps = {}) {
  if (typeof deps.readConnectionState === 'function') {
    const state = await deps.readConnectionState()
    // Fail closed: a record only counts when the state says it was verified alive.
    return state && state.reason === CONNECTION_ALIVE && state.info
      ? state
      : { info: null, reason: state?.reason || CONNECTION_NO_RECORD }
  }
  if (typeof deps.readConnectionInfo === 'function') {
    const info = deps.readConnectionInfo()
    return info ? { info, reason: CONNECTION_ALIVE } : { info: null, reason: CONNECTION_NO_RECORD }
  }
  return (await import('../connection-info.js')).readConnectionState()
}

/** `not_running` or `liveness_unverified`, for a state whose `info` is null. */
export function withheldReason(state) {
  return state.reason === CONNECTION_LIVENESS_UNVERIFIED ? 'liveness_unverified' : 'not_running'
}
