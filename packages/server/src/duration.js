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
