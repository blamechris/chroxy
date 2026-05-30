/**
 * #4591: shared formatters for the per-device notification overrides list.
 *
 * Both the dashboard `SettingsPanel` (#4587) and the mobile `SettingsScreen`
 * (#4587) render the same `{Platform} · Last seen {rel}` shape for each
 * known-device row. Pre-#4591 each surface carried a verbatim local copy of
 * `formatPlatform` (8 lines) and `formatRelativeTime` (16 lines). The
 * helpers are pure / dep-free, so a shared home in `@chroxy/store-core`
 * (which already ships to both targets) eliminates the duplication without
 * pulling a new dependency into the RN bundle.
 *
 * Both helpers are intentionally tiny — designed to stay readable inline
 * during code review. They never throw and never depend on locale state,
 * so they're safe to call from any render path on either platform.
 */

/**
 * Map the on-disk `platform` string stamped by the server (#4587) to a
 * user-facing label. Unknown platforms fall through to the raw value so a
 * forward-compatible install (newer server stamping a value this binary
 * hasn't shipped yet) still renders something instead of an empty span.
 */
export function formatPlatform(p: string): string {
  switch (p) {
    case 'ios': return 'iOS'
    case 'android': return 'Android'
    case 'web': return 'Web'
    case 'desktop': return 'Desktop'
    default: return p
  }
}

/**
 * Cheap human-readable "X ago" for the per-device list. Renders at minute
 * granularity (rounds down) so the smallest unit the operator sees is
 * "just now" or "N min ago" — nothing as precise as seconds. Future
 * timestamps (clock skew, server stamping ahead of dashboard read) fall
 * through to "just now" rather than rendering nonsense like "-1 min ago".
 *
 * `now` defaults to `Date.now()` so the helper is callable inline during
 * render, but tests can inject a fixed clock by passing the second arg.
 */
export function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  const diffMs = now - epochMs
  if (diffMs < 0) return 'just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} mo ago`
  const years = Math.floor(months / 12)
  return `${years} yr ago`
}
