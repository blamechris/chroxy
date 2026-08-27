/**
 * Live-session wakeup gate — the ONE place that decides whether a daemon-side
 * event may type a line into a running session.
 *
 * Two callers want this today: the mailbox live-interrupt (`mailbox-route.js`,
 * "you have unread mail") and the CI-completion watcher (`session-ci-watcher.js`,
 * "CI finished on your PR"). They shared nothing but a copied four-line gate,
 * and that gate is security-load-bearing — so it lives here once instead of
 * twice. The rules it enforces, and why each one exists:
 *
 * 1. **claude-tui only, via the positive discriminator.** `#5984` (epic #5982):
 *    gate on `constructor.isClaudeTui === true`, NOT on
 *    `typeof session.writeTerminalInput` — a user-shell session (#5983) also
 *    exposes `writeTerminalInput`, and duck-typing here would let a weaker
 *    credential inject an EXECUTED line into a root shell (swarm-audit finding
 *    C2). Strict `!== true` rather than truthiness: a buggy override returning
 *    a truthy non-boolean must not read as "tui".
 * 2. **Idle only.** `isRunning` is true mid-turn and while background shells are
 *    alive; typing then corrupts an in-flight turn's input.
 * 3. **One line, no control characters but the trailing return.** The caller's
 *    text is scrubbed here rather than at each call site, because the interesting
 *    inputs (a GitHub PR title, a mailbox subject) are strings this daemon did
 *    not author.
 *
 * The session lookup deliberately stays with the caller: "which session" is a
 * routing question (a mailbox id, a session id) and the two callers answer it
 * differently. This module only answers "may I, and did it land".
 */

/**
 * Outcome of a wake attempt.
 * @typedef {'injected'|'busy'|'not-tui'|'no-session'|'pty-dead'|'empty-text'} WakeOutcome
 */

/** Cap on injected text — one prompt line, not a payload. */
export const MAX_WAKE_TEXT_CHARS = 500

/**
 * Scrub a candidate wakeup line: collapse every control character (including
 * the CR/LF that would submit early, or split one line into several) to a
 * space, squeeze runs of whitespace, trim, and cap the length.
 *
 * Returns '' when nothing usable survives — the caller then gets `empty-text`
 * rather than a bare carriage return typed into a live prompt.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeWakeText(text) {
  if (typeof text !== 'string') return ''
  const flattened = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return flattened.length > MAX_WAKE_TEXT_CHARS ? flattened.slice(0, MAX_WAKE_TEXT_CHARS) : flattened
}

/**
 * Type `text` into a live session's prompt when it is safe to do so.
 *
 * Never throws: a session whose `writeTerminalInput` throws reports `pty-dead`
 * like a write that returns false, because both mean "the line did not land"
 * and neither is the caller's problem to recover from.
 *
 * @param {object|null|undefined} session - the live provider session object.
 * @param {string} text - the line to type. A trailing return is appended here;
 *   callers must NOT include one (it would be scrubbed anyway).
 * @returns {WakeOutcome}
 */
export function wakeSession(session, text) {
  if (!session) return 'no-session'
  if (session.constructor?.isClaudeTui !== true) return 'not-tui'
  // Defence in depth: isClaudeTui === true implies writeTerminalInput exists
  // today (only ClaudeTuiSession sets the marker AND defines the method), so
  // this is unreachable in practice — but it guards a future class that sets
  // the marker without the method rather than throwing on the write below.
  if (typeof session.writeTerminalInput !== 'function') return 'not-tui'
  if (session.isRunning) return 'busy'
  const line = sanitizeWakeText(text)
  if (line.length === 0) return 'empty-text'
  let ok
  try {
    ok = session.writeTerminalInput(`${line}\r`)
  } catch {
    return 'pty-dead'
  }
  return ok ? 'injected' : 'pty-dead'
}
