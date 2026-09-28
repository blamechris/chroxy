import type { KeyboardEvent } from 'react'

/**
 * #8064: true while an input method editor (Japanese, Chinese, Korean, …) is
 * composing. The key that commits a candidate (Enter, Tab, arrows) belongs to
 * the IME, so a composer or palette keydown handler must return early instead
 * of sending, selecting or completing. `isComposing` is the standard signal;
 * `keyCode === 229` is the fallback for browsers that don't set it reliably
 * (Safari). Some Android keyboards report 229 outside composition too — see
 * #8071 — which is why this lives in one place.
 */
export function isImeComposing(e: Pick<KeyboardEvent, 'nativeEvent' | 'keyCode'>): boolean {
  return e.nativeEvent.isComposing === true || e.keyCode === 229
}
