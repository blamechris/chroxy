import { describe, it, expect } from 'vitest'
import { buildProviderLimitationNote } from './provider-capabilities'

describe('buildProviderLimitationNote (#6312)', () => {
  it('lists all three degraded capabilities for claude-tui (modelSwitch/planMode/streaming false)', () => {
    expect(buildProviderLimitationNote({ planMode: false, streaming: false, modelSwitch: false })).toBe(
      "This provider doesn't support plan mode, streaming, and model switching.",
    )
  })

  it('returns null for a fully-capable provider', () => {
    expect(buildProviderLimitationNote({ planMode: true, streaming: true, modelSwitch: true })).toBeNull()
  })

  it('lists only the single disabled capability', () => {
    expect(buildProviderLimitationNote({ planMode: false, streaming: true, modelSwitch: true })).toBe(
      "This provider doesn't support plan mode.",
    )
  })

  it('joins two disabled capabilities with "and", no Oxford comma', () => {
    expect(buildProviderLimitationNote({ planMode: false, streaming: false, modelSwitch: true })).toBe(
      "This provider doesn't support plan mode and streaming.",
    )
  })

  it('ignores undefined/absent flags (only an explicit false counts)', () => {
    // A provider that simply omits `streaming` should not be reported as lacking it.
    expect(buildProviderLimitationNote({ planMode: true, modelSwitch: true })).toBeNull()
    expect(buildProviderLimitationNote({ streaming: false })).toBe(
      "This provider doesn't support streaming.",
    )
  })

  it('returns null for missing capabilities object', () => {
    expect(buildProviderLimitationNote(null)).toBeNull()
    expect(buildProviderLimitationNote(undefined)).toBeNull()
  })
})
