/**
 * Freshness grading from report age and the configured thresholds.
 *
 * Freshness is computed from the report's age alone: the reconciler's check
 * time minus the host's report time. A check never moves the report time, so
 * for a fixed report under a fixed configuration the graded value can only get
 * worse as time passes. Times are milliseconds since the epoch and are always
 * arguments; nothing here reads a clock.
 */

export const FRESHNESS = Object.freeze(['fresh', 'aging', 'stale', 'unknown', 'error', 'blocked'])

/** The age-graded values, in the order in which they get worse. */
export const AGE_ORDER = Object.freeze({ fresh: 0, aging: 1, stale: 2 })

/**
 * The age rule: check time minus report time. Kept as a separate
 * function so that a test can swap it (a check that refreshes a report is the
 * failure this rule exists to prevent).
 */
export function reportAgeMs({ lastReportAt, checkedAt }) {
  return checkedAt - lastReportAt
}

/**
 * Bands for one age (ms) under one threshold row (seconds): fresh means age <= fresh_max;
 * stale means age > stale_after; aging is everything between, including
 * exactly stale_after.
 */
export function band(ageMs, row) {
  if (ageMs <= row.fresh_max_s * 1000) return 'fresh'
  if (ageMs > row.stale_after_s * 1000) return 'stale'
  return 'aging'
}

/**
 * Grade one read.
 *
 * input:
 *   outcome        'ok' | 'no_report' | 'error' | 'blocked'
 *   state          the parsed state, or 'none'
 *   declaredVia    'marker' | 'transcript' | 'api' | 'hook'
 *   timeTrusted    false when the host time cannot be trusted
 *   lastReportAt   host time of the report (ms)
 *   checkedAt      reconciler time of the check (ms)
 *   previousCheckedAt  the previous check of the same report, if any (ms)
 *   sourceNow      the source's own current time, if it supplies one (ms)
 *   remoteWithoutClock  a source on another host that supplies no time
 *   errorCode, notReadReason  passed through for error and blocked reads
 *
 * returns { freshness, reason, ageS, errorCode, notReadReason }
 */
export function gradeRead(input, config, ageFn = reportAgeMs) {
  const skewMs = config.max_source_skew_seconds * 1000
  const out = { freshness: null, reason: null, ageS: null, errorCode: null, notReadReason: null }
  if (input.outcome === 'error') return { ...out, freshness: 'error', errorCode: input.errorCode ?? 'adapter_fault' }
  if (input.outcome === 'blocked') return { ...out, freshness: 'blocked', notReadReason: input.notReadReason ?? 'policy' }
  if (input.sourceNow != null && Math.abs(input.sourceNow - input.checkedAt) > skewMs) {
    return { ...out, freshness: 'error', errorCode: 'clock_skew' }
  }
  if (input.outcome === 'no_report' || input.state === 'none' || input.state == null) {
    return { ...out, freshness: 'unknown', reason: input.reason ?? 'no_status_line' }
  }
  if (input.timeTrusted === false) return { ...out, freshness: 'unknown', reason: 'time_untrusted' }
  if (input.declaredVia === 'api' || input.declaredVia === 'hook') {
    return { ...out, freshness: 'unknown', reason: 'relayed_declaration' }
  }
  if (input.lastReportAt - input.checkedAt > skewMs) {
    return { ...out, freshness: 'error', errorCode: 'clock_skew' }
  }
  const row = config.freshness[input.state]
  if (!row) return { ...out, freshness: 'unknown', reason: 'no_status_line' }
  // DESIGN-GAP: a report time later than the check time by no more than the
  // skew limit is allowed, but the rules define no age for it. The model
  // clamps the age at zero so that no negative age is ever recorded.
  const ageMs = Math.max(0, ageFn({ lastReportAt: input.lastReportAt, checkedAt: input.checkedAt, previousCheckedAt: input.previousCheckedAt }))
  const ageS = Math.floor(ageMs / 1000)
  let freshness = band(ageMs, row)
  if (input.remoteWithoutClock && freshness === 'fresh') freshness = 'aging'
  return { ...out, freshness, ageS }
}
