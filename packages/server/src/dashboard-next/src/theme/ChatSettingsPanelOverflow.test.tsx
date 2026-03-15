/**
 * CSS assertion: .chat-settings-panel must constrain its width
 * to prevent viewport overflow on narrow screens (#2306).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, 'components.css'), 'utf-8')

describe('ChatSettingsPanel overflow guard', () => {
  it('has a max-width using calc or vw to prevent viewport overflow', () => {
    // Extract the .chat-settings-panel rule block
    const match = css.match(/\.chat-settings-panel\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    const rules = match![1]
    // Must contain a max-width declaration using calc() or vw units
    expect(rules).toMatch(/max-width\s*:\s*(calc\(|[^;]*vw)/)
  })

  it('has a viewport-aware min-width so it cannot exceed max-width', () => {
    const match = css.match(/\.chat-settings-panel\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    const rules = match![1]
    // min-width must use min()/clamp() with a vw or calc(vw) term
    // so it yields to max-width on narrow viewports
    expect(rules).toMatch(/min-width\s*:\s*(min|clamp)\(/)
  })
})
