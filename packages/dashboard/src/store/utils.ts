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
 * "A copy of the active session's value" is the rule for eleven of the twelve.
 * `primaryClientId` is the exception and it is worth being exact about, because
 * a neighbouring docstring says the opposite: the server routes `primary_changed`
 * to two DISTINCT slots, and `resolveActivePrimaryClientId`
 * (`components/ViewersIndicator.tsx`) deliberately IGNORES the flat slot
 * whenever a session is active, reading the per-session one instead — the flat
 * slot is the default / no-session-context primary (#5281 ①.3). It belongs in
 * this roster because it is declared on both interfaces and because nulling it
 * at three connection teardowns is right either way, not because the UI reads it
 * as the active session's value (#7564 review, finding 7).
 *
 * The roster is exactly `keyof ConnectionState & keyof SessionState`, and the
 * `_flatSessionFieldsAreDeclaredOnBothInterfaces` binding below makes `tsc`
 * enforce one half of that. The other half — that no field declared on both
 * interfaces is MISSING here — is the TypeScript CHECKER, run over `types.ts` in
 * `flat-session-mirror-reset.test.ts` (a regex over the source had a blind spot
 * for a member whose type starts on the next line, and #7564's review walked a
 * thirteenth field straight through it), so a thirteenth field is red until
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
export const FLAT_SESSION_FIELDS_NOT_MIRRORED = {
  primaryClientId:
    "#5731 T2 — mirrored by `switchSession`'s two branches, not by `updateSession`. The " +
    'presence/"who is driving" badge is re-established by `primary_changed` / `session_role`, ' +
    'which write the flat slot themselves.',
  terminalRawBuffer:
    '#5982 — the raw PTY buffer is written through the terminal write-batching path, not through ' +
    'a `SessionState` patch. Mirroring it here would re-broadcast a multi-MB buffer on every ' +
    'unrelated session patch.',
  // #7564 review (finding 2, and Copilot's thread) — `satisfies Partial<Record<
  // FlatSessionField, string>>` rather than `Record<string, string>`, which
  // accepted ANY key. A one-character typo (`primaryClientId` →
  // `primaryClientld`) silently promoted the field back into
  // `UPDATE_SESSION_MIRRORED_FIELDS`, and `tsc` plus all 1458 store tests stayed
  // green — the same edit against `terminalRawBuffer` would re-enable exactly
  // the multi-MB re-broadcast its reason string exists to prevent. The argument
  // that an exclusion list is the safe DIRECTION for this mistake only holds if
  // the keys are real.
} as const satisfies Partial<Record<FlatSessionField, string>>;

/**
 * The roster `updateSession` mirrors into the flat connection state when the
 * patched session is the active one. Derived, so adding a flat field lands in
 * the mirror AND in every reset without a second edit.
 */
export const UPDATE_SESSION_MIRRORED_FIELDS: readonly FlatSessionField[] =
  FLAT_SESSION_FIELDS.filter(
    // OWN property, not `in` — the same hygiene `pruneSessionKeyedMap` uses, and
    // it closes `in`'s prototype-chain surface: a future flat field named
    // `toString` or `constructor` would otherwise be excluded from the mirror by
    // `Object.prototype` alone (#7564 review).
    (f) => !Object.prototype.hasOwnProperty.call(FLAT_SESSION_FIELDS_NOT_MIRRORED, f),
  );

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
 * #7559 / #7557 — the CONNECTION-scoped roster: the fields whose correct
 * lifetime is "this connection to this daemon", in ONE place because there is
 * more than one site that ends a connection.
 *
 * ## Why it is a roster and not sixteen literals
 *
 * These were spelled out inside `disconnect()` alone, and `disconnect()` is not
 * the only way a connection ends. `switchServer` / `connectLocal` call it only
 * `if (get().connectionPhase !== 'disconnected')`, so a switch made from a tab
 * that is ALREADY at `'disconnected'` — the state a FAILED CONNECT leaves
 * behind, with server A's values fully populated — ran `_resetSessionMemory()`
 * alone and every one of these survived into server B's UI (#7559).
 *
 * The fix is this function, spread into BOTH `disconnect()` and
 * `_resetSessionMemory()`. Copying the sixteen assignments into the second site
 * would have been the same defect one file over: a hardcoded list beside a set
 * that grows (`docs/false-safety-guards.md`). Adding a field here now clears it
 * on every connection boundary at once, and `session-destroy-prunes-pr-maps.
 * test.ts` resolves this roster when it checks where a field dies, so the two
 * cannot disagree about what the spread contains.
 *
 * ## The two members worth naming
 *
 * `serverCapabilities` is the FAIL-OPEN one: an empty map is the "fail-closed
 * for any capability-gated affordance" state (#3272 review), so server A's
 * advertised capabilities gating server B's UI is the failure this clear
 * prevents. `availablePermissionModes` is the SHARP one: `auth_ok` re-sets it
 * only CONDITIONALLY (`message-handler.ts`, `if (auth.availablePermissionModes)`),
 * so an older server B that omits the field leaves server A's mode list driving
 * the permission-mode picker — nothing else overwrites it (#7564 review).
 *
 * ## This roster is the STORE-STATE portion, not all connection-scoped state
 *
 * Connection-scoped state whose home is NOT the store lives in `message-handler.
 * ts` / store-core as module-level trackers — the outgoing message queue, the
 * replay history cursors, the in-flight transcript-fetch tracking. Those have
 * the same "this connection to this daemon" lifetime as the fields here, but a
 * store spread cannot reach them, so `disconnect()` and `_resetSessionMemory()`
 * clear them with explicit calls (`clearMessageQueue()` / `resetReplayReconcile
 * ({ clearCursors: true })` / `resetTranscriptFetchTracking()`) ALONGSIDE this
 * spread (#7578). Adding a new module-level tracker of that class means adding
 * its clear at both sites — this factory is not where it lands.
 *
 * A fresh object per call: these are mutable collections handed to the store.
 */
export function createEmptyConnectionScope() {
  return {
    // A half-typed permission reply is dead with the socket. #6559 — this also
    // drops any pulled pre-write-diff inputs; a resolved/expired/timed-out
    // prompt already self-prunes.
    permissionInputs: {},
    // The requestIds belong to the dropped connection.
    resolvedPermissions: {},
    // #3272 review: a reconnect against a different (or older) server must not
    // have its UI gates left enabled by stale state. Empty map = fail-closed
    // for any capability-gated affordance.
    serverCapabilities: {},
    // The provider registry is per daemon.
    availableProviders: [],
    // The model list is per daemon/provider.
    availableModels: [],
    // The mode enum is advertised per daemon, and `auth_ok` re-sets it only
    // when the server sends it — see the docstring above.
    availablePermissionModes: [],
    // The presence roster belongs to the dropped socket.
    connectedClients: [],
    // Web-task list is per daemon.
    webTasks: [],
    // Project commands differ per daemon and per session cwd.
    slashCommands: [],
    // A listing of the OLD daemon's filesystem.
    filePickerFiles: null,
    // The MCP resource list is per daemon.
    mcpResources: null,
    // Project agents differ per daemon and per session cwd.
    customAgents: [],
    // Transcripts pulled from the OLD daemon.
    conversationHistory: [],
    // A search over the OLD daemon's transcripts.
    searchResults: [],
    // Checkpoints belong to a session on the old daemon.
    checkpoints: [],
    // Container/worktree environments are per daemon — and since #7552
    // `EnvironmentInfo.sessions` carries LIVE session ids from one daemon, which
    // the panel renders ("{n} connected") and gates its Destroy button on.
    environments: [],
    // #7557 — the twelfth never-cleared field, adjudicated onto THIS roster
    // rather than onto the two full-reset sites. Its two siblings in the same
    // banner list, `serverErrors` and `sessionNotifications`, are both cleared
    // by `disconnect()` and by neither full-reset site, so the connection is
    // already where host-level notice history dies. #7528's precedent (a
    // notification row is a RECORD and must survive the SESSION it describes)
    // is about session death, not connection death, and is untouched: nothing
    // here is pruned by a roster wipe.
    infoNotifications: [],
  } satisfies Partial<ConnectionState>;
}

/**
 * The roster's field NAMES are deliberately not exported: the two test files
 * that need them derive them with `Object.keys(createEmptyConnectionScope())`,
 * from this one factory, so there is nothing for a second declaration to drift
 * from — and no production-unreferenced export for
 * `scripts/lint-write-only-ctx-fields.mjs` to warn about.
 */

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
