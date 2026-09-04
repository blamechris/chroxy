/**
 * Direct unit tests for the fixture field matchers (#7618).
 *
 * WHY THIS FILE EXISTS. The two container-lost fixtures consume `isTimestamp`,
 * and an adversarial audit of #7618 showed what that consumption does and does
 * not prove: making `isTimestamp` return a constant `false` turns both fixtures
 * red, but making it return a constant `true` leaves the ENTIRE repo green.
 * A predicate whose only exercise is through a caller that supplies one
 * satisfying value cannot catch its own weakening — the same shape as a
 * `describeVerdict` that returns a constant and survives every test that only
 * asserts a verdict was described.
 *
 * So the matcher's own discrimination is asserted here, on both sides of every
 * boundary it draws. A constant-`true` implementation fails the reject cases; a
 * constant-`false` one fails the accept cases; `>=` instead of `>` fails the
 * zero case. There is no implementation that passes this file without actually
 * discriminating.
 */
import { describe, it, expect } from 'vitest'
import { isTimestamp } from './fixtures'

describe('isTimestamp (#7618)', () => {
  // ACCEPT — the armed state. A real clock reading is the only thing the
  // handler ever writes here (`containerLostAt: Date.now()`).
  it('accepts a real clock reading', () => {
    expect(isTimestamp(Date.now())).toBe(true)
  })

  it('accepts the smallest positive integer, so the boundary is > 0 and not >= 1', () => {
    expect(isTimestamp(1)).toBe(true)
  })

  // REJECT — the un-armed state. `null` is what `createEmptySessionState` and
  // `clearContainerLostPatch` both write, so this is THE case that makes the
  // matcher worth having: a client that drops the patch leaves `null` here.
  it('rejects null, the un-armed value both the empty state and the clear patch write', () => {
    expect(isTimestamp(null)).toBe(false)
  })

  it('rejects undefined, the value an absent field reads as', () => {
    expect(isTimestamp(undefined)).toBe(false)
  })

  // Guards the `> 0` boundary specifically: weakening it to `>= 0` admits the
  // zero-initialised un-armed value and this case goes red.
  it('rejects 0, so a zero-initialised field does not read as armed', () => {
    expect(isTimestamp(0)).toBe(false)
  })

  it('rejects a negative number', () => {
    expect(isTimestamp(-1)).toBe(false)
  })

  // Guards `Number.isFinite`: dropping it admits both of these.
  it('rejects NaN and Infinity', () => {
    expect(isTimestamp(Number.NaN)).toBe(false)
    expect(isTimestamp(Number.POSITIVE_INFINITY)).toBe(false)
  })

  // Guards `typeof === 'number'`: a numeric STRING is what a field would hold
  // if a timestamp ever survived a JSON round-trip as text, and it is not armed.
  it('rejects a numeric string', () => {
    expect(isTimestamp('1788551596346')).toBe(false)
  })

  it('rejects the non-scalars a session field could otherwise hold', () => {
    expect(isTimestamp({})).toBe(false)
    expect(isTimestamp([])).toBe(false)
    expect(isTimestamp(true)).toBe(false)
  })
})
