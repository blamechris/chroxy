/**
 * SidebarCostBadge — formatter + render tests for #4073.
 *
 * Two angles:
 *   1. formatCostBadge / formatCostBreakdown — pure functions, pin the
 *      formatting rules (sub-dollar accuracy vs $X.YY at scale, breakdown
 *      ordering and field labels).
 *   2. Sidebar render — badge appears when costUsd > 0, hidden when 0
 *      (subscription-billed sessions), hidden when cumulativeUsage is
 *      null (no result event yet).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { CumulativeUsage } from '@chroxy/store-core'

// The Sidebar component pulls in ServerPicker + ConversationSearch which
// reach into the connection store. For the badge-render tests we don't
// care about those children; stub them out so the test stays focused on
// the badge logic. The pure formatter functions don't render anything
// and don't trigger this code path.
vi.mock('./ServerPicker', () => ({ ServerPicker: () => null }))
vi.mock('./ConversationSearch', () => ({ ConversationSearch: () => null }))
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => selector({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'connected',
    activeSessionId: null,
    sessionStates: {},
  }),
}))

// Import AFTER vi.mock declarations so the mocks register first.
import { Sidebar, formatCostBadge, formatCostBreakdown } from './Sidebar'

afterEach(cleanup)

const baseUsage: CumulativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turnsBilled: 0,
}

describe('formatCostBadge (#4073)', () => {
  it('formats values >= $1 with 2 decimal places', () => {
    expect(formatCostBadge(1.0)).toBe('$1.00')
    expect(formatCostBadge(1.234)).toBe('$1.23')
    expect(formatCostBadge(42.5)).toBe('$42.50')
  })

  it('formats values >= $0.01 and < $1 with 3 decimals (sub-dollar accuracy)', () => {
    expect(formatCostBadge(0.07)).toBe('$0.070')
    expect(formatCostBadge(0.013)).toBe('$0.013')
    expect(formatCostBadge(0.999)).toBe('$0.999')
  })

  it('formats values < $0.01 with 4 decimals (very small costs)', () => {
    expect(formatCostBadge(0.0001)).toBe('$0.0001')
    expect(formatCostBadge(0.0023)).toBe('$0.0023')
  })

  it('renders $0 for zero / negative / non-finite input (defensive)', () => {
    // The Sidebar guards on > 0 before rendering, but the formatter itself
    // must not crash or emit `$NaN` for a corrupted upstream payload.
    expect(formatCostBadge(0)).toBe('$0')
    expect(formatCostBadge(-0.5)).toBe('$0')
    expect(formatCostBadge(NaN)).toBe('$0')
    expect(formatCostBadge(Infinity)).toBe('$0')
  })
})

describe('formatCostBreakdown (#4073)', () => {
  it('contains all six rows in a stable order', () => {
    const breakdown = formatCostBreakdown({
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 8000,
      cacheCreationTokens: 200,
      costUsd: 0.0345,
      turnsBilled: 3,
    })
    const lines = breakdown.split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatch(/^Total cost: \$0\.0345$/)
    expect(lines[1]).toBe('Turns billed: 3')
    expect(lines[2]).toBe('Input tokens: 1,234')
    expect(lines[3]).toBe('Output tokens: 567')
    expect(lines[4]).toBe('Cache read: 8,000')
    expect(lines[5]).toBe('Cache write: 200')
  })

  it('uses locale formatting for large token counts (1,234,567 not 1234567)', () => {
    const breakdown = formatCostBreakdown({
      ...baseUsage,
      inputTokens: 1234567,
    })
    expect(breakdown).toMatch(/Input tokens: 1,234,567/)
  })
})

describe('Sidebar cost badge rendering (#4073)', () => {
  function makeProps(cumulativeUsage: CumulativeUsage | null | undefined) {
    return {
      repos: [
        {
          path: '/repo',
          name: 'repo',
          source: 'auto' as const,
          exists: true,
          activeSessions: [
            {
              sessionId: 'sess-1',
              name: 'session-1',
              isBusy: false,
              cumulativeUsage,
            },
          ],
          resumableSessions: [],
        },
      ],
      activeSessionId: null,
      isOpen: true,
      width: 240,
      filter: '',
      serverStatus: 'connected' as const,
      tunnelUrl: null,
      clientCount: 1,
      onFilterChange: () => {},
      onSessionClick: () => {},
      onResumeSession: () => {},
      onNewSession: () => {},
      onToggle: () => {},
      onContextMenu: () => {},
    }
  }

  it('renders a cost badge when costUsd > 0', () => {
    render(<Sidebar {...makeProps({ ...baseUsage, costUsd: 0.42, inputTokens: 1000, turnsBilled: 2 })} />)
    const badge = screen.getByTestId('sidebar-cost-badge-sess-1')
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).toBe('$0.420')
    expect(badge.getAttribute('title')).toMatch(/Total cost: \$0\.4200/)
    expect(badge.getAttribute('title')).toMatch(/Turns billed: 2/)
    expect(badge.getAttribute('title')).toMatch(/Input tokens: 1,000/)
  })

  it('hides the badge when costUsd is exactly 0 (subscription-billed session)', () => {
    // claude-tui sessions accumulate tokens but never cost — they should
    // get NO badge so the sidebar isn't cluttered.
    render(<Sidebar {...makeProps({ ...baseUsage, inputTokens: 10000, costUsd: 0 })} />)
    expect(screen.queryByTestId('sidebar-cost-badge-sess-1')).not.toBeInTheDocument()
  })

  it('hides the badge when cumulativeUsage is null (no result yet)', () => {
    render(<Sidebar {...makeProps(null)} />)
    expect(screen.queryByTestId('sidebar-cost-badge-sess-1')).not.toBeInTheDocument()
  })

  it('hides the badge when cumulativeUsage is undefined (older server)', () => {
    render(<Sidebar {...makeProps(undefined)} />)
    expect(screen.queryByTestId('sidebar-cost-badge-sess-1')).not.toBeInTheDocument()
  })
})
