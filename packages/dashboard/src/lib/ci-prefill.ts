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
 * ## The unresolved-thread count (#7430)
 *
 * #7423's example line carries "0 unresolved threads", which `session_pr_status`
 * does not have — it needs a GraphQL `reviewThreads` read that the daemon-side
 * CI sweep must not be made to pay for. It arrives instead as its OWN on-demand
 * message (`session_pr_threads`), which is why it is a second, OPTIONAL argument
 * here rather than another field read off the snapshot.
 *
 * Four renderings, and they must never collapse into each other:
 *
 *   - **absent** — no count was supplied. The line makes NO thread claim.
 *   - **unavailable** — a count was attempted and failed. The line says so, in
 *     words, with the server's reason.
 *   - **counted** — a number, which may be zero.
 *   - **retained** — a number the store kept when a later refresh failed,
 *     rendered WITH its own `countedAt` and the failure's reason. Both halves
 *     matter: dropping the number throws away the only count the user has;
 *     dropping the caveat presents a stale reading as current.
 *
 * The second is the reason this is worth spelling out. A missing count that
 * printed as "0 unresolved threads", beside a green check clause, tells a model
 * that nothing is blocking the PR — the same false green the check clause's own
 * `state: 'none'` handling exists to prevent, arriving by a different route. A
 * TRUNCATED count is the third route to it: 100 resolved threads on page one
 * with every unresolved one past it is a real "0" that means nothing, so it
 * renders as a lower bound instead.
 *
 * ## The guard ORDER is the whole of #7469's Critical 2
 *
 * A **reason** and a **number** need different join rules against the status
 * snapshot's PR. A number attributed to the wrong PR is a fabrication; a reason
 * has no PR to be wrong about. The first version tested `prNumber` before
 * `reason`, and since every degraded reply the server emits carries
 * `prNumber: null`, the "unavailable" rendering was unreachable for all four
 * failures a user can actually provoke — the clause silently vanished in
 * exactly the cases it exists for. The order below is load-bearing, not
 * stylistic, and `ci-prefill.test.ts` pins it against the server's real shapes.
 */
import type { ServerSessionPrStatusMessage, ServerSessionPrThreadsMessage } from '@chroxy/protocol'

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
/**
 * The unresolved-thread clause, or `null` when the line should make no thread
 * claim at all.
 *
 * `null` means "no claim", never "no threads", and is returned for exactly
 * three inputs:
 *
 *   1. no count was supplied at all;
 *   2. the reading names a DIFFERENT pull request — it says nothing about this
 *      one, neither its count nor whether a count could be taken;
 *   3. a reading that carries a NUMBER but cannot name its PR. Defensive: the
 *      server always stamps `prNumber` alongside a count, and a number with no
 *      PR attached is not attributable to this one.
 *
 * A degraded reading with `prNumber: null` is deliberately NOT in that list —
 * it is the shape every server-side failure actually has, and dropping it is
 * what #7469's Critical 2 was. See the guard-order note in the file header.
 */
function threadsClause(
  threads: ServerSessionPrThreadsMessage | null | undefined,
  prNumber: number,
): string | null {
  if (!threads) return null

  // (2) An explicitly different PR: no claim, in either direction.
  if (threads.prNumber !== null && threads.prNumber !== prNumber) return null

  if (threads.unresolvedCount === null) {
    // Said in words, never by omission: an omitted clause beside a green check
    // clause reads as nothing-to-report, which is the impression to avoid.
    // Reached with `prNumber: null`, which is what every degraded reply has.
    const why = threads.reason
    return why ? `unresolved-thread count unavailable: ${why}` : 'unresolved-thread count unavailable'
  }

  // (3) From here a NUMBER is rendered, so the join must be positive.
  if (threads.prNumber !== prNumber) return null

  const n = threads.unresolvedCount
  const noun = `unresolved thread${n === 1 ? '' : 's'}`
  // WHEN it was counted, for the same reason the subject carries `generatedAt`:
  // this is its OWN clock, and the two readings can be minutes apart. It is
  // what makes the RETAINED rendering below honest rather than misleading.
  const at = typeof threads.countedAt === 'string' && threads.countedAt.length > 0
    ? ` (counted ${threads.countedAt})`
    : ''
  // A count the store KEPT across a failed refresh (#7469 S1) carries the new
  // failure's reason beside the old count. Rendering the number without this
  // would present a stale reading as current.
  const stale = threads.reason
    ? ` — a newer unresolved-thread count was unavailable: ${threads.reason}`
    : ''

  if (threads.truncated) {
    // A lower bound, and labelled as one. `totalCount` is GitHub's own total and
    // stays authoritative even when only part of it was read.
    const of = threads.totalCount === null
      ? ' — not all review threads were read'
      : ` — only part of ${threads.totalCount} review threads were read`
    return `at least ${n} ${noun}${of}${at}${stale}`
  }
  return `${n} ${noun}${at}${stale}`
}

export function formatCiPrefill(
  status: ServerSessionPrStatusMessage | null,
  threads?: ServerSessionPrThreadsMessage | null,
): string | null {
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
  // #7430: placed after the review decision, which it explains — the count is
  // what turns `CHANGES_REQUESTED` or a `BLOCKED` merge state into a number.
  const threadsText = threadsClause(threads, status.pr.number)
  if (threadsText !== null) clauses.push(threadsText)
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
  threads: ServerSessionPrThreadsMessage | null,
  fx: CiPrefillEffects,
): string | null {
  const text = formatCiPrefill(status, threads)
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
