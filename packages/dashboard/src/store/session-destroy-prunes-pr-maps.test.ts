/**
 * #7470 — destroying a session must prune its entry from EVERY per-session
 * PR/CI map in the connection store.
 *
 * The store keeps five session-keyed maps for the PR/CI surface:
 *
 *   sessionPrStatus            (#7344)  full PR + check-rollup snapshot
 *   sessionPrStatusLoading     (#7344)  in-flight flag
 *   sessionPrStatusRequestedAt (#7344)  client-clock auto-pull throttle stamp
 *   sessionPrThreads           (#7430)  unresolved review-thread reading
 *   sessionPrThreadsLoading    (#7430)  in-flight flag
 *
 * `connection.ts` resets the three LOADING-shaped maps on a socket drop, which
 * is a reconnect reset (a control stranded by a reply that will never arrive) —
 * NOT a lifecycle prune. Nothing removed an entry when the session it describes
 * went away, so a long-lived tab accumulated one snapshot per ever-surveyed
 * session id for the life of the connection.
 *
 * ## Four sites, one mechanism
 *
 * "The session went away" has FOUR spellings here. The obvious one is the
 * `session_list` handler's `removedIds` block, where `sessionStates` and the
 * Control Room `activity` tree are already pruned. The other three empty the
 * roster WHOLESALE — `auth_ok`'s non-reconnect branch, `forgetSession`,
 * `_resetSessionMemory` — and because `removedIds` is a diff against
 * `Object.keys(sessionStates)`, emptying the roster leaves nothing to diff:
 * anything not cleared in the same patch is PERMANENTLY unprunable for the life
 * of the tab. So each of the four clears these maps itself.
 *
 * The fourth (`auth_ok`) was missed by the first version of this file and found
 * in review of PR #7481. It is the most ordinary gesture of the four —
 * Disconnect, then Connect to the same server — which is worth remembering
 * before the next "surely the removedIds prune covers this" simplification.
 *
 * ## What these tests are shaped to catch
 *
 * A per-map assertion for EACH of the five at EACH site, never one blanket "the
 * maps no longer mention sess-dead" check: a blanket assertion is satisfied by
 * pruning four of five, which is exactly the adjacent-field failure this issue
 * is an instance of. Mutating away any single clear must turn exactly one
 * assertion red, and the message must name the map AND the site.
 *
 * Plus a POSITIVE CONTROL in every case: the surviving session's entries must
 * come through byte-identical, and a silent RECONNECT must keep all five. Both
 * exist so that `set({ sessionPrStatus: {} })` — clearing everything, always —
 * cannot pass.
 *
 * Plus a roster guard that classifies every session-keyed-shaped collection on
 * `ConnectionState`, so a new one is red until someone says how it is keyed.
 * See its own docstring below for why the first version of that guard did not
 * work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import { handleMessage, setStore, clearDeltaBuffers, clearPermissionSplits, stopHeartbeat, resetReplayFlags } from './message-handler'
import { createEmptySessionState, pruneSessionKeyedMap } from './utils'
import type { ConnectionState } from './types'
import { createEmptyActivityState } from '@chroxy/store-core'
import type { ServerSessionPrStatusMessage, ServerSessionPrThreadsMessage } from '@chroxy/protocol'

const DEAD = 'sess-dead'
const LIVE = 'sess-live'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof s === 'function' ? s(state) : s) }
    },
  }
}
function createMockSocket(): WebSocket {
  return { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
}

/**
 * A realistic `session_pr_status` snapshot. Built to the REAL schema shape
 * (nested `repo` / `pr` / `checks` / `merge`) and typed WITHOUT a cast, so a
 * fixture that drifts from the wire contract fails the typecheck instead of
 * type-checking as whatever the test happens to assert on.
 */
function prStatus(sessionId: string, prNumber: number): ServerSessionPrStatusMessage {
  return {
    type: 'session_pr_status',
    requestId: `req-status-${sessionId}`,
    sessionId,
    generatedAt: '2026-08-28T00:00:00.000Z',
    branch: `feat/${sessionId}`,
    repo: { owner: 'blamechris', name: 'chroxy' },
    pr: {
      number: prNumber,
      title: `PR for ${sessionId}`,
      url: `https://github.com/blamechris/chroxy/pull/${prNumber}`,
      headRefOid: 'deadbeef',
      isDraft: false,
    },
    checks: {
      state: 'success',
      counts: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0, unknown: 0 },
    },
    merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' },
    reason: null,
  }
}

function prThreads(sessionId: string, unresolvedCount: number): ServerSessionPrThreadsMessage {
  return {
    type: 'session_pr_threads',
    requestId: `req-${sessionId}`,
    sessionId,
    countedAt: '2026-08-28T00:00:00.000Z',
    prNumber: 7470,
    unresolvedCount,
    totalCount: unresolvedCount,
    truncated: false,
    reason: null,
  }
}

/**
 * Both sessions are known to the store (they have `sessionStates` entries —
 * that is what `removedIds` is computed against) and both carry an entry in
 * every one of the five maps.
 */
function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected',
    socket: null,
    activeSessionId: LIVE,
    sessions: [
      { sessionId: DEAD, name: 'dead' },
      { sessionId: LIVE, name: 'live' },
    ] as ConnectionState['sessions'],
    sessionStates: {
      [DEAD]: createEmptySessionState(),
      [LIVE]: createEmptySessionState(),
    },
    messages: [],
    availableModels: [],
    // #5163 activity tree — the removedIds block calls `clearSessionActivity`
    // on it, so an undefined value throws there and the PR/CI assertions below
    // would never run (a crash is not a red assertion).
    activity: createEmptyActivityState(),
    sessionPrStatus: { [DEAD]: prStatus(DEAD, 1), [LIVE]: prStatus(LIVE, 2) },
    sessionPrStatusLoading: { [DEAD]: true, [LIVE]: true },
    sessionPrStatusRequestedAt: { [DEAD]: 1000, [LIVE]: 2000 },
    sessionPrThreads: { [DEAD]: prThreads(DEAD, 3), [LIVE]: prThreads(LIVE, 4) },
    sessionPrThreadsLoading: { [DEAD]: true, [LIVE]: true },
  }
}

/** A `session_list` snapshot that no longer contains `sess-dead`. */
function listWithoutDead(): Record<string, unknown> {
  return {
    type: 'session_list',
    sessions: [{ sessionId: LIVE, name: 'live', isBusy: false }],
  }
}

describe('#7470 session destroy prunes the per-session PR/CI maps', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat() })

  // ---- Per-map prune assertions. One `it` per map, so a partial fix fails
  // ---- with the name of the map that was missed.

  it('prunes sessionPrStatus for the destroyed session and leaves the survivor', () => {
    const before = store.getState().sessionPrStatus[LIVE]
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().sessionPrStatus
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    // Positive control: the survivor's snapshot is untouched, so a blanket
    // `sessionPrStatus: {}` cannot satisfy the assertion above.
    expect(after[LIVE]).toBe(before)
    expect(after[LIVE]?.pr?.number).toBe(2)
  })

  it('prunes sessionPrStatusLoading for the destroyed session and leaves the survivor', () => {
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().sessionPrStatusLoading
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe(true)
  })

  it('prunes sessionPrStatusRequestedAt for the destroyed session and leaves the survivor', () => {
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().sessionPrStatusRequestedAt
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    // The survivor's auto-pull stamp must survive intact — clearing it would
    // silently re-open the #7344 request-rate hole for every other tab.
    expect(after[LIVE]).toBe(2000)
  })

  it('prunes sessionPrThreads for the destroyed session and leaves the survivor', () => {
    const before = store.getState().sessionPrThreads[LIVE]
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().sessionPrThreads
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe(before)
    expect(after[LIVE]?.unresolvedCount).toBe(4)
  })

  it('prunes sessionPrThreadsLoading for the destroyed session and leaves the survivor', () => {
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().sessionPrThreadsLoading
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe(true)
  })

  // ---- Shape / no-op properties.

  it('leaves every map untouched (same reference) when no session was removed', () => {
    const before = store.getState()
    const refs = {
      sessionPrStatus: before.sessionPrStatus,
      sessionPrStatusLoading: before.sessionPrStatusLoading,
      sessionPrStatusRequestedAt: before.sessionPrStatusRequestedAt,
      sessionPrThreads: before.sessionPrThreads,
      sessionPrThreadsLoading: before.sessionPrThreadsLoading,
    }
    handleMessage({
      type: 'session_list',
      sessions: [{ sessionId: DEAD, isBusy: false }, { sessionId: LIVE, isBusy: false }],
    }, ctx() as never)
    const after = store.getState()
    // NOTE what this does and does NOT prove: with no removals the handler's
    // `removedIds.length > 0` guard skips the whole block, so this pins the
    // GUARD and says nothing about the prune helper. The helper's own no-op
    // path is pinned by the next test, which drives a real removal.
    for (const key of Object.keys(refs) as (keyof typeof refs)[]) {
      expect(after[key], `${key} must keep its reference when nothing was removed`).toBe(refs[key])
    }
  })

  it('keeps a map\'s reference when the removed session was never in THAT map', () => {
    // The reachable case: a tab has a PR status for both sessions but has only
    // ever counted threads for the survivor. Removing `sess-dead` must not hand
    // `sessionPrThreads` a fresh object — every `useShallow` consumer of it
    // would re-render for a value that did not change, on every session close.
    //
    // This is the test that actually exercises `pruneSessionKeyedMap`'s
    // same-reference return: the previous test's precondition
    // (`removedIds.length > 0`) is false, so the helper never runs there.
    store.setState({ sessionPrThreads: { [LIVE]: prThreads(LIVE, 4) } })
    const untrackedBefore = store.getState().sessionPrThreads
    const trackedBefore = store.getState().sessionPrStatus
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState()
    expect(after.sessionPrThreads).toBe(untrackedBefore)
    // Positive control for THIS test: a map that did hold the removed id is
    // rebuilt, so the assertion above cannot be passing because the prune
    // never ran at all.
    expect(after.sessionPrStatus).not.toBe(trackedBefore)
    expect(after.sessionPrStatus[DEAD]).toBeUndefined()
  })

  it('prunes every removed session when several disappear at once', () => {
    handleMessage({ type: 'session_list', sessions: [] }, ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus).toEqual({})
    expect(s.sessionPrStatusLoading).toEqual({})
    expect(s.sessionPrStatusRequestedAt).toEqual({})
    expect(s.sessionPrThreads).toEqual({})
    expect(s.sessionPrThreadsLoading).toEqual({})
  })
})

/**
 * #7470 (fourth site, PR #7481 review Critical 1) — a FRESH `auth_ok`.
 *
 * `auth_ok`'s non-reconnect branch empties `sessions` / `activeSessionId` /
 * `sessionStates` before any `session_list` arrives. That ordering is what makes
 * this its own site rather than a case the removedIds prune covers:
 * `removedIds` is a diff against `Object.keys(sessionStates)`
 * (store-core `buildSessionListPatches`), so once the roster has been emptied
 * there is nothing to diff and `removedIds` is `[]` — the
 * `removedIds.length > 0` guard skips the prune block entirely and the entries
 * are beyond the reach of the only prune path for the life of the tab.
 *
 * Reachable by the most ordinary gesture in the dashboard: Disconnect, then
 * Connect to the same server. `disconnect()` clears `lastConnectedUrl` while
 * PRESERVING the session roster, so the next `connect()` computes
 * `isReconnect = (lastConnectedUrl === url)` as `null === url` → false and takes
 * the wipe branch. The auto-retry ladder reaches it a second way, via
 * `scheduleRetry` re-entering `connect()` with `_retryCount > 0`.
 */
describe('#7470 a fresh auth_ok clears the per-session PR/CI maps', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  /** The minimal auth_ok the dashboard's handler needs. */
  function authOk(): Record<string, unknown> {
    return {
      type: 'auth_ok',
      serverMode: 'cli',
      cwd: '/home/user/project',
      defaultCwd: '/home/user',
      serverVersion: '0.11.0',
      protocolVersion: 3,
      clientId: 'client-1',
      connectedClients: [{ clientId: 'client-1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos' }],
    }
  }
  const freshCtx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })
  const reconnectCtx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat() })

  it('control: the fixture holds entries for both sessions before the connect', () => {
    // Without this, every "is empty afterwards" assertion below could be
    // passing because the seed never landed.
    const s = store.getState()
    expect(Object.keys(s.sessionPrStatus)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrThreads)).toEqual([DEAD, LIVE])
  })

  it('clears sessionPrStatus', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().sessionPrStatus).toEqual({})
  })
  it('clears sessionPrStatusLoading', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().sessionPrStatusLoading).toEqual({})
  })
  it('clears sessionPrStatusRequestedAt', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().sessionPrStatusRequestedAt).toEqual({})
  })
  it('clears sessionPrThreads', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().sessionPrThreads).toEqual({})
  })
  it('clears sessionPrThreadsLoading', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().sessionPrThreadsLoading).toEqual({})
  })

  it('clears them in the same patch that empties sessionStates', () => {
    handleMessage(authOk(), freshCtx() as never)
    const s = store.getState()
    expect(s.sessionStates).toEqual({})
    expect(s.sessions).toEqual([])
  })

  it('POSITIVE CONTROL: a silent RECONNECT keeps them, because it keeps sessionStates', () => {
    // The reconnect branch preserves the roster, so the snapshots it describes
    // stay valid — and clearing here would blank a chip the user is looking at
    // on every transient drop. This is what stops the fix degenerating into
    // "clear on every auth_ok", which would pass all five assertions above.
    handleMessage(authOk(), reconnectCtx() as never)
    const s = store.getState()
    expect(Object.keys(s.sessionStates)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrStatus)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrStatusLoading)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrStatusRequestedAt)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrThreads)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrThreadsLoading)).toEqual([DEAD, LIVE])
  })

  /**
   * Pins the MECHANISM, not the fix — this passes both before and after, and
   * that is the point. It is the reason the fourth site cannot be folded into
   * the removedIds block: after a roster wipe there is nothing left to diff, so
   * no `session_list` can ever produce a `removedIds` containing the stale ids.
   * If someone later "simplifies" the auth_ok clear away on the theory that the
   * removedIds prune covers it, this test states in one place why it does not.
   */
  it('MECHANISM: after a roster wipe, no session_list can ever prune the stale ids', () => {
    // Exactly the state auth_ok's else-branch leaves behind, minus the fix.
    store.setState({ sessions: [], activeSessionId: null, sessionStates: {} })
    handleMessage({ type: 'session_list', sessions: [{ sessionId: 'brand-new', isBusy: false }] }, freshCtx() as never)
    const s = store.getState()
    // removedIds was [] — the prune block never ran, so the dead ids are still
    // here. This is the defect Critical 1 named, reproduced as a property.
    expect(s.sessionPrStatus[DEAD]).toBeDefined()
    expect(s.sessionPrStatus[LIVE]).toBeDefined()
  })
})

/**
 * `pruneSessionKeyedMap`'s reference contract, tested directly (PR #7481 N1).
 *
 * The docstring calls the same-reference return "load-bearing, not an
 * optimisation detail", so the membership test has to be own-property. `in`
 * walks the prototype chain, which made the guarantee true only by luck about
 * the session-id alphabet.
 */
describe('#7470 pruneSessionKeyedMap reference contract', () => {
  it('returns the SAME reference when no id is an own key', () => {
    const map = { 'sess-a': 1 }
    expect(pruneSessionKeyedMap(map, ['sess-b'])).toBe(map)
  })

  it('is not fooled by inherited keys (`in` would clone here)', () => {
    const map = { 'sess-a': 1 }
    // Every one of these answers true to `id in map` via Object.prototype, so
    // the pre-fix helper cloned and returned a NEW object with identical
    // contents — silently breaking the reference guarantee for every
    // `useShallow` consumer.
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(pruneSessionKeyedMap(map, [inherited]), `${inherited} must not clone`).toBe(map)
    }
  })

  it('still returns a new object, without the id, for a real own key', () => {
    // Positive control: the two assertions above are satisfiable by a helper
    // that never prunes anything at all.
    const map = { 'sess-a': 1, 'sess-b': 2 }
    const out = pruneSessionKeyedMap(map, ['sess-a'])
    expect(out).not.toBe(map)
    expect(out).toEqual({ 'sess-b': 2 })
    expect(map).toEqual({ 'sess-a': 1, 'sess-b': 2 })
  })
})

/**
 * Roster coverage — the adjacent-field guard.
 *
 * ## What the first version of this got wrong (PR #7481 review, Critical 2)
 *
 * It extracted `/^\s{2}(sessionPr\w*): Record<string,/` and its docstring
 * claimed it covered "every session-keyed PR/CI map". It did not: it covered a
 * NAME PREFIX. The mutant offered as proof was named `sessionPrMutantSixth` —
 * derived from the guard's own pattern rather than from the defect — and the
 * reviewer killed the claim by running the identical mutant renamed
 * `sessionCiChecks`: same declaration point, same shape, genuinely session-keyed,
 * and it survived 38/38 in silence. `pendingServerSeed` was the live proof: a
 * real session-keyed map in the same file that the guard could not see.
 *
 * That is docs/false-safety-guards.md's "guard whose comment describes a
 * stronger check than its code performs", committed inside the guard written to
 * prevent its cousin. A guard certified by a mutant named after its own pattern
 * is testing itself.
 *
 * ## What it does now: classify-or-fail, red by default
 *
 * The extraction is now STRUCTURAL — every `Record<string, …>` and
 * `Set<string>` field declared on the `ConnectionState` interface, which is the
 * shape a session-keyed collection actually has, with no reliance on what it is
 * called. Each one must appear in exactly one of four buckets below. A field in
 * NONE of them fails `classification`, so a newly-added collection is RED until
 * someone states how it is keyed — `sessionCiChecks` included, whatever it is
 * named.
 *
 * The buckets are visible rather than inferred, because the deferred ones are
 * the point: `pendingServerSeed` (#7478) and `cancellingActivityIds` (#7483) are
 * session-scoped and NOT yet cleaned, and a reader has to be able to see that
 * they were considered. An exclusion list that names them beats a pattern that
 * cannot see them.
 *
 * Every "keyed by" reason below is quoted from the field's OWN declaration in
 * types.ts, not inferred from its name — the naming inference is what produced
 * the defect this guard now exists to catch.
 *
 * ## Four sites
 *
 * "The session went away" has four spellings in this store. Covering only the
 * one the issue named is the same adjacent-field mistake one level up, and the
 * review found the fourth after this table already had three:
 *
 *   1. `session_list` removedIds  — one session closed        (message-handler.ts)
 *   2. `auth_ok` non-reconnect    — fresh connect, roster wipe (message-handler.ts)
 *   3. `forgetSession`            — disconnect + forget        (connection.ts)
 *   4. `_resetSessionMemory`      — switchServer               (connection.ts)
 *
 * 2/3/4 empty `sessionStates` wholesale, and `removedIds` is a diff against
 * `sessionStates` — so each must clear these maps itself or they are permanently
 * unprunable. That is one mechanism, not four coincidences.
 */
describe('#7470 roster coverage: every session-keyed collection is classified and cleaned', () => {
  const typesSrc = readFileSync(resolve(__dirname, 'types.ts'), 'utf8')
  const handlerSrc = readFileSync(resolve(__dirname, 'message-handler.ts'), 'utf8')
  const connectionSrc = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')

  /** `[site label, source text, start marker, end marker]`. */
  const SITES: [string, string, string, string][] = [
    ['session_list removedIds', handlerSrc, '#7470 prune-block-start', '#7470 prune-block-end'],
    ['auth_ok fresh connect', handlerSrc, '#7470 authok-reset-start', '#7470 authok-reset-end'],
    ['forgetSession', connectionSrc, '#7470 forget-reset-start', '#7470 forget-reset-end'],
    ['_resetSessionMemory', connectionSrc, '#7470 switch-reset-start', '#7470 switch-reset-end'],
  ]

  // -- Bucket 1: session-id-keyed, cleaned at every site by this PR. ----------
  const CLEANED = [
    'sessionPrStatus',
    'sessionPrStatusLoading',
    'sessionPrStatusRequestedAt',
    'sessionPrThreads',
    'sessionPrThreadsLoading',
  ]

  // -- Bucket 2: session-id-keyed, cleaned by its own code at all four sites. -
  // `sessionStates` IS the roster the other three sites empty and the set
  // `removedIds` diffs against; the five above follow it rather than duplicate
  // it, so it is classified, not asserted against the markers.
  const SESSION_KEYED_ELSEWHERE = ['sessionStates']

  // -- Bucket 3: session-scoped and NOT yet cleaned — tracked, not hidden. ----
  const SESSION_KEYED_DEFERRED: Record<string, string> = {
    pendingServerSeed: '#7478 — keyed by sessionId; different feature family (#5553 presets)',
    cancellingActivityIds: '#7483 — keyed `${sessionId}:${activityId}`; missing from the removedIds site only',
  }

  // -- Bucket 4: keyed by something that is not a session id. ----------------
  // Reason quoted from each field's own declaration in types.ts.
  const NOT_SESSION_KEYED: Record<string, string> = {
    sessionPresetSnapshots: 'keyed by cwd (#5553)',
    reindexingRepoPaths: 'keyed by the repoPath the dashboard sent',
    reindexResults: 'per repo path',
    relayRerunningRepoPaths: 'repo paths with an in-flight relay re-run',
    relayRerunResults: 'per repo path',
    permissionInputs: 'keyed by requestId',
    resolvedPermissions: 'keyed by requestId',
    orchestrationPendingActions: 'keyed by requestId',
    orchestrationActionResults: 'keyed by requestId',
    scheduledTaskPendingActions: 'keyed by requestId',
    scheduledTaskActionResults: 'keyed by requestId',
    orchestrationRunDetails: 'per run (runId)',
    orchestrationRunDetailErrors: 'keyed by runId',
    orchestrationRunDetailStale: 'runIds whose held detail hit a seq gap',
    orchestrationRunDetailLoading: 'runIds with an in-flight detail request',
    containerActioningIds: 'keyed by environmentId',
    containerActionResults: 'per environment id',
    byokPoolActioningIds: 'keyed by the action target',
    byokPoolActionResults: 'per target id',
    hostPruneActioningIds: 'keyed by kind',
    hostPruneActionResults: 'per kind',
    simulatorActioningIds: 'keyed by udid',
    simulatorActionResults: 'per udid',
    emulatorActioningIds: 'keyed by avd / serial',
    emulatorActionResults: 'per target id',
    wslActioningIds: 'keyed by distro',
    wslActionResults: 'per distro name',
    serverCapabilities: 'keyed by feature name',
    credentialTestResults: 'keyed by credential key',
  }

  /**
   * Every `Record<string, …>` / `Set<string>` declared on `ConnectionState`.
   *
   * Sliced to the interface first: types.ts declares other interfaces with
   * two-space members (`env?: Record<string, string>` on the MCP shapes), and a
   * file-wide match would silently widen the roster with fields that are not
   * store state at all.
   */
  const interfaceBody = (() => {
    const m = /^export interface ConnectionState[\s\S]*?^\}/m.exec(typesSrc)
    return m ? m[0] : ''
  })()
  const declared = [...interfaceBody.matchAll(/^ {2}(\w+)\??: (?:Record<string,|Set<string>)/gm)].map((m) => m[1]!)

  it('control: the structural extraction is non-vacuous and sees the known fields', () => {
    // Guards the guard. If the interface slice or the member pattern stops
    // matching, `declared` goes empty and every loop below passes vacuously —
    // "cannot check this" silently becoming "nothing to check".
    //
    // The floor is deliberately loose (the roster grows) but the named members
    // are exact: the five under test, one from each other bucket, and one
    // `Set<string>` so a regression to Records-only is caught. A `Set` matters
    // because #7483 is one — the shape the first version of this guard could
    // not express at all.
    expect(declared.length).toBeGreaterThanOrEqual(30)
    expect(declared).toEqual(expect.arrayContaining([
      ...CLEANED,
      'sessionStates',
      'pendingServerSeed',
      'cancellingActivityIds',
      'sessionPresetSnapshots',
      'resolvedPermissions',
    ]))
  })

  it('classification: every session-keyed-shaped collection is in exactly one bucket', () => {
    // THE test Critical 2 asked for. A new collection on ConnectionState is RED
    // until it is classified, whatever it is called — so `sessionCiChecks`, the
    // mutant that survived the name-prefix version, fails here by name.
    const classified = new Set([
      ...CLEANED,
      ...SESSION_KEYED_ELSEWHERE,
      ...Object.keys(SESSION_KEYED_DEFERRED),
      ...Object.keys(NOT_SESSION_KEYED),
    ])
    const unclassified = declared.filter((f) => !classified.has(f))
    expect(
      unclassified,
      'new session-keyed-shaped field(s) on ConnectionState. Add each to CLEANED (and to all four ' +
      'site blocks), to SESSION_KEYED_DEFERRED with a tracking issue, or to NOT_SESSION_KEYED with ' +
      'the key it is actually keyed by — quoted from its declaration, not inferred from its name.',
    ).toEqual([])

    // And the reverse: a bucket entry for a field that no longer exists is a
    // stale allowlist, which is how an exclusion outlives its reason.
    const declaredSet = new Set(declared)
    expect(
      [...classified].filter((f) => !declaredSet.has(f)),
      'bucket entries for fields no longer declared on ConnectionState — stale allowlist',
    ).toEqual([])
  })

  const CASES: [string, string][] = SITES.flatMap(([site]) => CLEANED.map((f) => [site, f] as [string, string]))

  it.each(CASES)('[%s] cleans up %s', (site, field) => {
    const entry = SITES.find(([name]) => name === site)!
    const [, src, startMarker, endMarker] = entry
    // Slice to the marked block. A file-wide grep would be satisfied by any of
    // the dozens of other mentions of these fields in the same file — the
    // "source-level guards must be anchored" failure.
    const start = src.indexOf(startMarker)
    const end = src.indexOf(endMarker)
    expect(start, `${startMarker} must exist`).toBeGreaterThan(-1)
    expect(end, `${endMarker} must exist and follow its start`).toBeGreaterThan(start)
    const block = src.slice(start, end)
    // TOKEN match, not a substring match. `toContain(field)` looks right and is
    // not: `sessionPrStatusLoading: {}` contains the substring
    // `sessionPrStatus`, so a site that dropped `sessionPrStatus` entirely
    // still satisfied it — measured, not theorised (the mutation matrix showed
    // exactly two of ten mutants surviving this guard before it was tightened).
    //
    // Requiring the field to be followed by `:` or `=` pins it to an actual
    // assignment (`sessionPrStatus: {}` / `patch.sessionPrStatus = ...`) and
    // rejects a longer identifier that merely starts with it.
    const assigned = new RegExp(`(^|[^A-Za-z0-9_$])${field}\\s*[:=][^=]`)
    expect(assigned.test(block), `${site} must assign ${field} (token match, not substring)`).toBe(true)
  })
})
