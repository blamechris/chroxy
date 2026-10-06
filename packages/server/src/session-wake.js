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
 *
 * ## The second route: the provider-neutral turn-input seam (#8301)
 *
 * PTY typing reaches claude-tui only, so a claude-sdk session (the default
 * provider) never learned that CI finished (`wake: not-tui`). A caller that
 * opts in with `{ turnInput: true }` also reaches every provider whose
 * `sendMessage` is a real turn-input seam: it dispatches when idle, QUEUES when
 * busy (`enqueueOutgoingMessage`, flushed at turn end, cleared by `interrupt()`)
 * and reports admission through `onInputAdmission`. Those providers declare it
 * with the static capability `daemonTurnInput: true`.
 *
 * - **Positive discriminator, strict `=== true`** — the same reasoning as rule 1:
 *   a duck-typed `typeof session.sendMessage === 'function'` is true of EVERY
 *   session, the user shell included, and a user shell executes the lines it is
 *   given. `UserShellSession` must never declare the flag; `isUserShell` is
 *   refused here as well, so one wrong flag cannot reach it.
 * - **Opt-in per caller.** The mailbox wake does NOT pass `turnInput` — #7437
 *   owns that caller and its PTY-only gate stays as it is. A claude-tui session
 *   keeps the PTY route whatever the caller passes.
 * - **Busy is fine here.** The queue absorbs it; `isRunning` is not consulted
 *   (a background shell does not corrupt SDK input the way it corrupts PTY
 *   typing).
 * - **The outcome is the provider's admission, not our hope.** `accepted` →
 *   `injected`, `queued` → `queued`, `rejected` → `rejected`. Admission may land
 *   after `sendMessage` returns, in which case the synchronous result is
 *   `pending` and `onAdmission` is the one place the final outcome is delivered.
 */

import { createLogger } from './logger.js'

const log = createLogger('session-wake')

/**
 * Outcome of a wake attempt.
 * @typedef {'injected'|'busy'|'not-tui'|'no-session'|'pty-dead'|'empty-text'|'queued'|'rejected'|'pending'|'error'} WakeOutcome
 *   `queued`, `rejected`, `pending` and `error` belong to the turn-input route
 *   (#8301) only; the PTY route never returns them.
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
 * Does this session class declare the provider-neutral turn-input seam?
 * Strict `=== true` on the CLASS, never the instance and never truthiness. A
 * throwing `capabilities` getter reads as "no" — an unreadable declaration is
 * not a declaration.
 *
 * @param {object} session
 * @returns {boolean}
 */
export function supportsDaemonTurnInput(session) {
  try {
    const Klass = session?.constructor
    if (Klass?.isUserShell === true) return false
    return Klass?.capabilities?.daemonTurnInput === true
  } catch {
    return false
  }
}

/**
 * Map a provider admission report to a wake outcome, or null when the report is
 * not final (an unrecognised shape must not be read as success).
 */
function outcomeForAdmission(admission) {
  if (!admission || typeof admission !== 'object') return null
  const { status, delivery } = admission
  if (status === 'accepted' && delivery === 'dispatch_started') return 'injected'
  if (status === 'queued' && delivery === 'queued') return 'queued'
  if (status === 'rejected' && delivery === 'not_dispatched') return 'rejected'
  return null
}

/**
 * The turn-input route (#8301). See the module header.
 *
 * @param {object} session
 * @param {string} text
 * @param {{ clientMessageId?: string, onAdmission?: (result: {outcome: 'injected'|'queued'|'rejected', line: string, clientMessageId: string|undefined, admission: object}) => void }} opts
 * @returns {WakeOutcome}
 */
function wakeViaTurnInput(session, text, { clientMessageId, onAdmission } = {}) {
  if (!supportsDaemonTurnInput(session)) return 'not-tui'
  if (typeof session.sendMessage !== 'function') return 'not-tui'
  const line = sanitizeWakeText(text)
  if (line.length === 0) return 'empty-text'

  let outcome = null
  // A queued item is re-dispatched at turn end with the SAME sendOptions, so the
  // provider reports admission a second time (`accepted`). The first final
  // report is the one that counts — `queued` already told the caller it landed.
  const onInputAdmission = (admission) => {
    if (outcome !== null) return
    const mapped = outcomeForAdmission(admission)
    if (mapped === null) return
    outcome = mapped
    if (typeof onAdmission === 'function') {
      try {
        onAdmission({ outcome: mapped, line, clientMessageId, admission })
      } catch (err) {
        log.warn(`wake onAdmission callback threw: ${err?.message || err}`)
      }
    }
  }

  let result
  try {
    result = session.sendMessage(line, [], {
      ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}),
      onInputAdmission,
    })
  } catch (err) {
    log.warn(`wake sendMessage threw: ${err?.message || err}`)
    return outcome ?? 'error'
  }
  // #5313: a rejecting promise must never escape to process-level
  // unhandledRejection (which exits the daemon over one session's fault).
  if (result && typeof result.catch === 'function') {
    result.catch((err) => {
      log.error(`wake sendMessage rejected: ${err?.message || err}`)
    })
  }
  return outcome ?? 'pending'
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
 * @param {object} [opts]
 * @param {boolean} [opts.turnInput] - also reach non-tui providers through the
 *   `sendMessage`/queue seam (#8301). Absent/false = the claude-tui-only gate,
 *   unchanged. Strict `=== true`.
 * @param {string} [opts.clientMessageId] - turn-input route: the stable daemon
 *   id the provider's queue mirror and history carry.
 * @param {Function} [opts.onAdmission] - turn-input route: called once with the
 *   final admission outcome (see `wakeViaTurnInput`).
 * @returns {WakeOutcome}
 */
export function wakeSession(session, text, opts = {}) {
  if (!session) return 'no-session'
  if (session.constructor?.isClaudeTui !== true) {
    if (opts?.turnInput === true) return wakeViaTurnInput(session, text, opts)
    return 'not-tui'
  }
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
