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
 * prevents. `permissionModesByProvider` is the SHARP one: `auth_ok` re-sets it
 * only CONDITIONALLY (`message-handler.ts`, `if (auth.availablePermissionModes)`),
 * so an older server B that omits the field leaves server A's mode rosters driving
 * the permission-mode picker — nothing else overwrites it (#7564 review).
 *
 * ## This roster is the STORE-STATE portion, not all connection-scoped state
 *
 * Connection-scoped state whose home is NOT the store lives in
 * `message-handler.ts` / store-core as module-level trackers — the outgoing
 * message queue, the replay history cursors, the in-flight transcript-fetch
 * tracking, the un-flushed
 * streaming delta buffers, and the batched terminal writes. Those have the same
 * "this connection to this daemon" lifetime as the fields here, but a store
 * spread cannot reach them, so `disconnect()` and `_resetSessionMemory()` clear
 * them with explicit calls (`clearMessageQueue()` / `resetReplayReconcile({
 * clearCursors: true })` / `resetTranscriptFetchTracking()` / `clearDeltaBuffers
 * ()` / `clearTerminalWriteBatching()`) ALONGSIDE this spread (#7578). Adding a
 * new module-level tracker of that class means adding its clear at BOTH sites,
 * by hand and in lockstep — the drift that keeps having to be caught is why
 * follow-on #7592 (extract one shared teardown helper) exists. This factory is
 * not where it lands.
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
    // #7353: same lifetime as resolvedPermissions — the requestIds belong to the
    // dropped connection.
    dismissedExpiredPermissions: {},
    // #3272 review: a reconnect against a different (or older) server must not
    // have its UI gates left enabled by stale state. Empty map = fail-closed
    // for any capability-gated affordance.
    serverCapabilities: {},
    // The provider registry is per daemon.
    availableProviders: [],
    // The model rosters are per daemon/provider (#7728: one per provider).
    modelsByProvider: {},
    // The mode rosters are advertised per daemon (#8224: one per provider), and
    // `auth_ok` re-sets one only when the server sends it — see the docstring.
    permissionModesByProvider: {},
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
    // #7594: a destroy refusal answers the OLD daemon's live-session roster; on
    // another daemon (or after a reconnect) it would offer a Force for sessions
    // that are no longer there.
    environmentDestroyRefusals: {},
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
 * #7588 — the ACTIVE-SESSION PANEL roster: the flat, per-active-session pulls
 * (`permission_audit_result` #6772, `memory_stack_result` #6867 / #6996) and their
 * request/error flags. The panel renders whichever session is active, so its
 * contents are only true of THAT session on THAT daemon.
 *
 * The name is not `createEmptyActiveSessionPanels` (the issue's) on purpose: that
 * spelling contains `ptyActive`, which `store.test.ts`'s "PTY dead code removal"
 * source scan (#1759) forbids anywhere in `connection.ts`.
 *
 * ## Why it is its own roster
 *
 * Its lifetime is not `createEmptyConnectionScope()`'s ("this connection"): it
 * also dies when the ACTIVE SESSION changes while the socket lives on. Seven
 * literals were hand-copied across `switchSession`, the `session_list`
 * active-removal death path and the `session_timeout` death path (plus the test's
 * expected values), and #7546 was the copy that went missing: `switchSession`
 * reset them, the death paths did not, and a dead session's memory stack and
 * permission history rendered against whichever session became active next.
 *
 * It is spread or applied at exactly six sites: `switchSession` (one `set` ahead
 * of both the cached and the uncached branch), the `session_list` active-removal
 * death path, the `session_timeout` death path, `disconnect()`, `forgetSession`
 * and `_resetSessionMemory`. A panel field added here is cleared at all six; one
 * added anywhere else is not, and `store/reset-factories.test.ts` holds that line.
 *
 * It is NOT every path that changes the active session. `handleSessionSwitched`
 * (`session_switched`), `auth_ok`'s non-reconnect branch (`activeSessionId: null`)
 * and the `session_error` SESSION_NOT_FOUND write (`activeSessionId: null`) move
 * the active session without it; they predate this factory and are tracked
 * (#8488). `session_switched` in particular is not given the reset blindly: it
 * also echoes the user's own switch, which `switchSession` has already reset, and
 * an unconditional clear there could wipe a pull that was answered in between.
 *
 * `permissionAuditLoading` and `memoryStackLoading` ALSO belong to
 * `createEmptyInFlightMarkers()` (the transport-drop clear, #8378), with the same
 * value. The overlap is deliberate: dropping them from the markers would leave a
 * spinner latched after a socket drop, and dropping them here would leave one
 * latched across a session change (the in-flight pull belongs to the old
 * session). `reset-factories.test.ts` pins that these two are the ONLY overlap and
 * that the values agree.
 *
 * `lastMemoryStackRequestId` is deliberately NOT here. It is the correlation
 * nonce `handleMemoryStackResult` uses to drop a superseded reply, and a `null`
 * nonce APPLIES every reply, so nulling it on a session switch would let the
 * previous session's in-flight reply land on the new one. It is connection-
 * lifetime (`createEmptyConnectionReadings()`), not per-session.
 *
 * `primaryClientId` is not here either: its reset value differs per branch (the
 * new session's cached owner, or `null`), so it is not a constant.
 *
 * A fresh object per call, like its siblings.
 */
export function createEmptySessionPanels() {
  return {
    // #6772: the permission-audit history is scoped to the active session
    // (`queryPermissionAudit`). The loading + error flags reset with it so an
    // in-flight pull for the old session cannot wedge the button.
    permissionAudit: null,
    permissionAuditLoading: false,
    permissionAuditError: false,
    // #6996: the merged CLAUDE.md stack is the active session's cwd. Without the
    // reset `MemoryPanel`'s `entries === null` mount-guard never re-fires across
    // a switch and the panel keeps showing the previous session's stack.
    memoryStackEntries: null,
    memoryStackFile: null,
    memoryStackError: null,
    memoryStackLoading: false,
  } satisfies Partial<ConnectionState>;
}

/**
 * #8411 — the CONNECTION-LIFETIME READINGS roster: the object-shaped, transient
 * answers to requests made on ONE daemon's socket (the IDE navigation results,
 * the permission-confirm dialog, the memory-read correlation nonce).
 *
 * ## Why it is its own roster
 *
 * These were cleared inline by `disconnect()` and by NEITHER full-reset site.
 * `switchServer` / `connectLocal` run `disconnect()` only
 * `if (connectionPhase !== 'disconnected')`, and a failed connect rests at
 * exactly that phase with the previous server's values populated, so that switch
 * reached `_resetSessionMemory()` alone and carried all of them across (#7559
 * closed the same hole for the collection-shaped fields, via
 * `createEmptyConnectionScope()`).
 *
 * It is not folded into `createEmptyConnectionScope()` because that roster is
 * deliberately NOT spread by `forgetSession` (the taxonomy rewrite is #8207's),
 * and these must die at `forgetSession` as well: the direct `connect()` to a
 * different URL reaches it alone, and an open "find references" modal or a
 * pending file-open from server A is just as wrong on server B. Spread by
 * `disconnect()`, `forgetSession` and `_resetSessionMemory`.
 *
 * Per-field decisions, in one place:
 * - `pendingPermissionConfirm`, `fileBrowserPendingOpen`, `symbolLocation`
 *   (a one-shot jump with a nonce), `workspaceSymbols`, `codeSearchResults`,
 *   `referencesResult`: replies to requests sent on the dropped socket.
 * - `referencesSymbol` / `referencesOpen`: the modal that shows `referencesResult`;
 *   clearing the result and leaving the modal open would render an empty "find
 *   references" dialog for a symbol of the other daemon.
 * - `lastMemoryStackRequestId`: a correlation nonce for a request on the dropped
 *   socket. See `createEmptySessionPanels()` for why it is NOT per-session.
 * - The `*Loading` siblings (`workspaceSymbolsLoading`, `codeSearchLoading`,
 *   `referencesLoading`) already live in `createEmptyInFlightMarkers()` (#8378)
 *   and are not repeated here.
 *
 * A fresh object per call, like its siblings.
 */
export function createEmptyConnectionReadings() {
  return {
    pendingPermissionConfirm: null,
    fileBrowserPendingOpen: null,
    workspaceSymbols: null,
    symbolLocation: null,
    codeSearchResults: null,
    referencesResult: null,
    referencesSymbol: '',
    referencesOpen: false,
    lastMemoryStackRequestId: null,
  } satisfies Partial<ConnectionState>;
}

/**
 * #7579 — the DAEMON-SNAPSHOT roster: object-shaped state that is a reading of
 * ONE daemon, kept across a same-server Disconnect → Connect, and dropped the
 * moment the tab points at a different daemon.
 *
 * ## Why it is its own roster
 *
 * `createEmptyConnectionScope()` is "this connection to this daemon": cleared by
 * `disconnect()` AND by both full-reset sites. These fields are a different
 * answer to the same question. They are still TRUE of the same daemon across a
 * socket drop or a user Disconnect → Connect — the Control Room's "generated Nm
 * ago" line is the staleness cue, and `socket.onclose` deliberately keeps them
 * (#6153) — but they are NOT true of a different daemon, and #7557 / #7573 gave
 * their SATELLITES (`orchestrationRunDetails`, `credentialTestResults`,
 * `scheduledTaskActionResults`, …) that same lifetime while leaving the
 * PRIMARIES they attach to with none. After a switch the Runs panel rendered
 * server A's run list beside B's empty detail maps, and the credentials pane
 * rendered A's `masked` key previews and A's `fileError` beside B's empty test
 * verdicts, with action buttons that fire at B.
 *
 * So the consumers are the two sites that mean "a different daemon":
 * `forgetSession` (which a direct `connect()` to another URL reaches, #8207) and
 * `_resetSessionMemory` (every `retargetToServer` switch path). NOT `disconnect()`
 * and NOT `auth_ok`'s non-reconnect branch — that branch is also the ordinary
 * Disconnect → Connect to the SAME server, where every field here is still true.
 * `session-destroy-prunes-pr-maps.test.ts` resolves this roster when it checks
 * where a snapshot dies and asserts `disconnect()` does NOT clear a member (the
 * decision is per field, written down there next to a reason, and enforced).
 *
 * ## Per-field decisions, in one place
 *
 * Every member below is preserved across a same-server reconnect, for one of
 * three reasons:
 *   - a SURVEY reading (`hostStatus` … `wslStatus`, `externalSessionsSnapshot`,
 *     `repoEventsSnapshot`, `githubWebhookConfig`, `skillsInventory`,
 *     `integrationStatus`): kept so "generated Nm ago" can signal staleness; a
 *     reconnect re-fetches on tab activation.
 *   - a PRIMARY whose satellites #7557 already keeps across a reconnect
 *     (`orchestrationRuns` / `selectedRunId`, `scheduledTasks` /
 *     `selectedScheduledTaskId` / `scheduledTasksError`,
 *     `credentialsStatus` / `byokCredentialsStatus`): clearing the primary on
 *     disconnect while the run-detail map beside it survives would invert the
 *     defect this roster fixes.
 *   - a server-side PREFERENCE or tally (`monthlyBudget`, `notificationPrefs`)
 *     and the last IDE symbol table (`symbols`) / dead-session chip
 *     (`sessionNotFoundError`): still true of the same daemon. `monthlyBudget` is
 *     re-pushed on connect (the server sends `monthly_budget` once per
 *     handshake); `notificationPrefs` is NOT — the server only broadcasts it
 *     after a `notification_prefs_set`, so Settings re-REQUESTS it
 *     (`notification_prefs_get`, keyed on the completed handshake, #8485).
 *
 * `pendingApprovalPairHost` is deliberately NOT here: it names a saved SERVER
 * REGISTRY entry (the picker's own list), not a reading of the connected daemon.
 *
 * Initial values are asserted equal to the store's initial literal by a test,
 * not by a second hand-kept list. A fresh object per call.
 */
export function createEmptyDaemonSnapshots() {
  return {
    credentialsStatus: null,
    byokCredentialsStatus: null,
    orchestrationRuns: null,
    selectedRunId: null,
    scheduledTasks: null,
    scheduledTasksError: null,
    selectedScheduledTaskId: null,
    hostStatus: null,
    mailboxStatus: null,
    runnerStatus: null,
    containersStatus: null,
    repoRuntimeConfig: null,
    byokPoolStatus: null,
    hostPruneStatus: null,
    integrationStatus: null,
    skillsInventory: null,
    simulatorStatus: null,
    emulatorStatus: null,
    wslStatus: null,
    externalSessionsSnapshot: null,
    repoEventsSnapshot: null,
    githubWebhookConfig: null,
    monthlyBudget: null,
    notificationPrefs: null,
    sessionNotFoundError: null,
    symbols: null,
  } satisfies Partial<ConnectionState>;
}

/**
 * #7586 — the IN-FLIGHT marker roster: every store field that records "a
 * request is outstanding on this socket" (a spinner, a disabled control, a
 * throttle stamp), so that the reply which would clear it can never arrive once
 * the socket is gone.
 *
 * ## Why it is a roster
 *
 * These were cleared by `socket.onclose`, one `if (size > 0) set(...)` block per
 * field, and by nothing else on the user-initiated path: `disconnect()` nulls
 * `socket.onclose` to suppress auto-reconnect, so the sweep never ran for a
 * user Disconnect. A container action started, then Disconnect → Connect to
 * the same server, left the row stuck "actioning" forever (#7586). #7572 fixed
 * the two orchestration markers by copying them into `disconnect()`; this is
 * the rest, done once.
 *
 * `socket.onclose` (through `staleInFlightMarkers` in `connection.ts`),
 * `disconnect()`, `forgetSession` and `_resetSessionMemory` all take their set
 * from THIS factory, so a marker added here is cleared on every path that ends
 * a connection, and a marker that is NOT added here is cleared on none of them
 * — which a roster test (`connection-inflight-markers.test.ts`) can see, where
 * four hand-copied lists drifting apart could not.
 *
 * ## What is deliberately NOT in it
 *
 * Records that stay TRUE of the same daemon across Disconnect → Connect: the
 * `*Results` maps beside each marker (the outcome of an action that already
 * finished), the survey snapshots (kept so the "generated Nm ago" line can
 * signal staleness), and the #7557 family (`orchestrationRunDetails`,
 * `credentialTestResults`, `serverStartupLogs`, `pendingPairRequests`, …).
 * #7572 / #7570 settled that split; this roster is only the request markers.
 *
 * A fresh object per call: these are mutable collections handed to the store.
 */
export function createEmptyInFlightMarkers() {
  return {
    // #5277: an in-flight cancel_activity's ack/failure is socket-scoped. The
    // tree re-seeds from activity_snapshot on resubscribe.
    cancellingActivityIds: new Set<string>(),
    // #5500 / #5502: in-flight reindex / relay re-run requests. The server-side
    // work keeps running; the next survey refresh shows its effect.
    reindexingRepoPaths: new Set<string>(),
    relayRerunningRepoPaths: new Set<string>(),
    // #6134-#6140: in-flight lifecycle actions on a container / BYOK pool /
    // host prune / simulator / emulator / WSL distro.
    containerActioningIds: new Set<string>(),
    // #8407: a `destroy_environment` (plain or Force) sent from the Environments
    // panel and not yet answered. The reply is an `environment_list` without the
    // environment, or an `environment_error`, neither of which exists on a dead
    // socket.
    environmentDestroyingIds: new Set<string>(),
    byokPoolActioningIds: new Set<string>(),
    hostPruneActioningIds: new Set<string>(),
    simulatorActioningIds: new Set<string>(),
    emulatorActioningIds: new Set<string>(),
    wslActioningIds: new Set<string>(),
    // #7625: a pending restore retry can never be acked on a dead socket.
    retryingRestoreIds: new Set<string>(),
    // #6691 (S-3): an in-flight orchestration detail request and a pending
    // mutating action.
    orchestrationRunDetailLoading: new Set<string>(),
    orchestrationPendingActions: {},
    // #7344 / #7430: the session-keyed PR/CI request markers, and the auto-pull
    // throttle window (per CONNECTION: a request made on a socket that no longer
    // exists must not suppress the first re-survey after a reconnect).
    sessionPrStatusLoading: {},
    sessionPrStatusRequestedAt: {},
    sessionPrThreadsLoading: {},
    // #6472: the IDE symbol-table request.
    symbolsLoading: false,
    // #8378: the request/reply spinners that used to be cleared ONLY by a user
    // `disconnect()` (as hand-written literals) and not by a transport drop, so a
    // daemon restart or a network loss mid-request left the panel spinning
    // forever. Each is armed by a send on the live socket and cleared by its
    // reply; neither can arrive on the dead one. Only the flag clears: the
    // results beside each (`workspaceSymbols`, `codeSearchResults`,
    // `referencesResult`, `permissionAudit`, `memoryStackEntries`, `searchResults`)
    // are data, and stay.
    workspaceSymbolsLoading: false,
    codeSearchLoading: false,
    referencesLoading: false,
    permissionAuditLoading: false,
    memoryStackLoading: false,
    conversationHistoryLoading: false,
    searchLoading: false,
    // #6153: every Control Room survey *Loading flag. Each section computes
    // refreshDisabled = loading || !connected, so a refresh in flight when the
    // socket dies would leave loading=true forever. The stale snapshots are KEPT.
    hostStatusLoading: false,
    runnerStatusLoading: false,
    containersStatusLoading: false,
    repoRuntimeConfigLoading: false,
    byokPoolStatusLoading: false,
    hostPruneStatusLoading: false,
    simulatorStatusLoading: false,
    emulatorStatusLoading: false,
    wslStatusLoading: false,
    integrationStatusLoading: false,
    skillsInventoryLoading: false,
    mailboxStatusLoading: false,
    externalSessionsLoading: false,
    repoEventsLoading: false,
    githubWebhookConfigLoading: false,
    orchestrationRunsLoading: false,
    failedRestoresLoading: false,
  } satisfies Partial<ConnectionState>;
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
 * #8407: read a record that is keyed by a SERVER-SUPPLIED id, counting only an
 * OWN key. A plain `rec[id]` also answers for `constructor`, `toString`,
 * `__proto__`... — inherited members that would read as a recorded entry. The
 * ids are server-generated so this is unreachable today; it is cheap enough to
 * make unreachable by construction. (`Object.hasOwn` is ES2022; this package
 * targets ES2020.)
 */
export function getOwn<T>(rec: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return rec && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;
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
