import { describe, it, expect, vi } from 'vitest'
import { formatCiPrefill, runCiPrefill, CI_PREFILL_BUSY_NOTICE } from './ci-prefill'
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

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
    expect(formatCiPrefill(status())).toContain('PR #7423 (head 5fff69a)')
  })

  it('drops the head clause rather than printing a fake SHA when there is none', () => {
    const text = formatCiPrefill(status({
      pr: { number: 7423, title: null, url: null, headRefOid: null, isDraft: false },
    })) as string
    expect(text).toContain('PR #7423:')
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
    const staged = runCiPrefill(status(), fx)
    expect(staged).not.toBeNull()
    expect(fx.setDraft).toHaveBeenCalledTimes(1)
    expect(fx.setDraft).toHaveBeenCalledWith(staged)
    expect(fx.focusComposer).toHaveBeenCalledTimes(1)
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('refuses rather than clobbering an in-progress draft', () => {
    const fx = effects('half a thought about the refactor')
    expect(runCiPrefill(status(), fx)).toBeNull()
    expect(fx.setDraft).not.toHaveBeenCalled()
    expect(fx.notify).toHaveBeenCalledWith(CI_PREFILL_BUSY_NOTICE)
  })

  it('treats a whitespace-only draft as empty', () => {
    const fx = effects('   \n  ')
    expect(runCiPrefill(status(), fx)).not.toBeNull()
    expect(fx.setDraft).toHaveBeenCalledTimes(1)
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('does nothing at all — not even a notice — when there is no PR', () => {
    const fx = effects()
    expect(runCiPrefill(status({ pr: null, checks: null, merge: null }), fx)).toBeNull()
    expect(fx.setDraft).not.toHaveBeenCalled()
    expect(fx.notify).not.toHaveBeenCalled()
  })

  it('checks the draft only after it has a line to stage', () => {
    // Order matters: a no-PR click must not produce the busy notice just
    // because the user happened to be typing.
    const fx = effects('typing')
    runCiPrefill(status({ pr: null, checks: null, merge: null }), fx)
    expect(fx.notify).not.toHaveBeenCalled()
  })
})
