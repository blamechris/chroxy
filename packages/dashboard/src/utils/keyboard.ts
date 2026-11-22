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
