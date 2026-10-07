/**
 * The ONE copy of the parsing rules for the files the dashboard's update banner
 * exchanges with the idle-only auto-deploy script (#8331), imported by both
 * `daemon-update-status.js` (the daemon) and `scripts/deploy-daemon.mjs`. What counts
 * as a valid request or postpone, how old a request may be, and what a timestamp may
 * look like are decided here and nowhere else, so the two sides cannot drift.
 *
 * Next to `small-file.js`, which decides how the files are READ and WRITTEN; this
 * module decides what a parsed value MEANS.
 */

const SHA = /^[0-9a-f]{40}$/i
const NONCE = /^[A-Za-z0-9._-]{1,64}$/

/** A request older than this is ignored: a click from an hour ago must not restart the daemon now. At least twice the 600 s launchd StartInterval, so one missed tick does not lose a click. */
export const REQUEST_TTL_MS = 20 * 60 * 1000
/** How far in the future a `requestedAt` may be (clock skew between the writer and the reader). */
export const REQUEST_SKEW_MS = 5 * 60 * 1000
/**
 * How long an `applying` marker (written by the script when a forward deploy starts
 * building) is believed. The build timeout is 20 minutes, so 30 covers it plus slack;
 * past that the marker is the leftover of a crashed tick, not live work.
 */
export const APPLYING_MAX_MS = 30 * 60 * 1000
/** What the daemon's Postpone writes. */
export const POSTPONE_MS = 60 * 60 * 1000
/** A postpone is honoured only for at most this long from its own `requestedAt`: the hour, plus a minute of slack. */
export const POSTPONE_MAX_MS = POSTPONE_MS + 60 * 1000

export const isSha = (v) => typeof v === 'string' && SHA.test(v)

/**
 * A timestamp both sides can safely use: a string that parses, with a year in
 * 1970..9999. A year outside that range would make `toISOString()` emit the
 * extended `+275760-…` form, which the wire schema's `datetime()` rejects and
 * which would then fail a client's whole-frame parse.
 */
export function isIso(v) {
  if (typeof v !== 'string' || v.length > 40) return false
  const t = Date.parse(v)
  if (!Number.isFinite(t)) return false
  const year = new Date(t).getUTCFullYear()
  return year >= 1970 && year <= 9999
}

/** Canonical UTC ISO for a timestamp `isIso` accepted. */
export const canonIso = (v) => new Date(Date.parse(v)).toISOString()

/** -> a valid restart request, or null. The server writes exactly this shape. */
export function parseRequest(v) {
  if (!v || typeof v !== 'object' || v.action !== 'restart-now') return null
  if (!isSha(v.target)) return null
  if (typeof v.force !== 'boolean') return null
  if (!isIso(v.requestedAt)) return null
  if (typeof v.nonce !== 'string' || !NONCE.test(v.nonce)) return null
  return { target: v.target.toLowerCase(), force: v.force, requestedAt: canonIso(v.requestedAt), nonce: v.nonce }
}

/** A request is fresh while it is no older than the TTL and not meaningfully from the future. */
export function isRequestFresh(req, nowMs) {
  const age = nowMs - Date.parse(req.requestedAt)
  return age <= REQUEST_TTL_MS && age >= -60 * 1000
}

/**
 * -> `{ target, until }` for a postpone that is well-formed AND internally sane, else
 * null. It needs a valid `requestedAt` that is not more than REQUEST_SKEW_MS in the
 * future, and a hold of at most POSTPONE_MAX_MS from that timestamp, so a hand-written
 * far-future deadline is not a postpone.
 */
export function parsePostpone(v, nowMs) {
  if (!v || typeof v !== 'object' || !isSha(v.target) || !isIso(v.until) || !isIso(v.requestedAt)) return null
  const asked = Date.parse(v.requestedAt)
  if (asked - nowMs > REQUEST_SKEW_MS) return null
  if (Date.parse(v.until) - asked > POSTPONE_MAX_MS) return null
  return { target: v.target.toLowerCase(), until: canonIso(v.until) }
}

/**
 * Is an `applying` marker's `applyingSince` recent enough to be live? Missing, invalid,
 * older than APPLYING_MAX_MS, or meaningfully from the future: no.
 */
export function isApplyingFresh(applyingSince, nowMs) {
  // A missing or unparseable value is NaN, which fails both comparisons: not fresh.
  const age = nowMs - Date.parse(applyingSince)
  return age <= APPLYING_MAX_MS && age >= -REQUEST_SKEW_MS
}
