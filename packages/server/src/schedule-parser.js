// Dependency-free schedule parsing + next-run computation for the scheduled-task
// registry (#6862, foundation slice of epic #6784). This module ONLY parses a
// cadence and COMPUTES the next fire time — it never fires anything. The headless
// engine that actually spawns sessions is a sibling slice (#6865); it will import
// computeNextRun to advance a task's schedule after a run.
//
// Three cadence kinds are supported, all without any npm dependency:
//   - once:     { kind: 'once', at }                     — a single future timestamp
//   - interval: { kind: 'interval', everyMs[, anchor] }  — every N ms from an anchor
//   - cron:     { kind: 'cron', expression }             — a 5-field crontab expression
//
// Deliberately distinct from `ScheduleWakeup` (transcript-tasks.js), which is an
// intra-session, single-shot, transcript-derived self-resume ({delaySeconds,
// reason, prompt}). This is a standing, persisted, recurring registry cadence.

// Minimum interval a task may fire on. Sub-second scheduling is meaningless for a
// cadence that spawns a whole agent session, and a 0/tiny value would be a
// runaway. The engine (#6865) enforces its own real-world minimum; this is a
// data-integrity floor so the stored model can never carry an absurd interval.
export const MIN_INTERVAL_MS = 1000

// Forward-search horizon for cron next-run. A legitimate crontab always fires
// within a few years even for the rare leap-day-only expression
// (`0 0 29 2 *` — next match up to ~4 years out); 5 years gives headroom. An
// impossible expression (e.g. day-of-month 31 in a 30-day-only month set) yields
// no match inside the horizon and computeNextRun returns null rather than
// looping forever.
const CRON_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const FIELD_BOUNDS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 7 }, // 0 and 7 both mean Sunday
}

/**
 * Error thrown when a cron expression cannot be parsed. Carries the offending
 * expression so a caller (CLI #6868 / dashboard #6871) can surface a precise
 * message rather than a bare "invalid".
 */
export class CronParseError extends Error {
  constructor(message, expression) {
    super(message)
    this.name = 'CronParseError'
    this.expression = expression
  }
}

/**
 * Parse a single crontab field (one of minute/hour/dom/month/dow) into a Set of
 * the integer values it matches. Supports `*`, `?` (alias for `*`), single
 * values, `a-b` ranges, star-step and range-step forms (`* / s`, `a-b / s`,
 * written without the spaces), and comma lists combining any
 * of those. Month and day-of-week also accept 3-letter names (jan..dec /
 * sun..sat, case-insensitive).
 * @param {string} raw
 * @param {'minute'|'hour'|'dom'|'month'|'dow'} field
 * @param {string} expression - full expression, for error messages
 * @returns {{ values: Set<number>, star: boolean }}
 */
function parseField(raw, field, expression) {
  const { min, max } = FIELD_BOUNDS[field]
  const names = field === 'month' ? MONTH_NAMES : field === 'dow' ? DOW_NAMES : null

  const resolveToken = (tok) => {
    const lower = tok.toLowerCase()
    if (names && Object.prototype.hasOwnProperty.call(names, lower)) return names[lower]
    if (!/^\d+$/.test(tok)) {
      throw new CronParseError(`Invalid ${field} token '${tok}'`, expression)
    }
    return Number(tok)
  }

  const values = new Set()
  // Vixie star flag: set when the field's FIRST CHARACTER is `*` (or the Quartz
  // `?` alias) — which deliberately INCLUDES step forms like `*/5`. Vixie's
  // DOM_STAR / DOW_STAR are set off the leading `*` even though `*/5` also
  // restricts the value set, and that flag drives the dom/dow OR-vs-AND rule in
  // dayMatches. A literal-star-only check (`raw === '*'`) would wrongly treat
  // `*/5` as non-star and OR it against a weekday instead of AND-ing (#6879).
  const star = raw[0] === '*' || raw[0] === '?'

  for (const part of raw.split(',')) {
    if (part === '') throw new CronParseError(`Empty ${field} list item`, expression)
    // Split an optional step: "<range>/<step>".
    const [rangeText, stepText, ...rest] = part.split('/')
    if (rest.length > 0) throw new CronParseError(`Malformed ${field} step '${part}'`, expression)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronParseError(`Invalid ${field} step '${stepText}'`, expression)
      }
      step = Number(stepText)
    }

    // Determine the [lo, hi] range this part iterates over.
    let lo
    let hi
    if (rangeText === '*' || rangeText === '?') {
      lo = min
      hi = max
    } else if (rangeText.includes('-')) {
      const [a, b, ...more] = rangeText.split('-')
      if (more.length > 0) throw new CronParseError(`Malformed ${field} range '${rangeText}'`, expression)
      lo = resolveToken(a)
      hi = resolveToken(b)
    } else {
      lo = resolveToken(rangeText)
      // A bare value with a step (`5/10`) iterates from the value up to the max.
      hi = stepText !== undefined ? max : lo
    }

    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(`${field} value out of range in '${part}' (allowed ${min}-${max})`, expression)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }

  // Normalize day-of-week 7 -> 0 (both are Sunday) so matching against JS
  // Date.getDay() (0=Sun..6=Sat) is a straight Set lookup.
  if (field === 'dow' && values.has(7)) {
    values.delete(7)
    values.add(0)
  }

  return { values, star }
}

/**
 * Parse a standard 5-field crontab expression (minute hour day-of-month month
 * day-of-week) into matched-value sets. Whitespace between fields is collapsed.
 * Throws {@link CronParseError} on any malformed field.
 * @param {string} expression
 * @returns {{minute:Set<number>,hour:Set<number>,dom:Set<number>,month:Set<number>,dow:Set<number>,domStar:boolean,dowStar:boolean}}
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw new CronParseError('Cron expression must be a string', expression)
  }
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new CronParseError(`Expected 5 cron fields, got ${fields.length}`, expression)
  }
  const [min, hour, dom, month, dow] = fields
  const minute = parseField(min, 'minute', expression)
  const hourF = parseField(hour, 'hour', expression)
  const domF = parseField(dom, 'dom', expression)
  const monthF = parseField(month, 'month', expression)
  const dowF = parseField(dow, 'dow', expression)
  return {
    minute: minute.values,
    hour: hourF.values,
    dom: domF.values,
    month: monthF.values,
    dow: dowF.values,
    domStar: domF.star,
    dowStar: dowF.star,
  }
}

/**
 * Whether a Date's calendar day matches a parsed cron's day-of-month /
 * day-of-week fields, using the standard Vixie-cron rule (#6879 — this mirrors
 * cron.c's `(DOM_STAR || DOW_STAR) ? (dom && dow) : (dom || dow)`):
 *
 *   - If EITHER field is a star (its first char is `*`, which INCLUDES a
 *     step form such as star-slash-5), the two constraints are AND-ed: the day
 *     must satisfy BOTH. Because a bare `*` field matches every value, this
 *     reduces to "use the non-star field" for the common `0 0 15 * *` /
 *     `0 0 * * 1` cases — but for a dom step against a weekday (star-slash-5 in
 *     dom, Monday in dow) it correctly means "a Monday that ALSO falls on a day
 *     in the step set", NOT an OR of the two.
 *   - If NEITHER field is a star (both are explicitly restricted, e.g.
 *     `0 0 1,15 * 5` or `0 0 1-7 * 1`), the constraints are OR-ed: the day
 *     matches if EITHER matches.
 *
 * @param {ReturnType<typeof parseCron>} c
 * @param {Date} d - local Date
 * @returns {boolean}
 */
function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate())
  const dowOk = c.dow.has(d.getDay())
  if (c.domStar || c.dowStar) return domOk && dowOk
  return domOk || dowOk
}

/**
 * Compute the next time a parsed cron fires strictly AFTER `fromMs`, in the
 * daemon's LOCAL time zone. Returns an epoch-ms timestamp, or null if no match
 * falls within the search horizon (an impossible expression).
 *
 * Local time is deliberate: `0 9 * * *` should mean 9am wall-clock.
 *
 * DST is an INTENTIONAL product choice (#6879), not an accident of the
 * arithmetic: on a spring-forward day a wall-clock time that DOES NOT EXIST
 * (e.g. `30 2 * * *` when the clock jumps 02:00->03:00) is SKIPPED for that day
 * rather than fired at the shifted 03:00 — we would rather miss the
 * non-existent slot for one day than run at a time the user did not ask for.
 * This falls out of reading getHours()/getMinutes() back off a local Date after
 * each step: the Date never reports the non-existent 02:xx (setHours(2) on that
 * day normalizes to 03:00), so the 02:xx minute is never matched. On a fall-back
 * day the duplicated hour fires once. Explicit per-task time zones are a future
 * concern.
 * @param {ReturnType<typeof parseCron>} c
 * @param {number} fromMs
 * @returns {number|null}
 */
export function computeCronNextRun(c, fromMs) {
  const horizon = fromMs + CRON_HORIZON_MS
  const d = new Date(fromMs)
  // Advance to the next whole minute strictly after fromMs.
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)

  while (d.getTime() <= horizon) {
    if (!c.month.has(d.getMonth() + 1)) {
      // Jump to the first day of the next month at 00:00 local.
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d.getTime()
  }
  return null
}

/**
 * Compute the next fire time strictly AFTER `fromMs` for an interval cadence.
 * The anchor (defaulting to the caller's supplied base, typically the task's
 * createdAt) fixes the phase so the boundaries do not drift with computation
 * time. When the anchor itself is still in the future, that first anchor time is
 * the next run.
 * @param {number} everyMs
 * @param {number} anchorMs
 * @param {number} fromMs
 * @returns {number|null}
 */
export function computeIntervalNextRun(everyMs, anchorMs, fromMs) {
  if (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS) return null
  if (!Number.isFinite(anchorMs)) return null
  if (fromMs < anchorMs) return anchorMs
  const steps = Math.floor((fromMs - anchorMs) / everyMs) + 1
  return anchorMs + steps * everyMs
}

/**
 * Compute a task's next run time (epoch ms) strictly after `fromMs`, or null
 * when the task will not run again: it is disabled, it is a one-time task that
 * has already run, its cadence is malformed, or a cron match falls beyond the
 * search horizon. Pure — computes only, never fires.
 *
 * A one-time task that has NOT run yet returns its `at` even when `at` is in the
 * past: that "overdue" state is meaningful for display, and the engine (#6865)
 * decides whether to fire it immediately.
 * @param {object} task - normalized scheduled task (see scheduled-task-store.js)
 * @param {object} [opts]
 * @param {number} [opts.from] - reference time (defaults to Date.now())
 * @returns {number|null}
 */
export function computeNextRun(task, { from = Date.now() } = {}) {
  if (!task || task.enabled === false) return null
  const cadence = task.cadence
  if (!cadence || typeof cadence !== 'object') return null

  switch (cadence.kind) {
    case 'once': {
      if (task.lastRun) return null
      return Number.isFinite(cadence.at) ? cadence.at : null
    }
    case 'interval': {
      const anchor = Number.isFinite(cadence.anchor) ? cadence.anchor
        : (Number.isFinite(task.createdAt) ? task.createdAt : from)
      return computeIntervalNextRun(cadence.everyMs, anchor, from)
    }
    case 'cron': {
      let parsed
      try {
        parsed = parseCron(cadence.expression)
      } catch {
        return null
      }
      return computeCronNextRun(parsed, from)
    }
    default:
      return null
  }
}
