import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { isoFromEpochMs, MAX_WIRE_DATETIME_MS } from '../src/utils/iso-datetime.js'

// #7081 — the loaders behind `z.string().datetime()` fields guarded their epoch-ms
// input for TYPE (finite, positive) while the schema constrains RANGE. There is a
// band where `new Date(ms).toISOString()` SUCCEEDS but emits an expanded-year
// string the wire rejects, which failed the whole snapshot's safeParse.
describe('isoFromEpochMs (#7081)', () => {
  // The actual wire constraint, not a hand-rolled approximation of it. If Zod's
  // `.datetime()` ever widened to accept expanded years, this test is what tells us
  // the ceiling can be raised.
  const wireCap = z.string().datetime()

  it('the cap is exactly the last instant that keeps a 4-digit year', () => {
    assert.equal(MAX_WIRE_DATETIME_MS, 253402300799999)
    assert.equal(new Date(MAX_WIRE_DATETIME_MS).toISOString(), '9999-12-31T23:59:59.999Z')
    assert.equal(
      new Date(MAX_WIRE_DATETIME_MS + 1).toISOString(),
      '+010000-01-01T00:00:00.000Z',
      'one ms later is expanded-year — this is the boundary the wire cares about',
    )
  })

  it('CONTROL: an ordinary timestamp round-trips and satisfies the real wire schema', () => {
    const iso = isoFromEpochMs(1785000000000)
    assert.equal(typeof iso, 'string')
    assert.ok(wireCap.safeParse(iso).success)
  })

  it('accepts the cap itself (the bound is inclusive)', () => {
    const iso = isoFromEpochMs(MAX_WIRE_DATETIME_MS)
    assert.equal(iso, '9999-12-31T23:59:59.999Z')
    assert.ok(wireCap.safeParse(iso).success)
  })

  it('returns null one ms past the cap — where toISOString still SUCCEEDS', () => {
    // The whole point: this input does not throw. Only the range check catches it.
    assert.doesNotThrow(() => new Date(MAX_WIRE_DATETIME_MS + 1).toISOString())
    assert.equal(isoFromEpochMs(MAX_WIRE_DATETIME_MS + 1), null)
  })

  it('returns null across the whole expanded-year band, and past Date range', () => {
    for (const ms of [253402300800000, 1795000000000000, 8640000000000000, 8640000000000001, 1e300]) {
      assert.equal(isoFromEpochMs(ms), null, `${ms} must not yield a wire-illegal string`)
    }
  })

  it('every rejected value would otherwise have failed the wire schema', () => {
    // Proves the guard is not over-eager: each value it refuses is one the schema
    // would have refused too (or that throws), so nothing legal is being lost.
    for (const ms of [MAX_WIRE_DATETIME_MS + 1, 253402300800000, 8640000000000000]) {
      let iso = null
      try { iso = new Date(ms).toISOString() } catch { iso = null }
      assert.ok(iso !== null, `${ms} should be Date-representable (that is what makes it dangerous)`)
      assert.equal(wireCap.safeParse(iso).success, false, `${ms} -> ${iso} must be wire-illegal`)
    }
  })

  it('returns null for non-numeric, non-finite, and non-positive input', () => {
    for (const bad of [undefined, null, 'now', {}, [], NaN, Infinity, -Infinity, -1, 0]) {
      assert.equal(isoFromEpochMs(bad), null, `${String(bad)} must yield null`)
    }
  })

  it('allowEpoch admits 0 without admitting negatives', () => {
    assert.equal(isoFromEpochMs(0, { allowEpoch: true }), '1970-01-01T00:00:00.000Z')
    assert.equal(isoFromEpochMs(-1, { allowEpoch: true }), null)
  })
})
