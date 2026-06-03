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
  formatCostBreakdown,
  formatPartialCostLine,
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

  it('uses K/M abbreviation matching SidebarTokenView.formatTokenCount', () => {
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
})
