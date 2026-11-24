/**
 * Canonical encoding and hashing for the session-freshness model.
 *
 * Every idempotency key in the model is `H(...parts)`: sha256 over a canonical
 * JSON encoding of the parts array. Canonical means object keys are sorted and
 * `undefined` members are dropped, so two values that are equal as data always
 * hash the same, whatever order their keys were written in.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import { createHash } from 'node:crypto'

/**
 * Deterministic JSON. Objects are emitted with sorted keys; `undefined`
 * object members are omitted; arrays keep their order (an `undefined` array
 * element is encoded as `null`, as JSON.stringify does). Non-finite numbers
 * are rejected so a NaN can never hide inside a key.
 */
export function canonical(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical: non-finite number')
    return JSON.stringify(value)
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value)
  if (t === 'undefined') return 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  throw new TypeError(`canonical: unsupported type ${t}`)
}

/** sha256 hex of a string. */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** `H(...)`: a hash over the canonical encoding of its parts (README, keys). */
export function H(...parts) {
  return sha256(canonical(parts))
}
