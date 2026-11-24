/**
 * The per-application activity meter: for one day, how many sessions were live
 * and for how many hours each host application was active.
 *
 * It is a pure function of samples. A sample is one snapshot of the live
 * sessions at a time: `{ at, sessions: [{ id, app, busy }] }`, taken from the
 * registry by `sampleRegistry`. Nothing here reads a clock or a file, and no
 * title or path is in a sample, so none is in a record.
 *
 * Definitions (each is what a hand count would do):
 *   - live sessions: the distinct session ids seen in any sample dated inside
 *     the day, counted under the application of the first such sample;
 *   - active time: each sample holds until the next one. The span from a
 *     sample to the next counts, once, as active time for an application when
 *     any of its sessions was busy in the earlier sample. A span is credited
 *     at most `maxGapMs` (a gap between samples is not evidence of activity
 *     past it), is clipped to the day, and the last sample credits nothing
 *     because no later sample bounds it;
 *   - the day is the calendar day at `utcOffsetMinutes` from UTC (UTC by default).
 */

import { loadRegistry } from './session-registry-adapter.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const DEFAULT_MAX_GAP_MS = 30 * 60 * 1000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * One sample of the registry at `at`, or null when it cannot be read this
 * time (an unreadable registry is a missing sample, not an empty one).
 */
export function sampleRegistry({ dir, at, ...limits }) {
  const snap = loadRegistry(dir, limits)
  if (snap.error) return null
  return { at, sessions: [...snap.rows.values()].map((r) => ({ id: r.id, app: r.app, busy: r.busy })) }
}

function dayWindow(day, utcOffsetMinutes) {
  const m = DAY_RE.exec(day)
  if (!m) throw new TypeError('dailyActivity: day must be YYYY-MM-DD')
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const utc = new Date(Date.UTC(y, mo - 1, d))
  // Round-trip: an impossible date would otherwise roll over into another day.
  if (y < 1970 || utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) throw new TypeError('dailyActivity: day is not a real date (YYYY-MM-DD, 1970 or later)')
  const start = utc.getTime() - utcOffsetMinutes * 60_000
  return { start, end: start + DAY_MS }
}

/**
 * The activity record for one day.
 *
 * @param {object} opts
 * @param {object[]} opts.samples    samples, in any order
 * @param {string} opts.day          `YYYY-MM-DD`
 * @param {number} [opts.utcOffsetMinutes]  the local time's offset from UTC in minutes, as for UTC-6 is -360 (default 0)
 * @param {number} [opts.maxGapMs]   longest span credited from one sample (default 30 minutes)
 * @returns {{ day: string, utc_offset_minutes: number, samples: number, apps: { app: string, live_sessions: number, active_ms: number, active_hours: number }[] }}
 */
export function dailyActivity({ samples, day, utcOffsetMinutes = 0, maxGapMs = DEFAULT_MAX_GAP_MS }) {
  if (!Array.isArray(samples)) throw new TypeError('dailyActivity: samples must be an array')
  if (!Number.isFinite(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 840 || !(maxGapMs > 0)) throw new TypeError('dailyActivity: bad offset or gap')
  const { start, end } = dayWindow(day, utcOffsetMinutes)
  // A malformed sample or session entry is dropped, never thrown on.
  const okSession = (x) => x !== null && typeof x === 'object' && typeof x.id === 'string' && typeof x.app === 'string'
  const ordered = samples
    .filter((s) => s && Number.isFinite(s.at) && Array.isArray(s.sessions))
    .map((s) => ({ at: s.at, sessions: s.sessions.filter(okSession) }))
    .sort((a, b) => a.at - b.at)
  const apps = new Map()
  const slot = (app) => {
    if (!apps.has(app)) apps.set(app, { app, ids: new Set(), active_ms: 0 })
    return apps.get(app)
  }
  const seen = new Set()
  let inDay = 0
  for (const s of ordered) {
    if (s.at < start || s.at >= end) continue
    inDay++
    for (const x of s.sessions) {
      if (seen.has(x.id)) continue
      seen.add(x.id)
      slot(x.app).ids.add(x.id)
    }
  }
  for (let i = 0; i + 1 < ordered.length; i++) {
    const a = ordered[i]
    const from = Math.max(a.at, start)
    const to = Math.min(ordered[i + 1].at, a.at + maxGapMs, end)
    if (!(to > from)) continue
    for (const app of new Set(a.sessions.filter((x) => x.busy).map((x) => x.app))) slot(app).active_ms += to - from
  }
  return {
    day,
    utc_offset_minutes: utcOffsetMinutes,
    samples: inDay,
    apps: [...apps.values()]
      .sort((a, b) => (a.app < b.app ? -1 : 1))
      .map((a) => ({ app: a.app, live_sessions: a.ids.size, active_ms: a.active_ms, active_hours: Math.round((a.active_ms / HOUR_MS) * 100) / 100 })),
  }
}
