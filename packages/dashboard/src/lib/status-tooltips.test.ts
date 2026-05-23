/**
 * Tests for status-tooltip formatter helpers (#3858).
 *
 * The helpers must produce stable, descriptive tooltips for every read-only
 * status chip the header (StatusBar) and footer (FooterBar) render. The
 * issue's core requirement: cost, context %, model, agent count, and token
 * chip values must each have a hover-explanation so the user understands
 * what the number means — especially the context % (which looks alarming
 * at 100% but is per-turn, not cumulative).
 */
import { describe, it, expect } from 'vitest'
import {
  costTooltip,
  contextTooltip,
  modelTooltip,
  agentCountTooltip,
  tokenChipTooltip,
} from './status-tooltips'

describe('costTooltip (#3858)', () => {
  it('describes the cost as cumulative session total when no provider hint', () => {
    const t = costTooltip({ cost: 0.0234 })
    expect(t).toMatch(/total session cost/i)
    expect(t).toContain('$0.0234')
  })

  it('flags the value as client-estimated for Codex and Gemini', () => {
    expect(costTooltip({ cost: 0.5, provider: 'codex' })).toMatch(/estimated client-side/i)
    expect(costTooltip({ cost: 0.5, provider: 'gemini' })).toMatch(/estimated client-side/i)
  })

  it('does NOT flag for Claude / claude-byok / claude-tui (server-authoritative)', () => {
    expect(costTooltip({ cost: 0.5, provider: 'claude-byok' })).not.toMatch(/estimated client-side/i)
    expect(costTooltip({ cost: 0.5, provider: 'claude-tui' })).not.toMatch(/estimated client-side/i)
    expect(costTooltip({ cost: 0.5, provider: 'cli' })).not.toMatch(/estimated client-side/i)
  })

  it('handles undefined cost gracefully (pre-first-turn)', () => {
    const t = costTooltip({ cost: undefined })
    expect(t).toMatch(/no usage yet|will appear/i)
  })
})

describe('contextTooltip (#3858)', () => {
  it('explicitly calls out the per-turn nature (not cumulative)', () => {
    const t = contextTooltip({ percent: 45, contextSummary: '90k / 200k tokens' })
    // The issue's key requirement: disambiguate per-turn vs cumulative.
    expect(t).toMatch(/per[- ]turn|this turn|last turn|most recent turn/i)
    expect(t).not.toMatch(/cumulative|session total/i)
  })

  it('includes the percent and the summary string when both are present', () => {
    const t = contextTooltip({ percent: 73, contextSummary: '146k / 200k tokens' })
    expect(t).toContain('73%')
    expect(t).toContain('146k / 200k tokens')
  })

  it('falls back to the summary string alone when percent is null', () => {
    const t = contextTooltip({ percent: null, contextSummary: '45k / 200k tokens' })
    expect(t).toContain('45k / 200k tokens')
    expect(t).not.toContain('null')
  })

  it('handles a percent that exceeds 100 (model returned more than window)', () => {
    const t = contextTooltip({ percent: 134, contextSummary: '267k / 200k tokens' })
    // Don't clamp in the tooltip — the bar clamps, the tooltip is honest.
    expect(t).toContain('134%')
  })

  it('returns a sensible default when neither value is present', () => {
    const t = contextTooltip({ percent: null, contextSummary: undefined })
    expect(t).toMatch(/no context usage yet|first turn/i)
  })
})

describe('modelTooltip (#3858)', () => {
  it('shows the full model id', () => {
    const t = modelTooltip({ model: 'claude-opus-4-7[1m]' })
    expect(t).toContain('claude-opus-4-7[1m]')
  })

  it('formats context window with thousands separators when present', () => {
    const t = modelTooltip({ model: 'claude-opus-4-7[1m]', contextWindow: 1_000_000 })
    expect(t).toContain('1,000,000')
  })

  it('falls back gracefully when model id is missing', () => {
    const t = modelTooltip({ model: undefined })
    expect(t).toMatch(/no model|active model unknown/i)
  })
})

describe('agentCountTooltip (#3858)', () => {
  it('singular for 1', () => {
    expect(agentCountTooltip(1)).toMatch(/1 background agent/i)
  })

  it('plural for >1', () => {
    expect(agentCountTooltip(3)).toMatch(/3 background agents/i)
  })

  it('returns empty string for 0 / undefined (no chip is rendered anyway)', () => {
    expect(agentCountTooltip(0)).toBe('')
    expect(agentCountTooltip(undefined as unknown as number)).toBe('')
  })
})

describe('tokenChipTooltip (#3858)', () => {
  it('breaks down input + output + total for the most recent turn', () => {
    const t = tokenChipTooltip({ inputTokens: 12_000, outputTokens: 3_000 })
    expect(t).toContain('12k')
    expect(t).toContain('3k')
    expect(t).toContain('15k')
    expect(t).toMatch(/most recent turn|last turn/i)
    expect(t).toMatch(/not cumulative/i)
  })

  it('returns a sensible default when no usage data yet', () => {
    const t = tokenChipTooltip(null)
    expect(t).toMatch(/no usage yet|first turn/i)
  })
})
