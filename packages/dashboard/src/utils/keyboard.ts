/**
 * True for the first keydown of a physical key press, false for the browser's
 * auto-repeats while the key is held.
 *
 * Every caller rests on one assumption: the first keydown of a physical press
 * has `repeat: false` and each auto-repeat has `repeat: true`, so one physical
 * press decides one action (#9243 Stop key, #9270 permission prompts). The
 * structural type accepts both DOM and React keyboard events.
 */
export function isFreshKeyPress(e: { repeat: boolean }): boolean {
  return !e.repeat
}

/**
 * Stop a held Enter/Space from activating a focused `<button>` more than once
 * (#9271). Use as the button's `onKeyDown`.
 *
 * Measured in Chromium and WebKit: a focused button fires `click` on EVERY
 * Enter keydown, auto-repeats included (10 keydowns, 10 clicks), while Space
 * activates once, on keyup. `preventDefault()` on an auto-repeated Enter/Space
 * keydown leaves exactly one activation; a single Enter, a single Space and a
 * mouse click are untouched.
 */
export function suppressRepeatedActivation(e: {
  key: string
  repeat: boolean
  preventDefault(): void
}): void {
  if ((e.key === 'Enter' || e.key === ' ') && !isFreshKeyPress(e)) {
    e.preventDefault()
  }
}
