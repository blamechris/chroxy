/**
 * #9184: a TurnDriver refuses a sessionManager without the turn-driven registry,
 * so a test double must carry it. This installs the SAME semantics as
 * SessionManager.markTurnDriven / releaseTurnDriven / isTurnDriven (a per-session
 * set of owners; driven until every owner released) rather than no-op stubs, so
 * a test can still observe occupancy through the double.
 *
 * Unlike the real manager it does NOT ignore unknown sessions (mark records any
 * id) and does NOT clear a session's owners when the session is destroyed.
 */
export function installTurnDrivenRegistry(sm) {
  const driven = new Map()
  sm.markTurnDriven = (sessionId, owner) => {
    if (!owner) return
    let owners = driven.get(sessionId)
    if (!owners) { owners = new Set(); driven.set(sessionId, owners) }
    owners.add(owner)
  }
  sm.releaseTurnDriven = (sessionId, owner) => {
    const owners = driven.get(sessionId)
    if (!owners) return
    owners.delete(owner)
    if (owners.size === 0) driven.delete(sessionId)
  }
  sm.isTurnDriven = (sessionId) => (driven.get(sessionId)?.size ?? 0) > 0
  return sm
}
