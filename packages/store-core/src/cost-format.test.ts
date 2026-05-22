/**
 * Tests for shared cost-formatting helpers (#4123).
 *
 * Pure-function pin so both the dashboard sidebar badge (#4073) and the
 * mobile session-header badge (#4074) get identical formatting from
 * one source of truth.
 */
import { describe, it, expect } from 'vitest'
import { formatCostBadge, formatCostBreakdown } from './cost-format'
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
