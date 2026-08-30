/**
 * Shared utility functions for the connection store.
 *
 * Extracted from connection.ts to reduce file size. Contains pure
 * functions with no store dependency — safe to import anywhere.
 *
 * The pure helpers (stripAnsi, nextMessageId, withJitter, filterThinking)
 * live in @chroxy/store-core and are re-exported here for convenience.
 */
import type { ConnectionState, SessionState } from './types';
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
 * #7555 — the FLAT session mirror: the `ConnectionState` fields that hold a
 * copy of the ACTIVE session's `SessionState` value.
 *
 * These are not a cache. `App.tsx` reads the flat `isIdle` for
 * `isBusy={!isIdle}` (the Send/Stop button and the Working banner), the flat
 * `messages` for the transcript, the flat meters for the StatusBar — so a stale
 * mirror is a wrong thing on screen, not a slow one.
 *
 * The roster is exactly `keyof ConnectionState & keyof SessionState`, and the
 * `_flatSessionFieldsAreDeclaredOnBothInterfaces` binding below makes `tsc`
 * enforce one half of that. The other half — that no field declared on both
 * interfaces is MISSING here — is a structural read of `types.ts` in
 * `flat-session-mirror-reset.test.ts`, so a thirteenth field is red until
 * someone classifies it. A hand-list beside the state type is the drift class
 * this issue is an instance of (`docs/false-safety-guards.md`, "a hardcoded
 * list next to a set that grows"): #7550 fixed ONE member of this roster at the
 * consumer, and the other eleven were still stale.
 */
export const FLAT_SESSION_FIELDS = [
  'messages',
  'streamingMessageId',
  'claudeReady',
  'activeModel',
  'permissionMode',
  'contextUsage',
  'contextOccupancy',
  'lastResultCost',
  'lastResultDuration',
  'isIdle',
  'primaryClientId',
  'terminalRawBuffer',
] as const;

export type FlatSessionField = (typeof FLAT_SESSION_FIELDS)[number];

/**
 * Compile-time half of the roster contract: every name above must be declared
 * on BOTH interfaces. A typo, or a field that only exists on one of them, is a
 * typecheck error rather than a test that quietly stops covering it.
 */
const _flatSessionFieldsAreDeclaredOnBothInterfaces:
  readonly (keyof ConnectionState & keyof SessionState)[] = FLAT_SESSION_FIELDS;
void _flatSessionFieldsAreDeclaredOnBothInterfaces;

/**
 * #7555 — the two roster members `updateSession` deliberately does NOT mirror,
 * with the reason each is excluded. Written as an EXCLUSION list so the default
 * for a new flat field is "mirrored": the failure this issue is about is a
 * field that nobody remembered to add, and the safe direction for that mistake
 * is to mirror one field too many rather than one too few.
 */
export const FLAT_SESSION_FIELDS_NOT_MIRRORED: Record<string, string> = {
  primaryClientId:
    "#5731 T2 — mirrored by `switchSession`'s two branches, not by `updateSession`. The " +
    'presence/"who is driving" badge is re-established by `primary_changed` / `session_role`, ' +
    'which write the flat slot themselves.',
  terminalRawBuffer:
    '#5982 — the raw PTY buffer is written through the terminal write-batching path, not through ' +
    'a `SessionState` patch. Mirroring it here would re-broadcast a multi-MB buffer on every ' +
    'unrelated session patch.',
};

/**
 * The roster `updateSession` mirrors into the flat connection state when the
 * patched session is the active one. Derived, so adding a flat field lands in
 * the mirror AND in every reset without a second edit.
 */
export const UPDATE_SESSION_MIRRORED_FIELDS: readonly FlatSessionField[] =
  FLAT_SESSION_FIELDS.filter((f) => !(f in FLAT_SESSION_FIELDS_NOT_MIRRORED));

/**
 * #7555 — the flat mirror of "no session", for the three sites that empty the
 * session roster wholesale (`forgetSession`, `_resetSessionMemory`, `auth_ok`'s
 * non-reconnect branch).
 *
 * Sourced from {@link createEmptySessionState} rather than from a literal, so
 * the value the flat slot falls back to and the value a fresh shell starts at
 * are the same value by construction. Without this the mirror survived the
 * roster wipe and described a session that no longer exists — on a server that
 * may not even be the one it came from (#7555).
 */
export function createEmptyFlatSessionMirror(): Pick<SessionState, FlatSessionField> {
  const empty = createEmptySessionState() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of FLAT_SESSION_FIELDS) out[field] = empty[field];
  return out as Pick<SessionState, FlatSessionField>;
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

/**
 * #7516 — is `sessionId` present in the roster the tab strip renders from?
 *
 * ONE implementation, two vantage points. `switchSession` asks it to decide
 * whether an id may become `activeSessionId` (#7475/#7511, the choke point);
 * the notification surfaces ask the SAME question at RENDER time, so the
 * operator is never offered a jump the choke point is going to refuse. The
 * invariant that buys is "looks clickable ⟺ will work", and it holds because
 * both readings are the same function over the same array — a second
 * hand-rolled `sessions.some(...)` in a component would be the copy that
 * drifts, which is exactly what #7475 collapsed four call-site copies into one
 * door to avoid.
 *
 * `sessions` is the only correct source, and `sessionStates` is not a
 * substitute even though it looks like one: it retains a closed session's
 * transcript, which is how follow-mode's `hasSession()` gate walked onto a dead
 * session while appearing to be guarded (#7475).
 *
 * Typed on the structural minimum rather than `SessionInfo[]` so a caller
 * holding a narrower projection of the roster can still use it — and so this
 * file keeps its "pure functions with no store dependency" property.
 */
export function isSessionListed(
  sessions: readonly { sessionId: string }[],
  sessionId: string,
): boolean {
  return sessions.some((s) => s.sessionId === sessionId);
}
