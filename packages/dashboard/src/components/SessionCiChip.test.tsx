import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SessionCiChip, formatChecks, formatMergeState } from './SessionCiChip'
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

/**
 * #7344 — the session PR/CI chip.
 *
 * The assertions that matter are the ones about what the chip must NOT say:
 * it must not render "no checks" as a green, and it must never fuse check state
 * and merge state into one "ready to merge?" verdict. Each of those is paired
 * with a positive control so a chip that rendered nothing at all could not pass.
 */

// #dashboard-tests-no-rtl-autocleanup: this suite mounts, so it cleans up itself.
afterEach(cleanup)

function status(overrides: Partial<ServerSessionPrStatusMessage> = {}): ServerSessionPrStatusMessage {
  return {
    type: 'session_pr_status',
    requestId: null,
    sessionId: 's1',
    generatedAt: '2026-08-27T00:00:00.000Z',
    branch: 'feat/x',
    repo: { owner: 'blamechris', name: 'chroxy' },
    pr: { number: 7419, title: 'fix: t', url: 'https://github.com/blamechris/chroxy/pull/7419', headRefOid: 'abc1234def', isDraft: false },
    checks: { state: 'success', counts: { total: 21, passed: 21, failed: 0, pending: 0, skipped: 0, unknown: 0 } },
    merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' },
    reason: null,
    ...overrides,
  } as ServerSessionPrStatusMessage
}

describe('formatChecks', () => {
  it('never renders a head with no checks as a green', () => {
    expect(formatChecks({ state: 'none', counts: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 } }))
      .toBe('No checks')
  })

  it('positive control: the same function does render a real green', () => {
    expect(formatChecks({ state: 'success', counts: { total: 21, passed: 21, failed: 0, pending: 0, skipped: 0, unknown: 0 } }))
      .toBe('21/21 green')
  })

  it('surfaces a failure that is still running, instead of hiding it behind the pending count', () => {
    expect(formatChecks({ state: 'pending', counts: { total: 8, passed: 0, failed: 3, pending: 5, skipped: 0, unknown: 0 } }))
      .toBe('3 failed / 5 pending')
  })

  it('counts skipped checks as settled, so an all-skipped rollup is not "0/5 green"', () => {
    // Skipped checks satisfy branch protection, and this repo's path-filtered
    // jobs make a largely-skipped rollup common.
    expect(formatChecks({ state: 'success', counts: { total: 5, passed: 0, failed: 0, pending: 0, skipped: 5, unknown: 0 } }))
      .toBe('5/5 green')
  })

  it('keeps the unrecognised count visible in the pending branch', () => {
    // The unknown bucket exists to surface entries the server could not classify.
    // Omitting it from the label hid it in the branch that most needs it.
    expect(formatChecks({ state: 'pending', counts: { total: 10, passed: 5, failed: 0, pending: 2, skipped: 0, unknown: 3 } }))
      .toBe('5/10 · 2 pending · 3 unrecognised')
  })

  it('reports a failing run', () => {
    expect(formatChecks({ state: 'failure', counts: { total: 4, passed: 1, failed: 3, pending: 0, skipped: 0, unknown: 0 } }))
      .toBe('3 failed')
  })
})

describe('formatMergeState', () => {
  it("renders UNKNOWN as recomputing rather than dropping it or calling it a blocker", () => {
    expect(formatMergeState({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: null }))
      .toBe('merge: recomputing')
  })

  it('renders a real merge state', () => {
    expect(formatMergeState({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: null }))
      .toBe('merge: blocked')
  })

  it('renders "unknown" for a null merge state rather than dropping the pill', () => {
    // The defect this replaced: returning null here rendered a GREEN chip with
    // no merge pill beside it, which reads as "ready to merge". `mergeStateStatus`
    // is `.nullable()` in the schema, so this is a schema-valid server reply.
    expect(formatMergeState({ mergeable: null, mergeStateStatus: null, reviewDecision: null })).toBe('merge: unknown')
  })

  it('returns null ONLY when there is no PR to have a merge state', () => {
    expect(formatMergeState(null)).toBeNull()
  })
})

describe('SessionCiChip', () => {
  it('shows 21/21 green AND merge: blocked as separate elements', () => {
    // The motivating case. A chip that collapsed these into one badge would have
    // told the user their PR was ready when it was blocked on a review thread.
    render(<SessionCiChip status={status({ merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' } })} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip-checks').textContent).toBe('21/21 green')
    expect(screen.getByTestId('session-ci-chip-merge').textContent).toBe('merge: blocked')
  })

  it('still shows a merge pill when the merge state is null, so green never stands alone', () => {
    // Regression guard for the "green chip, no merge pill" reading. A user must
    // never see a passing check label with nothing beside it unless there is
    // genuinely no PR.
    render(<SessionCiChip status={status({ merge: { mergeable: null, mergeStateStatus: null, reviewDecision: null } })} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip-checks').textContent).toBe('21/21 green')
    expect(screen.getByTestId('session-ci-chip-merge').textContent).toBe('merge: unknown')
  })

  it('marks a draft PR', () => {
    const { unmount } = render(<SessionCiChip status={status({ pr: { number: 7419, title: 't', url: 'https://github.com/blamechris/chroxy/pull/7419', headRefOid: 'abc', isDraft: true } })} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip-draft')).toBeTruthy()
    unmount()

    render(<SessionCiChip status={status()} onRefresh={vi.fn()} />)
    expect(screen.queryByTestId('session-ci-chip-draft')).toBeNull()
  })

  it('tones a no-checks head neutral, never success', () => {
    render(<SessionCiChip status={status({ checks: { state: 'none', counts: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 } } })} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip').dataset.tone).toBe('neutral')
  })

  it('positive control: a genuinely green rollup IS toned success', () => {
    render(<SessionCiChip status={status()} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip').dataset.tone).toBe('success')
  })

  it('tones a failing rollup as failure', () => {
    render(<SessionCiChip status={status({ checks: { state: 'failure', counts: { total: 3, passed: 0, failed: 3, pending: 0, skipped: 0, unknown: 0 } } })} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip').dataset.tone).toBe('failure')
  })

  it('distinguishes "no open PR" from "could not determine"', () => {
    // Both have pr: null. Only the `reason` separates them, and rendering the
    // second as the first would be an implied green.
    const { unmount } = render(<SessionCiChip status={status({ pr: null, checks: null, merge: null, reason: null })} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip').textContent).toContain('No PR')
    unmount()

    render(<SessionCiChip status={status({ pr: null, checks: null, merge: null, reason: 'no GitHub remote' })} onRefresh={vi.fn()} />)
    const chip = screen.getByTestId('session-ci-chip')
    expect(chip.textContent).toContain('CI unavailable')
    expect(chip.getAttribute('title')).toBe('no GitHub remote')
  })

  it('renders the PR number as a link, and refuses a non-http(s) URL', () => {
    const { unmount } = render(<SessionCiChip status={status()} onRefresh={vi.fn()} />)
    const link = screen.getByRole('link', { name: /Open pull request #7419/ })
    expect(link.getAttribute('href')).toBe('https://github.com/blamechris/chroxy/pull/7419')
    unmount()

    render(<SessionCiChip status={status({ pr: { number: 7419, title: 't', url: 'javascript:alert(1)', headRefOid: null, isDraft: false } })} onRefresh={vi.fn()} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTestId('session-ci-chip').textContent).toContain('#7419')
  })

  it('calls onRefresh, and disables the control while loading', () => {
    const onRefresh = vi.fn()
    const { unmount } = render(<SessionCiChip status={status()} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('session-ci-chip-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    unmount()

    render(<SessionCiChip status={status()} loading onRefresh={onRefresh} />)
    expect(screen.getByTestId('session-ci-chip-refresh')).toBeDisabled()
  })

  it('renders nothing before any snapshot has landed and nothing is in flight', () => {
    const { container } = render(<SessionCiChip status={null} onRefresh={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows a placeholder while the first request is in flight', () => {
    render(<SessionCiChip status={null} loading onRefresh={vi.fn()} />)
    expect(screen.getByTestId('session-ci-chip')).toBeTruthy()
  })
})
