import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import { isFreshKeyPress, suppressRepeatedActivation } from './keyboard'

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

describe('suppressRepeatedActivation (#9271)', () => {
  const press = (key: string, repeat: boolean) => {
    const preventDefault = vi.fn()
    suppressRepeatedActivation({ key, repeat, preventDefault })
    return preventDefault
  }

  it.each(['Enter', ' '])('prevents default on a repeated %j', (key) => {
    expect(press(key, true)).toHaveBeenCalledTimes(1)
  })

  it.each(['Enter', ' '])('leaves a fresh %j alone', (key) => {
    expect(press(key, false)).not.toHaveBeenCalled()
  })

  it.each(['a', 'Escape', 'Tab'])('leaves a repeated %j alone', (key) => {
    expect(press(key, true)).not.toHaveBeenCalled()
  })
})
