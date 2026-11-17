import { describe, it, expect } from 'vitest'
import { resolveEffectiveProvider } from './effective-provider'

describe('resolveEffectiveProvider (#8277)', () => {
  const roster = [{ name: 'codex' }, { name: 'gemini' }]
  it('keeps a saved provider the server offers', () => {
    expect(resolveEffectiveProvider('gemini', roster)).toBe('gemini')
  })
  it('falls back to the first offered provider when the saved one is not offered', () => {
    expect(resolveEffectiveProvider('claude-tui', roster)).toBe('codex')
  })
  it('keeps the saved value while the roster is empty', () => {
    expect(resolveEffectiveProvider('claude-tui', [])).toBe('claude-tui')
  })
})
