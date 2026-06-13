/**
 * Tests for shared cost-formatting helpers (#4123).
 *
 * Pure-function pin so both the dashboard sidebar badge (#4073) and the
 * mobile session-header badge (#4074) get identical formatting from
 * one source of truth.
 */
import { describe, it, expect } from 'vitest'
import {
  formatCostBadge,
  formatCostBadgeOrNa,
  formatCostBreakdown,
  formatPartialCostLine,
  formatTokens,
  formatTokensCompact,
} from './cost-format'
import type { ErrorPartialCost } from './cost-format'
import type { CumulativeUsage } from './types'

describe('formatCostBadge (#4123)', () => {
  it('formats values >= $1 with 2 decimal places', () => {
    expect(formatCostBadge(1.0)).toBe('$1.00')
    expect(formatCostBadge(1.234)).toBe('$1.23')
    expect(formatCostBadge(42.5)).toBe('$42.50')
  })

  it('formats values >= $0.01 and < $1 with 3 decimals', () => {
    expect(formatCostBadge(0.07)).toBe('$0.070')
    expect(formatCostBadge(0.013)).toBe('$0.013')
    expect(formatCostBadge(0.999)).toBe('$0.999')
  })

  it('formats values < $0.01 with 4 decimals', () => {
    expect(formatCostBadge(0.0001)).toBe('$0.0001')
    expect(formatCostBadge(0.0023)).toBe('$0.0023')
  })

  it('returns $0 for zero / negative / non-finite (defensive)', () => {
    expect(formatCostBadge(0)).toBe('$0')
    expect(formatCostBadge(-0.5)).toBe('$0')
    expect(formatCostBadge(NaN)).toBe('$0')
    expect(formatCostBadge(Infinity)).toBe('$0')
  })
})

describe('formatCostBadgeOrNa (#5630)', () => {
  it('returns "n/a" for null / undefined / non-finite (unknown cost)', () => {
    expect(formatCostBadgeOrNa(null)).toBe('n/a')
    expect(formatCostBadgeOrNa(undefined)).toBe('n/a')
    expect(formatCostBadgeOrNa(NaN)).toBe('n/a')
    expect(formatCostBadgeOrNa(Infinity)).toBe('n/a')
  })

  it('delegates to formatCostBadge for finite values (including $0)', () => {
    // A genuine finite 0 stays "$0" (not "n/a") — only the null sentinel is n/a.
    expect(formatCostBadgeOrNa(0)).toBe('$0')
    expect(formatCostBadgeOrNa(0.07)).toBe('$0.070')
    expect(formatCostBadgeOrNa(1.5)).toBe('$1.50')
  })
})

describe('formatCostBreakdown (#4123)', () => {
  const localeNum = (n: number) => n.toLocaleString()

  it('contains all six rows in a stable order', () => {
    const usage: CumulativeUsage = {
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 8000,
      cacheCreationTokens: 200,
      costUsd: 0.0345,
      turnsBilled: 3,
    }
    const lines = formatCostBreakdown(usage).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('Total cost: $0.0345')
    expect(lines[1]).toBe(`Turns billed: ${localeNum(3)}`)
    expect(lines[2]).toBe(`Input tokens: ${localeNum(1234)}`)
    expect(lines[3]).toBe(`Output tokens: ${localeNum(567)}`)
    expect(lines[4]).toBe(`Cache read: ${localeNum(8000)}`)
    expect(lines[5]).toBe(`Cache write: ${localeNum(200)}`)
  })

  it('delegates token formatting to toLocaleString() (large numbers grouped)', () => {
    const usage: CumulativeUsage = {
      inputTokens: 1234567,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      turnsBilled: 0,
    }
    expect(formatCostBreakdown(usage)).toContain(`Input tokens: ${localeNum(1234567)}`)
  })
})

describe('formatPartialCostLine (#5039)', () => {
  const partial = (over: Partial<ErrorPartialCost> = {}): ErrorPartialCost => ({
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...over,
  })

  it('includes cost + abbreviated input/output tokens when both present', () => {
    // Cost formatting delegates to `formatCostBadge`: $0.01-$1 → 3 decimals.
    expect(
      formatPartialCostLine(partial({ costUsd: 0.0875, inputTokens: 1234, outputTokens: 3400 })),
    ).toBe('This turn cost $0.087 (1.2K in · 3.4K out)')
  })

  it('falls back to cost-only when both input and output tokens are zero', () => {
    // Subscription-billed providers can emit a cost without a usage
    // breakdown — surface the cost alone rather than a misleading
    // "(0 in · 0 out)" suffix. Cost formatting matches formatCostBadge:
    // $0.05 lands in the 3-decimal band → "$0.050".
    expect(formatPartialCostLine(partial({ costUsd: 0.05 }))).toBe('This turn cost $0.050')
  })

  it('still renders sub-line when only one of the token counters is non-zero', () => {
    expect(
      formatPartialCostLine(partial({ costUsd: 0.001, inputTokens: 500, outputTokens: 0 })),
    ).toBe('This turn cost $0.0010 (500 in · 0 out)')
    expect(
      formatPartialCostLine(partial({ costUsd: 0.001, inputTokens: 0, outputTokens: 750 })),
    ).toBe('This turn cost $0.0010 (0 in · 750 out)')
  })

  it('uses the canonical formatTokens K/M abbreviation', () => {
    expect(
      formatPartialCostLine(
        partial({ costUsd: 1.5, inputTokens: 1_234_567, outputTokens: 999_499 }),
      ),
    ).toBe('This turn cost $1.50 (1.23M in · 999.5K out)')
  })

  it('renders $0 when costUsd is exactly 0 (free / fully-cached turn)', () => {
    expect(
      formatPartialCostLine(partial({ costUsd: 0, inputTokens: 50, outputTokens: 0 })),
    ).toBe('This turn cost $0 (50 in · 0 out)')
  })
})

// STANDARD formatter (#5058 / #5094) — migrated here from
// SidebarTokenView.test.tsx so each canonical formatter has ONE test home.
describe('formatTokens (#5058 / #5094)', () => {
  it('renders below 1000 verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('abbreviates thousands with uppercase K (one decimal)', () => {
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(1234)).toBe('1.2K')
    expect(formatTokens(30_000)).toBe('30.0K')
    expect(formatTokens(999_499)).toBe('999.5K')
  })

  // Avoid the "1000.0K" visual nonsense — roll to M before the K-rounded
  // value crosses 1000.
  it('rolls over to M before the K-rounded value crosses 1000', () => {
    expect(formatTokens(999_500)).toBe('1.00M')
    expect(formatTokens(999_999)).toBe('1.00M')
  })

  it('abbreviates millions with uppercase M (two decimals)', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M')
    expect(formatTokens(1_500_000)).toBe('1.50M')
    expect(formatTokens(1_234_567)).toBe('1.23M')
  })

  // #5058 guard decision: the defensive guard lives on the shared helper.
  it('returns "0" for non-finite / non-positive (defensive)', () => {
    expect(formatTokens(-1)).toBe('0')
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(Infinity)).toBe('0')
  })

  // Copilot #5122: non-integer wire data must be rounded BEFORE the
  // threshold checks so 999.6 doesn't slip through the "< 1000" branch and
  // render "1000" with no K suffix.
  it('rounds non-integer input before applying thresholds', () => {
    expect(formatTokens(999.6)).toBe('1.0K')
    expect(formatTokens(999.4)).toBe('999')
    expect(formatTokens(1234.5)).toBe('1.2K')
  })
})

describe('formatTokensCompact (#5065)', () => {
  it('returns raw count under 1000', () => {
    expect(formatTokensCompact(0)).toBe('0')
    expect(formatTokensCompact(1)).toBe('1')
    expect(formatTokensCompact(999)).toBe('999')
  })

  it('formats thousands with lowercase k and one decimal', () => {
    expect(formatTokensCompact(1000)).toBe('1.0k')
    expect(formatTokensCompact(1234)).toBe('1.2k')
    expect(formatTokensCompact(30_000)).toBe('30.0k')
    expect(formatTokensCompact(200_000)).toBe('200.0k')
  })

  it('rolls over to M before "1000.0k"', () => {
    // 999_500 rounds to 1000.0k in the simple version; jump to M instead.
    expect(formatTokensCompact(999_500)).toBe('1M')
    expect(formatTokensCompact(999_999)).toBe('1M')
  })

  it('drops the trailing .0 for whole millions (1M, 2M)', () => {
    expect(formatTokensCompact(1_000_000)).toBe('1M')
    expect(formatTokensCompact(2_000_000)).toBe('2M')
  })

  it('keeps one decimal for fractional millions', () => {
    expect(formatTokensCompact(1_500_000)).toBe('1.5M')
    expect(formatTokensCompact(1_250_000)).toBe('1.3M')
  })

  it('returns "0" for non-finite / non-positive (defensive)', () => {
    expect(formatTokensCompact(-1)).toBe('0')
    expect(formatTokensCompact(NaN)).toBe('0')
    expect(formatTokensCompact(Infinity)).toBe('0')
  })

  // Copilot #5122: round non-integer input before the threshold checks.
  it('rounds non-integer input before applying thresholds', () => {
    expect(formatTokensCompact(999.6)).toBe('1.0k')
    expect(formatTokensCompact(999.4)).toBe('999')
  })
})
