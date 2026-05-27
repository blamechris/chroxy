/**
 * SidebarTokenView (#4303 v0) — first occupant of the sidebar panel slot.
 *
 * v0 scope per the issue: read existing in-memory `cumulativeUsage` from
 * the active session-states snapshot and render:
 *   - Today's aggregate totals (input + output + total)
 *   - Per-provider breakdown
 *   - Per-session list (sortable later; ordered by tokens-desc for v0)
 *   - TUI rows surface "—" with a tooltip (decision #1)
 *
 * Deferred to PR 2/3:
 *   - 7d / 30d aggregates and time-series sparkline (needs usage-history.json)
 *   - API-equivalent-cost toggle for subscription paths (decision #3)
 *   - Per-tool breakdown for BYOK
 *   - Cache-hit ratio (the data is on CumulativeUsage but UI is in PR 3)
 *   - Collapsed-panel header live metric (renderer scaffold already in
 *     SidebarPanelSlot)
 *
 * No new server-side plumbing needed for v0 — reads SessionInfo entries
 * (which carry `cumulativeUsage` from session_list snapshots + the
 * `session_usage` event stream).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CumulativeUsage, SessionInfo } from '@chroxy/store-core'
import { formatCostBadge, getProviderLabel } from '@chroxy/store-core'

// Subscription/PTY providers that never emit token usage today (decision #1).
// claude-tui is the only one in this set right now; if upstream adds usage
// exposure we drop it from here. claude-cli DOES emit usage even on
// subscription via stream-json's `result.usage`, so it is NOT in this set.
const UNTRACKED_PROVIDERS = new Set(['claude-tui'])

export interface ProviderTotals {
  provider: string
  /** True when this provider doesn't surface token data today (decision #1). */
  untracked: boolean
  totals: CumulativeUsage
  sessionCount: number
}

export interface AggregateTotals {
  /** Sum across ALL providers that surface tokens (untracked excluded). */
  totals: CumulativeUsage
  byProvider: ProviderTotals[]
  /** Total session count across all providers (including untracked). */
  totalSessions: number
  /** Whether any untracked-provider session is present (used for UI tooltip). */
  hasUntracked: boolean
}

const EMPTY_USAGE: CumulativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turnsBilled: 0,
}

function addUsage(a: CumulativeUsage, b: CumulativeUsage): CumulativeUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
    turnsBilled: a.turnsBilled + b.turnsBilled,
  }
}

/**
 * Aggregate `cumulativeUsage` across sessions, grouped by provider.
 *
 * Untracked providers (currently just claude-tui) are excluded from the
 * cross-provider totals but their session count is retained in
 * `totalSessions`. Each provider row in `byProvider` carries an
 * `untracked` flag so the renderer can show "—" instead of zeros.
 *
 * Pure / no React deps so it's unit-testable.
 */
export function aggregateUsage(sessions: SessionInfo[]): AggregateTotals {
  const byProviderMap = new Map<string, ProviderTotals>()
  let crossTotal = EMPTY_USAGE
  let totalSessions = 0
  let hasUntracked = false

  for (const session of sessions) {
    totalSessions += 1
    const provider = session.provider ?? 'unknown'
    const untracked = UNTRACKED_PROVIDERS.has(provider)
    if (untracked) hasUntracked = true

    const usage = session.cumulativeUsage ?? EMPTY_USAGE

    if (!byProviderMap.has(provider)) {
      byProviderMap.set(provider, {
        provider,
        untracked,
        totals: EMPTY_USAGE,
        sessionCount: 0,
      })
    }
    const entry = byProviderMap.get(provider)!
    entry.totals = addUsage(entry.totals, usage)
    entry.sessionCount += 1

    // Cross-provider totals exclude untracked providers — the value of "—" is
    // that it doesn't pretend to be a number, so untracked sessions should not
    // pull the overall total toward zero.
    if (!untracked) {
      crossTotal = addUsage(crossTotal, usage)
    }
  }

  // Sort by total tokens desc, untracked rows last (they're displayed but
  // shouldn't dominate the visual order since they're informational).
  const byProvider = Array.from(byProviderMap.values()).sort((a, b) => {
    if (a.untracked !== b.untracked) return a.untracked ? 1 : -1
    const aTotal = a.totals.inputTokens + a.totals.outputTokens
    const bTotal = b.totals.inputTokens + b.totals.outputTokens
    return bTotal - aTotal
  })

  return {
    totals: crossTotal,
    byProvider,
    totalSessions,
    hasUntracked,
  }
}

/**
 * Format integer tokens with K/M abbreviation.
 *
 *   formatTokenCount(0)         → "0"
 *   formatTokenCount(999)       → "999"
 *   formatTokenCount(1234)      → "1.2K"
 *   formatTokenCount(999_999)   → "1.0M"   ← #4304 review: cross to M when K would round to 1000
 *   formatTokenCount(1_500_000) → "1.50M"
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  // Roll over to "M" when the K-rounded value would be ≥ 1000 (i.e. when
  // n ≥ 999500 rounds to 1000.0K). Avoid the "1000.0K" visual nonsense
  // that the simple < 1_000_000 cutoff produced.
  if (n < 999_500) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/**
 * #4362: touch-friendly disclosure for explanatory tooltips.
 *
 * The native `title=` attribute renders a hover-only tooltip that doesn't
 * fire on tap, leaving touch users (iPad dashboard, mobile WebView) without
 * a way to surface the explanation. This component renders a small button
 * trigger that:
 *   - Toggles the popover on click/tap (the touch-friendly affordance)
 *   - Opens on mouseenter / closes on mouseleave (preserves hover UX for
 *     pointer users; matches the pre-#4362 desktop behavior)
 *   - Closes on Escape (keyboard dismissal)
 *   - Closes on click outside (standard popover dismissal)
 *   - Carries `aria-label` for screen readers and `aria-expanded` for state
 *
 * The popover content is rendered inline as a sibling rather than via a
 * portal — the sidebar panel is already a flex column and the explanatory
 * text is short, so we don't need positioning trickery.
 */
interface InfoDisclosureProps {
  /** Marker text shown inside the trigger (e.g. "ⓘ" or "—"). */
  triggerText: string
  /** Accessible name for the trigger button. */
  ariaLabel: string
  /** Class name applied to the trigger button. */
  triggerClassName: string
  /** Test id base — popover gets `${testIdBase}-popover`. */
  testIdBase: string
  /** Explanation content. Plain text or a node. */
  children: React.ReactNode
}

function InfoDisclosure({
  triggerText,
  ariaLabel,
  triggerClassName,
  testIdBase,
  children,
}: InfoDisclosureProps) {
  const [open, setOpen] = useState(false)
  const popoverId = useId()
  const containerRef = useRef<HTMLSpanElement | null>(null)
  // Track whether the most recent open was via hover so a subsequent tap
  // on the trigger toggles correctly without flickering on touch screens
  // that synthesize mouseenter just before click.
  const hoveredRef = useRef(false)

  // Click-outside + Escape handlers. Only attached when the popover is open
  // so we don't leak listeners on every mount of the sidebar.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (containerRef.current && containerRef.current.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [open])

  return (
    <span className="sidebar-token-view-disclosure" ref={containerRef}>
      <button
        type="button"
        className={triggerClassName}
        data-testid={testIdBase}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => {
          // If hover already opened it, a click should close (toggle).
          // Otherwise a tap opens it.
          setOpen((prev) => !prev)
          hoveredRef.current = false
        }}
        onMouseEnter={() => {
          hoveredRef.current = true
          setOpen(true)
        }}
        onMouseLeave={() => {
          // Only auto-close on mouseleave if it was opened via hover —
          // a click-opened popover should stay until explicit dismissal.
          if (hoveredRef.current) {
            setOpen(false)
            hoveredRef.current = false
          }
        }}
      >
        {triggerText}
      </button>
      {open && (
        <span
          id={popoverId}
          className="sidebar-token-view-popover"
          data-testid={`${testIdBase}-popover`}
          role="tooltip"
        >
          {children}
        </span>
      )}
    </span>
  )
}

const COST_INFO_EXPLANATION =
  // #4348: the optical illusion is that visible tokens ÷ cost yields a rate
  // nowhere near Anthropic's published pricing. Spell out the gap between
  // visible and billed tokens here.
  'Token counts above are user-visible (new content per turn). ' +
  'BYOK cost is computed from billed tokens, which include the ' +
  'full conversation context re-sent on every API call — so ' +
  'long agentic sessions bill far more input than the visible ' +
  'count suggests. Pricing follows Anthropic’s published rates.'

const TUI_UNTRACKED_EXPLANATION =
  'Token count not exposed by claude TUI (PTY-only interface)'

export interface SidebarTokenViewProps {
  /** All known sessions across active + resumable + background. */
  sessions: SessionInfo[]
}

export function SidebarTokenView({ sessions }: SidebarTokenViewProps) {
  const agg = useMemo(() => aggregateUsage(sessions), [sessions])
  const totalTokens = agg.totals.inputTokens + agg.totals.outputTokens

  return (
    <div className="sidebar-token-view" data-testid="sidebar-token-view">
      <div className="sidebar-token-view-aggregate" data-testid="sidebar-token-view-aggregate">
        <div className="sidebar-token-view-aggregate-row">
          <span className="sidebar-token-view-label">Today</span>
          <span
            className="sidebar-token-view-value"
            data-testid="sidebar-token-view-today-total"
          >
            {formatTokenCount(totalTokens)} tokens
          </span>
        </div>
        <div className="sidebar-token-view-aggregate-row">
          <span className="sidebar-token-view-label">Input · Output</span>
          <span className="sidebar-token-view-value-secondary">
            {formatTokenCount(agg.totals.inputTokens)} · {formatTokenCount(agg.totals.outputTokens)}
          </span>
        </div>
        {agg.totals.costUsd > 0 && (
          <div className="sidebar-token-view-aggregate-row">
            <span className="sidebar-token-view-label">
              Cost (BYOK){' '}
              <InfoDisclosure
                triggerText={'ⓘ'}
                ariaLabel="Why doesn't this cost match the visible token count?"
                triggerClassName="sidebar-token-view-info"
                testIdBase="sidebar-token-view-cost-info"
              >
                {COST_INFO_EXPLANATION}
              </InfoDisclosure>
            </span>
            <span className="sidebar-token-view-value-secondary">
              {formatCostBadge(agg.totals.costUsd)}
            </span>
          </div>
        )}
      </div>

      <div className="sidebar-token-view-section" data-testid="sidebar-token-view-by-provider">
        <div className="sidebar-token-view-section-header">By provider</div>
        {agg.byProvider.length === 0 ? (
          <div className="sidebar-token-view-empty" data-testid="sidebar-token-view-empty">
            No sessions yet
          </div>
        ) : (
          <ul className="sidebar-token-view-provider-list">
            {agg.byProvider.map((row) => {
              const label = getProviderLabel(row.provider)
              const tokens = row.totals.inputTokens + row.totals.outputTokens
              return (
                <li
                  key={row.provider}
                  className="sidebar-token-view-provider-row"
                  data-testid={`sidebar-token-view-provider-${row.provider}`}
                >
                  <span className="sidebar-token-view-provider-label">{label}</span>
                  {row.untracked ? (
                    <InfoDisclosure
                      triggerText="—"
                      ariaLabel={`Why does ${label} not show a token count?`}
                      triggerClassName="sidebar-token-view-provider-untracked"
                      testIdBase={`sidebar-token-view-provider-${row.provider}-untracked`}
                    >
                      {TUI_UNTRACKED_EXPLANATION}
                    </InfoDisclosure>
                  ) : (
                    <span className="sidebar-token-view-provider-tokens">
                      {formatTokenCount(tokens)}
                      {row.totals.costUsd > 0 && (
                        <span className="sidebar-token-view-provider-cost">
                          {' '}({formatCostBadge(row.totals.costUsd)})
                        </span>
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Collapsed-panel header metric for the token view (decision #4).
 * Exposed so the parent registering the view can wire this as
 * `view.collapsedHeaderMetric` without redoing the aggregation.
 */
export function tokenViewCollapsedMetric(sessions: SessionInfo[]): string {
  const agg = aggregateUsage(sessions)
  const totalTokens = agg.totals.inputTokens + agg.totals.outputTokens
  return `${formatTokenCount(totalTokens)} tokens`
}
