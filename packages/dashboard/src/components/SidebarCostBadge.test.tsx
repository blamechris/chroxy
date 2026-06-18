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
import { Sidebar } from './Sidebar'
// #4123: formatters now live in store-core, not Sidebar.tsx.
import { formatCostBadge, formatCostBreakdown } from '@chroxy/store-core'
// #5184: the configurable header badge component + its pure formatter.
import {
  SidebarCostBadge,
  formatCostBadgeContent,
  isCostBadgeMode,
  COST_BADGE_MODES,
  COST_BADGE_MODE_LABELS,
  DEFAULT_COST_BADGE_MODE,
} from './SidebarCostBadge'

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
  // Locale-agnostic helper — `toLocaleString()` output varies by
  // runtime locale (comma in en-US, period in de-DE, space in fr-FR).
  // Use the current runtime's formatter so the test passes everywhere
  // (#4119 review note).
  const localeNum = (n: number) => n.toLocaleString()

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
    expect(lines[1]).toBe(`Turns billed: ${localeNum(3)}`)
    expect(lines[2]).toBe(`Input tokens: ${localeNum(1234)}`)
    expect(lines[3]).toBe(`Output tokens: ${localeNum(567)}`)
    expect(lines[4]).toBe(`Cache read: ${localeNum(8000)}`)
    expect(lines[5]).toBe(`Cache write: ${localeNum(200)}`)
  })

  it('uses locale formatting for large token counts (delegates to toLocaleString)', () => {
    const breakdown = formatCostBreakdown({
      ...baseUsage,
      inputTokens: 1234567,
    })
    expect(breakdown).toContain(`Input tokens: ${localeNum(1234567)}`)
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
      connectedClients: [], activePrimaryClientId: null,
      onFilterChange: () => {},
      onSessionClick: () => {},
      onResumeSession: () => {},
      onNewSession: () => {},
      onToggle: () => {},
      onContextMenu: () => {},
    }
  }

  it('renders a cost badge when costUsd > 0', () => {
    // Locale-agnostic — derive expected strings via the runtime's own
    // `toLocaleString()` so the test passes under any system locale
    // (#4119 review note).
    const localeNum = (n: number) => n.toLocaleString()
    render(<Sidebar {...makeProps({ ...baseUsage, costUsd: 0.42, inputTokens: 1000, turnsBilled: 2 })} />)
    const badge = screen.getByTestId('sidebar-cost-badge-sess-1')
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).toBe('$0.420')
    const title = badge.getAttribute('title') ?? ''
    expect(title).toMatch(/Total cost: \$0\.4200/)
    expect(title).toContain(`Turns billed: ${localeNum(2)}`)
    expect(title).toContain(`Input tokens: ${localeNum(1000)}`)
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

// #5184: the header badge is now display-mode configurable. These tests pin
// each mode's output, the default, and the defensive fallbacks.
describe('SidebarCostBadge mode union (#5184)', () => {
  it('exposes exactly the five documented modes', () => {
    expect([...COST_BADGE_MODES].sort()).toEqual(
      ['context-pct', 'cost', 'provider-model', 'session-type', 'tokens'],
    )
  })

  it('defaults to cost (#5203: identity moved to the header-meta left group)', () => {
    expect(DEFAULT_COST_BADGE_MODE).toBe('cost')
  })

  it('has a human-readable label for every mode', () => {
    for (const mode of COST_BADGE_MODES) {
      expect(typeof COST_BADGE_MODE_LABELS[mode]).toBe('string')
      expect(COST_BADGE_MODE_LABELS[mode].length).toBeGreaterThan(0)
    }
  })

  it('isCostBadgeMode accepts valid modes and rejects junk', () => {
    expect(isCostBadgeMode('cost')).toBe(true)
    expect(isCostBadgeMode('provider-model')).toBe(true)
    expect(isCostBadgeMode('nonsense')).toBe(false)
    expect(isCostBadgeMode('')).toBe(false)
    expect(isCostBadgeMode(undefined)).toBe(false)
    expect(isCostBadgeMode(42)).toBe(false)
  })

  it('isCostBadgeMode rejects inherited Object.prototype keys (no prototype pollution)', () => {
    // The guard must use hasOwnProperty, NOT `in` — otherwise a corrupt
    // localStorage value of `toString` / `constructor` / `__proto__` would
    // pass and get stored as a fake CostBadgeMode.
    expect(isCostBadgeMode('toString')).toBe(false)
    expect(isCostBadgeMode('constructor')).toBe(false)
    expect(isCostBadgeMode('hasOwnProperty')).toBe(false)
    expect(isCostBadgeMode('__proto__')).toBe(false)
  })
})

describe('formatCostBadgeContent per mode (#5184)', () => {
  const full = {
    cost: 0.2903,
    provider: 'claude-sdk',
    model: 'Sonnet 4.6',
    inputTokens: 25000,
    outputTokens: 5000,
    contextPercent: 45.4,
  }

  it('provider-model (default): "Claude Code (SDK) · Sonnet 4.6"', () => {
    expect(formatCostBadgeContent({ ...full, mode: 'provider-model' }))
      .toBe('Claude Code (SDK) · Sonnet 4.6')
  })

  it('provider-model falls back to provider label alone when no model', () => {
    expect(formatCostBadgeContent({ ...full, mode: 'provider-model', model: null }))
      .toBe('Claude Code (SDK)')
  })

  it('defaults to cost when mode is omitted (#5203)', () => {
    expect(formatCostBadgeContent(full)).toBe('$0.2903')
  })

  it('cost: legacy "$0.2903" 4-decimal form', () => {
    expect(formatCostBadgeContent({ ...full, mode: 'cost' })).toBe('$0.2903')
  })

  it('tokens: compact input+output total with a tokens suffix', () => {
    expect(formatCostBadgeContent({ ...full, mode: 'tokens' })).toBe('30.0k tokens')
  })

  it('context-pct: rounded percent of the context window', () => {
    expect(formatCostBadgeContent({ ...full, mode: 'context-pct' })).toBe('45%')
  })

  it('session-type: the provider short tag', () => {
    expect(formatCostBadgeContent({ ...full, mode: 'session-type' })).toBe('SDK')
    expect(formatCostBadgeContent({ ...full, mode: 'session-type', provider: 'claude-cli' }))
      .toBe('CLI')
  })

  it('renders an NBSP placeholder when the mode datum is missing (no layout shift)', () => {
    const NBSP = ' '
    expect(formatCostBadgeContent({ mode: 'cost', cost: null })).toBe(NBSP)
    expect(formatCostBadgeContent({ mode: 'tokens', inputTokens: 0, outputTokens: 0 })).toBe(NBSP)
    expect(formatCostBadgeContent({ mode: 'context-pct', contextPercent: null })).toBe(NBSP)
    expect(formatCostBadgeContent({ mode: 'session-type', provider: null })).toBe(NBSP)
  })

  it('cost guards against non-finite input', () => {
    const NBSP = ' '
    expect(formatCostBadgeContent({ mode: 'cost', cost: NaN })).toBe(NBSP)
    expect(formatCostBadgeContent({ mode: 'cost', cost: Infinity })).toBe(NBSP)
  })
})

describe('SidebarCostBadge render (#5184)', () => {
  it('renders the mode content and stamps data-cost-badge-mode', () => {
    render(
      <SidebarCostBadge
        mode="cost"
        cost={0.2903}
        provider="claude-sdk"
        model="Sonnet 4.6"
        title="Total session cost"
      />,
    )
    const badge = screen.getByTestId('sidebar-cost-badge')
    expect(badge.textContent).toBe('$0.2903')
    expect(badge.getAttribute('data-cost-badge-mode')).toBe('cost')
    expect(badge.getAttribute('title')).toBe('Total session cost')
    expect(badge.getAttribute('aria-label')).toBe('Total session cost')
  })

  it('defaults to cost when no mode prop is given (#5203)', () => {
    render(<SidebarCostBadge provider="claude-sdk" model="Sonnet 4.6" cost={0.2903} />)
    const badge = screen.getByTestId('sidebar-cost-badge')
    expect(badge.getAttribute('data-cost-badge-mode')).toBe('cost')
    expect(badge.textContent).toBe('$0.2903')
  })

  it('appends an extra className alongside the base cost-badge class', () => {
    const { container } = render(<SidebarCostBadge mode="session-type" provider="claude-cli" className="status-cost" />)
    const el = container.querySelector('.cost-badge')
    expect(el).not.toBeNull()
    expect(el!.className).toContain('status-cost')
    expect(el!.textContent).toBe('CLI')
  })
})
