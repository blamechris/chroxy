/**
 * SidebarTokenView v0 tests (#4303).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import type { SessionInfo, CumulativeUsage } from '@chroxy/store-core'
import {
  SidebarTokenView,
  aggregateUsage,
  cacheHitRatio,
  tokenViewCollapsedMetric,
} from './SidebarTokenView'

afterEach(() => {
  cleanup()
})

function makeUsage(input: number, output: number, costUsd = 0): CumulativeUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    turnsBilled: 1,
  }
}

function makeUsageWithCache(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): CumulativeUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    costUsd: 0,
    turnsBilled: 1,
  }
}

function makeSession(
  id: string,
  provider: string,
  usage: CumulativeUsage | undefined,
): SessionInfo {
  return {
    sessionId: id,
    name: id,
    cwd: '/tmp',
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 0,
    conversationId: null,
    provider,
    cumulativeUsage: usage,
  }
}

describe('SidebarTokenView (#4303 v0)', () => {
  describe('aggregateUsage (pure)', () => {
    it('returns all-zero totals + empty list for no sessions', () => {
      const agg = aggregateUsage([])
      expect(agg.totalSessions).toBe(0)
      expect(agg.byProvider).toEqual([])
      expect(agg.totals.inputTokens).toBe(0)
      expect(agg.totals.outputTokens).toBe(0)
      expect(agg.hasUntracked).toBe(false)
    })

    it('sums tokens across same-provider sessions', () => {
      const sessions = [
        makeSession('s1', 'claude-sdk', makeUsage(1000, 500, 0)),
        makeSession('s2', 'claude-sdk', makeUsage(2000, 800, 0)),
      ]
      const agg = aggregateUsage(sessions)
      expect(agg.totals.inputTokens).toBe(3000)
      expect(agg.totals.outputTokens).toBe(1300)
      expect(agg.byProvider).toHaveLength(1)
      expect(agg.byProvider[0]!.provider).toBe('claude-sdk')
      expect(agg.byProvider[0]!.sessionCount).toBe(2)
      expect(agg.byProvider[0]!.totals.inputTokens).toBe(3000)
    })

    it('keeps per-provider rows separate', () => {
      const sessions = [
        makeSession('a', 'claude-byok', makeUsage(1000, 200, 0.05)),
        makeSession('b', 'claude-sdk', makeUsage(5000, 1000, 0)),
        makeSession('c', 'claude-cli', makeUsage(2000, 400, 0)),
      ]
      const agg = aggregateUsage(sessions)
      expect(agg.byProvider).toHaveLength(3)
      const providers = agg.byProvider.map((r) => r.provider)
      // Sorted by tokens desc (SDK=6000 > CLI=2400 > BYOK=1200)
      expect(providers).toEqual(['claude-sdk', 'claude-cli', 'claude-byok'])
    })

    it('marks claude-tui sessions as untracked and excludes them from totals', () => {
      const sessions = [
        makeSession('sdk', 'claude-sdk', makeUsage(1000, 200, 0)),
        makeSession('tui', 'claude-tui', makeUsage(0, 0, 0)),
      ]
      const agg = aggregateUsage(sessions)
      expect(agg.hasUntracked).toBe(true)
      const tuiRow = agg.byProvider.find((r) => r.provider === 'claude-tui')!
      expect(tuiRow.untracked).toBe(true)
      // SDK totals counted; TUI's zero-block doesn't affect cross-provider totals
      expect(agg.totals.inputTokens).toBe(1000)
      // TUI session counted in totalSessions for reference
      expect(agg.totalSessions).toBe(2)
    })

    it('sorts untracked providers last regardless of their token count', () => {
      // claude-tui sessions have all-zero usage today (no data). Even if a
      // future hypothetical world made TUI report tokens, the untracked flag
      // should keep them visually separated.
      const sessions = [
        makeSession('tui', 'claude-tui', makeUsage(0, 0, 0)),
        makeSession('sdk', 'claude-sdk', makeUsage(100, 50, 0)),
      ]
      const agg = aggregateUsage(sessions)
      expect(agg.byProvider[agg.byProvider.length - 1]!.provider).toBe('claude-tui')
    })

    it('handles missing cumulativeUsage as all-zero (defensive)', () => {
      const sessions = [
        makeSession('s1', 'claude-sdk', undefined),
        makeSession('s2', 'claude-sdk', makeUsage(100, 50, 0)),
      ]
      const agg = aggregateUsage(sessions)
      expect(agg.totals.inputTokens).toBe(100)
      expect(agg.byProvider[0]!.sessionCount).toBe(2)
    })

    it('groups sessions without a provider field under "unknown"', () => {
      const s: SessionInfo = {
        sessionId: 'no-prov',
        name: 'np',
        cwd: '/',
        type: 'cli',
        hasTerminal: false,
        model: null,
        permissionMode: null,
        isBusy: false,
        createdAt: 0,
        conversationId: null,
        cumulativeUsage: makeUsage(500, 100),
      }
      const agg = aggregateUsage([s])
      expect(agg.byProvider[0]!.provider).toBe('unknown')
    })
  })

  // formatTokenCount was unified into the canonical `formatTokens` in
  // @chroxy/store-core (#5058 / #5094); its unit tests now live in
  // store-core/src/cost-format.test.ts. The render-level assertions below
  // (today-total, by-provider) still exercise the formatter end-to-end.

  describe('cacheHitRatio (pure)', () => {
    it('returns null when there is no input surface', () => {
      expect(cacheHitRatio(makeUsage(0, 0))).toBeNull()
      expect(cacheHitRatio(makeUsageWithCache(0, 5000, 0, 0))).toBeNull()
    })

    it('computes cacheRead / (input + cacheRead + cacheCreation)', () => {
      // cacheRead=80, input=10, cacheCreation=10 -> 80/100 = 0.8
      expect(cacheHitRatio(makeUsageWithCache(10, 0, 80, 10))).toBeCloseTo(0.8)
    })

    it('is 0 when nothing was read from cache', () => {
      expect(cacheHitRatio(makeUsageWithCache(100, 0, 0, 0))).toBe(0)
    })

    it('does not count output tokens in the denominator', () => {
      // Large output should not dilute the ratio.
      expect(cacheHitRatio(makeUsageWithCache(50, 1_000_000, 50, 0))).toBeCloseTo(0.5)
    })
  })

  describe('cache-hit row render', () => {
    it('renders the cache-hit row when there is an input surface', () => {
      const sessions = [
        makeSession('s1', 'claude-byok', makeUsageWithCache(20, 10, 80, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      // 80 / (20 + 80 + 0) = 80%
      expect(screen.getByTestId('sidebar-token-view-cache-hit')).toHaveTextContent('80%')
    })

    it('hides the cache-hit row when there is no input surface', () => {
      const sessions = [makeSession('sub', 'claude-sdk', makeUsage(0, 0, 0))]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.queryByTestId('sidebar-token-view-cache-hit')).toBeNull()
    })
  })

  describe('per-session breakdown', () => {
    it('lists tracked sessions sorted by tokens desc', () => {
      const sessions = [
        makeSession('small', 'claude-sdk', makeUsage(100, 50)),
        makeSession('big', 'claude-byok', makeUsage(5000, 1000, 0.2)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      const list = screen.getByTestId('sidebar-token-view-by-session')
      const rows = list.querySelectorAll('[data-testid^="sidebar-token-view-session-"]')
      expect(rows[0]).toHaveTextContent('big')
      expect(rows[1]).toHaveTextContent('small')
    })

    it('excludes untracked (TUI) sessions from the per-session list', () => {
      const sessions = [
        makeSession('sdk', 'claude-sdk', makeUsage(100, 50)),
        makeSession('tui', 'claude-tui', makeUsage(0, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.getByTestId('sidebar-token-view-session-sdk')).toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-token-view-session-tui')).toBeNull()
    })

    it('hides the section entirely when no tracked sessions exist', () => {
      const sessions = [makeSession('tui', 'claude-tui', makeUsage(0, 0))]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.queryByTestId('sidebar-token-view-by-session')).toBeNull()
    })

    it('floats the active session to the top and marks it current', () => {
      const sessions = [
        makeSession('big', 'claude-byok', makeUsage(5000, 1000)),
        makeSession('active', 'claude-sdk', makeUsage(10, 5)),
      ]
      render(<SidebarTokenView sessions={sessions} activeSessionId="active" />)
      const list = screen.getByTestId('sidebar-token-view-by-session')
      const rows = list.querySelectorAll('[data-testid^="sidebar-token-view-session-"]')
      // Active session floats to top despite lower token count.
      expect(rows[0]).toHaveTextContent('active')
      const activeRow = screen.getByTestId('sidebar-token-view-session-active')
      expect(activeRow.getAttribute('aria-current')).toBe('true')
    })

    it('renders rows as buttons and activates on click when handler supplied', () => {
      const onSessionClick = vi.fn()
      const sessions = [makeSession('s1', 'claude-sdk', makeUsage(100, 50))]
      render(<SidebarTokenView sessions={sessions} onSessionClick={onSessionClick} />)
      const row = screen.getByTestId('sidebar-token-view-session-s1')
      expect(row.tagName).toBe('BUTTON')
      fireEvent.click(row)
      expect(onSessionClick).toHaveBeenCalledWith('s1')
    })

    it('renders static (non-button) rows when no click handler is supplied', () => {
      const sessions = [makeSession('s1', 'claude-sdk', makeUsage(100, 50))]
      render(<SidebarTokenView sessions={sessions} />)
      const row = screen.getByTestId('sidebar-token-view-session-s1')
      expect(row.tagName).toBe('LI')
    })
  })

  describe('tokenViewCollapsedMetric', () => {
    it('returns the same total as the expanded view', () => {
      const sessions = [
        makeSession('s1', 'claude-sdk', makeUsage(1000, 500, 0)),
        makeSession('s2', 'claude-byok', makeUsage(800, 200, 0.04)),
      ]
      // Total = (1000+500) + (800+200) = 2500
      expect(tokenViewCollapsedMetric(sessions)).toBe('2.5K tokens')
    })

    it('returns 0 tokens when no usage', () => {
      expect(tokenViewCollapsedMetric([])).toBe('0 tokens')
    })

    it('excludes TUI from the collapsed total (decision #1)', () => {
      const sessions = [
        makeSession('tui', 'claude-tui', makeUsage(0, 0, 0)),
        makeSession('sdk', 'claude-sdk', makeUsage(1000, 500, 0)),
      ]
      expect(tokenViewCollapsedMetric(sessions)).toBe('1.5K tokens')
    })
  })

  describe('render', () => {
    it('renders empty-state when no sessions', () => {
      render(<SidebarTokenView sessions={[]} />)
      expect(screen.getByTestId('sidebar-token-view-today-total')).toHaveTextContent('0 tokens')
      expect(screen.getByTestId('sidebar-token-view-empty')).toBeInTheDocument()
    })

    it('renders per-provider rows with token counts', () => {
      const sessions = [
        makeSession('s1', 'claude-sdk', makeUsage(1000, 500, 0)),
        makeSession('s2', 'claude-byok', makeUsage(2000, 800, 0.18)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.getByTestId('sidebar-token-view-provider-claude-sdk')).toBeInTheDocument()
      expect(screen.getByTestId('sidebar-token-view-provider-claude-byok')).toBeInTheDocument()
    })

    it('renders "—" for TUI rows with tap-to-disclose explanation', () => {
      const sessions = [makeSession('tui', 'claude-tui', makeUsage(0, 0, 0))]
      render(<SidebarTokenView sessions={sessions} />)
      const untracked = screen.getByTestId('sidebar-token-view-provider-claude-tui-untracked')
      expect(untracked).toHaveTextContent('—')
      // #4362: native title= doesn't fire on tap, so the trigger must be a
      // button + popover so touch users can surface the explanation.
      expect(untracked.tagName).toBe('BUTTON')
      // Closed by default
      expect(
        screen.queryByTestId('sidebar-token-view-provider-claude-tui-untracked-popover'),
      ).toBeNull()
      fireEvent.click(untracked)
      const popover = screen.getByTestId(
        'sidebar-token-view-provider-claude-tui-untracked-popover',
      )
      expect(popover.textContent ?? '').toContain('claude TUI')
    })

    // #4546: the Escape focus-restore wiring lives on the shared
    // `InfoDisclosure` component, so it benefits both the cost-info trigger
    // (covered above) AND the TUI-untracked trigger. Cover the TUI path
    // explicitly so a future refactor that splits `InfoDisclosure` into two
    // components — or introduces a per-trigger override — can't silently
    // lose focus-restoration coverage for the TUI-untracked popover.
    it('restores focus to the TUI-untracked disclosure on Escape (#4539)', () => {
      const sessions = [makeSession('tui', 'claude-tui', makeUsage(0, 0, 0))]
      render(<SidebarTokenView sessions={sessions} />)
      const trigger = screen.getByTestId('sidebar-token-view-provider-claude-tui-untracked')
      fireEvent.click(trigger)
      const popover = screen.getByTestId('sidebar-token-view-provider-claude-tui-untracked-popover')
      ;(popover as HTMLElement).focus()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(document.activeElement).toBe(trigger)
    })

    it('renders aggregate total and cost when present', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(1000, 500, 0.10)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.getByTestId('sidebar-token-view-today-total')).toHaveTextContent('1.5K tokens')
      // #5630: api-key class cost row renders as "Cost (BYOK)" with a dollar.
      expect(screen.getByText(/Cost \(BYOK\)/i)).toBeInTheDocument()
      expect(screen.getByTestId('sidebar-token-view-cost-value-api-key')).toHaveTextContent('$0.10')
    })

    it('hides priced cost row when an api-key session has cost === 0', () => {
      // claude-sdk with no server billingClass derives to api-key (fallback);
      // a priced row is hidden at $0.
      const sessions = [
        makeSession('sub', 'claude-sdk', makeUsage(1000, 500, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.queryByText(/Cost \(BYOK\)/i)).toBeNull()
      expect(screen.queryByTestId('sidebar-token-view-cost-api-key')).toBeNull()
    })

    // #5630: the no-dollar subscription chip shows whenever a subscription-class
    // session exists, even at $0 (a flat subscription has no per-turn charge).
    it('shows the no-dollar "Included (subscription)" chip for a subscription session', () => {
      const sessions = [
        makeSession('tui', 'claude-tui', makeUsage(1000, 500, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      const row = screen.getByTestId('sidebar-token-view-cost-subscription')
      expect(row).toHaveTextContent(/Included \(subscription\)/i)
      // No dollar figure anywhere in the subscription row.
      expect(screen.getByTestId('sidebar-token-view-cost-value-subscription')).toHaveTextContent('Included')
      expect(screen.getByTestId('sidebar-token-view-cost-value-subscription').textContent).not.toMatch(/\$/)
    })

    // #5630: the programmatic-credit class labels its row "Credit spend".
    it('labels a programmatic-credit session "Credit spend" with a dollar figure', () => {
      const s = makeSession('cli', 'claude-cli', makeUsage(1000, 500, 0.25))
      s.billingClass = 'programmatic-credit'
      render(<SidebarTokenView sessions={[s]} />)
      const row = screen.getByTestId('sidebar-token-view-cost-programmatic-credit')
      expect(row).toHaveTextContent(/Credit spend/i)
      expect(screen.getByTestId('sidebar-token-view-cost-value-programmatic-credit')).toHaveTextContent('$0.25')
    })

    // #4348 / #4362: visible-tokens-vs-billed-cost optical illusion. The
    // sidebar shows user-visible token counts (new content per turn) but BYOK
    // cost is computed from full per-call billed tokens (which include the
    // re-sent context). The disclosure surfaces the explanation on tap (not
    // just hover) so it works on touch devices.
    it('explains the visible-vs-billed-tokens distinction in the api-key cost popover', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(12_800, 134_400, 87.48)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      // #5630: the per-class info trigger is suffixed with the billing class.
      const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
      // Popover closed by default
      expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()

      fireEvent.click(trigger)
      const popover = screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')
      const text = popover.textContent ?? ''
      // Mentions "billed" tokens specifically (the key distinction)
      expect(text.toLowerCase()).toContain('billed')
      // Mentions the re-sent context (the cause of the gap)
      expect(text.toLowerCase()).toContain('context')
    })

    it('renders the info marker next to the api-key cost badge when cost > 0', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(1000, 500, 0.10)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.getByTestId('sidebar-token-view-cost-info-api-key')).toBeInTheDocument()
    })

    it('omits the api-key info marker when no priced cost row is shown', () => {
      const sessions = [
        makeSession('sub', 'claude-sdk', makeUsage(1000, 500, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key')).toBeNull()
    })

    // #4362: touch-friendly disclosure replaces the hover-only `title=`
    // attribute. The trigger must be a button so touch users get tap-to-
    // disclose, with click-outside and Escape both dismissing the popover.
    // Hover behavior is preserved for pointer users.
    describe('cost-info disclosure (#4362)', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(1000, 500, 0.10)),
      ]

      it('renders the trigger as a button with accessible name', () => {
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        expect(trigger.tagName).toBe('BUTTON')
        // The original aria-label intent is preserved (issue acceptance criteria).
        expect(trigger.getAttribute('aria-label')).toMatch(/cost|match|token/i)
        // aria-expanded should reflect closed state initially.
        expect(trigger.getAttribute('aria-expanded')).toBe('false')
      })

      it('toggles the popover on click (tap)', () => {
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')

        // Initially closed
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
        expect(trigger.getAttribute('aria-expanded')).toBe('false')

        // First click opens
        fireEvent.click(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()
        expect(trigger.getAttribute('aria-expanded')).toBe('true')

        // Second click closes
        fireEvent.click(trigger)
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
        expect(trigger.getAttribute('aria-expanded')).toBe('false')
      })

      it('exposes the popover with an appropriate ARIA role', () => {
        render(<SidebarTokenView sessions={sessions} />)
        fireEvent.click(screen.getByTestId('sidebar-token-view-cost-info-api-key'))
        const popover = screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')
        // Either role="dialog" or role="tooltip" is acceptable for a small
        // explanatory popover; both surface the content to AT users.
        const role = popover.getAttribute('role')
        expect(role === 'dialog' || role === 'tooltip').toBe(true)
      })

      it('dismisses the popover when Escape is pressed', () => {
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        fireEvent.click(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
        expect(trigger.getAttribute('aria-expanded')).toBe('false')
      })

      it('restores focus to the disclosure button when Escape dismisses the popover (#4539)', () => {
        // WAI-ARIA APG: a disclosure-triggered popover dismissed via Escape
        // should return focus to the invoker so keyboard users don't get
        // parked on document.body and lose their place in the tab order.
        // Mirrors PR #4525 which fixed the same omission for ActivityIndicator.
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        fireEvent.click(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()
        // Move focus into the popover to simulate a keyboard user who has
        // tabbed into the disclosure content. The Escape dismiss must yank
        // focus back to the trigger regardless of which element currently
        // holds it.
        const popover = screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')
        ;(popover as HTMLElement).focus()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
        expect(document.activeElement).toBe(trigger)
      })

      it('dismisses the popover when clicking outside', () => {
        render(
          <div>
            <SidebarTokenView sessions={sessions} />
            <button type="button" data-testid="outside-button">outside</button>
          </div>,
        )
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        fireEvent.click(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()

        // mousedown is the typical click-outside trigger (fires before focus).
        fireEvent.mouseDown(screen.getByTestId('outside-button'))
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
      })

      it('does NOT restore focus to the disclosure button on outside-click dismiss (#4539)', () => {
        // Outside-click dismiss intentionally leaves focus where the user
        // clicked — stealing it back would fight their pointer intent. Only
        // the keyboard-only Escape path restores focus per APG guidance.
        // Mirrors PR #4525 which made the same deliberate distinction for
        // ActivityIndicator.
        render(
          <div>
            <SidebarTokenView sessions={sessions} />
            <button type="button" data-testid="outside-button">outside</button>
          </div>,
        )
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        fireEvent.click(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()
        // Move focus elsewhere first so we can assert focus is NOT pulled
        // back to the disclosure after the outside-click dismiss.
        document.body.focus()
        expect(document.activeElement).not.toBe(trigger)
        fireEvent.mouseDown(document.body)
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
        expect(document.activeElement).not.toBe(trigger)
      })

      it('does not dismiss when clicking inside the popover', () => {
        render(<SidebarTokenView sessions={sessions} />)
        fireEvent.click(screen.getByTestId('sidebar-token-view-cost-info-api-key'))
        const popover = screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')
        fireEvent.mouseDown(popover)
        // Still open after clicking inside.
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()
      })

      it('opens on mouseenter so hover users keep the same affordance', () => {
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        // Hover should reveal the popover (matches the pre-#4362 hover-only UX
        // for desktop pointer users).
        fireEvent.mouseEnter(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()
        fireEvent.mouseLeave(trigger)
        // And hide on mouseleave so the popover doesn't linger after the
        // pointer moves away.
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
      })

      // #4362 regression guard: touch browsers synthesize mouseenter then click
      // on a single tap. Treating the synthetic mouseenter as a hover-open
      // would flip the popover closed on the very tap that's supposed to
      // surface it — re-introducing the issue this PR fixes. The trigger must
      // open and stay open on a single tap.
      it('opens on a single tap on touch devices (no flip-flop)', () => {
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        // Simulate a touch tap: pointerdown(touch) -> mouseenter -> click.
        fireEvent.pointerDown(trigger, { pointerType: 'touch' })
        fireEvent.mouseEnter(trigger)
        fireEvent.click(trigger)
        // Popover should be open after the tap.
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()
        expect(trigger.getAttribute('aria-expanded')).toBe('true')
      })

      // Second tap on touch should close (toggle behavior).
      it('closes on a second tap on touch devices', () => {
        render(<SidebarTokenView sessions={sessions} />)
        const trigger = screen.getByTestId('sidebar-token-view-cost-info-api-key')
        // First tap to open.
        fireEvent.pointerDown(trigger, { pointerType: 'touch' })
        fireEvent.mouseEnter(trigger)
        fireEvent.click(trigger)
        expect(screen.getByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeInTheDocument()

        // Second tap should close.
        fireEvent.pointerDown(trigger, { pointerType: 'touch' })
        fireEvent.click(trigger)
        expect(screen.queryByTestId('sidebar-token-view-cost-info-api-key-popover')).toBeNull()
      })
    })
  })
})
