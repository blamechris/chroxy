import { timingSafeEqual } from 'crypto'

/**
 * Constant-time string comparison for auth tokens.
 * Prevents timing attacks by always comparing the full buffer length.
 * Node.js-specific (uses native crypto.timingSafeEqual).
 */
export function safeTokenCompare(a, b) {
  let valid = true
  if (typeof a !== 'string' || typeof b !== 'string') {
    valid = false
    a = ''
    b = ''
  }

  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  const maxLen = Math.max(bufA.length, bufB.length)

  // Always compare buffers of equal length to avoid leaking length via timing
  const paddedA = Buffer.alloc(maxLen)
  const paddedB = Buffer.alloc(maxLen)
  bufA.copy(paddedA)
  bufB.copy(paddedB)

  const equal = maxLen === 0 ? false : timingSafeEqual(paddedA, paddedB)
  return valid && equal && bufA.length === bufB.length
}
