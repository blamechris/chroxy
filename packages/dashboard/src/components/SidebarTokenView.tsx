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
import type { BillingClass, CumulativeUsage, SessionInfo } from '@chroxy/store-core'
import { formatCostBadge, formatTokens, getProviderLabel } from '@chroxy/store-core'
import type { MonthlyBudgetState } from '../store/types'

// Subscription/PTY providers that never emit token usage today (decision #1).
// claude-tui is the only one in this set right now; if upstream adds usage
// exposure we drop it from here. claude-cli DOES emit usage even on
// subscription via stream-json's `result.usage`, so it is NOT in this set.
const UNTRACKED_PROVIDERS = new Set(['claude-tui'])

// #5630/#5629: per-billing-class cost-row copy + tooltip. The label/value
// rendering is class-specific:
//   - api-key            → "Cost (BYOK)" with a real dollar figure
//   - programmatic-credit → "Credit spend" with a real dollar figure
//   - subscription       → "Included (subscription)" — NO dollar figure (the
//                          flat subscription has no per-turn dollar charge)
const BILLING_CLASS_LABEL: Record<BillingClass, string> = {
  'api-key': 'Cost (BYOK)',
  'programmatic-credit': 'Credit spend',
  subscription: 'Included (subscription)',
}

const BILLING_CLASS_TOOLTIP: Record<BillingClass, string> = {
  'api-key':
    'Billed per token against your own API key. Cost is computed from billed ' +
    'tokens, which include the full conversation context re-sent every call — ' +
    'so long agentic sessions bill far more input than the visible count ' +
    'suggests. Pricing follows the provider’s published rates.',
  'programmatic-credit':
    'Drawn from Anthropic’s monthly programmatic-credit pool (metered credits, ' +
    'effective 2026-06-15). The dollar figure is the metered credit spend for ' +
    'these turns.',
  subscription:
    'Included in your flat Claude subscription — no per-turn dollar charge. ' +
    'Token counts are shown above; there is no metered cost to display.',
}

// Render order for the per-class aggregate cost rows. Priced classes first so
// the dollar figures lead; the no-dollar subscription chip trails.
const BILLING_CLASS_ORDER: BillingClass[] = ['api-key', 'programmatic-credit', 'subscription']

// #5630: when a session predates the server's billingClass field, derive a
// best-effort class from the provider id so the cost row still labels
// correctly. Mirrors the server's billingClassForProvider buckets but cannot
// see the era flip or the explicit-key refinement — it's a fallback only.
const SUBSCRIPTION_PROVIDERS = new Set(['claude-tui', 'claude-channel'])
const API_KEY_PROVIDERS = new Set([
  'claude-byok',
  'docker-byok',
  'codex',
  'gemini',
  'deepseek',
  'ollama',
])
function deriveBillingClass(session: SessionInfo): BillingClass {
  if (session.billingClass) return session.billingClass
  const provider = session.provider ?? 'unknown'
  if (SUBSCRIPTION_PROVIDERS.has(provider)) return 'subscription'
  if (API_KEY_PROVIDERS.has(provider)) return 'api-key'
  // claude-cli/sdk + docker-cli/sdk + any unknown: without the server field we
  // can't know the era, so default to api-key (the priced class) — a dollar
  // figure is the safer default than hiding real spend behind a subscription
  // chip. The server populates billingClass for live sessions, so this only
  // bites pre-#5630 reconnect snapshots.
  return 'api-key'
}

export interface ProviderTotals {
  provider: string
  /** True when this provider doesn't surface token data today (decision #1). */
  untracked: boolean
  totals: CumulativeUsage
  sessionCount: number
  /** #5630: the billing class for this provider's rows (cost labelling). */
  billingClass: BillingClass
}

/** #5630: per-billing-class cost subtotal for the aggregate cost rows. */
export interface BillingClassTotals {
  billingClass: BillingClass
  /** Summed cost across tracked sessions in this class. */
  costUsd: number
  /** Number of (tracked) sessions in this class — used to show/hide the row. */
  sessionCount: number
}

export interface AggregateTotals {
  /** Sum across ALL providers that surface tokens (untracked excluded). */
  totals: CumulativeUsage
  byProvider: ProviderTotals[]
  /**
   * #5630: cost subtotals grouped by billing class. Each entry drives one
   * aggregate cost row: a dollar figure for api-key / programmatic-credit, the
   * no-dollar "Included (subscription)" chip for subscription.
   */
  byBillingClass: BillingClassTotals[]
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
 * Cache-hit ratio = cacheRead / (input + cacheRead + cacheCreation).
 *
 * "Input" on the wire is split three ways: brand-new input tokens, tokens
 * read from the prompt cache (cacheRead), and tokens written into the cache
 * (cacheCreation). The ratio of cacheRead to the total input surface is the
 * visible signal of prompt-caching effectiveness (decision in #4303 token
 * view). Returns null when there's no input surface at all so the renderer
 * can hide the row rather than show a meaningless 0%.
 */
export function cacheHitRatio(usage: CumulativeUsage): number | null {
  const denom = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  if (denom <= 0) return null
  return usage.cacheReadTokens / denom
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
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
  // #5630: per-class cost subtotal. Subscription sessions (including untracked
  // claude-tui) are tallied here so the no-dollar "Included (subscription)"
  // chip appears whenever such a session exists, even with zero cost.
  const byClassMap = new Map<BillingClass, BillingClassTotals>()
  let crossTotal = EMPTY_USAGE
  let totalSessions = 0
  let hasUntracked = false

  for (const session of sessions) {
    totalSessions += 1
    const provider = session.provider ?? 'unknown'
    const untracked = UNTRACKED_PROVIDERS.has(provider)
    if (untracked) hasUntracked = true
    const billingClass = deriveBillingClass(session)

    const usage = session.cumulativeUsage ?? EMPTY_USAGE

    if (!byProviderMap.has(provider)) {
      byProviderMap.set(provider, {
        provider,
        untracked,
        totals: EMPTY_USAGE,
        sessionCount: 0,
        billingClass,
      })
    }
    const entry = byProviderMap.get(provider)!
    entry.totals = addUsage(entry.totals, usage)
    entry.sessionCount += 1

    // Per-class cost subtotal. Every session (tracked or not) contributes its
    // session count so a subscription-only set still shows the chip; cost is
    // summed verbatim (subscription sessions report 0, which is correct — the
    // chip never shows a dollar figure anyway).
    if (!byClassMap.has(billingClass)) {
      byClassMap.set(billingClass, { billingClass, costUsd: 0, sessionCount: 0 })
    }
    const classEntry = byClassMap.get(billingClass)!
    classEntry.costUsd += usage.costUsd
    classEntry.sessionCount += 1

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

  // Stable class order: priced classes first, subscription chip last.
  const byBillingClass = BILLING_CLASS_ORDER
    .map((bc) => byClassMap.get(bc))
    .filter((x): x is BillingClassTotals => x !== undefined)

  return {
    totals: crossTotal,
    byProvider,
    byBillingClass,
    totalSessions,
    hasUntracked,
  }
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
  // #4539 — keep a handle on the disclosure button so Escape dismiss can
  // return focus to the invoker per WAI-ARIA APG disclosure guidance.
  // Mirrors the ActivityIndicator fix from PR #4525.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Track whether the popover was opened via hover (mouse) so a subsequent
  // mouseleave can close it. Click-opened popovers stay until explicit
  // dismissal (Escape, click-outside, or second click).
  const openedByHoverRef = useRef(false)
  // Touch interactions on mobile browsers synthesize `mouseenter` -> `click`
  // on a single tap. If we treat the synthesized `mouseenter` as a hover-open
  // we'd flip-flop on the very tap that's supposed to surface the popover.
  // Pointer Events expose `pointerType` so we can gate hover-open to genuine
  // mouse pointers and let the click handler own the toggle on touch.
  const pointerTypeRef = useRef<string>('mouse')

  // Click-outside + Escape handlers. Only attached when the popover is open
  // so we don't leak listeners on every mount of the sidebar.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        // #4539 — WAI-ARIA APG: a disclosure-triggered popover dismissed
        // via Escape should return focus to the invoker so keyboard users
        // don't get parked on document.body and lose their place in the
        // tab order. Mirrors PR #4525 which did the same for
        // ActivityIndicator.
        triggerRef.current?.focus()
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (containerRef.current && containerRef.current.contains(target)) return
      // #4539 — outside-click dismiss intentionally does NOT restore focus
      // to the disclosure trigger: the user explicitly clicked elsewhere,
      // so stealing focus back would fight their pointer intent. Escape
      // (above) is the keyboard-only path that needs focus restoration
      // per WAI-ARIA APG disclosure guidance.
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    // pointerdown covers both mouse and touch click-outside in one listener.
    // Tests still use fireEvent.mouseDown which dispatches a MouseEvent that
    // browsers also fire alongside pointerdown — so we listen to mousedown
    // as well to stay compatible with the jsdom test harness.
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('mousedown', onPointerDown as EventListener)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('mousedown', onPointerDown as EventListener)
    }
  }, [open])

  return (
    <span className="sidebar-token-view-disclosure" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={triggerClassName}
        data-testid={testIdBase}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onPointerDown={(e) => {
          // Record the pointer type so the upcoming click handler can decide
          // whether to honor a hover-open it just triggered. Touch synthesizes
          // mouseenter+click on the same tap, which would otherwise flip the
          // popover closed immediately on touch devices (the bug we're
          // fixing).
          pointerTypeRef.current = e.pointerType || 'mouse'
        }}
        onClick={() => {
          // On touch, the synthetic mouseenter may have just opened the
          // popover. Ignore that and treat the click as the "open" action.
          if (pointerTypeRef.current === 'touch' && openedByHoverRef.current) {
            openedByHoverRef.current = false
            setOpen(true)
            return
          }
          setOpen((prev) => !prev)
          openedByHoverRef.current = false
        }}
        onMouseEnter={() => {
          openedByHoverRef.current = true
          setOpen(true)
        }}
        onMouseLeave={() => {
          // Only auto-close on mouseleave if it was opened via hover —
          // a click-opened popover should stay until explicit dismissal.
          if (openedByHoverRef.current) {
            setOpen(false)
            openedByHoverRef.current = false
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

// #5630: the legacy single "Cost (BYOK)" explanation was replaced by the
// per-billing-class BILLING_CLASS_TOOLTIP map above (the api-key tooltip
// carries the same visible-vs-billed-tokens explanation).

const TUI_UNTRACKED_EXPLANATION =
  'Token count not exposed by claude TUI (PTY-only interface)'

export interface SidebarTokenViewProps {
  /** All known sessions across active + resumable + background. */
  sessions: SessionInfo[]
  /** Currently-active session id, so its per-session row can be highlighted. */
  activeSessionId?: string | null
  /**
   * Click-to-activate parity with the sidebar tree (decision in #4303): a
   * click on a per-session row activates that session. Omitting it renders
   * the rows as static (no click affordance).
   */
  onSessionClick?: (sessionId: string) => void
  /**
   * #5665 — machine-wide monthly programmatic-credit meter snapshot. When
   * present (and there's a cap or some spend), a "Credit spend (chroxy-observed)"
   * meter renders. Omitted/null → no meter (pre-era, pre-#5665 server, or no
   * programmatic-credit activity).
   */
  monthlyBudget?: MonthlyBudgetState | null
}

export function SidebarTokenView({
  sessions,
  activeSessionId = null,
  onSessionClick,
  monthlyBudget = null,
}: SidebarTokenViewProps) {
  const agg = useMemo(() => aggregateUsage(sessions), [sessions])
  const totalTokens = agg.totals.inputTokens + agg.totals.outputTokens
  const hitRatio = cacheHitRatio(agg.totals)

  // Per-session rows: tracked providers only (untracked providers have no
  // tokens to show), sorted by total tokens desc. The active session is
  // highlighted and floated to the top so the user's current context is
  // always visible without scrolling.
  const sessionRows = useMemo(() => {
    return sessions
      .filter((s) => !UNTRACKED_PROVIDERS.has(s.provider ?? 'unknown'))
      .map((s) => {
        const usage = s.cumulativeUsage ?? EMPTY_USAGE
        return {
          session: s,
          tokens: usage.inputTokens + usage.outputTokens,
          costUsd: usage.costUsd,
          // #5630: per-session billing class for the class-aware cost label.
          billingClass: deriveBillingClass(s),
        }
      })
      .sort((a, b) => {
        const aActive = a.session.sessionId === activeSessionId
        const bActive = b.session.sessionId === activeSessionId
        if (aActive !== bActive) return aActive ? -1 : 1
        return b.tokens - a.tokens
      })
  }, [sessions, activeSessionId])

  return (
    <div className="sidebar-token-view" data-testid="sidebar-token-view">
      <div className="sidebar-token-view-aggregate" data-testid="sidebar-token-view-aggregate">
        <div className="sidebar-token-view-aggregate-row">
          <span className="sidebar-token-view-label">Today</span>
          <span
            className="sidebar-token-view-value"
            data-testid="sidebar-token-view-today-total"
          >
            {formatTokens(totalTokens)} tokens
          </span>
        </div>
        <div className="sidebar-token-view-aggregate-row">
          <span className="sidebar-token-view-label">Input · Output</span>
          <span className="sidebar-token-view-value-secondary">
            {formatTokens(agg.totals.inputTokens)} · {formatTokens(agg.totals.outputTokens)}
          </span>
        </div>
        {hitRatio !== null && (
          <div className="sidebar-token-view-aggregate-row">
            <span className="sidebar-token-view-label">Cache hit</span>
            <span
              className="sidebar-token-view-value-secondary"
              data-testid="sidebar-token-view-cache-hit"
            >
              {formatPercent(hitRatio)}
            </span>
          </div>
        )}
        {/* #5630: one aggregate cost row PER billing class. Priced classes
            (api-key / programmatic-credit) show a dollar figure only when
            there's spend; the subscription class shows the no-dollar
            "Included (subscription)" chip whenever a subscription session
            exists, even at $0 (a flat subscription has no per-turn charge). */}
        {agg.byBillingClass.map((cls) => {
          const isSubscription = cls.billingClass === 'subscription'
          // Priced classes hide their row when there's no spend yet; the
          // subscription chip shows as long as such a session exists.
          if (!isSubscription && cls.costUsd <= 0) return null
          const label = BILLING_CLASS_LABEL[cls.billingClass]
          return (
            <div
              key={cls.billingClass}
              className="sidebar-token-view-aggregate-row"
              data-testid={`sidebar-token-view-cost-${cls.billingClass}`}
            >
              <span className="sidebar-token-view-label">
                {label}{' '}
                <InfoDisclosure
                  triggerText={'ⓘ'}
                  ariaLabel={`What does "${label}" mean?`}
                  triggerClassName="sidebar-token-view-info"
                  testIdBase={`sidebar-token-view-cost-info-${cls.billingClass}`}
                >
                  {BILLING_CLASS_TOOLTIP[cls.billingClass]}
                </InfoDisclosure>
              </span>
              {isSubscription ? (
                <span
                  className="sidebar-token-view-value-secondary sidebar-token-view-included-chip"
                  data-testid={`sidebar-token-view-cost-value-${cls.billingClass}`}
                >
                  Included
                </span>
              ) : (
                <span
                  className="sidebar-token-view-value-secondary"
                  data-testid={`sidebar-token-view-cost-value-${cls.billingClass}`}
                >
                  {formatCostBadge(cls.costUsd)}
                </span>
              )}
            </div>
          )
        })}

        {/* #5665 — machine-wide monthly programmatic-credit meter. Shows once
            there's a configured cap or some observed spend this month. */}
        {monthlyBudget && (monthlyBudget.budgetUsd != null || monthlyBudget.spentUsd > 0) && (() => {
          const { spentUsd, budgetUsd, percent, warning, exceeded } = monthlyBudget
          const clampedPercent = percent == null ? null : Math.min(100, Math.max(0, percent))
          const state = exceeded ? 'exceeded' : warning ? 'warning' : 'ok'
          return (
            <div
              className={`sidebar-token-view-credit-meter sidebar-token-view-credit-meter-${state}`}
              data-testid="sidebar-token-view-credit-meter"
              data-meter-state={state}
            >
              <div className="sidebar-token-view-aggregate-row">
                <span className="sidebar-token-view-label">
                  Credit spend{' '}
                  <InfoDisclosure
                    triggerText={'ⓘ'}
                    ariaLabel="What does the credit spend meter count?"
                    triggerClassName="sidebar-token-view-info"
                    testIdBase="sidebar-token-view-credit-meter-info"
                  >
                    Chroxy-observed programmatic-credit spend (claude -p / SDK) this UTC month — only sessions THIS daemon ran. Not your full Anthropic credit-pool balance; sessions on other machines or outside chroxy aren't counted.
                  </InfoDisclosure>
                </span>
                <span
                  className="sidebar-token-view-value-secondary"
                  data-testid="sidebar-token-view-credit-meter-value"
                >
                  {budgetUsd != null
                    ? `${formatCostBadge(spentUsd)} / ${formatCostBadge(budgetUsd)}${clampedPercent != null ? ` · ${Math.round(clampedPercent)}%` : ''}`
                    : `${formatCostBadge(spentUsd)} this month`}
                </span>
              </div>
              {budgetUsd != null && clampedPercent != null && (
                <div
                  className="sidebar-token-view-credit-bar"
                  role="progressbar"
                  aria-valuenow={Math.round(clampedPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Monthly credit spend"
                >
                  <div
                    className="sidebar-token-view-credit-bar-fill"
                    data-testid="sidebar-token-view-credit-bar-fill"
                    style={{ width: `${clampedPercent}%` }}
                  />
                </div>
              )}
            </div>
          )
        })()}
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
              // #5630: label the cost suffix by billing class — a dollar for
              // priced classes, "Included" for subscription (no dollar figure).
              const isSubscription = row.billingClass === 'subscription'
              return (
                <li
                  key={row.provider}
                  className="sidebar-token-view-provider-row"
                  data-testid={`sidebar-token-view-provider-${row.provider}`}
                  data-billing-class={row.billingClass}
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
                      {formatTokens(tokens)}
                      {isSubscription ? (
                        <span className="sidebar-token-view-provider-cost sidebar-token-view-included-chip">
                          {' '}(Included)
                        </span>
                      ) : (
                        row.totals.costUsd > 0 && (
                          <span className="sidebar-token-view-provider-cost">
                            {' '}({formatCostBadge(row.totals.costUsd)})
                          </span>
                        )
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {sessionRows.length > 0 && (
        <div className="sidebar-token-view-section" data-testid="sidebar-token-view-by-session">
          <div className="sidebar-token-view-section-header">By session</div>
          <ul className="sidebar-token-view-session-list">
            {sessionRows.map(({ session, tokens, costUsd, billingClass }) => {
              const isActive = session.sessionId === activeSessionId
              const isSubscription = billingClass === 'subscription'
              const tokensLabel = (
                <span className="sidebar-token-view-session-tokens" data-billing-class={billingClass}>
                  {formatTokens(tokens)}
                  {isSubscription ? (
                    <span className="sidebar-token-view-provider-cost sidebar-token-view-included-chip">
                      {' '}(Included)
                    </span>
                  ) : (
                    costUsd > 0 && (
                      <span className="sidebar-token-view-provider-cost">
                        {' '}({formatCostBadge(costUsd)})
                      </span>
                    )
                  )}
                </span>
              )
              const rowClass = `sidebar-token-view-session-row${isActive ? ' active' : ''}`
              const testId = `sidebar-token-view-session-${session.sessionId}`
              // Click-to-activate parity with the sidebar tree (#4303). When no
              // handler is supplied, render a static row instead of a button so
              // we don't advertise an affordance that does nothing.
              if (onSessionClick) {
                return (
                  <li key={session.sessionId}>
                    <button
                      type="button"
                      className={rowClass}
                      data-testid={testId}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => onSessionClick(session.sessionId)}
                    >
                      <span className="sidebar-token-view-session-name">{session.name}</span>
                      {tokensLabel}
                    </button>
                  </li>
                )
              }
              return (
                <li
                  key={session.sessionId}
                  className={rowClass}
                  data-testid={testId}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <span className="sidebar-token-view-session-name">{session.name}</span>
                  {tokensLabel}
                </li>
              )
            })}
          </ul>
        </div>
      )}
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
  return `${formatTokens(totalTokens)} tokens`
}
