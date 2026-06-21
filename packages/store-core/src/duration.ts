/**
 * Duration formatting utilities — #4510 / #6201.
 *
 * Two named exports cover the two display registers used across the app and
 * dashboard:
 *   - `formatDurationTerse`   — "30s" / "5m" / "1h 2m"  (chip / inline labels)
 *   - `formatDurationVerbose` — "30 seconds" / "5 minutes" / "2 hours" (prose)
 *
 * Consolidated here (#6201 SOLID/DRY sweep) as the single cross-package source.
 * History: originally inlined as private helpers in `ActivityIndicator.tsx`
 * (#4308) and `StreamStallChip.tsx` (#4497, PR #4505); the dashboard copies were
 * then folded into `dashboard/src/utils/duration.ts` (#4510); #6201 promotes that
 * dashboard module into store-core and retires the app's separate inlined copy,
 * so the app + dashboard now share one source. The
 * terse form is wrong for natural-language sentences ("No response for 5m") and
 * the verbose form is wrong for compact chips ("Running Bash · 30 seconds"); we
 * keep both registers but ship them from one place so future consumers (app,
 * dashboard, or any new surface) don't reinvent either.
 */

/**
 * Terse "Ns" / "Nm" / "Nh Nm" form, suitable for inline chip labels where
 * vertical space and reading speed both matter more than grammar.
 */
export function formatDurationTerse(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * Verbose "N seconds / N minutes / N hours" form, suitable for prose copy
 * ("No response for 5 minutes — retry?"). Pluralisation is decided per unit.
 *
 * Hardening notes:
 *   - Non-finite inputs (NaN, ±Infinity) collapse to "1 second" so a malformed
 *     value from upstream never bleeds a literal "NaN" or "Infinity" into the
 *     UI. Real call sites (StreamStallChip) gate with `Number.isFinite`, but
 *     the helper owns its own contract.
 *   - `Math.max(1, seconds)` floors sub-500ms inputs to "1 second" rather than
 *     the meaningless "0 seconds" the original helper produced.
 */
export function formatDurationVerbose(ms: number): string {
  if (!Number.isFinite(ms)) return '1 second'
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(minutes / 60)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}
