/**
 * model-pricing — unit tests for calculateCost and MODEL_PRICING table.
 *
 * Verifies that Codex and Gemini models return sensible cost estimates and
 * that unknown models return null rather than NaN or incorrect values.
 */
import { describe, it, expect } from 'vitest'
import { calculateCost, getModelPricing, MODEL_PRICING } from './model-pricing'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round a number to N significant figures for readable assertions. */
function sig(n: number, digits = 6): number {
  if (n === 0) return 0
  const d = Math.ceil(Math.log10(Math.abs(n)))
  const power = digits - d
  const magnitude = Math.pow(10, power)
  return Math.round(n * magnitude) / magnitude
}

// ---------------------------------------------------------------------------
// calculateCost — unknown model
// ---------------------------------------------------------------------------

describe('calculateCost — unknown model', () => {
  it('returns null for an unrecognised model id', () => {
    expect(calculateCost('some-unknown-model-xyz', 1000, 500)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// calculateCost — Codex / OpenAI models
// ---------------------------------------------------------------------------

describe('calculateCost — Codex / OpenAI models', () => {
  it('gpt-4o: 1k input + 500 output', () => {
    // inputPer1k=0.0025, outputPer1k=0.01
    // cost = (1000/1000)*0.0025 + (500/1000)*0.01 = 0.0025 + 0.005 = 0.0075
    const cost = calculateCost('gpt-4o', 1000, 500)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.0075, 6)
  })

  it('gpt-4.1: 2k input + 1k output', () => {
    // inputPer1k=0.002, outputPer1k=0.008
    // cost = 2*0.002 + 1*0.008 = 0.004 + 0.008 = 0.012
    const cost = calculateCost('gpt-4.1', 2000, 1000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.012, 6)
  })

  it('o1: 5k input + 2k output', () => {
    // inputPer1k=0.015, outputPer1k=0.06
    // cost = 5*0.015 + 2*0.06 = 0.075 + 0.12 = 0.195
    const cost = calculateCost('o1', 5000, 2000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.195, 6)
  })

  it('o3: 10k input + 4k output', () => {
    // inputPer1k=0.01, outputPer1k=0.04
    // cost = 10*0.01 + 4*0.04 = 0.1 + 0.16 = 0.26
    const cost = calculateCost('o3', 10000, 4000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.26, 6)
  })

  it('gpt-4o-mini: zero tokens yields zero cost', () => {
    expect(calculateCost('gpt-4o-mini', 0, 0)).toBe(0)
  })

  it('gpt-5 entry exists in table', () => {
    expect(getModelPricing('gpt-5')).toBeDefined()
  })

  it('gpt-5-codex entry exists in table', () => {
    expect(getModelPricing('gpt-5-codex')).toBeDefined()
  })

  it('o3-mini entry exists in table', () => {
    expect(getModelPricing('o3-mini')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// calculateCost — Gemini models
// ---------------------------------------------------------------------------

describe('calculateCost — Gemini models', () => {
  it('gemini-2.5-pro: 10k input + 2k output', () => {
    // inputPer1k=0.00125, outputPer1k=0.01
    // cost = 10*0.00125 + 2*0.01 = 0.0125 + 0.02 = 0.0325
    const cost = calculateCost('gemini-2.5-pro', 10000, 2000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.0325, 6)
  })

  it('gemini-2.5-flash: 8k input + 1k output', () => {
    // inputPer1k=0.0003, outputPer1k=0.0025
    // cost = 8*0.0003 + 1*0.0025 = 0.0024 + 0.0025 = 0.0049
    const cost = calculateCost('gemini-2.5-flash', 8000, 1000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.0049, 6)
  })

  it('gemini-2.0-flash: 100k input + 10k output', () => {
    // inputPer1k=0.0001, outputPer1k=0.0004
    // cost = 100*0.0001 + 10*0.0004 = 0.01 + 0.004 = 0.014
    const cost = calculateCost('gemini-2.0-flash', 100000, 10000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.014, 6)
  })

  it('gemini-1.5-pro: 50k input + 5k output', () => {
    // inputPer1k=0.00125, outputPer1k=0.005
    // cost = 50*0.00125 + 5*0.005 = 0.0625 + 0.025 = 0.0875
    const cost = calculateCost('gemini-1.5-pro', 50000, 5000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.0875, 6)
  })

  it('gemini-1.5-flash: 200k input + 20k output', () => {
    // inputPer1k=0.000075, outputPer1k=0.0003
    // cost = 200*0.000075 + 20*0.0003 = 0.015 + 0.006 = 0.021
    const cost = calculateCost('gemini-1.5-flash', 200000, 20000)
    expect(cost).not.toBeNull()
    expect(sig(cost!)).toBeCloseTo(0.021, 6)
  })

  it('gemini-2.0-flash-lite entry exists in table', () => {
    expect(getModelPricing('gemini-2.0-flash-lite')).toBeDefined()
  })

  it('gemini-1.5-flash-8b entry exists in table', () => {
    expect(getModelPricing('gemini-1.5-flash-8b')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// MODEL_PRICING table integrity
// ---------------------------------------------------------------------------

describe('MODEL_PRICING table integrity', () => {
  it('all entries have positive inputPer1k and outputPer1k', () => {
    for (const [id, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPer1k, `${id} inputPer1k`).toBeGreaterThan(0)
      expect(pricing.outputPer1k, `${id} outputPer1k`).toBeGreaterThan(0)
      expect(pricing.label, `${id} label`).toBeTruthy()
    }
  })

  it('output is always more expensive than input for each model', () => {
    for (const [id, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.outputPer1k, `${id} output >= input`).toBeGreaterThanOrEqual(pricing.inputPer1k)
    }
  })

  it('covers all required Codex models from issue #2964', () => {
    const required = ['gpt-5-codex', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3']
    for (const model of required) {
      expect(MODEL_PRICING[model], `${model} missing`).toBeDefined()
    }
  })

  it('covers all required Gemini models from issue #2964', () => {
    const required = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
    for (const model of required) {
      expect(MODEL_PRICING[model], `${model} missing`).toBeDefined()
    }
  })
})
