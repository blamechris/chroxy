/**
 * A session's latest Stop signal, as a timestamp (#9272); 0 when there is none.
 *
 * Two signals, because a Stop reaches the client two ways:
 *  - `stoppedAt` — set by `session_stopped` (every requested Stop, and the
 *    quiet confirmation that trails a plain `result` on claude-sdk / claude-cli,
 *    #8461). The shared handlers clear it on `agent_busy` / `claude_ready`.
 *  - `lastTurnStoppedAt` — stamped by a LIVE `result` whose `turnOutcome` is
 *    `stopped`, `stopped_before_output` or `interrupted`. Never cleared.
 *
 * Neither is cleared reliably at the start of a turn (`agent_busy` is only sent
 * with a non-thinking `stream_start`, so a turn that goes busy through
 * `session_activity` alone leaves them), so the stamp is NOT read as "the last
 * turn was stopped". `useTurnCompleteNotification` compares it with the stamp
 * it saw when the turn began: only a Stop that moved it past that counts.
 */
import type { SessionState } from '../store/types'

export function sessionStopStamp(
  ss: Pick<SessionState, 'stoppedAt' | 'lastTurnStoppedAt'> | undefined,
): number {
  if (!ss) return 0
  return Math.max(ss.stoppedAt ?? 0, ss.lastTurnStoppedAt ?? 0)
}
