/**
 * SidebarCostBadge — the configurable header cost/info badge (#5184, epic #5170).
 *
 * The header badge used to be hard-wired to "<provider-short> $<cost>"
 * (e.g. "SDK $0.2903"). Users liked the badge but wanted control over WHAT
 * it shows, so the content is now driven by a `mode` chosen in Settings and
 * persisted via the connection store (see `costBadgeMode`).
 *
 * The mode union, default, runtime guard, labels, and pure content formatter
 * live in `lib/cost-badge-mode.ts` (a non-React module) so the store layer
 * can import them without pulling this `.tsx` file into the non-UI graph.
 * They're re-exported here so existing component-level imports keep working.
 *
 * This component is pure / presentational: every input arrives via props so
 * the badge is trivially testable and free of store coupling. The host
 * (StatusBar) reads the mode + data from the store and forwards them.
 */
import {
  type CostBadgeContentInput,
  DEFAULT_COST_BADGE_MODE,
  formatCostBadgeContent,
} from '../lib/cost-badge-mode'

// Re-export the mode primitives so existing `from './SidebarCostBadge'`
// imports (store, Settings, tests) continue to resolve.
export {
  type CostBadgeMode,
  type CostBadgeContentInput,
  DEFAULT_COST_BADGE_MODE,
  COST_BADGE_MODES,
  COST_BADGE_MODE_LABELS,
  isCostBadgeMode,
  formatCostBadgeContent,
} from '../lib/cost-badge-mode'

export interface SidebarCostBadgeProps extends CostBadgeContentInput {
  /** Tooltip text — host computes the same tooltip it always did. */
  title?: string
  /** Extra class names appended to the base `cost-badge`. */
  className?: string
}

export function SidebarCostBadge(props: SidebarCostBadgeProps) {
  const { title, className } = props
  const mode = props.mode ?? DEFAULT_COST_BADGE_MODE
  const content = formatCostBadgeContent(props)
  const cls = className ? `cost-badge ${className}` : 'cost-badge'

  return (
    <span
      className={cls}
      data-testid="sidebar-cost-badge"
      data-cost-badge-mode={mode}
      title={title}
      aria-label={title}
    >
      {content}
    </span>
  )
}
