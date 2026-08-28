import { describe, it, expect, vi } from 'vitest'
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
 * The clause is optional, and the reason it is worth a test block of its own is
 * a single asymmetry: of the three things the line can say about threads —
 * a counted number, "unavailable", or nothing at all — exactly one of them is
 * dangerous when it is wrong. "0 unresolved threads" printed for a count that
 * was never taken reads as "nothing is blocking this PR", beside a green check
 * clause, to a model that will act on it. Every assertion below exists to pin
 * that the three renderings cannot collapse into each other.
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
    // The direction that matters. `reason` set + `unresolvedCount: null` is the
    // server's "could not find out"; if this ever renders as "0 unresolved
    // threads" the line asserts an absence of blockers it never verified.
    const text = formatCiPrefill(status(), threads({
      unresolvedCount: null,
      totalCount: null,
      reason: 'gh CLI not found on PATH',
    })) as string
    expect(text).not.toMatch(COUNTED_ZERO)
    expect(text).not.toMatch(/\bunresolved threads?\b(?!\s*count)/)
    // Positive control: it did not simply drop the subject either — silence
    // beside a green check clause reads as nothing-to-report.
    expect(text).toContain('unresolved-thread count unavailable')
    expect(text).toContain('gh CLI not found on PATH')
  })

  it('the two renderings are DIFFERENT strings for the same PR', () => {
    // The issue's requirement stated directly: whatever the wording, a counted
    // zero and an uncounted one must not produce the same line.
    const counted = formatCiPrefill(status(), threads({ unresolvedCount: 0 }))
    const uncounted = formatCiPrefill(status(), threads({ unresolvedCount: null, totalCount: null, reason: 'gh api graphql failed: timeout' }))
    expect(counted).not.toEqual(uncounted)
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
    // Absent ≠ unavailable ≠ zero. An omitted optional argument makes NO claim
    // and must not manufacture one in either direction.
    const text = formatCiPrefill(status()) as string
    expect(text).not.toMatch(/unresolved/i)
    // Positive control: the rest of the line is unchanged.
    expect(text).toContain('checks green')
    expect(text).toContain('merge state CLEAN')
  })

  it('makes no claim when the count describes a DIFFERENT pull request', () => {
    // A stale count from the previously-active session's PR must not be
    // narrated as this one's.
    const text = formatCiPrefill(status(), threads({ prNumber: 9999, unresolvedCount: 0 })) as string
    expect(text).not.toMatch(/unresolved/i)
  })

  it('carries the count\'s OWN timestamp, not the status snapshot\'s', () => {
    // The two readings are taken separately and go stale separately; one
    // timestamp over both would claim a consistency neither has.
    const text = formatCiPrefill(status(), threads({ unresolvedCount: 2 })) as string
    expect(text).toContain('2026-08-27T00:00:00.000Z') // generatedAt, the status reading
    expect(text).toContain('2026-08-27T00:05:00.000Z') // countedAt, the thread reading
  })

  it('treats a count that arrives WITH a reason as unavailable', () => {
    // Defensive: the schema permits the pairing and the server never emits it,
    // but if a daemon ever does, the caveat wins over the number.
    const text = formatCiPrefill(status(), threads({ unresolvedCount: 0, reason: 'partial read' })) as string
    expect(text).not.toMatch(COUNTED_ZERO)
    expect(text).toContain('unresolved-thread count unavailable')
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
