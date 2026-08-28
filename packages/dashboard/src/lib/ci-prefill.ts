/**
 * ci-prefill — turn a `session_pr_status` snapshot into one factual line, and
 * stage it in the composer WITHOUT sending it (#7423, step 2 of #7344).
 *
 * ## Why this exists after #7426 already tells the agent automatically
 *
 * #7426's `SessionCiWatcher` fires on a pending→settled transition it observed
 * ITSELF, and its agent half is a keystroke injection gated by `session-wake.js`.
 * Four things follow, and each is a case where the agent is never told:
 *
 *   1. **A run it never saw pending never fires.** That is deliberate honesty,
 *      not a bug — but it means a daemon restart, a session attached after CI
 *      started, or a run that begins and ends inside one discovery interval all
 *      leave the agent with nothing.
 *   2. **The wake is claude-tui only.** Every other provider gets the push and
 *      no injected line at all.
 *   3. **A busy session drops the wake.** `_fire` consumes the arm before
 *      waking, so a `busy` outcome is logged and never retried.
 *   4. **It fires once per `(pr, headRefOid)`.** A user who wants to ask about
 *      the same state a second time has no path.
 *
 * So this is the USER-driven path over the same reading: they are looking at the
 * chip, they want to hand the agent what it says, and they press Enter
 * themselves. It is not a fallback for a broken watcher — it is the half that
 * keeps the human in the loop by construction.
 *
 * ## What the line must never say
 *
 * The same contract the chip and the schema hold, restated because a prompt line
 * is read by a model that will act on it:
 *
 *   - **Check state and merge state are separate clauses.** The session that
 *     motivated #7344 had 21/21 green while `mergeStateStatus` was `BLOCKED`.
 *     No word in the output implies readiness, mergeability, or "done".
 *   - **`state: 'none'` is not a green.** It renders as "no checks ran on
 *     <sha>", never as an omitted clause — an absent clause beside a PR number
 *     reads as nothing-to-report.
 *   - **A failing snapshot prefills too.** A prefill that only armed on green
 *     would pass a naive test while dropping the case the user most needs to
 *     relay.
 *
 * ## Deliberately NOT included: the unresolved-thread count
 *
 * #7423's example line carries "0 unresolved threads", which `session_pr_status`
 * does not have — it needs a GraphQL `reviewThreads` read. That is not paid for
 * here: since #7426 the same survey runs on a daemon-side sweep across every
 * session, so adding a second `gh` call to it would multiply the cost of a
 * background poll to enrich a string that only a click builds. `reviewDecision`
 * (already on the snapshot) carries the review state in the meantime. See the
 * follow-on issue for the on-demand shape.
 */
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

/** Short SHA length, matching the chip's tooltip. */
const SHA_CHARS = 7

/** The line's opening words — the single place the subject is spelled. */
export const CI_PREFILL_PREFIX = 'CI status for PR #'

/**
 * The notice shown when the composer already holds a draft. Same fail-shape as
 * `EDIT_QUEUED_BUSY_NOTICE`: refuse rather than clobber, and say so.
 */
export const CI_PREFILL_BUSY_NOTICE =
  'Composer already has a draft — clear or send it before inserting the CI status.'

/**
 * State word for the check clause. Never 'green' for anything but `success`.
 *
 * `none` deliberately has NO row here: `checksClause` returns before reaching
 * this map, because a head that produced no run has no counts worth printing —
 * and a missing row would otherwise fall through to the `??` default and label
 * it "unrecognised", which is a different (and wrong) claim.
 */
const CHECK_VERB: Record<string, string> = {
  pending: 'checks still running',
  failure: 'checks failing',
  success: 'checks green',
  unknown: 'check state unrecognised',
}

function shortSha(headRefOid: string | null): string | null {
  if (typeof headRefOid !== 'string' || headRefOid.length === 0) return null
  return headRefOid.slice(0, SHA_CHARS)
}

/**
 * The check clause. Counts are rendered in full for every state except `none`,
 * rather than per-state selections, so no branch can silently omit the number a
 * reader needs (the `formatChecks` lesson: a fully-skipped rollup once read as
 * "0/5 green" because only `passed` was shown).
 */
function checksClause(
  checks: ServerSessionPrStatusMessage['checks'],
  sha: string | null,
): string {
  if (!checks) return 'check state unavailable'
  const { state, counts } = checks
  if (state === 'none') {
    // Explicit, and never omitted: no run exists for this head. Absence of
    // failure is not a pass.
    return sha === null ? 'no checks ran on this head' : `no checks ran on ${sha}`
  }
  const verb = CHECK_VERB[state] ?? 'check state unrecognised'
  const parts = [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    `${counts.pending} pending`,
    `${counts.skipped} skipped`,
  ]
  if (counts.unknown > 0) parts.push(`${counts.unknown} unrecognised`)
  return `${verb} (${parts.join(', ')} of ${counts.total})`
}

/**
 * The merge clause. Always rendered when there is a PR — its absence beside a
 * green check clause is read as "nothing blocking", which is the one impression
 * this whole feature exists to avoid giving.
 */
function mergeClause(merge: ServerSessionPrStatusMessage['merge']): string {
  const status = merge?.mergeStateStatus
  if (!status) return 'merge state unknown'
  // GitHub reports UNKNOWN while recomputing after a base change. Passed
  // through with the reason so it does not read as "no blocker".
  if (status === 'UNKNOWN') return 'merge state UNKNOWN (GitHub is still recomputing)'
  return `merge state ${status}`
}

/**
 * Build the composer line for a snapshot.
 *
 * Returns `null` when there is nothing verified to relay — no snapshot, or no
 * PR (whether that is the quiet negative or a survey that could not find out).
 * A caller must not offer the action in that case; a line saying "this branch
 * has no open PR" is not state worth handing an agent.
 */
export function formatCiPrefill(status: ServerSessionPrStatusMessage | null): string | null {
  if (!status || !status.pr) return null
  const sha = shortSha(status.pr.headRefOid)
  // Everything after CI_PREFILL_PREFIX, which already carries the "PR #".
  const head = sha === null ? `${status.pr.number}` : `${status.pr.number} (head ${sha})`
  // WHEN the reading was taken, always. The snapshot refreshes on a session
  // switch, a reconnect, or the chip's Refresh — nothing pushes it — so a tab
  // left open for half an hour holds a half-hour-old rollup, and this line
  // states it in the present tense to a model that will act on it. Without the
  // timestamp the staleness is invisible in exactly the artefact that leaves
  // the dashboard. `generatedAt` is passed through verbatim rather than
  // rendered relative: no `Date` parsing in a pure formatter, and a UTC instant
  // is unambiguous to both readers.
  const readAt = typeof status.generatedAt === 'string' && status.generatedAt.length > 0
    ? status.generatedAt
    : null
  const subject = readAt === null ? head : `${head} as of ${readAt}`
  const clauses = [checksClause(status.checks, sha), mergeClause(status.merge)]
  const reviewDecision = status.merge?.reviewDecision
  if (reviewDecision) clauses.push(`review ${reviewDecision}`)
  if (status.pr.isDraft) clauses.push('PR is a draft')
  // A partial reading says so: the chip can hide a caveat in a tooltip, a prompt
  // line cannot, and a caveat the model never sees is a caveat that did not
  // happen.
  //
  // UNREACHABLE against today's server, deliberately kept. Every
  // `snapshot.reason = ...` path in `session-pr-status.js` leaves `pr` null, and
  // this function returns before here in that case — so no current daemon can
  // produce a `pr` + `reason` snapshot, and the test below covers a state the
  // server does not emit. It stays because the SCHEMA permits the pairing
  // (`reason` is independent of `pr`) and a dashboard talks to daemons it did
  // not ship with; dropping a partial-reading caveat on the floor is the worse
  // failure. Labelled rather than silently believed to be live coverage.
  if (status.reason) clauses.push(`note: ${status.reason}`)
  return `${CI_PREFILL_PREFIX}${subject}: ${clauses.join(' — ')}`
}

export interface CiPrefillEffects {
  /** Current composer draft text (untrimmed). */
  getDraft: () => string
  /**
   * The EXACT text this helper last staged for this session, or null. Supplying
   * it lets a second click refresh a line the user has not touched; omitting it
   * makes every non-empty draft a refusal, which is the safe default.
   */
  getLastStaged?: () => string | null
  /** Stage `text` in the composer. Never sends. */
  setDraft: (text: string) => void
  /** Surface a non-blocking notice (the draft-would-be-clobbered guard). */
  notify: (message: string) => void
  /** Optional: focus the composer after staging. */
  focusComposer?: () => void
}

/**
 * Decide + apply what clicking the chip's prefill action should do.
 *
 * Pure control flow over injected effects, mirroring `runQueuedEdit`. Returns
 * the staged text, or `null` when nothing was staged, so a caller (and a test)
 * can tell "refused" from "wrote".
 */
export function runCiPrefill(
  status: ServerSessionPrStatusMessage | null,
  fx: CiPrefillEffects,
): string | null {
  const text = formatCiPrefill(status)
  if (text === null) return null
  const draft = fx.getDraft()
  // Guard: never clobber an in-progress draft. #7423 is explicit that the
  // composer keeps what the user typed, or the action is refused.
  //
  // The ONE exception is a line this helper staged and the user has not since
  // edited: refusing there leaves the composer holding a reading the chip has
  // already superseded, and the stale line is what gets sent. The test is exact
  // equality against the last staged text, never a prefix or shape match — a
  // user who appended "…can you look at the failure?" has made it theirs, and
  // that must still refuse.
  if (draft.trim().length > 0 && draft !== fx.getLastStaged?.()) {
    fx.notify(CI_PREFILL_BUSY_NOTICE)
    return null
  }
  fx.setDraft(text)
  fx.focusComposer?.()
  return text
}
