import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'

/**
 * Validate an operator-supplied inactivity-timeout value (in ms) against the
 * shared `MAX_SANE_DURATION_MS` (24h) ceiling that the protocol schemas apply
 * via `.max(MAX_SANE_DURATION_MS)`.
 *
 * Returns `true` when the value is a finite number, within the ceiling, and
 * positive (or non-negative when `allowZero` is set). Returns `false`
 * otherwise so the caller can fall back to its own default (`null` /
 * `DEFAULT_*_TIMEOUT_MS`). When the value falls back specifically because it
 * exceeds the ceiling, a single warning log line is emitted so operators can
 * spot a typoed `CHROXY_*` env var.
 *
 * Mirrors the ceiling check #4484 added to `ws-history.js sendPostAuthInfo`,
 * extending the same guardrail to the three internal sites listed in #4509
 * (session-manager, server-cli, base-session).
 *
 * @param {*} value - The candidate timeout in ms.
 * @param {object} opts
 * @param {boolean} [opts.allowZero=false] - `streamStallTimeoutMs` accepts 0
 *   as "explicitly disabled"; the two soft/hard timeouts treat 0 as invalid.
 * @param {string} opts.name - Operator-facing name used in the warn log
 *   (e.g. `resultTimeoutMs`). Should match the `CHROXY_*`/config-file key
 *   the operator would have set.
 * @param {{ warn: Function }} opts.log - Logger to emit the over-ceiling
 *   warning through. Tests can stub this.
 * @returns {boolean} `true` if the value is in-range and should be used as-is.
 */
export function isOperatorTimeoutInRange(value, { allowZero = false, name, log }) {
  if (!Number.isFinite(value)) return false
  const lowerOk = allowZero ? value >= 0 : value > 0
  if (!lowerOk) return false
  if (value <= MAX_SANE_DURATION_MS) return true
  // Over-ceiling: warn once so operators can spot a typoed CHROXY_* env var
  // (e.g. `CHROXY_HARD_TIMEOUT_MS=99999999999` accidentally typed with an
  // extra digit) instead of silently producing a >24h internal inactivity
  // timer.
  if (log && typeof log.warn === 'function') {
    log.warn(`${name} ${value} exceeds MAX_SANE_DURATION_MS (${MAX_SANE_DURATION_MS}ms / 24h); falling back to default`)
  }
  return false
}

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Supported units: d (days), h (hours), m (minutes), s (seconds).
 * Examples: '2h', '30m', '1h30m', '1d12h', '90s', '2h30m15s'
 *
 * @param {string} str - Duration string
 * @returns {number|null} Milliseconds, or null if unparseable
 */
export function parseDuration(str) {
  if (typeof str !== 'string' || str.trim().length === 0) return null

  const cleaned = str.trim().toLowerCase()

  // Pure numeric → treat as seconds
  if (/^\d+$/.test(cleaned)) {
    const ms = parseInt(cleaned, 10) * 1000
    return ms > 0 ? ms : null
  }

  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
  const match = cleaned.match(pattern)
  if (!match || match[0].length === 0) return null

  const days = parseInt(match[1] || '0', 10)
  const hours = parseInt(match[2] || '0', 10)
  const minutes = parseInt(match[3] || '0', 10)
  const seconds = parseInt(match[4] || '0', 10)

  if (days === 0 && hours === 0 && minutes === 0 && seconds === 0) return null

  return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000
}
