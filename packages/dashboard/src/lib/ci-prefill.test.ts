import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatCiPrefill, runCiPrefill, CI_PREFILL_BUSY_NOTICE } from './ci-prefill'
import type { ServerSessionPrStatusMessage, ServerSessionPrThreadsMessage } from '@chroxy/protocol'

/**
 * #7423 — the composer prefill line.
 *
 * The line is read by a MODEL that will act on it, so the assertions that carry
 * weight are the negative ones: it must not say "green" for a run still going,
 * must not omit the merge state beside a green one, and must not imply
 * readiness. Every negative is paired with a positive control, because a
 * formatter that returned the empty string would otherwise pass all of them.
 */

function status(overrides: Partial<ServerSessionPrStatusMessage> = {}): ServerSessionPrStatusMessage {
  return {
    type: 'session_pr_status',
    requestId: null,
    sessionId: 's1',
    generatedAt: '2026-08-27T00:00:00.000Z',
    branch: 'feat/x',
    repo: { owner: 'blamechris', name: 'chroxy' },
    pr: { number: 7423, title: 'feat: x', url: 'https://github.com/blamechris/chroxy/pull/7423', headRefOid: '5fff69ab1c2d3e4', isDraft: false },
    checks: { state: 'success', counts: { total: 21, passed: 21, failed: 0, pending: 0, skipped: 0, unknown: 0 } },
    merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' },
    reason: null,
    ...overrides,
  } as ServerSessionPrStatusMessage
}

/**
 * Words that would let a reader (or a model) conclude the PR can be merged.
 * The whole feature exists because 21/21 green sat beside `BLOCKED`.
 */
const READINESS_WORDS = /\b(ready|mergeable|good to go|safe to merge|all clear|looks good)\b/i

describe('formatCiPrefill — what the line must never say', () => {
  it('does not call a still-running rollup green', () => {
    const text = formatCiPrefill(status({
      checks: { state: 'pending', counts: { total: 21, passed: 12, failed: 0, pending: 9, skipped: 0, unknown: 0 } },
    }))
    expect(text).not.toMatch(/green/i)
    // Positive control: it still produced a line, and still named the pending run.
    expect(text).toContain('checks still running')
    expect(text).toContain('9 pending')
  })

  it('reports check state and merge state as separate facts when they diverge', () => {
    // The motivating case: everything green, merge BLOCKED on a review thread.
    const text = formatCiPrefill(status({
      merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
    })) as string
    expect(text).toContain('checks green')
    expect(text).toContain('merge state BLOCKED')
    expect(text).not.toMatch(READINESS_WORDS)
  })

  it('positive control: READINESS_WORDS can actually match, so the assertion above is not free', () => {
    expect('the PR is ready to merge').toMatch(READINESS_WORDS)
  })

  it('renders "no checks ran" for state none rather than omitting the clause', () => {
    // An absent check clause beside a PR number reads as nothing-to-report, and
    // `none` is emphatically not a pass.
    const text = formatCiPrefill(status({
      checks: { state: 'none', counts: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 } },
    })) as string
    expect(text).toContain('no checks ran on 5fff69a —')
    expect(text).not.toMatch(/green|passed/i)
  })

  it('never omits the merge clause, even when the merge state is null', () => {
    const text = formatCiPrefill(status({
      merge: { mergeable: null, mergeStateStatus: null, reviewDecision: null },
    })) as string
    expect(text).toContain('merge state unknown')
    // The optional clauses are OMITTED, not rendered empty — 'review null' in a
    // prompt line is worse than no review clause at all.
    expect(text).not.toContain('review')
  })

  it('still renders a line, and no green, when the checks block itself is absent', () => {
    const text = formatCiPrefill(status({ checks: null })) as string
    expect(text).toContain('check state unavailable')
    expect(text).toContain('merge state CLEAN')
    expect(text).not.toMatch(/green|passed/i)
  })

  it('spells out that UNKNOWN means recomputing, not unblocked', () => {
    const text = formatCiPrefill(status({
      merge: { mergeable: null, mergeStateStatus: 'UNKNOWN', reviewDecision: null },
    })) as string
    expect(text).toContain('merge state UNKNOWN (GitHub is still recomputing)')
  })
})

describe('formatCiPrefill — the cases the user most needs to relay', () => {
  it('positive control: a FAILING run prefills too', () => {
    // A prefill that only armed on green would pass every negative test above
    // while silently dropping the case with the most urgency.
    const text = formatCiPrefill(status({
      checks: { state: 'failure', counts: { total: 21, passed: 18, failed: 3, pending: 0, skipped: 0, unknown: 0 } },
      merge: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: null },
    })) as string
    expect(text).toContain('checks failing')
    expect(text).toContain('3 failed')
    expect(text).toContain('merge state DIRTY')
  })

  it('names the head SHA the verdict describes', () => {
    expect(formatCiPrefill(status())).toContain('PR #7423 (head 5fff69a) as of')
  })

  it('drops the head clause rather than printing a fake SHA when there is none', () => {
    const text = formatCiPrefill(status({
      pr: { number: 7423, title: null, url: null, headRefOid: null, isDraft: false },
    })) as string
    expect(text).toContain('PR #7423 as of')
    expect(text).not.toContain('head ')
  })

  it('carries the review decision and the draft flag when present', () => {
    const text = formatCiPrefill(status({
      pr: { number: 7423, title: null, url: null, headRefOid: 'abc1234def', isDraft: true },
      merge: { mergeable: null, mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' },
    })) as string
    expect(text).toContain('review CHANGES_REQUESTED')
    expect(text).toContain('PR is a draft')
  })

  it('surfaces a partial reading in the line itself, not only in a tooltip', () => {
    const text = formatCiPrefill(status({ reason: 'gh rate limit exceeded' })) as string
    expect(text).toContain('note: gh rate limit exceeded')
  })

  it('keeps the unrecognised bucket visible', () => {
    const text = formatCiPrefill(status({
      checks: { state: 'unknown', counts: { total: 5, passed: 2, failed: 0, pending: 0, skipped: 0, unknown: 3 } },
    })) as string
    expect(text).toContain('3 unrecognised')
    expect(text).toContain('check state unrecognised')
  })

  it('omits the unrecognised clause when there is nothing unrecognised', () => {
    expect(formatCiPrefill(status())).not.toContain('unrecognised')
  })

  it('omits the draft and note clauses when they do not apply', () => {
    const text = formatCiPrefill(status()) as string
    expect(text).not.toContain('draft')
    expect(text).not.toContain('note:')
  })

  it('says WHEN the reading was taken, so a stale snapshot cannot pass as current', () => {
    // The snapshot only refreshes on a session switch, a reconnect, or the
    // chip's Refresh — nothing pushes it. A tab left open holds an old rollup,
    // and this line states it in the present tense to a model that will act on
    // it, so the timestamp is the only thing making the staleness visible.
    const text = formatCiPrefill(status({ generatedAt: '2026-08-27T00:00:00.000Z' })) as string
    expect(text).toContain('as of 2026-08-27T00:00:00.000Z')
  })

  it('omits the "as of" clause rather than inventing a time it does not have', () => {
    const text = formatCiPrefill(status({ generatedAt: '' })) as string
    expect(text).not.toContain('as of')
    // Positive control: the rest of the line is unaffected.
    expect(text).toContain('checks green')
  })

  it('returns null when there is no verified state to relay', () => {
    expect(formatCiPrefill(null)).toBeNull()
    // The quiet negative (no open PR) and cannot-determine both yield nothing:
    // "this branch has no open PR" is not state worth handing an agent.
    expect(formatCiPrefill(status({ pr: null, checks: null, merge: null }))).toBeNull()
    expect(formatCiPrefill(status({ pr: null, checks: null, merge: null, reason: 'gh not found' }))).toBeNull()
  })
})

describe('runCiPrefill', () => {
  function effects(draft = '') {
    return {
      getDraft: vi.fn(() => draft),
      setDraft: vi.fn(),
      notify: vi.fn(),
      focusComposer: vi.fn(),
    }
  }

  it('stages the line in the composer and never sends it', () => {
    const fx = effects()
    const staged = runCiPrefill(status(), null, fx)
    expect(staged).not.toBeNull()
    expect(fx.setDraft).toHaveBeenCalledTimes(1)
    expect(fx.setDraft).toHaveBeenCalledWith(staged)
    expect(fx.focusComposer).toHaveBeenCalledTimes(1)
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('refuses rather than clobbering an in-progress draft', () => {
    const fx = effects('half a thought about the refactor')
    expect(runCiPrefill(status(), null, fx)).toBeNull()
    expect(fx.setDraft).not.toHaveBeenCalled()
    expect(fx.notify).toHaveBeenCalledWith(CI_PREFILL_BUSY_NOTICE)
  })

  it('treats a whitespace-only draft as empty', () => {
    const fx = effects('   \n  ')
    expect(runCiPrefill(status(), null, fx)).not.toBeNull()
    expect(fx.setDraft).toHaveBeenCalledTimes(1)
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('refreshes a line it staged itself, so the composer cannot disagree with the chip', () => {
    // The sharp case: prefill, hit Refresh (the chip flips pending -> failure),
    // click prefill again. Refusing there leaves the SUPERSEDED line in the
    // composer, and that is what gets sent.
    const first = formatCiPrefill(status({
      checks: { state: 'pending', counts: { total: 3, passed: 1, failed: 0, pending: 2, skipped: 0, unknown: 0 } },
    })) as string
    const fx = { ...effects(first), getLastStaged: vi.fn(() => first) }
    const second = runCiPrefill(status({
      checks: { state: 'failure', counts: { total: 3, passed: 1, failed: 2, pending: 0, skipped: 0, unknown: 0 } },
    }), null, fx)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(fx.setDraft).toHaveBeenCalledWith(second)
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('still refuses once the user has EDITED the line it staged', () => {
    // Exact equality, never a prefix or shape match: an appended question makes
    // the draft theirs, and theirs is never overwritten.
    const staged = formatCiPrefill(status()) as string
    const fx = {
      ...effects(staged + ' — can you look at the failure?'),
      getLastStaged: vi.fn(() => staged),
    }
    expect(runCiPrefill(status(), null, fx)).toBeNull()
    expect(fx.setDraft).not.toHaveBeenCalled()
    expect(fx.notify).toHaveBeenCalledWith(CI_PREFILL_BUSY_NOTICE)
  })

  it('refuses a non-empty draft when no getLastStaged is supplied at all', () => {
    // The effect is optional; omitting it must fail CLOSED, never open.
    const fx = effects('something the user typed')
    expect(runCiPrefill(status(), null, fx)).toBeNull()
    expect(fx.notify).toHaveBeenCalledWith(CI_PREFILL_BUSY_NOTICE)
  })

  it('does nothing at all — not even a notice — when there is no PR', () => {
    const fx = effects()
    expect(runCiPrefill(status({ pr: null, checks: null, merge: null }), null, fx)).toBeNull()
    expect(fx.setDraft).not.toHaveBeenCalled()
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('checks the draft only after it has a line to stage', () => {
    // Order matters: a no-PR click must not produce the busy notice just
    // because the user happened to be typing.
    const fx = effects('typing')
    runCiPrefill(status({ pr: null, checks: null, merge: null }), null, fx)
    expect(fx.notify).not.toHaveBeenCalled()
  })
})

/**
 * #7430 — the unresolved-review-thread clause.
 *
 * The clause is optional, and it is worth a block of its own because of a
 * single asymmetry: of the four things the line can say about threads — a
 * counted number, a RETAINED number whose refresh failed, "unavailable", or
 * nothing at all — exactly one is dangerous when it is wrong. "0 unresolved
 * threads" printed for a count that was never taken reads as "nothing is
 * blocking this PR", beside a green check clause, to a model that will act on
 * it.
 *
 * ## The fixtures are the server's shapes, not convenient ones
 *
 * The first version of this block pinned the false green against
 * `{ prNumber: 7423, reason: 'gh CLI not found' }` — a pairing the server can
 * only emit if `gh` disappears from PATH *between* the resolution call and the
 * `probeGh` that follows it. Review on #7469 proved it: every degraded reply
 * `degraded()` builds carries `prNumber: null`, as does every survey path that
 * returns before the PR is resolved. So the pin was green against a shape that
 * essentially cannot reach it, while all four REACHABLE degraded readings
 * silently rendered no clause at all.
 *
 * `serverDegraded()` below is therefore shape-coupled to the handler's
 * `degraded()` on purpose, and `SERVER_REASONS` carries the real reason strings
 * — with a source-level join test that fails if the producer's shape drifts
 * from this fixture. Validating the experiment ("does the formatter print a
 * zero?") without validating the fixture ("can the server produce this?") is
 * the same defect class as M12, one seam further out.
 */
function threads(overrides: Partial<ServerSessionPrThreadsMessage> = {}): ServerSessionPrThreadsMessage {
  return {
    type: 'session_pr_threads',
    requestId: null,
    sessionId: 's1',
    countedAt: '2026-08-27T00:05:00.000Z',
    prNumber: 7423,
    unresolvedCount: 0,
    totalCount: 4,
    truncated: false,
    reason: null,
    ...overrides,
  } as ServerSessionPrThreadsMessage
}

/**
 * EXACTLY the shape `degraded()` in `session-pr-threads-handlers.js` puts on
 * the wire, and the shape every pre-resolution bail-out in
 * `session-pr-threads.js` returns: no count, and — the part that mattered —
 * `prNumber: null`, because a reading that failed before resolving the PR has
 * no PR number to name.
 */
function serverDegraded(reason: string): ServerSessionPrThreadsMessage {
  return threads({ prNumber: null, unresolvedCount: null, totalCount: null, truncated: false, reason })
}

/**
 * The reasons a user can actually provoke, copied from the server's exported
 * constants. Each is reachable from the dashboard as it is wired today:
 *
 *   - IN_PROGRESS — a second prefill click while the first count is in flight
 *     (the click fires a request even when `runCiPrefill` then refuses it).
 *   - RATE_LIMITED — two clicks inside the 5s window before any count has
 *     completed, which is the FIRST-click path since the auto-pull deliberately
 *     does not fetch a count.
 *   - a passed-through status-survey reason — the double-`gh` coherence race:
 *     the dashboard holds a good status snapshot with a PR while the threads
 *     survey's own re-resolution fails transiently.
 *   - a handler-level failure.
 */
const SERVER_REASONS = [
  'a review-thread count is already running for this client',
  'review threads were counted moments ago — retry in a few seconds',
  'gh CLI not found on PATH — install GitHub CLI (gh) to see pull-request and CI status',
  'review-thread count failed: boom',
]

/**
 * A DEFINITE counted zero — the claim "this PR has no unresolved threads".
 *
 * The lookbehind is load-bearing rather than cosmetic: "at least 0 unresolved
 * threads" is the TRUNCATED rendering, which asserts a lower bound and not an
 * absence, so it must be allowed to contain the same five words. Without the
 * exclusion this regex would conflate the one rendering that is dangerous with
 * one that is explicitly hedged — and the two controls below pin exactly that
 * boundary, so the exclusion cannot quietly widen later.
 */
const COUNTED_ZERO = /(?<!at least )\b0 unresolved threads\b/

describe('#7430 — the unresolved-thread clause', () => {
  it('renders a counted zero as "0 unresolved threads"', () => {
    const text = formatCiPrefill(status(), threads()) as string
    expect(text).toMatch(COUNTED_ZERO)
    expect(text).not.toMatch(/unavailable/i)
  })

  it('renders a non-zero count, singular and plural', () => {
    expect(formatCiPrefill(status(), threads({ unresolvedCount: 1 }))).toContain('1 unresolved thread')
    expect(formatCiPrefill(status(), threads({ unresolvedCount: 1 }))).not.toContain('1 unresolved threads')
    expect(formatCiPrefill(status(), threads({ unresolvedCount: 3 }))).toContain('3 unresolved threads')
  })

  it('THE FALSE-GREEN PIN: a count that was not taken NEVER renders as a zero', () => {
    // The direction that matters, on the shape the server ACTUALLY emits
    // (`prNumber: null`). If this ever renders as "0 unresolved threads" the
    // line asserts an absence of blockers it never verified.
    const text = formatCiPrefill(status(), serverDegraded('gh CLI not found on PATH')) as string
    expect(text).not.toMatch(COUNTED_ZERO)
    expect(text).not.toMatch(/\b\d+ unresolved threads?\b/)
    // Positive control, and the half that fails without the guard reorder: it
    // did not simply DROP the subject either. Silence beside a green check
    // clause reads as nothing-to-report, which is the same false green by
    // omission rather than by number.
    expect(text).toContain('unresolved-thread count unavailable')
    expect(text).toContain('gh CLI not found on PATH')
  })

  it('THE JOIN: every reason the server can actually send renders the caveat', () => {
    // Each half of this was pinned separately before #7469's review and the two
    // disagreed about `prNumber`: the server test asserted null on the
    // passthrough path, the formatter test assumed a number. Nothing was
    // positioned to notice. This is that join.
    for (const reason of SERVER_REASONS) {
      const text = formatCiPrefill(status(), serverDegraded(reason)) as string
      expect(text, `no caveat for: ${reason}`).toContain('unresolved-thread count unavailable')
      expect(text, `caveat lost its reason for: ${reason}`).toContain(reason)
      expect(text).not.toMatch(COUNTED_ZERO)
    }
  })

  it('the three renderings are DIFFERENT strings for the same PR', () => {
    const counted = formatCiPrefill(status(), threads({ unresolvedCount: 0 }))
    const uncounted = formatCiPrefill(status(), serverDegraded('gh api graphql failed: timeout'))
    const absent = formatCiPrefill(status())
    expect(new Set([counted, uncounted, absent]).size).toBe(3)
  })

  it('a TRUNCATED zero is not a definite zero', () => {
    // 100 resolved threads on page one, every unresolved one past it. A flat
    // "0 unresolved threads" here is the same false green by another route.
    const text = formatCiPrefill(status(), threads({
      unresolvedCount: 0,
      totalCount: 150,
      truncated: true,
    })) as string
    expect(text).not.toMatch(COUNTED_ZERO)
    expect(text).toContain('at least 0 unresolved threads')
    expect(text).toContain('150')
  })

  it('omits the clause entirely when no count was supplied', () => {
    // Absent is not the same as unavailable, and neither is zero. An omitted
    // optional argument makes NO claim and must not manufacture one.
    const text = formatCiPrefill(status()) as string
    expect(text).not.toMatch(/unresolved/i)
    // Positive control: the rest of the line is unchanged.
    expect(text).toContain('checks green')
    expect(text).toContain('merge state CLEAN')
  })

  it('makes no claim when a count describes a DIFFERENT pull request', () => {
    // A stale count from the previously-active session's PR must not be
    // narrated as this one's. This is the guard that must survive the reorder:
    // it applies to a NUMBER, which can be mis-attributed, and the reorder
    // deliberately does not extend it to a reason, which cannot.
    const text = formatCiPrefill(status(), threads({ prNumber: 9999, unresolvedCount: 0 })) as string
    expect(text).not.toMatch(/unresolved/i)
  })

  it('makes no claim when a DEGRADED reading names a different pull request', () => {
    // The mirror: a reason that explicitly belongs to another PR's count says
    // nothing about this one either.
    const text = formatCiPrefill(status(), threads({ prNumber: 9999, unresolvedCount: null, totalCount: null, reason: 'boom' })) as string
    expect(text).not.toMatch(/unresolved/i)
  })

  it('refuses to render a count that cannot name its PR', () => {
    // Defensive, and the reason the reorder keeps a second prNumber test on the
    // COUNTED branch rather than dropping it: a number with no PR attached is
    // not attributable to this PR, even though a bare reason is.
    const text = formatCiPrefill(status(), threads({ prNumber: null, unresolvedCount: 4 })) as string
    expect(text).not.toMatch(/unresolved/i)
  })

  it('carries the count\'s OWN timestamp, not the status snapshot\'s', () => {
    // The two readings are taken separately and go stale separately; one
    // timestamp over both would claim a consistency neither has.
    const text = formatCiPrefill(status(), threads({ unresolvedCount: 2 })) as string
    expect(text).toContain('2026-08-27T00:00:00.000Z') // generatedAt, the status reading
    expect(text).toContain('2026-08-27T00:05:00.000Z') // countedAt, the thread reading
  })

  it('RETAINED COUNT: a kept count renders WITH the failed-refresh caveat, not instead of it', () => {
    // The store keeps the last good count when a degraded reply lands (#7469
    // S1), so this pairing — a real number plus a reason — is now a shape the
    // dashboard produces on purpose. Both halves must survive: dropping the
    // number throws away the only count the user has, and dropping the caveat
    // presents a stale reading as current.
    const text = formatCiPrefill(status(), threads({
      unresolvedCount: 2,
      reason: 'review threads were counted moments ago — retry in a few seconds',
    })) as string
    expect(text).toContain('2 unresolved threads')
    expect(text).toContain('counted 2026-08-27T00:05:00.000Z')
    expect(text).toContain('a newer unresolved-thread count was unavailable')
    expect(text).toContain('retry in a few seconds')
  })

  it('positive control: COUNTED_ZERO can actually match, so the negatives are not free', () => {
    expect('… — 0 unresolved threads (counted x)').toMatch(COUNTED_ZERO)
  })

  it('control: COUNTED_ZERO excludes the hedged lower bound, and ONLY that', () => {
    // The exclusion the pin depends on, stated as its own fact.
    expect('at least 0 unresolved threads — only part of 150 were read').not.toMatch(COUNTED_ZERO)
    expect('roughly 0 unresolved threads').toMatch(COUNTED_ZERO)
  })
})

describe('#7430 — the degraded fixture is joined to the server that produces it', () => {
  // A shape-coupled fixture is only as good as the coupling. These read the
  // PRODUCER and fail if it drifts — which is the specific thing that went
  // wrong before: the formatter was tested against a shape the server does not
  // emit, and nothing noticed for a whole review cycle.
  const HANDLER = resolve(__dirname, '..', '..', '..', 'server', 'src', 'handlers', 'session-pr-threads-handlers.js')

  it('the handler source exists where this fixture claims it does', () => {
    expect(existsSync(HANDLER), `${HANDLER} should exist`).toBe(true)
  })

  it('the server\'s degraded() really does emit prNumber:null and no counts', () => {
    const src = readFileSync(HANDLER, 'utf8')
    const start = src.indexOf('function degraded(')
    expect(start, 'session-pr-threads-handlers.js should define degraded()').toBeGreaterThan(-1)
    // Anchored to the function body, never a file-wide grep: `prNumber: null`
    // also appears nowhere else today, and "also appears elsewhere tomorrow" is
    // exactly how a file-wide grep goes vacuous.
    const body = src.slice(start, src.indexOf('\n}', start))
    expect(body.includes('prNumber: null')).toBe(true)
    expect(body.includes('unresolvedCount: null')).toBe(true)
    expect(body.includes('totalCount: null')).toBe(true)
    expect(body.includes('truncated: false')).toBe(true)
  })

  it('positive control: the slice is the function, not the whole file', () => {
    const src = readFileSync(HANDLER, 'utf8')
    const start = src.indexOf('function degraded(')
    const body = src.slice(start, src.indexOf('\n}', start))
    expect(body.includes('export const COUNT_MIN_INTERVAL_MS')).toBe(false)
    expect(body.length).toBeLessThan(700)
  })

  it('every reason this file pins is still a reason the server exports', () => {
    // The fixture strings are copies; this is what keeps them honest.
    const handlerSrc = readFileSync(HANDLER, 'utf8')
    const surveySrc = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'src', 'session-pr-threads.js'), 'utf8')
    const statusSrc = readFileSync(resolve(__dirname, '..', '..', '..', 'server', 'src', 'session-pr-status.js'), 'utf8')
    const all = handlerSrc + surveySrc + statusSrc
    for (const reason of SERVER_REASONS) {
      // The handler-level failure reason is a template; pin its literal prefix.
      const needle = reason === 'review-thread count failed: boom' ? 'review-thread count failed: ' : reason
      expect(all.includes(needle), `server no longer emits: ${needle}`).toBe(true)
    }
  })
})
