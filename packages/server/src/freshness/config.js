/**
 * Configuration for the session-freshness model: starting values
 * expressed in seconds, plus the source capabilities the model needs to know.
 *
 * Every value here is a starting value, not a measurement. Pure data.
 */

const MIN = 60
const HOUR = 3600

export const DEFAULT_CONFIG = Object.freeze({
  // The name an `OWNER:` slot must carry for a blocked line to be an owner
  // block. Deliberately unset: a deployment supplies it.
  owner_name: null,
  cadence_minutes: 30,
  per_source: Object.freeze({}),
  investigation_budget_per_tick: 3,
  recheck_budget_per_tick: 3,
  freshness: Object.freeze({
    running: Object.freeze({ fresh_max_s: 20 * MIN, stale_after_s: 45 * MIN }),
    unknown: Object.freeze({ fresh_max_s: 20 * MIN, stale_after_s: 45 * MIN }),
    blocked: Object.freeze({ fresh_max_s: 60 * MIN, stale_after_s: 4 * HOUR }),
    stalled: Object.freeze({ fresh_max_s: 60 * MIN, stale_after_s: 4 * HOUR }),
    idle: Object.freeze({ fresh_max_s: 4 * HOUR, stale_after_s: 24 * HOUR }),
    done: Object.freeze({ fresh_max_s: 4 * HOUR, stale_after_s: 24 * HOUR }),
  }),
  max_source_skew_seconds: 120,
  investigation: Object.freeze({
    activity_window_minutes: 20,
    background_wait_max_minutes: 90,
  }),
  surface: Object.freeze({
    reminder_after_minutes: Object.freeze([60, 180]),
    item_time_limit_hours: 8,
    max_presentations: 3,
    // An owner's deferral: the longest one accepted, and how many an item
    // may have in one episode. One past either is refused and recorded.
    defer_max_minutes: 24 * 60,
    defer_max_count: 3,
  }),
  // The files a consumer exchanges with the reconciler (exchange.js). Every
  // input is untrusted: these bound what one tick will read from it.
  exchange: Object.freeze({
    max_file_bytes: 1024 * 1024,
    max_line_bytes: 1024,
    max_new_lines_per_tick: 200,
    max_rejects_per_tick: 20,
    text_field_max: 240,
    digest_max_items: 12,
  }),
  // What each source's adapter can do. `native_in_read`: the report read also
  // returns native state (busy, prompts, events). `activity_read`: a separate
  // native-activity read exists. `scope`: the source gives a session's
  // working scope. `can_confirm_gone`: a missing session may be called gone.
  sources: Object.freeze({
    chroxy: Object.freeze({ native_in_read: true, activity_read: false, scope: true, can_confirm_gone: true, report_time_basis: 'changed_at' }),
    codex: Object.freeze({ native_in_read: false, activity_read: true, scope: true, can_confirm_gone: true, report_time_basis: 'authored_at' }),
    'claude-desktop': Object.freeze({ native_in_read: false, activity_read: false, scope: false, can_confirm_gone: true, report_time_basis: 'authored_at' }),
  }),
})

/** Cadence of one source in seconds. */
export function cadenceSeconds(config, source) {
  const m = config.per_source?.[source] ?? config.cadence_minutes
  return m * MIN
}

/** Capabilities of one source; unknown sources have none. */
export function sourceCaps(config, source) {
  return config.sources?.[source] ?? { native_in_read: false, activity_read: false, scope: false, can_confirm_gone: false, report_time_basis: 'none' }
}

/** A shallow-merged copy of the defaults with overrides, for tests and callers. */
export function makeConfig(overrides = {}) {
  const base = structuredClone(DEFAULT_CONFIG)
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      base[k] = { ...base[k], ...structuredClone(v) }
    } else {
      base[k] = structuredClone(v)
    }
  }
  return base
}

/** The surface and exchange values of a configuration, with the defaults for a configuration stored before they existed. */
export function exchangeLimits(config) {
  return { ...DEFAULT_CONFIG.exchange, ...(config?.exchange ?? {}) }
}

export function deferLimits(config) {
  const s = { ...DEFAULT_CONFIG.surface, ...(config?.surface ?? {}) }
  return { maxMs: s.defer_max_minutes * MIN * 1000, maxCount: s.defer_max_count }
}
