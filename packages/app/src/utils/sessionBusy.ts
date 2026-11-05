/**
 * Whether a session reads busy, for the tab dot and the overview card (#8261).
 *
 * `SessionInfo.isBusy` is a `session_list` SNAPSHOT: it only moves on
 * create / destroy / switch. The live per-turn channel (`stream_start` /
 * `result` -> `session_activity`, `agent_idle`) writes
 * `sessionStates[id].isIdle`, which is also what the header and composer read.
 * Reading the snapshot made a dot taken mid-turn outlive the turn.
 *
 * The live state wins whenever it exists; the snapshot is only the fallback for
 * a session whose state slot has not been seeded yet.
 */
export function isSessionBusy(
  session: { isBusy: boolean },
  state: { isIdle: boolean } | undefined,
): boolean {
  return state ? !state.isIdle : session.isBusy;
}
