/**
 * Provider billing hint CSS tests (#1677)
 *
 * Verifies CSS styling for billing hint element.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')

describe('Provider billing hint CSS (#1677)', () => {
  it('has .provider-billing-hint rule', () => {
    expect(css).toMatch(/\.provider-billing-hint\s*\{/)
  })

  it('uses secondary text color', () => {
    const match = css.match(/\.provider-billing-hint\s*\{[^}]*color:\s*var\(--text-secondary\)/s)
    expect(match).toBeTruthy()
  })

  it('uses small font size', () => {
    const match = css.match(/\.provider-billing-hint\s*\{[^}]*font-size:\s*11px/s)
    expect(match).toBeTruthy()
  })
})
