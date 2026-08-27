/**
 * Session CI-completion watcher (#7424 — step 3 of #7344).
 *
 * #7422 built the *reading* (`session-pr-status.js`): a session-scoped survey
 * that answers "what is the state of the PR this session produced?" on demand.
 * It still requires someone to look. This module is the *watching* and the
 * *routing*: it notices a run settle and tells two audiences without either of
 * them asking —
 *
 *   - the **user**, through the existing notification pipeline (a `ci_complete`
 *     push → Expo / the Discord sink), so a finished run reaches the phone;
 *   - the **agent**, by typing one line into the session's own prompt when it
 *     is idle, so the model learns CI settled instead of spending a turn (and a
 *     whole cached-context re-read) polling `gh pr checks`.
 *
 * ## Completion is a TRANSITION, not a state
 *
 * The watcher fires only when it has itself observed the same PR at the same
 * head SHA go from pending to settled. "This PR is green" is not news — it is
 * true of every merged branch on the machine, and firing on first sight would
 * mean a daemon restart announces every long-finished run at once. So arming is
 * a precondition, and the arm is keyed on `(pr.number, pr.headRefOid)`:
 *
 *   - a re-push produces a new `headRefOid`, which re-arms and can fire again;
 *   - a reconnect changes nothing (this state is daemon-side, not client-side);
 *   - a run the watcher never saw pending never fires, which is the honest
 *     answer — nothing completed while it was watching.
 *
 * The cost of that honesty is a run that starts AND finishes inside one poll
 * interval, which is silently missed. That is why `tickIntervalMs` is minutes
 * shorter than any real CI run rather than a "cheap" hourly sweep.
 *
 * ## What "settled" means
 *
 * `counts.pending === 0` — NOT "the rollup's state says success", which hides a
 * run that has already failed but is still finishing, exactly the case the user
 * most needs to hear about. A head SHA whose rollup is EMPTY is not settled
 * either: nothing started, so nothing completed. #7422 reports that as
 * `state: 'none'` and an empty rollup is the only way to reach
 * `counts.total === 0`, so the two say the same thing — but the verdict here is
 * derived from the COUNTS rather than from the state label, because reading the
 * label produces guards that mask one another (see `terminalVerdict`). A
 * snapshot carrying a `reason` is "could not determine" and changes nothing — it
 * never disarms and never fires.
 *
 * ## Bounded fan-out
 *
 * Every survey shells out to git + `gh` (a network call), so a per-session timer
 * would fan subprocesses out with the session count. Instead there is ONE timer
 * and one sweep, and each tick surveys at most `maxSurveysPerTick` sessions,
 * sequentially, oldest-surveyed first:
 *
 *   - an ARMED session (CI known to be running) is due every tick;
 *   - any other session is due every `discoveryIntervalMs` — this is the
 *     discovery path that notices a PR opening in the first place.
 *
 * Oldest-first ordering is what makes the per-tick cap safe: it cannot starve a
 * session, only delay it. A tick that hits the cap says so in a debug log rather
 * than dropping work silently.
 *
 * ## Known behaviour: the arm is per SESSION, not per PR
 *
 * Two sessions sitting on the same branch (a worktree and its main checkout, say)
 * each hold their own arm, so one settling run produces one event per session:
 * two near-identical notifications, and a wake for each agent. The wakes are
 * right — each session is a separate agent that was waiting — and deduplicating
 * only the user half would need a cross-session (repo, PR, head SHA) ledger that
 * nothing else here wants. Left as-is deliberately; revisit if it grates.
 */

import { surveySessionPrStatus } from './session-pr-status.js'
import { wakeSession, sanitizeWakeText } from './session-wake.js'
import { settlePush } from './push.js'
import { createLogger } from './logger.js'
import { getErrorMessage } from './utils/error-message.js'

const defaultLog = createLogger('ci-watch')

/** How often the sweep runs. Armed sessions are re-surveyed every tick. */
export const DEFAULT_TICK_INTERVAL_MS = 60_000

/** How often an UNARMED session is re-surveyed, to discover a new PR/run. */
export const DEFAULT_DISCOVERY_INTERVAL_MS = 5 * 60_000

/** Upper bound on surveys (git + gh subprocesses) started by one tick. */
export const DEFAULT_MAX_SURVEYS_PER_TICK = 4

/** Cap on the PR title echoed into a notification body. */
export const MAX_TITLE_CHARS = 120

/**
 * Decide whether a survey snapshot describes a SETTLED run, and with what
 * verdict.
 *
 * @param {object|null|undefined} snapshot - a `surveySessionPrStatus` result.
 * @returns {'success'|'failure'|'unknown'|null} the terminal check state, or
 *   null when the run is still going, never started, or could not be determined.
 */
export function terminalVerdict(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  // A reason means the survey could not find out. Never a verdict — an
  // undeterminable state must not render (or notify) as an implied green.
  if (snapshot.reason) return null
  // A verdict has to be ATTRIBUTABLE — it names a PR in a notification and in
  // the line typed at a live agent — so a snapshot without one is not one.
  if (!snapshot.pr || !snapshot.checks) return null
  const { counts } = snapshot.checks
  if (!counts) return null
  // Derived from the COUNTS, not from #7422's `checks.state`. That field is a
  // live-progress label, and its two non-terminal values ('pending', 'none') are
  // exactly the two this function must refuse — so reading it here produces
  // guards that mask each other: drop the no-run check and the state label still
  // rejects it, drop the state check and the no-run guard still does. Both
  // survive mutation while looking careful, which is the failure mode
  // docs/false-safety-guards.md is a catalogue of. Every branch below is
  // reachable on its own, and the counts carry the same facts.
  //
  // No run exists for this head SHA — an empty rollup is the only way to get a
  // zero total. It never started, so it cannot have completed, and it is
  // emphatically not a pass.
  if (counts.total === 0) return null
  // The honest definition of settled. Deliberately NOT "the state says success",
  // which would swallow a run with a failure already recorded and other jobs
  // still going.
  if (counts.pending > 0) return null
  // Same precedence #7422's own rollup summary uses: a failure outranks an
  // unrecognised entry, and success is claimed only when every entry was
  // recognised and passed (or was skipped). An entry chroxy could not classify
  // never counts as a pass.
  if (counts.failed > 0) return 'failure'
  if (counts.unknown > 0) return 'unknown'
  return 'success'
}

/**
 * Normalise a GitHub merge-state enum for display. GitHub's own values are
 * SCREAMING_SNAKE; anything else is dropped rather than echoed into a
 * notification body or a session prompt.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normaliseMergeState(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.toUpperCase().replace(/[^A-Z_]/g, '')
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Human-facing title + body for a completion event.
 *
 * The three verdicts read differently on purpose, and `success` splits again on
 * merge state: the case that motivated #7344 had 21/21 green while the PR was
 * `BLOCKED` on an unresolved thread, and "CI passed" alone would have been
 * actively misleading there. Checks and mergeability stay separate facts in the
 * same sentence — never collapsed into one "ready?" verdict.
 *
 * @param {object} event - a completion event (see `_fire`).
 * @returns {{title: string, body: string}}
 */
export function describeCiCompletion(event) {
  const { verdict, prNumber, prTitle, counts, mergeStateStatus } = event
  const c = counts || {}
  const total = Number.isInteger(c.total) ? c.total : 0
  const failed = Number.isInteger(c.failed) ? c.failed : 0
  const unknown = Number.isInteger(c.unknown) ? c.unknown : 0
  const blocked = verdict === 'success' && mergeStateStatus === 'BLOCKED'

  let title
  if (verdict === 'failure') title = `CI failed on #${prNumber}`
  else if (verdict === 'unknown') title = `CI finished on #${prNumber} with unrecognised checks`
  else if (blocked) title = `CI passed on #${prNumber} — merge blocked`
  else title = `CI passed on #${prNumber}`

  const parts = []
  if (verdict === 'failure') parts.push(`${failed} of ${total} check${total === 1 ? '' : 's'} failed`)
  else if (verdict === 'unknown') parts.push(`${unknown} of ${total} check${total === 1 ? '' : 's'} reported a state chroxy does not recognise`)
  else parts.push(`${total} check${total === 1 ? '' : 's'} passed`)
  if (mergeStateStatus) parts.push(`merge state ${mergeStateStatus}`)
  const suffix = prTitle ? ` — ${prTitle}` : ''
  return { title, body: `${parts.join('; ')}${suffix}` }
}

/**
 * The line typed into the session's own prompt.
 *
 * Carries no PR title and no URL: this string is appended to a live agent's
 * input, and everything in it is either an integer this daemon derived or a
 * value from a fixed enum. GitHub-authored free text does not belong in a
 * model's instruction stream.
 *
 * @param {object} event
 * @returns {string}
 */
export function buildAgentWakeText(event) {
  const { verdict, prNumber, counts, mergeStateStatus } = event
  const c = counts || {}
  const total = Number.isInteger(c.total) ? c.total : 0
  const failed = Number.isInteger(c.failed) ? c.failed : 0
  const head = verdict === 'failure'
    ? `CI finished on PR #${prNumber}: ${failed} of ${total} checks FAILED.`
    : verdict === 'unknown'
      ? `CI finished on PR #${prNumber}: ${total} checks, some in a state chroxy does not recognise.`
      : `CI finished on PR #${prNumber}: all ${total} checks passed.`
  const merge = mergeStateStatus ? ` Merge state: ${mergeStateStatus}.` : ''
  return `${head}${merge} You did not need to poll for this.`
}

export class SessionCiWatcher {
  /**
   * @param {object} opts
   * @param {() => Array<{sessionId: string, cwd: string}>} opts.listSessions -
   *   the live session list (SessionManager.listSessions() shape).
   * @param {(sessionId: string) => object|null} [opts.resolveSession] - the live
   *   provider session object for an id, used for the agent wake. Absent = the
   *   agent half is unavailable and every completion notifies only.
   * @param {(opts: {sessionId: string, cwd: string}) => Promise<object>} [opts.survey]
   *   - the PR/CI survey seam (defaults to `surveySessionPrStatus`).
   * @param {(event: object) => void} [opts.notify] - fired once per completion,
   *   with the event. The caller routes it to PushManager.
   * @param {boolean} [opts.wakeAgent] - when false, completions notify the user
   *   but never type into a session.
   * @param {number} [opts.tickIntervalMs]
   * @param {number} [opts.discoveryIntervalMs]
   * @param {number} [opts.maxSurveysPerTick]
   * @param {() => number} [opts.nowFn] - injectable clock.
   * @param {object} [opts.logger]
   */
  constructor({
    listSessions,
    resolveSession,
    survey = surveySessionPrStatus,
    notify,
    wakeAgent = true,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    discoveryIntervalMs = DEFAULT_DISCOVERY_INTERVAL_MS,
    maxSurveysPerTick = DEFAULT_MAX_SURVEYS_PER_TICK,
    nowFn = Date.now,
    logger = defaultLog,
  } = {}) {
    this._listSessions = typeof listSessions === 'function' ? listSessions : () => []
    this._resolveSession = typeof resolveSession === 'function' ? resolveSession : null
    this._survey = survey
    this._notify = typeof notify === 'function' ? notify : null
    this._wakeAgent = wakeAgent !== false
    this._tickIntervalMs = tickIntervalMs
    this._discoveryIntervalMs = discoveryIntervalMs
    this._maxSurveysPerTick = maxSurveysPerTick
    this._now = nowFn
    this._log = logger
    this._timer = null
    this._stopped = false
    this._ticking = false
    /**
     * sessionId → { lastSurveyedAt: number, armed: {number, headRefOid}|null }.
     * Bounded by the live session count — entries are pruned in `tick()` when a
     * session disappears, so a long-running daemon does not accumulate the ids
     * of every session it has ever seen.
     */
    this._state = new Map()
  }

  /** Watch state for one session, creating it on first sight. */
  _stateFor(sessionId) {
    let s = this._state.get(sessionId)
    if (!s) {
      // `lastSurveyedAt: null` is "never surveyed", NOT "surveyed at time 0":
      // a first sight must be due regardless of what the clock reads, and
      // `now - 0 >= discoveryIntervalMs` only happens to be true because
      // Date.now() is large. An injected clock (or a mocked one starting near
      // zero) would otherwise silently never survey a new session.
      s = { lastSurveyedAt: null, armed: null }
      this._state.set(sessionId, s)
    }
    return s
  }

  /**
   * Run one sweep. Never rejects — a survey that throws is logged and the
   * session's arm is left untouched (a failed reading is not evidence of
   * anything, in either direction).
   *
   * Re-entrancy: a tick that is still running when the interval fires again
   * (a slow `gh`) causes the new one to return immediately rather than doubling
   * the subprocess fan-out.
   */
  async tick() {
    if (this._ticking) return
    this._ticking = true
    try {
      const sessions = (this._listSessions() || []).filter(
        s => s && typeof s.sessionId === 'string' && typeof s.cwd === 'string' && s.cwd.length > 0
      )

      // Prune state for sessions that are gone.
      const live = new Set(sessions.map(s => s.sessionId))
      for (const id of this._state.keys()) {
        if (!live.has(id)) this._state.delete(id)
      }

      const now = this._now()
      const due = sessions.filter(s => {
        const st = this._stateFor(s.sessionId)
        if (st.armed) return true
        if (st.lastSurveyedAt === null) return true
        return now - st.lastSurveyedAt >= this._discoveryIntervalMs
      })
      // Oldest reading first, so the per-tick cap delays a session but can never
      // starve one. Never-surveyed sorts ahead of everything.
      const age = id => {
        const at = this._stateFor(id).lastSurveyedAt
        return at === null ? -Infinity : at
      }
      due.sort((a, b) => age(a.sessionId) - age(b.sessionId))

      const batch = due.slice(0, this._maxSurveysPerTick)
      if (due.length > batch.length) {
        this._log?.debug?.(`ci-watch: ${due.length - batch.length} session(s) deferred to the next tick (cap ${this._maxSurveysPerTick})`)
      }

      for (const { sessionId, cwd } of batch) {
        if (this._stopped) return
        let snapshot
        try {
          snapshot = await this._survey({ sessionId, cwd })
        } catch (err) {
          // surveySessionPrStatus degrades environmental failures itself, so
          // reaching here means a defect — log it and leave the arm alone.
          this._log?.warn?.(`ci-watch: survey failed for ${sessionId}: ${getErrorMessage(err, 'unknown error')}`)
          continue
        }
        this._stateFor(sessionId).lastSurveyedAt = this._now()
        try {
          this._reconcile(sessionId, snapshot)
        } catch (err) {
          this._log?.warn?.(`ci-watch: reconcile failed for ${sessionId}: ${getErrorMessage(err, 'unknown error')}`)
        }
      }
    } finally {
      this._ticking = false
    }
  }

  /**
   * Fold one snapshot into the watch state, firing a completion event when it
   * closes a pending→settled transition this watcher armed.
   *
   * @param {string} sessionId
   * @param {object} snapshot
   */
  _reconcile(sessionId, snapshot) {
    const st = this._stateFor(sessionId)

    // "Could not determine" changes nothing. Disarming here would mean a single
    // `gh` hiccup silently cancels a watch the user is waiting on.
    if (snapshot?.reason) return

    // No open PR (the quiet negative — merged, closed, or never opened). Nothing
    // left to report on, so drop any arm.
    if (!snapshot?.pr) {
      st.armed = null
      return
    }

    const number = snapshot.pr.number
    const headRefOid = snapshot.pr.headRefOid
    const verdict = terminalVerdict(snapshot)

    if (verdict === null) {
      // Still going, or no run yet for this head.
      // Arm only on a run that is actually RUNNING, and only with a head SHA:
      // without one, a later settled reading cannot be told apart from a
      // different run entirely, and the whole one-event-per-(PR, SHA) contract
      // rests on that comparison. An unarmable reading (no run yet for this
      // head, a missing SHA) leaves any existing arm alone rather than clearing
      // it — clearing would be untestable dead code, because firing still
      // requires the settled reading to carry the SAME (number, headRefOid), so
      // a stale arm can only ever close against the very run it was set for.
      if (snapshot.checks?.counts?.pending > 0 && typeof headRefOid === 'string' && headRefOid.length > 0) {
        st.armed = { number, headRefOid }
      }
      return
    }

    const armed = st.armed
    // Settled. Consume the arm either way: whether or not it matched, the run it
    // referred to is no longer the one in flight.
    st.armed = null
    if (!armed) return
    if (armed.number !== number || armed.headRefOid !== headRefOid) return

    this._fire(sessionId, snapshot, verdict)
  }

  /**
   * Build the completion event and route it to both audiences. Each route is
   * isolated: a failing notification must not cost the agent its wake, and vice
   * versa.
   */
  _fire(sessionId, snapshot, verdict) {
    const event = {
      sessionId,
      prNumber: snapshot.pr.number,
      prTitle: sanitizeWakeText(snapshot.pr.title).slice(0, MAX_TITLE_CHARS) || null,
      prUrl: typeof snapshot.pr.url === 'string' ? snapshot.pr.url : null,
      headRefOid: snapshot.pr.headRefOid,
      repo: snapshot.repo ? `${snapshot.repo.owner}/${snapshot.repo.name}` : null,
      verdict,
      counts: snapshot.checks.counts,
      mergeStateStatus: normaliseMergeState(snapshot.merge?.mergeStateStatus),
      generatedAt: snapshot.generatedAt ?? null,
    }

    if (this._notify) {
      try {
        this._notify(event)
      } catch (err) {
        this._log?.warn?.(`ci-watch: notify failed for ${sessionId}: ${getErrorMessage(err, 'unknown error')}`)
      }
    }

    let wakeOutcome = 'disabled'
    if (this._wakeAgent && this._resolveSession) {
      try {
        wakeOutcome = wakeSession(this._resolveSession(sessionId), buildAgentWakeText(event))
      } catch (err) {
        wakeOutcome = 'error'
        this._log?.warn?.(`ci-watch: agent wake failed for ${sessionId}: ${getErrorMessage(err, 'unknown error')}`)
      }
    }
    this._log?.info?.(`ci-watch: #${event.prNumber} settled ${verdict} for session ${sessionId} (wake: ${wakeOutcome})`)
    return { event, wakeOutcome }
  }

  /** Start the periodic sweep. The first tick runs immediately. */
  start() {
    this._stopped = false
    this.tick().catch(() => {})
    this._timer = setInterval(() => {
      this.tick().catch(err => this._log?.warn?.(`ci-watch tick failed: ${getErrorMessage(err, 'unknown error')}`))
    }, this._tickIntervalMs)
    // Never keep the event loop alive for this; shutdown calls stop().
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()
    return this
  }

  /** Stop the sweep. Idempotent. */
  stop() {
    this._stopped = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }
}

/**
 * The push notification a completion event becomes. Pure, so the mapping the
 * user actually receives — category, title, body, payload — is assertable
 * without a PushManager.
 *
 * @param {object} event
 * @returns {{category: string, title: string, body: string, data: object}}
 */
export function ciCompletionPush(event) {
  const { title, body } = describeCiCompletion(event)
  return {
    category: 'ci_complete',
    title,
    body,
    data: {
      sessionId: event.sessionId,
      prNumber: event.prNumber,
      prUrl: event.prUrl,
      repo: event.repo,
      verdict: event.verdict,
      mergeStateStatus: event.mergeStateStatus,
    },
  }
}

/**
 * Build the daemon's watcher from config plus the live daemon objects, or null
 * when `sessionCi.watch` is off.
 *
 * This exists so server-cli's wiring is three lines and everything decidable —
 * the config gate, the interval overrides, the push mapping — is reachable from
 * a unit test. The alternative (an inline object literal in a 1500-line startup
 * function) can only ever be pinned by a source grep, and a source grep is
 * satisfied by the text being present whether or not it runs.
 *
 * @param {object} opts
 * @param {object} [opts.config] - the loaded daemon config.
 * @param {object} opts.sessionManager
 * @param {object|null} [opts.pushManager] - absent = the user half is silent.
 * @param {object} [opts.logger]
 * @param {Function} [opts.survey] - the survey seam, forwarded so a wiring test
 *   never shells out to real git/gh.
 * @returns {SessionCiWatcher|null}
 */
export function buildSessionCiWatcher({ config, sessionManager, pushManager = null, logger = defaultLog, survey } = {}) {
  const sessionCi = config?.sessionCi ?? {}
  if (sessionCi.watch === false) return null
  // A non-positive interval would spin the sweep; config.js warns about it, and
  // the value is ignored here rather than honoured.
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0
  return new SessionCiWatcher({
    listSessions: () => sessionManager?.listSessions?.() ?? [],
    resolveSession: sessionId => sessionManager?.getSession?.(sessionId)?.session ?? null,
    wakeAgent: sessionCi.wakeAgent !== false,
    ...(positive(sessionCi.intervalMs) ? { tickIntervalMs: sessionCi.intervalMs } : {}),
    ...(positive(sessionCi.discoveryIntervalMs) ? { discoveryIntervalMs: sessionCi.discoveryIntervalMs } : {}),
    ...(survey ? { survey } : {}),
    notify: (event) => {
      if (!pushManager) return
      const { category, title, body, data } = ciCompletionPush(event)
      // settlePush (#5702) logs both a thrown error AND a `false` not-delivered
      // return that a bare `.catch()` would drop.
      settlePush(pushManager.send(category, title, body, data), 'ci-complete', logger)
    },
    logger,
  })
}
