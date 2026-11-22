/**
 * Whether a session's most recent turn ended because it was stopped (#9272).
 *
 * Two signals, because a Stop reaches the client two ways:
 *  - `stoppedAt` — set by `session_stopped` (every requested Stop, and the
 *    quiet confirmation that trails a plain `result` on claude-sdk / claude-cli,
 *    #8461); cleared by `agent_busy` when the next turn begins.
 *  - `lastTurnStopped` — set by a `result` whose `turnOutcome` is `stopped`,
 *    `stopped_before_output` or `interrupted`; cleared by `agent_busy`.
 *
 * Only meaningful while the session is idle: a busy session is mid-turn, so a
 * stale flag from the previous turn must not read as "this turn was stopped".
 */
import type { SessionState } from '../store/types'

export function sessionEndedByStop(
  ss: Pick<SessionState, 'isIdle' | 'stoppedAt' | 'lastTurnStopped'> | undefined,
): boolean {
  if (!ss || ss.isIdle === false) return false
  return ss.stoppedAt != null || ss.lastTurnStopped === true
}
