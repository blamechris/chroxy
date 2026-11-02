/**
 * #8236 — cap for the scrollable chrome region of SessionScreen.
 *
 * Everything between the mode toggle and the chat (tools row, search, settings
 * bar, banners) lives in a ScrollView that shrinks when space runs out. While
 * the keyboard is up we additionally cap it to a fraction of the space above the
 * keyboard so the chat keeps some room. Returns undefined (no cap) when the
 * keyboard is hidden or the container is not measured yet; the cap is only an
 * upper bound and never a minimum, so the composer always wins.
 */
export const CHROME_KEYBOARD_FRACTION = 0.4

export function chromeMaxHeight({
  containerHeight,
  keyboardHeight,
  bottomPadding,
}: {
  containerHeight: number
  keyboardHeight: number
  bottomPadding: number
}): number | undefined {
  if (!(keyboardHeight > 0) || !(containerHeight > 0)) return undefined
  // bottomPadding includes keyboardHeight (+ Android suggestion buffer); the
  // room above the keyboard is what remains of the container.
  const pad = Math.max(bottomPadding, keyboardHeight)
  const available = Math.max(0, containerHeight - pad)
  return Math.floor(available * CHROME_KEYBOARD_FRACTION)
}
