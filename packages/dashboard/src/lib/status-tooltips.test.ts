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
import { CLIENT_ESTIMATED_COST_PROVIDERS } from './client-estimated-cost-providers'

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

describe('contextTooltip (#3858 / #6769)', () => {
  it('describes cumulative context-window fill, NOT per-turn (#6769)', () => {
    const t = contextTooltip({ percent: 45, contextSummary: '90k / 200k tokens' })
    // #6769 reversed #3858's per-turn framing: the meter now tracks the whole
    // conversation's fill, so the tooltip must NOT claim it resets each turn.
    expect(t).toMatch(/whole conversation|fills 45% of the model's context window|before auto-compact/i)
    expect(t).not.toMatch(/per[- ]turn|resets each turn|most recent turn used/i)
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

  it('returns empty string for 0 / undefined / null (no chip is rendered anyway)', () => {
    // Loosened signature (Copilot review on #4204) — callers naturally
    // have `agentCount?: number`, so accept null/undefined without casts.
    expect(agentCountTooltip(0)).toBe('')
    expect(agentCountTooltip(undefined)).toBe('')
    expect(agentCountTooltip(null)).toBe('')
  })
})

describe('costTooltip single source of truth (#4206)', () => {
  // Pre-#4206 the provider list lived twice — once in status-tooltips.ts
  // (this file's gate for the "estimated client-side" wording) and
  // implicitly in message-handler.ts (where the cost-fallback fires).
  // The two sites stayed in sync by accident: the only providers that
  // emitted `cost: null` + usage happened to be Codex and Gemini. The
  // moment a new such provider lands, the message-handler fallback
  // would silently price it without the tooltip flagging it as
  // estimated. After #4206 both sites import the same exported set,
  // so adding a provider is a single edit. This test pins that
  // contract: every provider in the shared set MUST get the
  // estimated-client-side wording out of costTooltip, with no second
  // edit required here.
  it('every CLIENT_ESTIMATED_COST_PROVIDERS entry triggers the estimated-client-side wording', () => {
    for (const provider of CLIENT_ESTIMATED_COST_PROVIDERS) {
      const t = costTooltip({ cost: 0.5, provider })
      expect(t, `provider "${provider}" must trigger estimated-client-side wording`)
        .toMatch(/estimated client-side/i)
    }
  })

  it('the shared set is non-empty and includes the known client-priced providers', () => {
    // Belt-and-suspenders: if a future refactor accidentally empties
    // the set, the loop above would vacuously pass. Pin the floor
    // explicitly. Codex + Gemini are the two providers that emit
    // cost: null today; any reduction below that needs an obvious
    // failure here so the change is intentional.
    expect(CLIENT_ESTIMATED_COST_PROVIDERS.has('codex')).toBe(true)
    expect(CLIENT_ESTIMATED_COST_PROVIDERS.has('gemini')).toBe(true)
    expect(CLIENT_ESTIMATED_COST_PROVIDERS.size).toBeGreaterThanOrEqual(2)
  })
})

describe('contextTooltip rounding (#4204 Copilot review)', () => {
  it('rounds a long float percent to 1 decimal', () => {
    const t = contextTooltip({ percent: 12.3456789, contextSummary: '24k / 200k' })
    // App.tsx computes percent as (total/contextWindow)*100 which is a
    // float. Without rounding the tooltip showed "12.3456789%" in
    // production. Round to 1 decimal.
    expect(t).not.toContain('12.3456789')
    expect(t).toContain('12.3%')
  })

  it('trims trailing .0 for clean round numbers', () => {
    const t = contextTooltip({ percent: 45, contextSummary: '90k / 200k' })
    expect(t).toContain('45%')
    expect(t).not.toContain('45.0%')
  })
})

describe('tokenChipTooltip (#4205)', () => {
  // #5094: now delegates to the canonical `formatTokensCompact`, which keeps
  // one decimal on all kilo values for consistency with the header meter.
  it('formats in/out/total breakdown in kilo-tokens', () => {
    const t = tokenChipTooltip({ inputTokens: 1200, outputTokens: 8000 })
    expect(t).toContain('1.2k input')
    expect(t).toContain('8.0k output')
    expect(t).toContain('9.2k tokens')
  })

  it('keeps one decimal for round multiples of 1000 (canonical compact)', () => {
    const t = tokenChipTooltip({ inputTokens: 2000, outputTokens: 1000 })
    expect(t).toContain('2.0k input')
    expect(t).toContain('1.0k output')
    expect(t).toContain('3.0k tokens')
  })

  it('renders raw counts under 1000 without the "k" suffix', () => {
    const t = tokenChipTooltip({ inputTokens: 450, outputTokens: 120 })
    expect(t).toContain('450 input')
    expect(t).toContain('120 output')
    expect(t).toContain('570 tokens')
  })

  it('handles zero output (system / no reply yet)', () => {
    const t = tokenChipTooltip({ inputTokens: 1500, outputTokens: 0 })
    expect(t).toContain('1.5k input')
    expect(t).toContain('0 output')
    expect(t).toContain('1.5k tokens')
  })

  // #6769: the breakdown is the last turn's BILLING counts (summed across the
  // turn's agent-loop rounds) — labelled as billing so it can't be mistaken
  // for window occupancy, which the contextTooltip lead covers separately.
  it('labels the breakdown as last-turn billing, not window fill (#6769)', () => {
    const t = tokenChipTooltip({ inputTokens: 1200, outputTokens: 8000 })
    expect(t).toMatch(/last turn billed/i)
    expect(t).not.toMatch(/cached history|occupan|window/i)
  })
})

describe('contextTooltip + token breakdown (#4205)', () => {
  it('appends the in/out/total breakdown when both token counts are present', () => {
    const t = contextTooltip({
      percent: 45,
      contextSummary: '90k / 200k tokens',
      inputTokens: 80000,
      outputTokens: 10000,
    })
    // Percent still leads (the chip's main job is "how full?")…
    expect(t).toContain('45%')
    // …and the breakdown follows so the chip explains where the
    // percent came from (the original #3858 acceptance criterion).
    expect(t).toContain('80.0k input')
    expect(t).toContain('10.0k output')
    expect(t).toContain('90.0k tokens')
  })

  it('omits the breakdown when only inputTokens is known (defensive)', () => {
    const t = contextTooltip({
      percent: 45,
      contextSummary: '90k / 200k tokens',
      inputTokens: 80000,
    })
    expect(t).toContain('45%')
    // Both must be present together — half a breakdown is misleading.
    expect(t).not.toContain('input +')
  })

  it('omits the breakdown when only outputTokens is known (defensive)', () => {
    const t = contextTooltip({
      percent: 45,
      contextSummary: '90k / 200k tokens',
      outputTokens: 10000,
    })
    expect(t).toContain('45%')
    expect(t).not.toContain('output =')
  })

  it('still returns the "no usage yet" fallback when ALL inputs are absent', () => {
    const t = contextTooltip({ percent: null })
    expect(t).toMatch(/no context usage yet|first turn/i)
  })

  // #6769: byok's final-round snapshot is an estimate — the tooltip must say
  // so; the SDK's authoritative snapshot must not carry the caveat.
  it('flags a byok final-round snapshot as estimated (#6769)', () => {
    const t = contextTooltip({
      percent: 50,
      contextSummary: '92.0k tokens',
      estimated: true,
    })
    expect(t).toContain('50%')
    expect(t).toMatch(/estimated from the last api round/i)
  })

  it('omits the estimate caveat for the SDK snapshot (#6769)', () => {
    const t = contextTooltip({ percent: 50, contextSummary: '110.0k tokens' })
    expect(t).not.toMatch(/estimated/i)
  })

  it('describes occupancy that grows and steps down after compaction (#6769)', () => {
    const t = contextTooltip({ percent: 66, contextSummary: '110.0k tokens' })
    expect(t).toMatch(/occup/i)
    expect(t).toMatch(/steps down after a compaction/i)
    expect(t).not.toMatch(/per[- ]turn|resets each turn/i)
  })
})
