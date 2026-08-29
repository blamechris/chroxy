/**
 * Shared utility functions for the connection store.
 *
 * Extracted from connection.ts to reduce file size. Contains pure
 * functions with no store dependency — safe to import anywhere.
 *
 * The pure helpers (stripAnsi, nextMessageId, withJitter, filterThinking)
 * live in @chroxy/store-core and are re-exported here for convenience.
 */
import type { SessionState } from './types';
import { createEmptyBaseSessionState } from '@chroxy/store-core';

export {
  stripAnsi,
  nextMessageId,
  withJitter,
  filterThinking,
} from '@chroxy/store-core';

/** Create a fresh empty SessionState */
export function createEmptySessionState(): SessionState {
  return {
    ...createEmptyBaseSessionState(),
    terminalRawBuffer: '',
    selectedFilePath: null,
    thinkingLevel: 'default',
    // #3646: default to `null` (not `undefined`) so the field is always
    // present in the same shape the handler uses to clear it. Prevents
    // tests from having to handle `toBeUndefined()` (initial) vs
    // `toBeNull()` (cleared) for the same field.
    pendingEvaluatorClarify: null,
  };
}

/**
 * #7470 — drop every id in `removedIds` from a session-keyed map, returning a
 * NEW object only when something was actually removed.
 *
 * The same-reference return on a no-op is load-bearing, not an optimisation
 * detail: these maps are read through `useShallow` selectors, and rebuilding
 * them on every `session_list` snapshot (one per session lifecycle event, plus
 * every reconnect) would re-render each consumer for a value that did not
 * change.
 *
 * Inputs are treated as immutable — the source map is never mutated.
 *
 * Membership is an OWN-property test, deliberately not `in`. `in` walks the
 * prototype chain, so `prune({ a: 1 }, ['toString'])` would find a "match",
 * clone, and return a NEW object with identical contents — defeating the
 * same-reference guarantee above. Unreachable with today's session ids
 * (`[a-f0-9]{32}`), but this helper is generic and exported, and its contract
 * is reference identity: `__proto__` / `constructor` / `hasOwnProperty` must
 * not be able to break it (PR #7481 review N1).
 *
 * Spelled `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`:
 * the latter is ES2022 and this package's `lib` predates it, so it fails
 * `tsc --noEmit`. Caught by running the typecheck for its bare exit code.
 */
export function pruneSessionKeyedMap<T>(
  map: Record<string, T>,
  removedIds: readonly string[],
): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const id of removedIds) {
    if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
    if (!next) next = { ...map };
    delete next[id];
  }
  return next ?? map;
}

/**
 * #7483 — the `Set` sibling of `pruneSessionKeyedMap`, for a collection whose
 * members are SESSION-SCOPED COMPOSITE keys rather than bare session ids.
 *
 * `cancellingActivityIds` is keyed `${sessionId}:${activityId}` on purpose:
 * activity ids are provider tool-use ids and are only unique WITHIN a session,
 * so an activityId-only set would let one session's cancel disable another
 * session's identically-ided node (#5277). That composite is exactly why
 * `pruneSessionKeyedMap` cannot be reused here — it is an exact own-key test
 * against a `Record`, and no member of this set is ever equal to a session id.
 *
 * It lives BESIDE that helper rather than as a filter at the call site so the
 * next collection to join the session-removal roster picks a pruner by SHAPE.
 * A hand-rolled `[...set].filter(k => !removedIds.some(id => k.startsWith(id)))`
 * is the shape this exists to prevent — see the anchoring rule below.
 *
 * ## The match is ANCHORED on the first `:`
 *
 * A session id is compared against the segment BEFORE the first delimiter, not
 * against a prefix of the whole key. `'sess-ab:1'.startsWith('sess-a')` is
 * true, so an unanchored implementation prunes a NEIGHBOUR's keys — the
 * "guard whose comment describes a stronger check than its code performs"
 * class from docs/false-safety-guards.md. Today's ids are 32 hex characters so
 * a real collision is unreachable, and that is a property of the id alphabet
 * rather than of this helper, which is generic and exported.
 *
 * Anchoring on the FIRST delimiter also keeps the tail out of the comparison:
 * activity ids are not guaranteed colon-free, and only the session-id half may
 * decide the match.
 *
 * A member with NO delimiter is KEPT. It cannot be attributed to a session, and
 * a prune may only remove what it can prove belongs to a removed one.
 * (Unreachable from `sendCancelActivity`, which always writes the composite.)
 *
 * Same same-reference contract as `pruneSessionKeyedMap`, and load-bearing for
 * the same reason: the Control Room subscribes to this set, so returning a
 * fresh `Set` on every `session_list` that closed some unrelated session would
 * re-render the whole panel for a value that did not change.
 *
 * There is deliberately NO `removedIds.length === 0 || keys.size === 0` early
 * return, and the sibling above has none either. It looks like a cheap fast
 * path and is behaviourally UNOBSERVABLE: with either input empty the loop
 * body never runs, `next` stays null, and `return next ?? keys` already hands
 * back the same reference. PR #7489 review measured both halves against every
 * input class — empty/empty, empty keys, empty ids, no-match, match,
 * delimiter-less, all-removed — and found no distinguishing input, so under
 * the untestable-guard rule it is cut rather than kept with a test that cannot
 * fail. (The assertion originally offered as its proof compared a fresh empty
 * `Set` against an unrelated one, which is true whatever the helper does.)
 *
 * Inputs are treated as immutable — the source set is never mutated.
 */
export function pruneSessionScopedKeySet(
  keys: Set<string>,
  removedIds: readonly string[],
): Set<string> {
  const removed = new Set(removedIds);
  let next: Set<string> | null = null;
  for (const key of keys) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    if (!removed.has(key.slice(0, sep))) continue;
    if (!next) next = new Set(keys);
    next.delete(key);
  }
  return next ?? keys;
}
