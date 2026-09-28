import { describe, it, expect } from 'vitest'
import type { KeyboardEvent } from 'react'
import { isImeComposing } from './ime'

function ev(isComposing: boolean, keyCode: number): Pick<KeyboardEvent, 'nativeEvent' | 'keyCode'> {
  return { nativeEvent: { isComposing } as unknown as KeyboardEvent['nativeEvent'], keyCode }
}

describe('isImeComposing (#8064)', () => {
  it('is true while the native event reports composition', () => {
    expect(isImeComposing(ev(true, 13))).toBe(true)
  })
  it('is true for the keyCode 229 fallback', () => {
    expect(isImeComposing(ev(false, 229))).toBe(true)
  })
  it('is false for an ordinary key outside composition', () => {
    expect(isImeComposing(ev(false, 13))).toBe(false)
    expect(isImeComposing(ev(false, 9))).toBe(false)
  })
})
