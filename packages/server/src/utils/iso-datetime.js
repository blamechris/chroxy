/**
 * #7081 — epoch-ms → wire-legal ISO 8601, or null.
 *
 * Several outbound fields are `z.string().datetime()` in @chroxy/protocol
 * (`skills.ts` `lastUsed`, control-room `RepoMemoryCache.lastModified`, …) and are
 * produced by `new Date(ms).toISOString()` from a number read off disk. Those
 * loaders guarded the number for TYPE (finite, positive) while the schema
 * constrains RANGE, which leaves a band where `toISOString()` succeeds but emits
 * something the wire rejects:
 *
 *   253402300799999  -> '9999-12-31T23:59:59.999Z'    accepted
 *   253402300800000  -> '+010000-01-01T00:00:00.000Z' REJECTED by .datetime()
 *   8640000000000000 -> '+275760-09-13T00:00:00.000Z' REJECTED by .datetime()
 *   8640000000000001 -> RangeError
 *
 * ES2015+ requires the expanded-year form (`±YYYYYY`) once the year leaves
 * [0, 9999], and `z.string().datetime()` only accepts a 4-digit year. So the
 * usable ceiling is the last instant of year 9999 — NOT `Date`'s ±8.64e15 limit,
 * which is the bound `scheduled-task-store.js` uses for a different purpose
 * (representable-as-a-Date, not representable-on-the-wire). Do not conflate them.
 *
 * Returns `null` rather than clamping. Every consuming field is `.nullable()`, and
 * a clamped timestamp is a LIE rendered to the operator: "last used in the year
 * 9999" is not more truthful than "never recorded", it is just harder to notice.
 */

/** Last epoch-ms whose ISO form keeps a 4-digit year (`9999-12-31T23:59:59.999Z`). */
export const MAX_WIRE_DATETIME_MS = 253402300799999

/**
 * Convert an epoch-ms value to an ISO string the wire can carry.
 *
 * @param {unknown} ms - candidate epoch-ms; anything non-numeric yields null
 * @param {{ allowEpoch?: boolean }} [opts] - `allowEpoch` permits 0 (the Unix
 *   epoch). Off by default because the existing callers treat 0 as "never
 *   recorded" rather than as 1970-01-01.
 * @returns {string|null} an ISO 8601 string with a 4-digit year, or null
 */
export function isoFromEpochMs(ms, { allowEpoch = false } = {}) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  if (allowEpoch ? ms < 0 : ms <= 0) return null
  if (ms > MAX_WIRE_DATETIME_MS) return null
  // Defensive: a fractional value is legal here (Date accepts it and truncates),
  // so this cannot throw after the range check above — but a future caller
  // passing something exotic should degrade to null rather than crash a snapshot.
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}
