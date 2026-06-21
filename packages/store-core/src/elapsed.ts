/**
 * Elapsed / relative-time formatters — #6201.
 *
 * Two registers for "how long since X", both taking a millisecond delta and
 * flooring sub-second values to "just now":
 *   - `formatElapsedSince` — "just now" / "5s" / "2m 30s" / "1h 5m" (terse,
 *     no suffix) — used by the CheckInChip "Agent quiet for …" copy.
 *   - `formatElapsedAgo`  — the same, with an " ago" suffix on every
 *     non-"just now" branch ("5s ago", "2m 30s ago") — used by the
 *     ActivityIndicator "last activity …" copy.
 *
 * Consolidated here (#6201 SOLID/DRY sweep): both forms were inlined
 * byte-identically in the app AND dashboard copies of ActivityIndicator
 * (relative) and CheckInChip (terse). Single-sourcing also de-dups the two
 * registers against each other — `formatElapsedAgo` is `formatElapsedSince`
 * plus the suffix, so the branch structure lives in exactly one place.
 *
 * Distinct from `formatDurationTerse` (./duration), which formats an arbitrary
 * duration and returns "0s" (not "just now") for sub-second input.
 */

/**
 * Terse elapsed form: "just now" under 1s, then "5s" / "2m 30s" / "1h 5m".
 */
export function formatElapsedSince(ms: number): string {
  if (ms < 1000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * Relative form: `formatElapsedSince` with an " ago" suffix on every branch
 * except "just now" ("5s ago", "2m 30s ago", "1h 5m ago").
 */
export function formatElapsedAgo(ms: number): string {
  const since = formatElapsedSince(ms)
  return since === 'just now' ? since : `${since} ago`
}
