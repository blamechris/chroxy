/**
 * SidebarTokenView v0 tests (#4303).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import type { SessionInfo, CumulativeUsage } from '@chroxy/store-core'
import {
  SidebarTokenView,
  aggregateUsage,
  formatTokenCount,
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

  describe('formatTokenCount', () => {
    it('renders below 1000 verbatim', () => {
      expect(formatTokenCount(0)).toBe('0')
      expect(formatTokenCount(999)).toBe('999')
    })

    it('abbreviates thousands with K', () => {
      expect(formatTokenCount(1000)).toBe('1.0K')
      expect(formatTokenCount(1234)).toBe('1.2K')
      expect(formatTokenCount(999_499)).toBe('999.5K')
    })

    // #4304 review: avoid the "1000.0K" visual nonsense.
    it('rolls over to M before the K-rounded value crosses 1000', () => {
      expect(formatTokenCount(999_500)).toBe('1.00M')
      expect(formatTokenCount(999_999)).toBe('1.00M')
    })

    it('abbreviates millions with M', () => {
      expect(formatTokenCount(1_000_000)).toBe('1.00M')
      expect(formatTokenCount(1_500_000)).toBe('1.50M')
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

    it('renders "—" for TUI rows with tooltip', () => {
      const sessions = [makeSession('tui', 'claude-tui', makeUsage(0, 0, 0))]
      render(<SidebarTokenView sessions={sessions} />)
      const untracked = screen.getByTestId('sidebar-token-view-provider-claude-tui-untracked')
      expect(untracked).toHaveTextContent('—')
      expect(untracked.getAttribute('title')).toContain('claude TUI')
    })

    it('renders aggregate total and cost when present', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(1000, 500, 0.10)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.getByTestId('sidebar-token-view-today-total')).toHaveTextContent('1.5K tokens')
      // Cost row only renders when costUsd > 0
      expect(screen.getByText(/Cost \(BYOK\)/i)).toBeInTheDocument()
    })

    it('hides cost row when all sessions are subscription (cost === 0)', () => {
      const sessions = [
        makeSession('sub', 'claude-sdk', makeUsage(1000, 500, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.queryByText(/Cost \(BYOK\)/i)).toBeNull()
    })

    // #4348: visible-tokens-vs-billed-cost optical illusion.
    // The sidebar shows user-visible token counts (new content per turn) but
    // BYOK cost is computed from full per-call billed tokens (which include
    // the re-sent context). Without an affordance, the apparent $/token rate
    // looks wildly off Anthropic's published pricing.
    it('explains the visible-vs-billed-tokens distinction on the cost badge', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(12_800, 134_400, 87.48)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      const costInfo = screen.getByTestId('sidebar-token-view-cost-info')
      const tooltip = costInfo.getAttribute('title') ?? ''
      // Mentions "billed" tokens specifically (the key distinction)
      expect(tooltip.toLowerCase()).toContain('billed')
      // Mentions Anthropic pricing (so it's clear cost is faithful to invoice)
      expect(tooltip).toContain('Anthropic')
      // Mentions the re-sent context (the cause of the gap)
      expect(tooltip.toLowerCase()).toContain('context')
    })

    it('renders the info marker next to the cost badge when cost > 0', () => {
      const sessions = [
        makeSession('byok', 'claude-byok', makeUsage(1000, 500, 0.10)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.getByTestId('sidebar-token-view-cost-info')).toBeInTheDocument()
    })

    it('omits the info marker when no cost row is shown', () => {
      const sessions = [
        makeSession('sub', 'claude-sdk', makeUsage(1000, 500, 0)),
      ]
      render(<SidebarTokenView sessions={sessions} />)
      expect(screen.queryByTestId('sidebar-token-view-cost-info')).toBeNull()
    })
  })
})
