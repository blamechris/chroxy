/**
 * Internal null-prototype map helpers shared by the activity reducer's state
 * (mutation) and selector layers. NOT part of the public @chroxy/store-core
 * surface — the barrel (activity-reducer.ts) does not re-export this module.
 *
 * All dictionaries keyed off WIRE-controlled strings (`bySession` by
 * `sessionId`, `byId` by `ActivityEntry.id`) use a null-prototype map so a
 * malicious / accidental key like `"__proto__"`, `"toString"`, or
 * `"constructor"` can't collide with an inherited `Object.prototype` member.
 * On a plain `{}`, `"toString" in obj` is `true` even when unset (breaking
 * upsert/order bookkeeping) and `obj["__proto__"] = entry` mutates the
 * prototype rather than storing a value — both are closed off here. `hasKey` is
 * the matching own-property check used instead of the `in` operator on these
 * maps. Matches the existing store-core hardening (`freeform-answer.ts`,
 * `types.ts`'s `hasOwnProperty.call` guards).
 */
export function emptyRecord<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>
}

export function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}
