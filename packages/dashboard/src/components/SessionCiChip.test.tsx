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

  it('returns null when there is nothing to say', () => {
    expect(formatMergeState({ mergeable: null, mergeStateStatus: null, reviewDecision: null })).toBeNull()
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
