/**
 * Is the daemon safe to restart right now? (#8324)
 *
 * The idle-only auto-deploy (`scripts/deploy-daemon.mjs`) restarts the owner's
 * daily daemon, which kills every live session. It may only do that when
 * nothing would be lost. "Idle" here is deliberately strict and means ALL of:
 *
 *   - no session is busy (a turn is running, OR a tracked background shell
 *     still holds the session busy — `isBusy` merges both, #8302)
 *   - no session has a permission request waiting on a human
 *   - no session has an AskUserQuestion waiting on a human
 *   - no hook-routed permission request is parked on the daemon
 *
 * FAIL SAFE. Every uncertainty reads as NOT idle. "Could not check" must never
 * be the same observable outcome as "nothing to check" (docs/false-safety-guards.md):
 * a missing session manager, a throwing accessor and a malformed row each add a
 * reason and force `idle: false`. A deploy that is wrongly deferred costs a
 * ten-minute wait; a deploy that is wrongly allowed kills a running turn.
 */

/**
 * @param {object} input
 * @param {object|null|undefined} input.sessionManager - exposes listSessions()
 *   and getSession(id).
 * @param {() => number} [input.getHookPendingPermissionCount] - hook-routed
 *   requests parked on the daemon.
 * @returns {{ idle: boolean, reasons: string[], sessions: object[], hookPendingPermissions: number }}
 */
export function computeDaemonIdleState({ sessionManager, getHookPendingPermissionCount } = {}) {
  const reasons = []
  const sessions = []
  let hookPendingPermissions = 0

  if (!sessionManager || typeof sessionManager.listSessions !== 'function') {
    reasons.push('idle state unavailable: no session manager')
    return { idle: false, reasons, sessions, hookPendingPermissions }
  }

  let rows
  try {
    rows = sessionManager.listSessions()
    if (!Array.isArray(rows)) throw new Error('listSessions() did not return an array')
  } catch (err) {
    reasons.push(`idle state unavailable: ${err?.message || String(err)}`)
    return { idle: false, reasons, sessions, hookPendingPermissions }
  }

  for (const row of rows) {
    const sessionId = row?.sessionId
    const label = row?.name ? `"${row.name}"` : String(sessionId)
    let pendingPermissions = 0
    let pendingQuestions = 0
    try {
      const entrySession = sessionManager.getSession?.(sessionId)?.session
      if (!entrySession) {
        // A row with no live session behind it cannot be inspected.
        throw new Error(`session ${label} not inspectable`)
      }
      pendingPermissions = countPending(entrySession, 'pending permission count', () => entrySession.getPendingPermissionCount())
      pendingQuestions = countPending(entrySession, 'pending question count', () => entrySession.getPendingQuestions().length)
    } catch (err) {
      reasons.push(`idle state unavailable for session ${label}: ${err?.message || String(err)}`)
      pendingPermissions = 0
      pendingQuestions = 0
    }
    const isBusy = row?.isBusy === true
    sessions.push({
      sessionId,
      name: row?.name ?? null,
      isBusy,
      busyReason: row?.busyReason ?? null,
      backgroundShellCount: Number.isSafeInteger(row?.backgroundShellCount) ? row.backgroundShellCount : 0,
      pendingPermissions,
      pendingQuestions,
    })
    if (isBusy) reasons.push(`session ${label} busy: ${row?.busyReason || 'turn'}`)
    if (pendingPermissions > 0) reasons.push(`session ${label} has ${pendingPermissions} pending permission(s)`)
    if (pendingQuestions > 0) reasons.push(`session ${label} has ${pendingQuestions} pending question(s)`)
  }

  try {
    const n = typeof getHookPendingPermissionCount === 'function' ? getHookPendingPermissionCount() : 0
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('hook permission count is not a count')
    hookPendingPermissions = n
    if (n > 0) reasons.push(`${n} hook-routed permission request(s) pending`)
  } catch (err) {
    reasons.push(`idle state unavailable: ${err?.message || String(err)}`)
  }

  return { idle: reasons.length === 0, reasons, sessions, hookPendingPermissions }
}

// A provider that lacks the accessor is not "has none": it is "cannot say", and
// that reads as not idle. BaseSession carries both accessors, so a missing one
// means a stub or custom provider we cannot vouch for.
function countPending(session, what, read) {
  let n
  try {
    n = read()
  } catch (err) {
    throw new Error(`${what} unavailable (${err?.message || String(err)})`)
  }
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} is not a count`)
  return n
}
