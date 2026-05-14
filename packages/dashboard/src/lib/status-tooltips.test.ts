import { describe, it, expect } from 'vitest'
import {
  tokenTooltip,
  costTooltip,
  contextTooltip,
  agentTooltip,
  modelTooltip,
} from './status-tooltips'

describe('tokenTooltip', () => {
  it('returns a generic line when usage is null', () => {
    expect(tokenTooltip(null)).toMatch(/most recent turn/i)
  })

  it('returns a generic line when both counts are zero', () => {
    expect(tokenTooltip({ inputTokens: 0, outputTokens: 0 })).toMatch(/most recent turn/i)
  })

  it('breaks down input vs output with thousands separators', () => {
    const out = tokenTooltip({ inputTokens: 12345, outputTokens: 678 })
    expect(out).toContain('12,345 input')
    expect(out).toContain('678 output')
    expect(out).toContain('13,023 tokens')
  })

  it('explicitly notes not cumulative', () => {
    const out = tokenTooltip({ inputTokens: 100, outputTokens: 50 })
    expect(out.toLowerCase()).toContain('not cumulative')
  })
})

describe('costTooltip', () => {
  it('renders without provider context when no provider given', () => {
    expect(costTooltip(0.42, null)).toContain('$0.4200')
  })

  it('omits estimate disclaimer for Claude', () => {
    const out = costTooltip(1.23, 'claude-sdk')
    expect(out).not.toMatch(/estimated client-side/i)
  })

  it('includes estimate disclaimer for non-Claude providers', () => {
    expect(costTooltip(1.23, 'codex')).toMatch(/estimated client-side/i)
    expect(costTooltip(1.23, 'gemini')).toMatch(/estimated client-side/i)
  })

  it('omits estimate disclaimer for Docker wrappers (they delegate to Claude)', () => {
    // Docker images inherit Claude's billing — server-side
    // _isClaudeFamilyProvider() classifies them as Claude family, so the
    // client tooltip must agree.
    expect(costTooltip(1.23, 'docker')).not.toMatch(/estimated client-side/i)
    expect(costTooltip(1.23, 'docker-cli')).not.toMatch(/estimated client-side/i)
    expect(costTooltip(1.23, 'docker-sdk')).not.toMatch(/estimated client-side/i)
  })

  it('is case-insensitive for provider names', () => {
    expect(costTooltip(1.23, 'CLAUDE-SDK')).not.toMatch(/estimated client-side/i)
    expect(costTooltip(1.23, 'Docker-CLI')).not.toMatch(/estimated client-side/i)
  })

  it('handles null cost gracefully', () => {
    expect(costTooltip(null, 'claude-sdk')).toMatch(/total session cost/i)
  })
})

describe('contextTooltip', () => {
  it('explains per-turn nature when total is zero', () => {
    const out = contextTooltip({ inputTokens: 0, outputTokens: 0, contextWindow: 200000, percent: 0 })
    expect(out.toLowerCase()).toContain('per-turn')
    expect(out.toLowerCase()).toContain('not cumulative')
  })

  it('includes percent, totals, and window when all known', () => {
    const out = contextTooltip({ inputTokens: 1000, outputTokens: 200, contextWindow: 200000, percent: 0.6 })
    expect(out).toContain('1,200 tokens')
    expect(out).toContain('200,000 tokens')
    expect(out).toContain('1%')
  })

  it('caps the displayed percent at 100', () => {
    const out = contextTooltip({ inputTokens: 250000, outputTokens: 50000, contextWindow: 200000, percent: 150 })
    expect(out).toContain('100%')
    expect(out).not.toContain('150%')
  })

  it('gracefully omits the window phrase when window is unknown', () => {
    const out = contextTooltip({ inputTokens: 100, outputTokens: 50, contextWindow: null, percent: null })
    expect(out).not.toContain('context window')
  })
})

describe('agentTooltip', () => {
  it('handles zero', () => {
    expect(agentTooltip(0)).toMatch(/no background agents/i)
  })

  it('pluralizes correctly', () => {
    expect(agentTooltip(1)).toMatch(/\b1 background agent\b/)
    expect(agentTooltip(1)).not.toMatch(/\bbackground agents\b/)
    expect(agentTooltip(3)).toMatch(/\b3 background agents\b/)
  })
})

describe('modelTooltip', () => {
  it('returns a generic line when no model is set', () => {
    expect(modelTooltip(null, null)).toMatch(/active model/i)
    expect(modelTooltip(undefined, null)).toMatch(/active model/i)
  })

  it('includes model id and window when both known', () => {
    const out = modelTooltip('claude-opus-4-7', 200000)
    expect(out).toContain('claude-opus-4-7')
    expect(out).toContain('200,000 tokens')
  })

  it('omits the window sentence when unknown', () => {
    const out = modelTooltip('claude-opus-4-7', null)
    expect(out).toContain('claude-opus-4-7')
    expect(out).not.toMatch(/context window/i)
  })
})
