/**
 * Platform detection and keyboard-shortcut label helpers (#2840, #2883).
 *
 * `isMacPlatform()` is the single source of truth for Mac detection across
 * the dashboard (permission hints, shortcut modal). Falls back to non-Mac
 * when `navigator` is unavailable (SSR / tests).
 *
 * `formatShortcutKeys()` rewrites `Cmd`-prefixed labels to `Ctrl` on
 * non-Mac platforms so the cheat-sheet modal matches what the user can
 * actually press.
 */

/** Returns true when the current user agent identifies as macOS/iOS. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined' || !navigator) return false
  const ua = navigator.userAgent || ''
  return /Mac|iPod|iPhone|iPad/.test(ua)
}

/**
 * Transform a shortcut `keys` label for display so the modifier matches
 * the current platform. On Mac the input is returned unchanged; on
 * Windows/Linux any `Cmd` token is rewritten to `Ctrl`.
 *
 * Replacement is guarded by word boundaries so we only rewrite the
 * standalone `Cmd` modifier and not other tokens that happen to start
 * with those three letters.
 */
export function formatShortcutKeys(keys: string): string {
  if (isMacPlatform()) return keys
  return keys.replace(/\bCmd\b/g, 'Ctrl')
}
