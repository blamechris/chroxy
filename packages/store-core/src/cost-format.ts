/**
 * Shared cost-formatting helpers (#4123).
 *
 * Both the dashboard's sidebar badge (#4073) and the mobile session-
 * header badge (#4074) format the same `cumulativeUsage.costUsd` value
 * the same way. Keeping the implementation in one place avoids drift —
 * if the dashboard's badge ever showed `$0.07` while the app showed
 * `$0.070`, users would think the two surfaces disagreed on cost.
 *
 * Pure functions with no DOM/RN dependencies — safe to import from
 * either consumer.
 */

import type { CumulativeUsage } from './types'

/**
 * Format a USD value for the cost badge. Three tiers of fixed-decimal
 * precision based on magnitude — sub-dollar accuracy matters for spotting
 * whether a session ran one tiny test or dozens of expensive turns; at
 * dollar scale, fractional cents are noise.
 *
 *   `< $0.01`  → 4 decimals (`$0.0023`) — very small turns stay readable
 *   `$0.01–$1` → 3 decimals (`$0.070`, `$0.420`) — sub-dollar accuracy
 *   `>= $1`    → 2 decimals (`$1.23`, `$42.50`) — dollars are the unit
 *
 * Returns `'$0'` for zero / negative / non-finite input (defensive — the
 * Sidebar still guards on `> 0` before rendering, but a corrupted
 * upstream payload must not poison the renderer with `$NaN`).
 */
export function formatCostBadge(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '$0'
  if (costUsd >= 1) return `$${costUsd.toFixed(2)}`
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toFixed(3)}`
}

/**
 * Build the multi-line breakdown shown in the dashboard's native browser
 * tooltip and in the mobile app's tap-to-expand sheet. Six rows in a
 * stable order; token counts use locale formatting so 1234567 reads as
 * "1,234,567" in en-US (or the equivalent in the runtime's locale).
 */
export function formatCostBreakdown(usage: CumulativeUsage): string {
  const fmt = (n: number) => n.toLocaleString()
  return [
    `Total cost: $${usage.costUsd.toFixed(4)}`,
    `Turns billed: ${fmt(usage.turnsBilled)}`,
    `Input tokens: ${fmt(usage.inputTokens)}`,
    `Output tokens: ${fmt(usage.outputTokens)}`,
    `Cache read: ${fmt(usage.cacheReadTokens)}`,
    `Cache write: ${fmt(usage.cacheCreationTokens)}`,
  ].join('\n')
}
