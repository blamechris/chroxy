import { describe, it, expect } from 'vitest'
import { unwrapToolResultText } from './tool-result-text'

// #5800 — the implementation + its full case table moved to store-core
// (packages/store-core/src/tool-result-text.test.ts). This dashboard test now
// imports through the re-export shim (`./tool-result-text` →
// `@chroxy/store-core`) to prove the shim resolves and the dashboard call sites
// still get the unwrap behavior unchanged.
describe('unwrapToolResultText re-export shim (#5800)', () => {
  it('re-exports a callable unwrapToolResultText from store-core', () => {
    expect(typeof unwrapToolResultText).toBe('function')
  })

  it('passes plain strings through unchanged', () => {
    expect(unwrapToolResultText('total 0\ndrwxr-xr-x')).toBe('total 0\ndrwxr-xr-x')
  })

  it('unwraps a stdout/stderr JSON envelope to stdout text', () => {
    const envelope = JSON.stringify({ stdout: 'out line', stderr: '' })
    expect(unwrapToolResultText(envelope)).toBe('out line')
  })

  it('appends stderr after stdout when both are present', () => {
    const envelope = JSON.stringify({ stdout: 'out line', stderr: 'err line' })
    expect(unwrapToolResultText(envelope)).toBe('out line\nerr line')
  })
})
