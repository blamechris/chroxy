/**
 * Why a session reads "busy" (#8302).
 *
 * `BaseSession.isRunning` is `_isBusy || backgroundShellTracker.size > 0`: one
 * boolean for two different facts. "The model is mid-turn" and "the model is
 * idle but a background shell is still tracked" call for opposite UX — the
 * first is "Working", the second is "waiting on N background shell(s)" — and
 * the wire published only the merged boolean, so a session held busy by a dead
 * shell was indistinguishable from one doing real work. That is the observed
 * "Working · last activity 45s ago" on an idle session.
 *
 * The wire keeps `isBusy` byte-for-byte and adds, beside it:
 *
 *   busyReason         'turn' | 'background-shells' | null
 *   backgroundShellCount  the tracker's size, quiesced shells included
 *
 * The count is the tracker's `size`, NOT `pendingBackgroundShells.length`: the
 * advisory mtime sweep (#5247) hides a quiesced shell from the banner list
 * while it still holds the session busy, which is precisely the case where the
 * list reads `[]` and the session reads busy.
 *
 * Invariants (pinned by tests, and enforced at the publish boundary by
 * `busyStateOf` so a provider that gets them wrong cannot put a contradiction
 * on the wire):
 *   - busyReason === null                 <=> !isBusy
 *   - busyReason === 'background-shells'  =>  !turnActive && backgroundShellCount > 0
 */

/** The reasons a session can be busy, in the order they are checked. */
export const BUSY_REASONS = Object.freeze(['turn', 'background-shells'])

/**
 * Pure derivation. A busy session with no turn and no tracked shell (a user
 * shell's live PTY is the one such case) reads `'turn'`: the pre-#8302 meaning
 * of "busy" is unchanged for anything that is not specifically shell-held.
 *
 * @param {boolean} running - the session's `isRunning`.
 * @param {boolean} turnActive - the model is mid-turn (`_isBusy`).
 * @param {number} backgroundShellCount - tracker size.
 * @returns {'turn'|'background-shells'|null}
 */
export function deriveBusyReason(running, turnActive, backgroundShellCount) {
  if (!running) return null
  if (turnActive) return 'turn'
  return backgroundShellCount > 0 ? 'background-shells' : 'turn'
}

/**
 * The wire projection of a live session's busy state. Defensive on purpose: a
 * custom or stub provider that does not extend BaseSession has no
 * `busyReason`/`backgroundShellCount`, and gets the pre-#8302 reading
 * (`'turn'` when busy) rather than a missing or contradictory field.
 *
 * @param {object|null|undefined} session
 * @returns {{ busyReason: 'turn'|'background-shells'|null, backgroundShellCount: number }}
 */
export function busyStateOf(session) {
  const running = !!session?.isRunning
  const rawCount = session?.backgroundShellCount
  const backgroundShellCount = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 0
  let busyReason = session?.busyReason
  if (!BUSY_REASONS.includes(busyReason)) busyReason = null
  if (!running) {
    busyReason = null
  } else if (busyReason === null) {
    busyReason = 'turn'
  } else if (busyReason === 'background-shells' && backgroundShellCount === 0) {
    // Claimed shell-held with no shell to hold it: not a statement we can make.
    busyReason = 'turn'
  }
  return { busyReason, backgroundShellCount }
}
