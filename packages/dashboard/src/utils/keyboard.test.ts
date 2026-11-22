import { describe, it, expect } from 'vitest'
import { isFreshKeyPress } from './keyboard'

describe('isFreshKeyPress', () => {
  it('is true for the first keydown of a press', () => {
    expect(isFreshKeyPress({ repeat: false })).toBe(true)
    expect(isFreshKeyPress(new KeyboardEvent('keydown', { key: 'y' }))).toBe(true)
  })

  it('is false for an auto-repeat keydown', () => {
    expect(isFreshKeyPress({ repeat: true })).toBe(false)
    expect(isFreshKeyPress(new KeyboardEvent('keydown', { key: 'y', repeat: true }))).toBe(false)
  })
})
