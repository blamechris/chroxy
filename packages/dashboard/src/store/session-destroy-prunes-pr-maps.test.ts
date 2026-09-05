/**
 * #7470 / #7478 / #7483 — destroying a session must drop its entry from EVERY
 * session-scoped collection in the connection store.
 *
 * The file is still named for the five PR/CI maps #7470 was filed against, and
 * the roster is no longer only those five:
 *
 *   sessionPrStatus            (#7344)  full PR + check-rollup snapshot
 *   sessionPrStatusLoading     (#7344)  in-flight flag
 *   sessionPrStatusRequestedAt (#7344)  client-clock auto-pull throttle stamp
 *   sessionPrThreads           (#7430)  unresolved review-thread reading
 *   sessionPrThreadsLoading    (#7430)  in-flight flag
 *   pendingServerSeed          (#7478)  server-provided composer seed (#5553)
 *   cancellingActivityIds      (#7483)  in-flight cancel_activity keys (#5277)
 *
 * The last two were the visible DEFERRED bucket of the roster guard below when
 * #7481 landed; they are cleaned now, and the bucket is empty. They are also
 * the reason the guard had to stop reading names: `pendingServerSeed` is a
 * `Record` under a name with no `session` prefix at all, and
 * `cancellingActivityIds` is a `Set` whose key is COMPOSITE
 * (`${sessionId}:${activityId}`) rather than a bare session id — two shapes a
 * roster built from `sessionPr*` could not express.
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
 * Plus a roster guard that classifies every collection-shaped member of
 * `ConnectionState` — `Record<string, …>`, `Set<string>` and, since #7527,
 * ARRAYS — so a new one is red until someone says how it is keyed. See its own
 * docstring below for why the first two versions of that guard did not work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
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
import { createEmptyConnectionScope, createEmptySessionState, pruneSessionKeyedMap, pruneSessionScopedKeySet } from './utils'

/**
 * The #7559 roster's field names, derived from the ONE factory the fix spreads
 * (`utils.ts`) rather than transcribed — a hardcoded copy beside a growing set
 * is the defect class this whole file is about.
 */
const CONNECTION_SCOPED_RESET_FIELDS: readonly string[] = Object.keys(createEmptyConnectionScope())
import type { ConnectionState } from './types'
import { createEmptyActivityState } from '@chroxy/store-core'
import type { ActivityState } from '@chroxy/store-core'
import type { ActivityEntry, ServerSessionPrStatusMessage, ServerSessionPrThreadsMessage } from '@chroxy/protocol'

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
 * One session's Control Room activity subtree (#5163), carrying a real running
 * entry.
 *
 * Seeded rather than left empty (#7495): `clearSessionActivity` only removes a
 * key that is present, so `bySession[DEAD] === undefined` after the handler runs
 * is satisfied for free by a tree that never held `DEAD` at all — this repo's
 * "negative assertions need a positive control" rule. The entry is typed as
 * `ActivityEntry` without a cast, so a fixture that drifts from the wire
 * contract fails the typecheck.
 */
function activitySubtree(sessionId: string): ActivityState['bySession'][string] {
  const entry: ActivityEntry = {
    id: `${sessionId}-act-1`,
    kind: 'agent',
    label: `work in ${sessionId}`,
    status: 'running',
    startedAt: 1000,
  }
  return { byId: { [entry.id]: entry }, order: [entry.id] }
}

function seededActivity(): ActivityState {
  return { bySession: { [DEAD]: activitySubtree(DEAD), [LIVE]: activitySubtree(LIVE) } }
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
    //
    // #7495: SEEDED with a subtree per session rather than empty. It was empty
    // because nothing asserted on it; `session_timeout` leaking the subtree is
    // half of #7495, and an empty tree makes every "the subtree is gone"
    // assertion pass for the wrong reason.
    activity: seededActivity(),
    sessionPrStatus: { [DEAD]: prStatus(DEAD, 1), [LIVE]: prStatus(LIVE, 2) },
    sessionPrStatusLoading: { [DEAD]: true, [LIVE]: true },
    sessionPrStatusRequestedAt: { [DEAD]: 1000, [LIVE]: 2000 },
    sessionPrThreads: { [DEAD]: prThreads(DEAD, 3), [LIVE]: prThreads(LIVE, 4) },
    sessionPrThreadsLoading: { [DEAD]: true, [LIVE]: true },
    // #7478 — the server-provided composer seed. A plain `Record<sessionId, …>`,
    // so `pruneSessionKeyedMap` applies to it unchanged.
    pendingServerSeed: { [DEAD]: 'seed for the dead session', [LIVE]: 'seed for the live session' },
    // #7483 — a `Set` keyed `${sessionId}:${activityId}`, NOT a Record keyed by
    // session id. TWO entries for the dead session so "dropped one of them"
    // is distinguishable from "dropped the session", and the survivor reuses
    // one of the dead session's activity ids so an activityId-only match
    // cannot pass.
    //
    // Carried here for the same reason #7486 filled the five PR/CI maps: both
    // pruners are deliberately intolerant of an absent collection, so a
    // fixture that omits one must fail loudly rather than be papered over in
    // the helper.
    cancellingActivityIds: new Set<string>([`${DEAD}:act-1`, `${DEAD}:act-2`, `${LIVE}:act-1`]),
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

  it('prunes pendingServerSeed for the destroyed session and leaves the survivor', () => {
    // #7478 (1): the seed is drained only if App's create-confirm effect runs
    // for that session. A session destroyed before the composer is touched
    // leaves its seed behind, and until now nothing here removed it.
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().pendingServerSeed
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    // Positive control: the survivor's seed comes through byte-identical, so a
    // blanket `pendingServerSeed: {}` cannot satisfy the assertion above.
    expect(after[LIVE]).toBe('seed for the live session')
  })

  it('drops the destroyed session\'s Control Room activity subtree', () => {
    // #5163's clear, which this site has always done and no test in this file
    // asserted — the fixture carried an EMPTY tree purely so the call would not
    // throw. Pinned here because it is the same per-session-state family as the
    // seven below, and #7495 is the same clear missing at the fifth site.
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().activity
    expect(after.bySession[DEAD]).toBeUndefined()
    expect(Object.keys(after.bySession)).toEqual([LIVE])
    // Positive control: the survivor's subtree comes through intact.
    expect(after.bySession[LIVE]?.order).toEqual([`${LIVE}-act-1`])
  })

  it('prunes cancellingActivityIds for the destroyed session and leaves the survivor', () => {
    // #7483: the composite key is `${sessionId}:${activityId}`, so this is a
    // session-SCOPED prune of a Set, not an exact-key prune of a Record.
    handleMessage(listWithoutDead(), ctx() as never)
    const after = store.getState().cancellingActivityIds
    // BOTH of the dead session's keys go — not just the first one found.
    expect(after.has(`${DEAD}:act-1`)).toBe(false)
    expect(after.has(`${DEAD}:act-2`)).toBe(false)
    // Positive control: the survivor's key carries the SAME activityId as one
    // of the dead session's, so neither "clear the whole set" nor a match on
    // the activityId half can pass.
    expect(after.has(`${LIVE}:act-1`)).toBe(true)
    expect([...after]).toEqual([`${LIVE}:act-1`])
  })

  it('does NOT cross-prune a session id that is a strict PREFIX of another', () => {
    // #7483 acceptance: the prefix match must be anchored on the `:`
    // delimiter. `sess-dead` is a strict prefix of `sess-deadbeef`; a
    // `startsWith(id)` without the delimiter — or a bare `includes(id)` —
    // takes the neighbour's keys with it. Today's ids are 32 hex chars so this
    // cannot arise in production, and the helper must not depend on that.
    const NEIGHBOUR = `${DEAD}beef`
    store.setState({
      sessions: [
        { sessionId: DEAD, name: 'dead' },
        { sessionId: NEIGHBOUR, name: 'neighbour' },
      ] as ConnectionState['sessions'],
      sessionStates: {
        [DEAD]: createEmptySessionState(),
        [NEIGHBOUR]: createEmptySessionState(),
      },
      pendingServerSeed: { [DEAD]: 'dead seed', [NEIGHBOUR]: 'neighbour seed' },
      cancellingActivityIds: new Set<string>([`${DEAD}:act-1`, `${NEIGHBOUR}:act-1`]),
    })
    handleMessage({
      type: 'session_list',
      sessions: [{ sessionId: NEIGHBOUR, name: 'neighbour', isBusy: false }],
    }, ctx() as never)
    const s = store.getState()
    expect(s.pendingServerSeed[DEAD]).toBeUndefined()
    expect(s.pendingServerSeed[NEIGHBOUR]).toBe('neighbour seed')
    expect(s.cancellingActivityIds.has(`${DEAD}:act-1`)).toBe(false)
    expect(s.cancellingActivityIds.has(`${NEIGHBOUR}:act-1`)).toBe(true)
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
      pendingServerSeed: before.pendingServerSeed,
      cancellingActivityIds: before.cancellingActivityIds,
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

  it('keeps cancellingActivityIds by reference when no removed session had a key in it', () => {
    // The Set sibling of the Record case above. `pruneSessionScopedKeySet`
    // carries the same same-reference contract, and it matters for the same
    // reason: ControlRoomSection / CrossSessionMissionControl subscribe to this
    // Set, so a fresh object on every session close re-renders the whole
    // Control Room for a value that did not change.
    store.setState({ cancellingActivityIds: new Set<string>([`${LIVE}:act-1`]) })
    const before = store.getState().cancellingActivityIds
    handleMessage(listWithoutDead(), ctx() as never)
    expect(store.getState().cancellingActivityIds).toBe(before)
    // Positive control for THIS test: a collection that DID hold the removed
    // id is rebuilt, so the assertion above cannot be passing because the
    // prune block never ran at all.
    expect(store.getState().pendingServerSeed[DEAD]).toBeUndefined()
  })

  it('prunes every removed session when several disappear at once', () => {
    handleMessage({ type: 'session_list', sessions: [] }, ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus).toEqual({})
    expect(s.sessionPrStatusLoading).toEqual({})
    expect(s.sessionPrStatusRequestedAt).toEqual({})
    expect(s.sessionPrThreads).toEqual({})
    expect(s.sessionPrThreadsLoading).toEqual({})
    expect(s.pendingServerSeed).toEqual({})
    expect(s.cancellingActivityIds.size).toBe(0)
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
    expect(Object.keys(s.pendingServerSeed)).toEqual([DEAD, LIVE])
    expect(s.cancellingActivityIds.size).toBe(3)
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
  it('clears pendingServerSeed', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().pendingServerSeed).toEqual({})
  })
  it('clears cancellingActivityIds', () => {
    handleMessage(authOk(), freshCtx() as never)
    expect(store.getState().cancellingActivityIds.size).toBe(0)
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
    expect(Object.keys(s.pendingServerSeed)).toEqual([DEAD, LIVE])
    // A silent reconnect keeps the roster, so a seed the composer has not yet
    // drained is still owed to a session that still exists.
    expect(s.cancellingActivityIds.size).toBe(3)
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
 * #7495 — the FIFTH site: `session_timeout`.
 *
 * The server closes an idle session on its own and pushes `session_timeout`.
 * The handler deletes `sessionStates[id]` and filters `sessions`, and until this
 * issue it pruned NONE of the seven collections above — no helper call, no
 * marker block, no row in the SITES table at the bottom of this file.
 *
 * Mechanically it is the roster-wipe case, one session at a time. `removedIds`
 * is a diff against `Object.keys(sessionStates)` (store-core
 * `buildSessionListPatches`) and this handler removes the id from
 * `sessionStates` ITSELF, so by the time the next `session_list` lands there is
 * nothing to diff: `removedIds` is `[]`, the prune block is skipped, and the
 * entries are unreachable for the life of the tab. The MECHANISM test at the
 * bottom of this describe drives exactly that sequence.
 *
 * How it slipped is the more useful half. The FIELD axis of the roster guard
 * below is exhaustive — every `Record<string, …>` / `Set<string>` on
 * `ConnectionState` must be classified or the run is red — while the SITE axis
 * was a hand-written list of four. So adding a collection was red until every
 * site cleaned it, and adding a SITE was green. That is
 * docs/false-safety-guards.md's "guard wired to only some of its callers", at
 * the site axis, and the `roster removal sites` describe at the end of this
 * file is the answer to it.
 */
describe('#7495 session_timeout prunes the per-session roster (the fifth site)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  let warn: ReturnType<typeof vi.spyOn>
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  /** The frame the server pushes when it closes an idle session. */
  function timeout(sessionId: string = DEAD): Record<string, unknown> {
    return { type: 'session_timeout', sessionId, name: 'dead', idleMs: 600000 }
  }

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    // The handler raises a platform alert, which on the dashboard is
    // `console.warn`. Silenced so this describe does not bury the run's real
    // output, and restored in afterEach rather than left patched for whatever
    // file vitest schedules next.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { warn.mockRestore(); stopHeartbeat() })

  it('control: the fixture holds entries for both sessions before the timeout', () => {
    // Without this, every "is gone afterwards" assertion below could be passing
    // because the seed never landed.
    const s = store.getState()
    expect(Object.keys(s.sessionPrStatus)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrStatusLoading)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrStatusRequestedAt)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrThreads)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.sessionPrThreadsLoading)).toEqual([DEAD, LIVE])
    expect(Object.keys(s.pendingServerSeed)).toEqual([DEAD, LIVE])
    expect(s.cancellingActivityIds.size).toBe(3)
    expect(Object.keys(s.activity.bySession)).toEqual([DEAD, LIVE])
  })

  it('removes the timed-out session from sessionStates and sessions', () => {
    // The pre-existing behaviour (#816). Pinned so the prune assertions below
    // cannot be read as the whole of what this site does — and so a fix that
    // broke the roster removal to satisfy them would be caught here.
    handleMessage(timeout(), ctx() as never)
    const s = store.getState()
    expect(s.sessionStates[DEAD]).toBeUndefined()
    expect(Object.keys(s.sessionStates)).toEqual([LIVE])
    expect(s.sessions.map((x) => x.sessionId)).toEqual([LIVE])
  })

  // ---- One `it` per collection, so a partial fix fails naming what was missed.

  it('prunes sessionPrStatus for the timed-out session and leaves the survivor', () => {
    const before = store.getState().sessionPrStatus[LIVE]
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().sessionPrStatus
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    // Positive control: the survivor's snapshot is untouched, so a blanket
    // `sessionPrStatus: {}` cannot satisfy the assertion above.
    expect(after[LIVE]).toBe(before)
    expect(after[LIVE]?.pr?.number).toBe(2)
  })

  it('prunes sessionPrStatusLoading for the timed-out session and leaves the survivor', () => {
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().sessionPrStatusLoading
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe(true)
  })

  it('prunes sessionPrStatusRequestedAt for the timed-out session and leaves the survivor', () => {
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().sessionPrStatusRequestedAt
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    // The survivor's auto-pull stamp must survive intact — clearing it re-opens
    // the #7344 request-rate hole for every session that did not time out.
    expect(after[LIVE]).toBe(2000)
  })

  it('prunes sessionPrThreads for the timed-out session and leaves the survivor', () => {
    const before = store.getState().sessionPrThreads[LIVE]
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().sessionPrThreads
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe(before)
    expect(after[LIVE]?.unresolvedCount).toBe(4)
  })

  it('prunes sessionPrThreadsLoading for the timed-out session and leaves the survivor', () => {
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().sessionPrThreadsLoading
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe(true)
  })

  it('prunes pendingServerSeed for the timed-out session and leaves the survivor', () => {
    // #7478's collection at this site. A seed is drained only when App's
    // create-confirm effect runs for that session, so a session that idles out
    // before the composer is touched leaves its seed behind forever.
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().pendingServerSeed
    expect(after[DEAD]).toBeUndefined()
    expect(Object.keys(after)).toEqual([LIVE])
    expect(after[LIVE]).toBe('seed for the live session')
  })

  it('prunes cancellingActivityIds for the timed-out session and leaves the survivor', () => {
    // #7483's collection: a Set keyed `${sessionId}:${activityId}`, so this is
    // the session-SCOPED prune, not the exact-key one.
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().cancellingActivityIds
    // BOTH of the dead session's keys go, not just the first found.
    expect(after.has(`${DEAD}:act-1`)).toBe(false)
    expect(after.has(`${DEAD}:act-2`)).toBe(false)
    // Positive control: the survivor's key carries the SAME activityId as one
    // of the timed-out session's, so neither "clear the whole set" nor a match
    // on the activityId half can pass.
    expect(after.has(`${LIVE}:act-1`)).toBe(true)
    expect([...after]).toEqual([`${LIVE}:act-1`])
  })

  it('drops the timed-out session\'s Control Room activity subtree', () => {
    // Not one of the seven — `activity` is an ActivityState, not a
    // `Record<string, …>` — but it is the same "belongs to a session that is
    // gone" family, it IS cleared at the other four sites, and the issue names
    // it explicitly. Without this the Control Room keeps rendering a tree for a
    // session the user can no longer select.
    handleMessage(timeout(), ctx() as never)
    const after = store.getState().activity
    expect(after.bySession[DEAD]).toBeUndefined()
    expect(Object.keys(after.bySession)).toEqual([LIVE])
    // Positive control: the survivor's subtree comes through intact, so
    // `activity: createEmptyActivityState()` cannot pass.
    expect(after.bySession[LIVE]?.order).toEqual([`${LIVE}-act-1`])
  })

  // ---- Reference contracts: the prune must not churn subscribers.

  it('keeps the activity reference when the timed-out session had no subtree', () => {
    // `clearSessionActivity` returns the SAME state when the session is absent,
    // and the handler must propagate that rather than assign unconditionally —
    // every Control Room subscriber re-renders on a value that did not change.
    store.setState({ activity: createEmptyActivityState() })
    const before = store.getState().activity
    handleMessage(timeout(), ctx() as never)
    expect(store.getState().activity).toBe(before)
  })

  it('keeps a collection\'s reference when the timed-out session was never in it', () => {
    // The reachable case: a tab holds a PR status for both sessions but has
    // only ever counted threads for the survivor. A fresh object for
    // `sessionPrThreads` re-renders every `useShallow` consumer of it on every
    // idle timeout, for a value that did not change.
    store.setState({ sessionPrThreads: { [LIVE]: prThreads(LIVE, 4) } })
    const untrackedBefore = store.getState().sessionPrThreads
    const trackedBefore = store.getState().sessionPrStatus
    handleMessage(timeout(), ctx() as never)
    const after = store.getState()
    expect(after.sessionPrThreads).toBe(untrackedBefore)
    // Positive control for THIS test: a collection that DID hold the id is
    // rebuilt, so the assertion above cannot be passing because the prune never
    // ran at all.
    expect(after.sessionPrStatus).not.toBe(trackedBefore)
    expect(after.sessionPrStatus[DEAD]).toBeUndefined()
  })

  it('POSITIVE CONTROL: a timeout for an UNKNOWN session touches none of them', () => {
    // What stops the fix degenerating into "clear everything on any timeout",
    // which would satisfy all seven assertions above. A `session_timeout` for
    // an id this tab never knew must leave every collection at its own
    // reference — nothing to prune, nothing rebuilt.
    const before = store.getState()
    const refs = {
      sessionPrStatus: before.sessionPrStatus,
      sessionPrStatusLoading: before.sessionPrStatusLoading,
      sessionPrStatusRequestedAt: before.sessionPrStatusRequestedAt,
      sessionPrThreads: before.sessionPrThreads,
      sessionPrThreadsLoading: before.sessionPrThreadsLoading,
      pendingServerSeed: before.pendingServerSeed,
      cancellingActivityIds: before.cancellingActivityIds,
      activity: before.activity,
    }
    handleMessage(timeout('sess-never-seen'), ctx() as never)
    const after = store.getState()
    for (const key of Object.keys(refs) as (keyof typeof refs)[]) {
      expect(after[key], `${key} must keep its reference when the timed-out id was unknown`).toBe(refs[key])
    }
    // And the roster is otherwise untouched.
    expect(Object.keys(after.sessionStates)).toEqual([DEAD, LIVE])
  })

  it('MECHANISM: after the timeout, no later session_list can prune the stale ids', () => {
    // Passes both before and after the fix, and that is the point — it states
    // in one place WHY this site cannot be folded into the removedIds block.
    // The timeout removes the id from `sessionStates`, which is the set
    // `removedIds` is diffed against, so the next snapshot yields `[]` and the
    // prune block never runs.
    handleMessage(timeout(), ctx() as never)
    // Re-seed as if the timeout site had left an entry behind, then prove no
    // snapshot can reclaim it.
    store.setState({ pendingServerSeed: { [DEAD]: 'stranded', [LIVE]: 'seed for the live session' } })
    handleMessage(listWithoutDead(), ctx() as never)
    expect(store.getState().pendingServerSeed[DEAD]).toBe('stranded')
    expect(store.getState().pendingServerSeed[LIVE]).toBe('seed for the live session')
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
 * `pruneSessionScopedKeySet`'s contract, tested directly (#7483).
 *
 * The Set/composite-key sibling of `pruneSessionKeyedMap`, and it is a sibling
 * rather than a second pruner on purpose: it carries the SAME same-reference
 * guarantee, and both live in `utils.ts` so the next collection to join the
 * roster picks one by SHAPE instead of re-deriving a filter at the call site.
 *
 * The membership rule is the interesting half. The keys here are
 * `${sessionId}:${activityId}` and `removedIds` is a list of bare session ids,
 * so the match has to be anchored on the delimiter — a `startsWith(id)` or an
 * `includes(id)` is the "guard whose comment describes a stronger check than
 * its code performs" shape from docs/false-safety-guards.md.
 */
describe('#7483 pruneSessionScopedKeySet contract', () => {
  it('drops every key scoped to a removed session', () => {
    const out = pruneSessionScopedKeySet(new Set(['a:1', 'a:2', 'b:1']), ['a'])
    expect([...out]).toEqual(['b:1'])
  })

  it('is ANCHORED on the delimiter: a session id that is a prefix of another does not cross-prune', () => {
    // `sess-a` vs `sess-ab`: `'sess-ab:1'.startsWith('sess-a')` is true, so an
    // unanchored implementation deletes the neighbour's key here.
    const out = pruneSessionScopedKeySet(new Set(['sess-a:1', 'sess-ab:1']), ['sess-a'])
    expect([...out]).toEqual(['sess-ab:1'])
  })

  it('is anchored on the FIRST delimiter, so an activityId containing a colon is safe', () => {
    // Activity ids are provider tool-use ids and are not guaranteed
    // colon-free; only the session-id half may decide the match.
    const out = pruneSessionScopedKeySet(new Set(['a:tool:1', 'b:tool:1']), ['b'])
    expect([...out]).toEqual(['a:tool:1'])
    // And the reverse: a removed id must not be matched against the tail.
    expect([...pruneSessionScopedKeySet(new Set(['a:tool:1']), ['tool'])]).toEqual(['a:tool:1'])
  })

  it('returns the SAME reference when nothing matched', () => {
    // Every one of these goes through the GENERAL path — there is no
    // empty-input early return to shortcut them (see the helper's docstring:
    // PR #7489 review proved that refinement unobservable and it was cut).
    // So an always-clone regression dies on each of the three.
    const keys = new Set(['a:1'])
    expect(pruneSessionScopedKeySet(keys, ['b'])).toBe(keys)
    expect(pruneSessionScopedKeySet(keys, [])).toBe(keys)
    // The empty-input case, asserted against ITSELF. The first version of this
    // line read `expect(prune(new Set(), ['a'])).not.toBe(keys)` — a fresh Set
    // compared to an UNRELATED one, which is true however the helper behaves
    // and would have passed with the function deleted (PR #7489 review,
    // BLOCKING). Pinned to its own input, it now pins the real contract.
    const empty = new Set<string>()
    expect(pruneSessionScopedKeySet(empty, ['a'])).toBe(empty)
  })

  it('keeps a key with no delimiter — an unattributable key is not a licence to delete', () => {
    // Unreachable from `sendCancelActivity`, which always writes
    // `${sid}:${activityId}`. The rule still has to be stated: a prune may only
    // remove what it can PROVE belongs to a removed session.
    const keys = new Set(['orphan'])
    expect(pruneSessionScopedKeySet(keys, ['orphan'])).toBe(keys)
  })

  it('does not mutate its input', () => {
    const keys = new Set(['a:1', 'b:1'])
    const out = pruneSessionScopedKeySet(keys, ['a'])
    expect(out).not.toBe(keys)
    expect([...keys]).toEqual(['a:1', 'b:1'])
  })
})

/**
 * The three store sources the guards below read, and the SITE table.
 *
 * At module scope (#7495) because two describes need them now: the per-cell
 * `[site] cleans up <field>` matrix, and the structural roster-removal detector
 * that cross-checks this table against the markers actually present in the
 * sources.
 */
const typesSrc = readFileSync(resolve(__dirname, 'types.ts'), 'utf8')
const handlerSrc = readFileSync(resolve(__dirname, 'message-handler.ts'), 'utf8')
const connectionSrc = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')

/**
 * The SERVER's production source tree, for the one classification in this file
 * that depends on it (#7551 review).
 *
 * `environments` sits in SESSION_TAGGED_BY_DESIGN because `EnvironmentInfo.sessions`
 * is written by the SERVER on session create/destroy (#7552) — see its reason.
 * That is a claim about server code, so it is checked against server code rather
 * than asserted from the dashboard. Tests are deliberately excluded on BOTH
 * directions of the claim: counting `environment-manager.test.js` would let the
 * evidence be satisfied by a test file, which is precisely how this surface
 * looked alive for as long as it was not.
 *
 * #7552 INVERTED the cell below. Between #7551 and #7552 this scan proved a
 * NEGATIVE (zero production callers of `addSession`); it now proves a POSITIVE
 * (at least one, in session-manager.js). The scan and its detector are
 * unchanged — only the direction of the claim moved, which is what the old cell
 * said would happen and told the next reader to do.
 */
/**
 * Blank every comment in a source, preserving line breaks so derived line
 * numbers stay true.
 *
 * #7552 review, F2. Both cross-package detectors below scan SERVER source text
 * for a call site, and the code they look for is documented in comments that
 * quote it verbatim — `session-manager.js` names `environmentManager` and
 * `removeSession` several times in the JSDoc explaining the very calls being
 * detected. Scanning raw text lets the documentation satisfy the check for the
 * code, which is a guard reporting on its own prose. The same reason the
 * `roster removal sites` describe blanks comments before ITS scan; the regex is
 * that one, and the two are kept identical on purpose.
 */
const blankSourceComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))

const serverSrcDir = resolve(__dirname, '../../../server/src')
const serverProductionSources: [string, string][] = readdirSync(serverSrcDir, { recursive: true })
  .map((e) => String(e))
  .filter((f) => /\.(js|mjs)$/.test(f))
  .map((f) => [f, readFileSync(resolve(serverSrcDir, f), 'utf8')] as [string, string])

/** `[file label, source text]` — for error messages and per-file scans. */
const SOURCES: [string, string][] = [
  ['message-handler.ts', handlerSrc],
  ['connection.ts', connectionSrc],
]

/** `[site label, source text, start marker, end marker]`. */
const SITES: [string, string, string, string][] = [
  ['session_list removedIds', handlerSrc, '#7470 prune-block-start', '#7470 prune-block-end'],
  ['auth_ok fresh connect', handlerSrc, '#7470 authok-reset-start', '#7470 authok-reset-end'],
  ['forgetSession', connectionSrc, '#7470 forget-reset-start', '#7470 forget-reset-end'],
  ['_resetSessionMemory', connectionSrc, '#7470 switch-reset-start', '#7470 switch-reset-end'],
  // #7495 — the fifth. Found in review of #7489 with the table already at
  // four: `session_timeout` removes ONE id from `sessionStates` and, like the
  // three wipe sites, removes it before any `session_list` can diff it out.
  ['session_timeout', handlerSrc, '#7470 timeout-reset-start', '#7470 timeout-reset-end'],
]

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
 * ## What the SECOND version got wrong (#7527)
 *
 * Making the extraction structural fixed the NAME axis and left a SHAPE axis
 * that was hand-written: `Record<string, …>` and `Set<string>`, because those
 * were the two shapes the roster happened to hold. There is a third.
 * `sessionNotifications: SessionNotification[]` is a session-TAGGED array —
 * every element carries a required `sessionId`, and connection.ts says out loud
 * that it "is never pruned on close" — and it is one of TWENTY-FOUR array
 * members of `ConnectionState` the guard could not see. So the field was
 * outside the roster in BOTH directions: not cleaned, and not classifiable
 * (adding it to any bucket turned the stale-allowlist assertion red, because
 * `declared` did not contain it).
 *
 * That is the same defect one axis over — "a hardcoded list next to a set that
 * grows", `docs/false-safety-guards.md` — and it is the third time this guard's
 * coverage has been widened under review rather than by a test going red: the
 * NAME axis in #7481, the SITE axis in #7495, the SHAPE axis here. The
 * countermeasure is the same each time: derive the axis, then pin the
 * derivation with a phantom that no bucket names.
 *
 * ## What it does now: classify-or-fail, red by default
 *
 * The extraction is STRUCTURAL over THREE shapes — every `Record<string, …>`,
 * `Set<string>` and ARRAY member declared on the `ConnectionState` interface,
 * with no reliance on what any of them is called. Each one must appear in
 * exactly one of FIVE buckets below. A member in NONE of them fails
 * `classification`, so a newly-added collection is RED until someone states how
 * it is keyed — `sessionCiChecks` included, whatever it is named, and
 * `agentRunLedger: AgentRunRecord[]` included, whatever shape it has.
 *
 * The fifth bucket is #7527's: session-TAGGED and deliberately NOT pruned.
 * `sessionNotifications` needed a home that neither of the two honest existing
 * ones could give — DEFERRED claims someone will fix it, NOT_SESSION_KEYED
 * claims the element has no session id — and #7516 had already adjudicated it
 * as a RECORD that outlives its session on purpose (#7528 gated the
 * session-jump instead). An entry there must cite the adjudication, exactly as
 * a deferral must cite its tracking issue.
 *
 * The buckets are visible rather than inferred, because a deferral has to be
 * READABLE: `pendingServerSeed` (#7478) and `cancellingActivityIds` (#7483) sat
 * in the deferred bucket when #7481 landed — session-scoped, considered, not
 * yet cleaned — and an exclusion list that names them is what made them
 * findable enough to fix here. The bucket is empty now and stays, for the next
 * one.
 *
 * Every "keyed by" reason below is quoted from the field's OWN declaration in
 * types.ts, not inferred from its name — the naming inference is what produced
 * the defect this guard now exists to catch.
 *
 * ## Five sites
 *
 * "The session went away" has five spellings in this store. Covering only the
 * one the issue named is the same adjacent-field mistake one level up, and the
 * count has now grown TWICE under review — the fourth was found reviewing
 * #7481, the fifth reviewing #7489:
 *
 *   1. `session_list` removedIds  — one session closed         (message-handler.ts)
 *   2. `auth_ok` non-reconnect    — fresh connect, roster wipe (message-handler.ts)
 *   3. `forgetSession`            — disconnect + forget        (connection.ts)
 *   4. `_resetSessionMemory`      — switchServer               (connection.ts)
 *   5. `session_timeout`          — server closed an idle one  (message-handler.ts)
 *
 * 2/3/4 empty `sessionStates` wholesale and 5 removes one id from it, while
 * `removedIds` is a diff against `sessionStates` — so each must clear these maps
 * itself or they are permanently unprunable. That is one mechanism, not five
 * coincidences.
 *
 * Twice is a pattern, so the SITE axis is no longer only this hand-written
 * table: the `roster removal sites` describe below finds the removal statements
 * structurally and fails on one that is not accounted for here.
 */
describe('#7470 roster coverage: every session-keyed collection is classified and cleaned', () => {

  // -- Bucket 1: session-scoped, cleaned at every site. ----------------------
  // Two SHAPES live here, and the site blocks spell them differently:
  //   * `Record<sessionId, …>` — pruned with `pruneSessionKeyedMap` (exact key)
  //   * `Set<`${sessionId}:${activityId}`>` — pruned with
  //     `pruneSessionScopedKeySet` (anchored session-scope match)
  // The guard below asserts the field is ASSIGNED in each block, not how, so
  // it holds either way — which is what lets a new collection join by shape.
  const CLEANED = [
    'sessionPrStatus',
    'sessionPrStatusLoading',
    'sessionPrStatusRequestedAt',
    'sessionPrThreads',
    'sessionPrThreadsLoading',
    // #7478 — server-provided composer seed, keyed by sessionId.
    'pendingServerSeed',
    // #7483 — in-flight cancel_activity keys, `${sessionId}:${activityId}`.
    'cancellingActivityIds',
  ]

  // -- Bucket 2: session-scoped, cleaned by its OWN code at all five sites. --
  // Not "cleaned by the marked block" — cleaned by a statement that predates
  // #7470 entirely, because these three are what the site is fundamentally
  // about rather than baggage that has to follow it. Their position relative to
  // the markers VARIES (#7551 review corrected an earlier "sits OUTSIDE the
  // markers" here, which was false for `sessions` at `session_timeout`, where
  // the `sessions.filter(...)` is inside the marked block beside the roster
  // delete): at auth_ok / forgetSession / _resetSessionMemory the `sessions: []`
  // and `messages: []` lines sit above the marker, and at session_timeout the
  // roster filter sits within it. That is exactly why these are classified here
  // rather than asserted against the markers — the per-cell matrix slices to the
  // marked block, and a field whose cleaning straddles it cannot be held that
  // way. A reason per entry, because #7527 turned a one-name array into three
  // and "you can see which is which" stopped being true.
  //
  // The reason is not decoration: `classification` requires it to be non-empty
  // and `every SESSION_KEYED_ELSEWHERE entry names where it is cleaned` requires
  // it to name a site, so a field cannot be parked here with a shrug.
  const SESSION_KEYED_ELSEWHERE: Record<string, string> = {
    sessionStates:
      'IS the roster `removedIds` diffs against, and the thing every site removes FROM: ' +
      '`delete newStates[id]` at session_list / session_timeout, `sessionStates: {}` at auth_ok ' +
      '/ forgetSession / _resetSessionMemory. The seven CLEANED collections follow it rather ' +
      'than duplicate it, so it is classified here and not asserted against the markers (#7470)',
    // #7527 — an ARRAY member, visible to the extraction for the first time.
    sessions:
      'SessionInfo[] — the roster in list form, replaced wholesale by the `session_list` ' +
      'snapshot, `filter`ed by `session_timeout`, and emptied by `sessions: []` at auth_ok / ' +
      'forgetSession / _resetSessionMemory (#7527)',
    // #7527 — an ARRAY member. ChatMessage carries an optional `sessionId`
    // (#5667), but this array is not a per-session store: the per-session
    // transcripts live in `sessionStates[id].messages` and this is the ACTIVE
    // one's flat mirror.
    messages:
      "ChatMessage[] — the ACTIVE session's flat mirror of `sessionStates[activeSessionId]" +
      ".messages`, re-synced from the newly-active session by the flat-field block at " +
      'session_list / session_timeout, and emptied by the `createEmptyFlatSessionMirror()` spread ' +
      'at auth_ok / forgetSession / _resetSessionMemory (#7527, #7555 — which replaced the three ' +
      '`messages: []` literals this reason used to name)',
  }

  // -- Bucket 3: session-scoped and NOT yet cleaned — tracked, not hidden. ----
  // It was EMPTY between #7478/#7483 and #7527, kept "because it is the honest
  // place to park the next one". #7527 is the next one, and it is the first
  // time this bucket has held real entries — which also makes the `#N` contract
  // below non-vacuous for the first time.
  //
  // #7481's review established that a deferral a reader can SEE beats a pattern
  // that cannot see the field at all. An entry here needs a tracking issue in
  // its reason string; the `classification` test below is what makes adding one
  // the only alternative to fixing the field.
  const SESSION_KEYED_DEFERRED: Record<string, string> = {
    // #7527 / #7546 — both are ARRAY members, and both are session-scoped by
    // their OWN code: `switchSession` clears each one on purpose so a previous
    // session's data is never shown against a new one (`memoryStackEntries`'
    // declaration in types.ts says exactly that; the `permissionAudit` reset
    // says "so the panel re-fetches for the new session").
    //
    // Two of the five sites move `activeSessionId` WITHOUT going through
    // `switchSession` — the `session_list` removedIds flat-field block and the
    // `session_timeout` one — and neither hand-synced list includes these. So
    // the active session dying re-homes the dashboard onto another session with
    // the dead one's memory stack and permission audit still on screen.
    //
    // Deferred rather than folded because the fix needs a DECISION this guard
    // cannot make: the clear has to be conditional on the ACTIVE session being
    // the one that died (an unconditional clear inside the prune block would
    // blank a panel the operator is reading when an unrelated BACKGROUND
    // session closes), which means these do not fit CLEANED's "assigned in
    // every site block" contract at all. #7546 carries it.
    memoryStackEntries:
      'MemoryStackEntry[] | null — the active session\'s merged CLAUDE.md stack. `switchSession` ' +
      'resets it "so a previous session\'s stack is never shown against a new one"; the two ' +
      'death sites that re-home `activeSessionId` do not. #7546 (#6867)',
    permissionAudit:
      'PermissionAuditEntry[] | null — the active session\'s pulled audit (the server filters by ' +
      'sessionId). `switchSession` resets it "so the panel re-fetches for the new session"; the ' +
      'two death sites that re-home `activeSessionId` do not. #7546 (#6772)',
  }

  // -- Bucket 4: keyed by something that is not a session id. ----------------
  // Reason quoted from each field's own declaration in types.ts.
  //
  // #7527 added the ARRAY members, where "keyed by" has to be read as "what
  // identifies an element, and does the element carry a session id" — an array
  // has no key, and the honest question for a session-death roster is whether
  // destroying a session can strand anything in here. So each array reason
  // names the element type and the field that identifies it. A member whose
  // element DOES carry a session id does not belong in this bucket, however
  // incidental the tagging looks; that is what SESSION_TAGGED_BY_DESIGN is for.
  const NOT_SESSION_KEYED: Record<string, string> = {
    // #7488 — the classification is unchanged and still correct: it IS keyed by
    // cwd, so `removedIds` (a list of session ids) has nothing to diff against
    // it and this bucket is where it belongs. What #7488 established is that the
    // bucket answers the KEY question, not the LIFETIME one: "not keyed by a
    // session id" says nothing about whether an entry may outlive the
    // CONNECTION. It may not — cwd paths are shared across machines, so a preset
    // (full preamble + seed text + approval state) fetched from server A was
    // being read against server B at the same path. It is cleared at the two
    // full-reset sites now, which the `connection lifecycle` describe below
    // holds for this field and for every other member of this bucket.
    sessionPresetSnapshots: 'keyed by cwd (#5553); cleared at the two full-reset sites (#7488)',
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

    // ---- #7527: the ARRAY members. -------------------------------------
    // Sixteen of the 24 (fifteen at first draft, plus `environments` after
    // #7551's review re-adjudicated it — see its own comment below). Each
    // element type was READ (not inferred from the field name) to confirm it
    // carries no session id — the naming inference is what produced the defect
    // this guard exists to catch, and #7481's review killed a version of it that
    // guessed from names. #7551 is the reminder that reading the TYPE is not
    // always enough either: `environments` needed the WRITERS read too.
    serverRegistry:
      'ServerEntry[] — keyed by `ServerEntry.id` ("Unique ID for this server (stable across ' +
      'renames)"). A server, not a session; it outlives every connection by design (it is what ' +
      'the picker is drawn from) and is loaded from localStorage at construction.',
    pendingPairRequests:
      'ServerPairPendingMessage[] — keyed by `requestId`. A device-pairing request (deviceName / ' +
      'verifyCode / expiresAt); the wire schema has no sessionId, and entries are removed on ' +
      '`pair_resolved` or by TTL (#5510).',
    availableProviders:
      'ProviderInfo[] — keyed by `name`. The server\'s provider registry, connection-wide.',
    availableModels:
      'ModelInfo[] — keyed by `id` / `fullId`. The server\'s model list, connection-wide.',
    availablePermissionModes:
      'PermissionMode[] — keyed by `id`. The server\'s PERMISSION_MODES table, connection-wide ' +
      '(#4019).',
    connectedClients:
      'ConnectedClient[] — keyed by `clientId`. Clients, not sessions; replaced wholesale from ' +
      'each `auth_ok` / clients broadcast.',
    serverStartupLogs:
      'string[] | null — plain lines fetched over Tauri IPC on a startup FAILURE, before any ' +
      'session exists. No element identity at all, let alone a session one.',
    webTasks:
      'WebTask[] — keyed by `taskId`. A web task is not a chroxy session and the type carries no ' +
      'sessionId; `webTasks` is emptied by disconnect, not by session death.',
    slashCommands:
      'SlashCommand[] — keyed by `name`, with a `source` of builtin/project/user/mcp. The ' +
      'command roster for the connection, replaced wholesale by the server\'s reply.',
    filePickerFiles:
      'FilePickerItem[] | null — keyed by `path`. The last `list_files` reply, replaced wholesale ' +
      'on each pull and null until the first.',
    mcpResources:
      'MCPResourceItem[] | null — keyed by `uri`. From the same file_list reply as ' +
      '`filePickerFiles`; replaced wholesale, empty for non-BYOK sessions (#6823).',
    customAgents:
      'CustomAgent[] — keyed by `name`, with a `source` of project/user. Agent definitions on ' +
      'disk, not per-session state.',
    conversationHistory:
      'ConversationSummary[] — keyed by `conversationId`. Past CONVERSATIONS, which are exactly ' +
      'the thing that outlives the session that wrote them; this is the list you resume FROM.',
    searchResults:
      'SearchResult[] — keyed by `conversationId`. The last cross-session search\'s hits, ' +
      'replaced wholesale per query and cleared by `clearSearch`.',
    checkpoints:
      'Checkpoint[] — keyed by `Checkpoint.id`. The server scopes the `list_checkpoints` reply ' +
      'to the requesting client\'s session and the panel re-pulls, and the element carries no ' +
      'sessionId — unlike `memoryStackEntries` / `permissionAudit`, nothing in the store claims a ' +
      'previous session\'s checkpoints must not be shown against a new one.',
    // The one array member in this bucket whose ELEMENT TYPE could carry a
    // session id and does not. `ServerError` has an optional `sessionId` and
    // `serverErrors` (session-tagged, bucket 5) really does set it — but this
    // field's ONE producer never does, which is a property of the PRODUCER
    // rather than of the type, so it is pinned by its own test below rather
    // than asserted here in prose.
    infoNotifications:
      'ServerError[] structurally, but host-level notices only ("update available, etc." — last ' +
      '10). Its only producer, `addInfoNotification(message)`, builds the entry from ' +
      '{id, category, message, recoverable, timestamp} and never sets `sessionId` — pinned by ' +
      '`infoNotifications\' only producer never session-tags an entry` below (#7527).',
  }

  // -- Bucket 5: session-TAGGED, and deliberately NOT pruned. ----------------
  //
  // #7527. The bucket the array shape needed and the four above could not
  // express. Every element here carries a session id, so NOT_SESSION_KEYED
  // would be a lie; nobody is going to "fix" them, so SESSION_KEYED_DEFERRED
  // would be a lie in the other direction — its contract is "a tracking issue
  // and someone will fix it". These are RECORDS: history that deliberately
  // survives the session it describes, and pruning them is the wrong default.
  //
  // The reason must state WHY it survives and cite the adjudication (`#N`),
  // asserted below — same convention as the deferred bucket, for the same
  // reason: an unsourced "by design" is indistinguishable from an oversight
  // nobody has looked at yet.
  const SESSION_TAGGED_BY_DESIGN: Record<string, string> = {
    // #7516 adjudicated this one deliberately, and #7528 landed the gate it
    // chose instead. It is the field that made this bucket necessary.
    sessionNotifications:
      'SessionNotification[], every element carries a required `sessionId`. The row IS the record ' +
      'of what happened (#7353) and a "session errored" alert pointing at a now-closed session is ' +
      'exactly what the operator wants kept, so #7516 gated the session-JUMP at the two ' +
      'operator-clicked controls (#7528) instead of pruning the history. connection.ts says it ' +
      'out loud: "`sessionNotifications` is never pruned on close" (#7466). #7516/#7527',
    serverErrors:
      'ServerError[] with an optional `sessionId` the wire path really sets ' +
      '(`handleServerError` reads `serverError.sessionId` and routes on it). The error is usually ' +
      'the REASON the session died — dropping it with the session would delete the explanation ' +
      'at the moment it is wanted. Bounded to the last 10 and individually dismissible, so it ' +
      'cannot grow without limit the way an unpruned Record can. #7527',
    logEntries:
      'LogEntry[] with an optional `sessionId` set from the wire (store-core `handleLogEntry`). ' +
      'The daemon log is a diagnostic record and the entries about a session that just died are ' +
      'the ones worth reading; the Console page clears it on an explicit action. Bounded to the ' +
      'last 500. #7527',
    // The one entry in this bucket that is NOT a record, and it took two
    // adjudications to land here honestly.
    //
    // #7551's first draft put it here with a mechanism that DID NOT EXIST:
    // "`environment_list` replaces the whole array on every change, so the
    // server is the authority". The server re-sent the list, but never on
    // session lifecycle — all four emit sites were in feature-handlers.js
    // (env list / create / destroy requests). Review caught it and moved the
    // row to NOT_SESSION_KEYED for the REAL reason: `EnvironmentInfo.sessions`
    // was dead surface, `[]` at runtime forever, with zero production writers.
    //
    // #7552 fixed the surface rather than the story. The tag was load-bearing:
    // EnvironmentPanel renders "{env.sessions.length} connected" and gates the
    // Destroy button on `env.sessions.length > 0` ("Disconnect all sessions
    // first"), so a permanently-empty tag meant that safety could never engage
    // — docs/false-safety-guards.md's class, rendered as UI. #7552 wired the
    // writers (SessionManager tags on create, untags in `_cleanupSessionMaps`
    // and `destroyAll`) AND built the missing re-broadcast: EnvironmentManager
    // emits `environment_sessions_changed` and WsServer re-sends
    // `environment_list`. So the mechanism the first draft invented is now
    // real, and this row is back in this bucket citing the code instead of a
    // plausible story.
    //
    // "By design" here means: the dashboard must NOT prune it on session death.
    // The server owns the tag and replaces the whole array; a local prune would
    // be a second implementation racing the authoritative one, and would be
    // overwritten by the next broadcast anyway.
    // #7625. Both are keyed by a sessionId, and both must survive session
    // death for the same definitional reason `failedRestores` does: the id
    // names a session parked in SessionManager._failedRestores, which is absent
    // from `_sessions` and therefore from `session_list`. `removedIds` can
    // never contain one, so a session-death prune would be a no-op or a bug.
    // They ARE transient request markers, so they are cleared on a socket drop
    // (see the onclose sweep in connection.ts) — that is a different lifetime
    // question from this bucket, which answers the KEY question only (#7488).
    retryingRestoreIds:
      'Set<string> of parked sessionIds with a retry in flight. The id names a session that is ' +
      'deliberately NOT live, so session-death pruning cannot apply. #7625',
    retryRestoreResults:
      'Record<sessionId, retry outcome> keyed by a PARKED session id — one absent from _sessions ' +
      'and from session_list, so removedIds can never name it and a session-death prune could ' +
      'only ever be a no-op. The outcome must also outlive the attempt itself: a failed retry ' +
      'leaves the row on screen and this record is what that row renders. #7625',
    environments:
      'EnvironmentInfo[] — keyed by `EnvironmentInfo.id`, and the element carries `sessions: ' +
      'string[]`, a LIVE attachment list of real session ids (#7552 wired ' +
      '`environmentManager.addSession`/`removeSession` to SessionManager\'s create/cleanup ' +
      'funnels). It is not pruned dashboard-side because the SERVER owns it: it untags on every ' +
      'session-death path and re-broadcasts `environment_list` via ' +
      '`environment_sessions_changed`, replacing the whole array — a local prune would race the ' +
      'authoritative replacement and be overwritten by it. The tag is load-bearing, not ' +
      'cosmetic: EnvironmentPanel gates Destroy on `sessions.length > 0`. #7551 / #7552',
  }


  /**
   * Every COLLECTION-shaped member declared on `ConnectionState`, by shape.
   *
   * THREE shapes since #7527, not two: `Record<string, …>`, `Set<string>`, and
   * arrays. The array half was the blind spot #7527 was filed for —
   * `sessionNotifications: SessionNotification[]` is a session-TAGGED array
   * that this extraction could not see in either direction, so it was neither
   * cleaned nor classifiable, and the next session-tagged array would have
   * joined the store the same way: unclassified, unguarded, and green.
   *
   * Sliced to the interface first: types.ts declares other interfaces with
   * two-space members (`env?: Record<string, string>` on the MCP shapes), and a
   * file-wide match would silently widen the roster with fields that are not
   * store state at all.
   *
   * A FUNCTION over an arbitrary source, not an expression over `typesSrc`, so
   * the phantom-member tests at the bottom of this describe can run the real
   * extraction against a synthetic interface. That is what turns "a new array
   * member is red until classified" from a mutant someone ran once into a
   * permanent cell — the same move the `roster removal sites` describe already
   * makes for its site detector.
   *
   * SHAPE is the boundary, and #7573 review (C2 → #7579) names the gap it leaves:
   * a daemon snapshot typed as a plain object or a named message type is none of
   * `Record<string,` / `Set<string>` / `[]`, so it is never extracted here,
   * never classified, and never asked the lifetime question. `credentialsStatus`,
   * `byokCredentialsStatus`, `orchestrationRuns`, `scheduledTasks` and the Control
   * Room survey family sit in exactly that blind spot. So "the deferred bucket is
   * EMPTY" is acceptance for every Record/Set/Array-shaped member — NOT for
   * "every connection-scoped collection", the stronger claim the PR title reads
   * as. #7579 widens the extraction to reach the object-shaped members.
   */
  /** The `ConnectionState` interface body in `src`, or `''` when it is absent. */
  const sliceInterface = (src: string): string =>
    (/^export interface ConnectionState[\s\S]*?^\}/m.exec(src) ?? [''])[0]!

  function declaredMembers(src: string): { recordSet: string[]; array: string[]; all: string[] } {
    const body = sliceInterface(src)
    const recordSet = [...body.matchAll(/^ {2}(\w+)\??: (?:Record<string,|Set<string>)/gm)].map((x) => x[1]!)
    // The array shape. Seven FUNCTION members are declared on this interface and
    // every one of them has a `[]` inside its parameter list
    // (`requestGitStage: (paths: string[]) => boolean;`), so "contains `[]`" is
    // not the test — a version of this that reported those seven as
    // unclassified collections would be noise someone silences by widening a
    // bucket to admit them.
    //
    // TWO things exclude them, and this comment names both because two earlier
    // drafts each named something that did not do the job:
    //
    //   1. The type HEAD is anchored immediately after `: `. A function
    //      member's head is a parameter list, and `[]` never follows its
    //      closing paren — `(paths: string[])` is followed by ` => boolean`.
    //      This is what actually does the work.
    //   2. `(?![^;]*=>)` rejects a member whose declaration reaches a `=>`
    //      BEFORE its terminating `;`. Belt-and-braces for the parenthesised
    //      alternative, which is genuinely fooled by a parenthesised type inside
    //      a parameter list: `(a: (b)[]) => void` reads as `(…)[]` to rule 1
    //      alone.
    //
    // Draft 1 anchored `…\[\](?: \| null)?;$` and claimed the END-OF-LINE
    // anchor separated function members. Deleting it as a mutant killed NOTHING
    // (119/119 green) — rule 1 was doing the work — and it cost two real cases
    // (a member with a trailing `// comment`, and `Foo[] | Bar[]`). Deleted.
    //
    // Draft 2 wrote rule 2 as `(?!.*=>)`, scanning the WHOLE LINE, and PR #7551's
    // review found the hole that opens: a trailing comment is part of the line,
    // so
    //
    //     sessionAgentRuns: AgentRunRecord[]; // maps sessionId => run
    //
    // is a session-tagged array member that the guard cannot see, because the
    // `=>` in its COMMENT disarms the lookahead. Green, silently, on exactly the
    // field this guard exists to catch — the trailing-comment hole draft 1 had
    // closed by accident and draft 2 reopened by hand. `[^;]*` stops the
    // lookahead at the member's own terminator, so the comment can no longer
    // reach into it. Verified byte-identical on the real interface: both spellings
    // extract the same 24 members, and all seven function members stay out
    // (including `sendInput` / `addUserMessage`, whose inline-object parameters
    // contain a `;` of their own — those are excluded by rule 1, not rule 2).
    //
    // Both holes are pinned below: `covers the array spellings a real member is
    // written in` (re-adding the end anchor goes red) and `sees a session-tagged
    // array member hidden behind a trailing comment` (reverting to `.*` goes red).
    const array = [
      ...body.matchAll(/^ {2}(\w+)\??: (?![^;]*=>)(?:readonly )?(?:Array<[^<>]*>|(?:\w+(?:<[^<>]*>)?|\([^)]*\))\[\])/gm),
    ].map((x) => x[1]!)
    // Deduped: a member could in principle match BOTH shapes (an array OF
    // records, `Record<string, X>[]`). None is declared today; if one lands it
    // is one member needing one bucket, not two entries needing two.
    return { recordSet, array, all: [...new Set([...recordSet, ...array])] }
  }

  /**
   * The RESIDUAL: members that MENTION an array and are not accounted for.
   *
   * PR #7551's review, and the answer to a question the spelling list could not
   * answer. `covers the array spellings a real member is written in` enumerates
   * the shapes the extraction handles — which means it can only ever be as
   * complete as whoever last thought about it, and the review named four shapes
   * it missed at once: an inline-object element (`{ sessionId: string }[]`,
   * already IN USE at types.ts:445 on `PermissionAuditEntry.rules`, an element
   * of a DEFERRED member), `ReadonlyArray<…>`, `Array<Record<…>>`, and tuples.
   * Adding four rows to a list is the "hardcoded list next to a set that grows"
   * move that produced this whole issue; deriving the residual is not.
   *
   * The claim: every member whose TYPE mentions an array is either extracted as
   * an array, extracted as a Record/Set, or is function-typed. Anything else is
   * a shape that mentions an array and reached NO bucket — which is precisely
   * "unclassified and invisible", the #7527 defect, whatever spelling it wears.
   *
   * Both derived sets strip a trailing `// comment` first, for the same reason
   * the extraction's own lookahead does: a comment is not part of the type, and
   * letting it in is how the trailing-comment hole worked. Without the strip,
   * `sessionAgentRuns: AgentRunRecord[]; // a => b` would be misread as
   * function-typed and excused from the residual — the hole one level up.
   *
   * KNOWN BOUNDARY, stated rather than implied (#7551 review): an ARRAY OF
   * FUNCTIONS — `handlers: (() => void)[]` — contains `=>` in its type, so this
   * classifies it as function-typed and excuses it from the residual. It is a
   * real collection and would be missed. No such member is declared today, and
   * the alternative (parsing TS types properly, in a regex) buys a shape nobody
   * has written for a large increase in the ways this can go wrong. A member
   * declared that way needs the extraction widened, not the residual loosened —
   * which is the same instruction the residual's own failure message gives.
   */
  function arrayResidual(src: string): string[] {
    const body = sliceInterface(src)
    const typeOf = (t: string): string => t.replace(/\/\/.*$/, '')
    const members = [...body.matchAll(/^ {2}(\w+)\??: ([^\n]*)$/gm)].map((m) => ({
      name: m[1]!,
      type: typeOf(m[2]!),
    }))
    const { recordSet, array } = declaredMembers(src)
    const accounted = new Set([...recordSet, ...array])
    return members
      .filter((m) => /\[|Array</.test(m.type))          // mentions an array, in any spelling
      .filter((m) => !accounted.has(m.name))            // …and no shape pattern claimed it
      .filter((m) => !/=>/.test(m.type))                // …and it is not a function member
      .map((m) => `${m.name}: ${m.type}`)
  }

  // One derivation of the slice, used by both the extraction and the
  // declaration-text assertions below. It was two identical regexes until the
  // #7527 refactor; the copy is always the convenient thing to write and always
  // the one that drifts.
  const interfaceBody = sliceInterface(typesSrc)
  const { recordSet: declaredRecordSet, array: declaredArray, all: declared } = declaredMembers(typesSrc)

  it('control: the structural extraction is non-vacuous and sees the known fields', () => {
    // Guards the guard. If the interface slice or the member pattern stops
    // matching, `declared` goes empty and every loop below passes vacuously —
    // "cannot check this" silently becoming "nothing to check".
    //
    // The floor is deliberately loose (the roster grows) but the named members
    // are exact: the seven under test, one from each other bucket, and a
    // `Set<string>` from OUTSIDE `CLEANED` so a regression to Records-only is
    // still caught if the CLEANED roster ever loses its own Set. A `Set`
    // matters because #7483 is one — the shape the first version of this guard
    // could not express at all.
    expect(declared.length).toBeGreaterThanOrEqual(30)
    expect(declared).toEqual(expect.arrayContaining([
      ...CLEANED,
      'sessionStates',
      'sessionPresetSnapshots',
      'resolvedPermissions',
      'reindexingRepoPaths',
      // #7527 — an ARRAY member in the floor, one per bucket, so a regression
      // that drops the array half of the extraction fails HERE and not only in
      // `classification`. Without these the whole array shape could stop
      // matching and every array member would simply vanish from `declared` —
      // which reads as green, because an unclassified member that is never
      // extracted is never unclassified.
      'sessions',                // SESSION_KEYED_ELSEWHERE
      'memoryStackEntries',      // SESSION_KEYED_DEFERRED
      'sessionNotifications',    // SESSION_TAGGED_BY_DESIGN
      'checkpoints',             // NOT_SESSION_KEYED
    ]))
    // Both shapes are represented in what the site blocks are checked against,
    // so `[site] cleans up X` cannot be a Records-only guard by accident.
    expect(CLEANED).toContain('pendingServerSeed')
    expect(CLEANED).toContain('cancellingActivityIds')
  })

  it('control: each of the THREE shapes is extracted, and neither half can go quiet', () => {
    // The per-shape non-vacuity the combined `declared` cannot give. A floor on
    // the union is satisfiable by one shape alone: 37 Record/Set members would
    // clear a `>= 30` union floor with the array pattern matching nothing at
    // all. So each half gets its own floor and its own named members.
    //
    // Both floors are loose (the roster grows in both directions); what they
    // pin is that the half is ALIVE.
    expect(declaredRecordSet.length, 'the Record/Set half of the extraction matched nothing')
      .toBeGreaterThanOrEqual(30)
    expect(declaredArray.length, 'the ARRAY half of the extraction matched nothing (#7527)')
      .toBeGreaterThanOrEqual(20)
    expect(declaredRecordSet).toEqual(expect.arrayContaining(['sessionStates', 'cancellingActivityIds']))
    expect(declaredArray).toEqual(expect.arrayContaining(['sessions', 'sessionNotifications']))
    // And the halves are disjoint in fact, so `declared`'s dedupe is not
    // quietly hiding a member classified once and counted twice.
    expect(
      declaredArray.filter((f) => declaredRecordSet.includes(f)),
      'member(s) matched by BOTH shape patterns — check the array regex is not eating a Record',
    ).toEqual([])
  })

  it('classification: every session-keyed-shaped collection is in exactly one bucket', () => {
    // THE test Critical 2 asked for. A new collection on ConnectionState is RED
    // until it is classified, whatever it is called — so `sessionCiChecks`, the
    // mutant that survived the name-prefix version, fails here by name.
    const classified = new Set([
      ...CLEANED,
      ...Object.keys(SESSION_KEYED_ELSEWHERE),
      ...Object.keys(SESSION_KEYED_DEFERRED),
      ...Object.keys(SESSION_TAGGED_BY_DESIGN),
      ...Object.keys(NOT_SESSION_KEYED),
    ])
    const unclassified = declared.filter((f) => !classified.has(f))
    expect(
      unclassified,
      'new collection-shaped field(s) on ConnectionState — Record, Set or ARRAY (#7527). Add each ' +
      'to CLEANED (and to all five site blocks), to SESSION_KEYED_ELSEWHERE naming the site that ' +
      'already cleans it, to SESSION_KEYED_DEFERRED with a tracking issue, to ' +
      'SESSION_TAGGED_BY_DESIGN with the adjudication that says why it must SURVIVE the session, ' +
      'or to NOT_SESSION_KEYED with the key it is actually keyed by — quoted from its ' +
      'declaration, not inferred from its name.',
    ).toEqual([])

    // And the reverse: a bucket entry for a field that no longer exists is a
    // stale allowlist, which is how an exclusion outlives its reason.
    const declaredSet = new Set(declared)
    expect(
      [...classified].filter((f) => !declaredSet.has(f)),
      'bucket entries for fields no longer declared on ConnectionState — stale allowlist',
    ).toEqual([])

    // And "in EXACTLY one bucket", which this test is NAMED for and did not
    // check (PR #7489 review): `classified` is a Set, so a field listed in two
    // buckets collapsed into one entry and passed silently. A field that is
    // both CLEANED and deferred, or both session-keyed and not, is a
    // contradiction someone has to resolve — and a guard whose name promises
    // more than its code checks is the exact class this guard exists for.
    const allEntries = [
      ...CLEANED,
      ...Object.keys(SESSION_KEYED_ELSEWHERE),
      ...Object.keys(SESSION_KEYED_DEFERRED),
      ...Object.keys(SESSION_TAGGED_BY_DESIGN),
      ...Object.keys(NOT_SESSION_KEYED),
    ]
    const seen = new Set<string>()
    const duplicated = allEntries.filter((f) => (seen.has(f) ? true : (seen.add(f), false)))
    expect(duplicated, 'field(s) classified into more than one bucket').toEqual([])
  })

  it('#7527 — the extraction covers THREE shapes, and sessionNotifications is classified', () => {
    // RETIRES the `#7516/#7527 — the array shape is out of reach` cell that
    // stood here. That cell was the honest marker for a gap: it asserted
    // `declared` did NOT contain `sessionNotifications`, and its own comment
    // said it "goes red the moment someone widens the extraction, which is when
    // the note above stops being true". Widening it is what this change does,
    // so the marker was replaced by the real classification in the same commit
    // rather than deleted or relaxed — measured red first: the widening alone,
    // with no bucket work, failed exactly the two cells the marker predicted
    // (`classification` + this one), 2 failed / 110.
    //
    // What replaces it is the positive form of the same claim, which the marker
    // could not state: the field IS extracted, and it IS classified — into the
    // bucket #7516 adjudicated it into.
    expect(declared, 'the array shape stopped being extracted (#7527)').toContain('sessionNotifications')
    expect(declaredArray, 'sessionNotifications must come from the ARRAY half').toContain('sessionNotifications')
    expect(
      Object.keys(SESSION_TAGGED_BY_DESIGN),
      'sessionNotifications belongs in the session-tagged-BY-DESIGN bucket: #7516 decided the ' +
      'alert OUTLIVES its session on purpose (the row is the record of what happened, #7353) and ' +
      'gated the session-jump instead (#7528). DEFERRED would claim someone will prune it; ' +
      'NOT_SESSION_KEYED would claim the element has no sessionId, and it has a required one.',
    ).toContain('sessionNotifications')
    // Non-vacuous, in the shape and at the declaration the classification is
    // ABOUT. Without this, every assertion above would still pass if the field
    // were renamed, or its type changed to something that is not an array of
    // session-tagged records at all.
    expect(/^ {2}sessionNotifications\??: SessionNotification\[\];/m.test(interfaceBody)).toBe(true)
    expect(/^ {2}sessionId: string;/m.test(
      (/^export interface SessionNotification[\s\S]*?^\}/m.exec(typesSrc) ?? [''])[0],
    ), 'SessionNotification must still carry a REQUIRED sessionId, or the bucket is the wrong one')
      .toBe(true)
  })

  it('every DEFERRED entry names a tracking issue', () => {
    // The bucket's contract, stated in its own comment ("An entry here needs a
    // tracking issue in its reason string") and never asserted until now — the
    // partially-pinned shape from this repo's memory: the bucket membership was
    // pinned, the reason text next to it was not.
    //
    // Vacuous while the bucket is empty, which is the honest state after #7478
    // and #7483 emptied it. It is not vacuous the moment anyone defers a field,
    // which is when it matters: a deferral without an issue number is how an
    // exclusion becomes permanent. Proven non-vacuous by mutant (adding an
    // entry with no `#N` turns this red).
    for (const [field, reason] of Object.entries(SESSION_KEYED_DEFERRED)) {
      expect(
        reason,
        `SESSION_KEYED_DEFERRED.${field} must cite a tracking issue (#N) in its reason`,
      ).toMatch(/#\d+/)
    }
  })

  it('every SESSION_TAGGED_BY_DESIGN entry names the adjudication that made it by-design', () => {
    // #7527. Same contract as the deferred bucket, for the opposite claim and
    // the same reason: "by design" with no pointer is indistinguishable from
    // "nobody has looked at this", and this bucket's whole job is to be the
    // place a DECISION is written down. An entry here says a session-tagged
    // collection deliberately survives the session — that is exactly the kind
    // of assertion a later reader must be able to check against a record.
    //
    // Not vacuous: the bucket has entries.
    expect(Object.keys(SESSION_TAGGED_BY_DESIGN).length).toBeGreaterThan(0)
    for (const [field, reason] of Object.entries(SESSION_TAGGED_BY_DESIGN)) {
      // `/#\d+/` alone is satisfied by `'dunno #1'` (#7551 review). Two cheap
      // tightenings, and the comment says what they do and do not buy:
      //   * `#\d{4,}` — chroxy passed #1000 years ago, so a 1-3 digit citation
      //     is a placeholder, not a reference. It does NOT prove the issue
      //     exists or is about this field; nothing short of a network call
      //     would, and a guard that needs the network is a guard that flakes.
      //   * a length floor — an entry in this bucket is asserting that a
      //     session-tagged collection deliberately outlives its session, and
      //     that assertion does not fit in a sentence fragment. This is the half
      //     that actually rejects `'dunno #1234'`.
      expect(
        reason,
        `SESSION_TAGGED_BY_DESIGN.${field} must cite the adjudication (#NNNN, four+ digits) that ` +
        'decided it survives — a 1-3 digit number is a placeholder, not a reference',
      ).toMatch(/#\d{4,}/)
      expect(
        reason.length,
        `SESSION_TAGGED_BY_DESIGN.${field} needs the RATIONALE beside the issue number: why does ` +
        'this session-tagged collection deliberately outlive the session it describes?',
      ).toBeGreaterThan(120)
    }
  })

  it('every SESSION_KEYED_ELSEWHERE entry names where it is cleaned', () => {
    // #7527. This bucket used to be a bare `['sessionStates']` with the reason
    // in a comment above it, which was fine for one member and stopped being
    // fine at three. Its claim — "cleaned by its own code at all five sites" —
    // is the one claim in this file that nothing checks mechanically, because
    // the cleaning happens OUTSIDE the `#7470` markers the per-cell matrix
    // slices to. So the reason must at least NAME a site, which is what makes
    // the claim falsifiable by a reader.
    // ALL five, not "at least one" (#7551 review). The bucket's claim is
    // "cleaned by its own code at all five sites"; a reason naming one site
    // satisfies a `.some` while documenting a fifth of the claim, which is the
    // partially-pinned shape this repo keeps rediscovering — the membership
    // pinned, the assertion beside it not.
    const SITE_WORDS = SITES.map(([site]) => site.split(' ')[0]!)
    expect(SITE_WORDS.length, 'the site roster is empty — this check is vacuous').toBe(5)
    for (const [field, reason] of Object.entries(SESSION_KEYED_ELSEWHERE)) {
      const missing = SITE_WORDS.filter((w) => !reason.includes(w))
      expect(
        missing,
        `SESSION_KEYED_ELSEWHERE.${field} claims it is cleaned at all five sites but its reason ` +
        'names only some of them. Name every site, or the entry belongs in a different bucket — ' +
        '"cleaned elsewhere" without saying WHERE is an exclusion nobody can check.',
      ).toEqual([])
    }
  })

  it("infoNotifications' only producer never session-tags an entry", () => {
    // The one NOT_SESSION_KEYED reason that is a claim about a PRODUCER rather
    // than about a type, pinned so it cannot rot silently.
    //
    // `infoNotifications` is `ServerError[]` — the SAME element type as
    // `serverErrors`, which is in the session-tagged bucket because its wire
    // path really does set `sessionId`. The only thing separating them is that
    // `addInfoNotification` builds its entry by hand and never sets one. If a
    // session-scoped info notice is ever added, that separation disappears and
    // the field belongs in SESSION_TAGGED_BY_DESIGN (or gets pruned) — but
    // nothing about the TYPE would change, so no shape-based guard in this file
    // would notice. This is the guard that does.
    //
    // Anchored to the action's own body, not the file: `sessionId` appears
    // hundreds of times in connection.ts, so a file-wide grep would be
    // satisfied by any of them ("source-level guards must be anchored").
    const start = connectionSrc.indexOf('  addInfoNotification: (message: string) => {')
    expect(start, 'addInfoNotification must exist in connection.ts').toBeGreaterThan(-1)
    const end = connectionSrc.indexOf('\n  },', start)
    expect(end, 'addInfoNotification must have a closing brace').toBeGreaterThan(start)
    const body = connectionSrc.slice(start, end)
    // Positive control FIRST: the slice is the right body and is non-empty, so
    // a negative assertion below cannot pass because `indexOf` drifted.
    expect(body).toContain('infoNotifications: [...state.infoNotifications, notification]')
    expect(
      /sessionId/.test(body),
      'addInfoNotification now sets a sessionId — infoNotifications is session-tagged and its ' +
      'NOT_SESSION_KEYED reason is no longer true. Move it to SESSION_TAGGED_BY_DESIGN with the ' +
      'adjudication, or prune it (#7527).',
    ).toBe(false)
  })

  /**
   * Every production call site of `environmentManager.addSession` in `sources`.
   *
   * A FUNCTION over arbitrary sources, not an expression over the real tree, so
   * the cell below can drive the REAL detector against synthetic files — the
   * same move `declaredMembers` makes, and for the same reason: a detector that
   * only ever runs against a tree where the answer is `[]` cannot be shown to
   * detect anything at all.
   */
  function addSessionCallers(sources: [string, string][]): string[] {
    return sources.flatMap(([file, raw]) => {
      // Comments blanked, not stripped, so the reported line number is still the
      // line in the ORIGINAL file (#7552 review, F2).
      const src = blankSourceComments(raw)
      return [...src.matchAll(/[A-Za-z0-9_$)\]]\s*\??\.\s*addSession\s*\(/g)].map(
        (m) => `${file}:${src.slice(0, m.index).split('\n').length}`,
      )
    })
  }

  it('the addSession detector sees both spellings of a call, and neither definition', () => {
    // #7551 review, M15b — kept as a permanent cell rather than a mutant run
    // once, because the gap it closes was invisible in exactly the way the cell
    // above is designed to be reassuring: the real tree answers `[]` whether the
    // detector works or not.
    //
    // The first version required the receiver to be immediately followed by `.`,
    // so an OPTIONAL-CHAINED call went straight through it. The server tree has
    // 88 optional-chaining call sites and already writes `environmentManager?.`
    // (http-routes.js:225), so this was one refactor away from a silent hole in
    // the premise the `environments` classification rests on.
    expect(addSessionCallers([['a.js', 'ctx.services.environmentManager.addSession(envId, sid)']]))
      .toEqual(['a.js:1'])
    expect(addSessionCallers([['b.js', 'ctx.services.environmentManager?.addSession(envId, sid)']]))
      .toEqual(['b.js:1'])
    expect(addSessionCallers([['c.js', 'const m = get(); m ?. addSession(envId, sid)']]))
      .toEqual(['c.js:1'])
    // …and the DEFINITION is still not a caller, which is the property that lets
    // environment-manager.js stay IN the scanned tree instead of being excluded
    // from the guard that is about it.
    expect(addSessionCallers([['environment-manager.js', '  addSession(envId, sessionId) {\n    ...\n  }']]))
      .toEqual([])
    // Nor is an unrelated method that merely ends in the same letters.
    expect(addSessionCallers([['d.js', 'ctx.timeouts.removeSession(sid)\nctx.x.readdSession(sid)']]))
      .toEqual([])
    // Nor is a COMMENT that quotes one (#7552 review, F2). This is not
    // hypothetical: session-manager.js documents both calls in JSDoc that names
    // them, so without blanking, deleting the code and leaving the comment —
    // the #7421 shape, a guard removed with its documentation left behind —
    // would read as a live caller.
    expect(addSessionCallers([['e.js', '// ctx.services.environmentManager.addSession(envId, sid)']]))
      .toEqual([])
    expect(addSessionCallers([['f.js', '/* x.addSession(a, b) */\nconst y = 1']]))
      .toEqual([])
    // …and blanking preserves offsets, so a real call after a comment still
    // reports its true line.
    expect(addSessionCallers([['g.js', '// addSession is wired here:\nmgr.addSession(a, b)']]))
      .toEqual(['g.js:2'])
  })

  it('EnvironmentInfo.sessions has a production writer, and it is paired with a remover', () => {
    // #7552 INVERTED this cell, which is what its predecessor said to do.
    //
    // The history in one paragraph, because the classification is only legible
    // with it: #7551's draft called `environments` session-tagged and justified
    // it with an `environment_list` re-broadcast that did not exist. Review
    // moved the row to NOT_SESSION_KEYED for the real reason — the `sessions`
    // tag had ZERO production writers and was `[]` at runtime forever — and
    // left THIS cell asserting that zero, so the classification could not
    // outlive the state it was correct for. #7552 then fixed the surface: the
    // tag is load-bearing (EnvironmentPanel gates its Destroy button on
    // `sessions.length > 0`), so a permanently-empty tag was a safety that
    // could never engage.
    //
    // So the scan is unchanged and the claim is now the positive one: there IS
    // a production caller. The pairing half matters as much as the existence
    // half — an `addSession` with no matching `removeSession` caller is the
    // INVERSE bug (a stale id makes the environment permanently undestroyable),
    // so both are pinned here rather than only the writer the old cell named.
    //
    // KNOWN LIMIT, stated rather than left for the next reader to discover
    // (#7552 review, R1). This cell greps for the CALL SITE. It cannot see the
    // RECEIVER: `this._environmentManager?.addSession(...)` is optional-chained,
    // so deleting the single `environmentManager,` argument from
    // `new SessionManager({…})` in server-cli.js leaves every call site intact,
    // running against null, with this cell green and the tag `[]` again. That
    // injection point has its own anchored cell in
    // `packages/server/tests/environment-session-wiring.test.js`
    // ("server-cli hands the EnvironmentManager to the SessionManager"), and the
    // behaviour has six detach cells and an attach cell beside it. Those are the
    // teeth; this is the cross-package structural half that keeps the
    // CLASSIFICATION below honest, and it is defence in depth, not the guard.
    //
    // Positive controls FIRST, so a scan that reached the wrong tree — or no
    // tree — cannot report a clean answer in EITHER direction. This is the
    // "validate the control, not just the experiment" failure: a mutant that
    // never loads reports 0 hits, which used to read as PASS here.
    expect(serverProductionSources.length, 'the server source scan found nothing')
      .toBeGreaterThan(50)
    const manager = serverProductionSources.find(([f]) => f.endsWith('environment-manager.js'))
    expect(manager, 'environment-manager.js must be in the scanned tree').toBeDefined()
    expect(/^ {2}addSession\(envId, sessionId\) \{/m.test(manager![1]),
      'the writer this cell is about must still exist, or the check is about nothing').toBe(true)

    // The check. A DEFINITION is not a caller, so the declaration line above is
    // excluded by requiring a receiver (`x.addSession(`) — otherwise
    // environment-manager.js would flag itself and the escape would be to
    // exclude the file, which is how a guard stops covering the thing it names.
    //
    // `\??\.` because OPTIONAL CHAINING is a call (#7551 review, M15b). The
    // first version's receiver class `[A-Za-z0-9_$)\]]` is immediately followed
    // by `\.`, so `environmentManager?.addSession(envId, sid)` did not match —
    // the `?` sits between the receiver and the dot. That is not hypothetical
    // here: the server tree has 88 optional-chaining call sites, and
    // `environmentManager?.` is one of the spellings already in use
    // (http-routes.js:225). A guard against "a production caller appears" that
    // is blind to one of the two ways this codebase writes a call is the
    // "guard whose comment describes a stronger check than its code performs"
    // family, again. `\s*` on both sides so ` ?. ` is caught too, and the
    // DEFINITION line still does not match — it has no receiver at all.
    const callers = addSessionCallers(serverProductionSources)
    expect(
      callers.length,
      '`EnvironmentInfo.sessions` has NO production caller of environmentManager.addSession — it ' +
      'is dead surface again (#7552). The dashboard renders the tag and GATES the Destroy button ' +
      'on it ("Disconnect all sessions first"), so an unwritten tag makes that safety unable to ' +
      'engage: an environment becomes destroyable out from under its live sessions. Either ' +
      're-wire the writer or delete the tag AND the guard together — a permanently-inert safety ' +
      'gate is not an option.',
    ).toBeGreaterThan(0)
    // WHERE, not just how many. `toBeGreaterThan(0)` alone would be satisfied by
    // a caller anywhere — including a future one added for an unrelated reason
    // in an unrelated file — while the session lifecycle quietly stopped
    // tagging. session-manager.js is the attach point the whole fix rests on.
    expect(
      callers.map((c) => c.split(':')[0]),
      'the addSession caller must be SessionManager (the create funnel). If the attach moved, ' +
      'move this expectation with it and say where it went.',
    ).toContain('session-manager.js')

    // The remover, pinned in the same cell. An attach without a detach is the
    // inverse bug: a stale session id in `env.sessions` keeps the Destroy
    // button disabled forever and the environment can never be torn down. The
    // per-path proof lives server-side in
    // packages/server/tests/environment-session-wiring.test.js (six detach
    // cells); this is the cross-package structural half, because the dashboard
    // classification is what goes stale if the pairing is ever dropped.
    // The RECEIVER is part of the pattern here, unlike `addSession`. A bare
    // `x.removeSession(` detector would be satisfied by
    // `this._timeoutManager.removeSession(sessionId)` and
    // `this._costBudget.removeSession(sessionId)`, which sit four lines away in
    // the same function — the "measure a defect class with a tool that lacks
    // it" failure, and it would have passed on the dead-surface tree too.
    // Deliberately NOT /g: a global regex carries `lastIndex` across `.test()`
    // calls, so reusing one in a `.filter()` skips files at random — a detector
    // whose answer depends on iteration order.
    const ENV_REMOVE_RE = /environmentManager\s*\??\.\s*removeSession\s*\(/i
    // Controls: anchored to the receiver, not to the method name…
    expect('    this._timeoutManager.removeSession(sessionId)'.match(ENV_REMOVE_RE)).toBe(null)
    expect('this._environmentManager?.removeSession(id, sid)'.match(ENV_REMOVE_RE)).not.toBe(null)
    // …and not satisfiable by the JSDoc that documents the call (#7552 review,
    // F2). environment-manager.js's own `removeSession` docstring says
    // "called from SessionManager._cleanupSessionMaps", so this matters.
    expect(ENV_REMOVE_RE.test(blankSourceComments('// this._environmentManager?.removeSession(a, b)')))
      .toBe(false)
    expect(ENV_REMOVE_RE.test(blankSourceComments('this._environmentManager?.removeSession(a, b)')))
      .toBe(true)

    const removeCallers = serverProductionSources
      .filter(([, src]) => ENV_REMOVE_RE.test(blankSourceComments(src)))
      .map(([file]) => file)
    expect(
      removeCallers,
      'SessionManager calls environmentManager.addSession but never removeSession — every session ' +
      'that opens in an environment would be tagged FOREVER, and the environment could never be ' +
      'destroyed (the inverse of #7552).',
    ).toContain('session-manager.js')

    // And the CLASSIFICATION this evidence exists for, asserted in the same
    // cell so the two cannot drift apart. The predecessor cell had a real gap
    // here: it proved "no writer" and left the bucket membership to prose, so a
    // row moved between buckets by hand was invisible to it. Now the evidence
    // and the conclusion go red together.
    expect(
      Object.keys(SESSION_TAGGED_BY_DESIGN),
      '`environments` must be classified SESSION_TAGGED_BY_DESIGN while `EnvironmentInfo.sessions` ' +
      'carries live session ids (#7552). NOT_SESSION_KEYED would claim the element has no session ' +
      'id, and it has a list of them.',
    ).toContain('environments')
  })

  // ---- The extraction's own contract, on synthetic sources (#7527). -------
  //
  // The phantom 25th array member, kept as PERMANENT tests rather than run once
  // as a mutant — the same move the `roster removal sites` describe makes for
  // its site detector, and for the same reason: a mutant proves the guard was
  // alive on the day someone ran it, and these prove it is alive on every run.
  //
  // #7481's review is the standard being met here. It killed the previous
  // version of this guard with a mutant named for the DEFECT (`sessionCiChecks`
  // — a real-looking session-keyed map) rather than for the guard's own
  // pattern (`sessionPrMutantSixth`), and the renamed mutant survived 38/38 in
  // silence. So the phantoms below are named for what a real new field would be
  // called, and the shapes are the ones a real one would have.

  /** A synthetic `ConnectionState` with `members` as its body. */
  const iface = (members: string[]): string =>
    ['export interface ConnectionState {', ...members.map((m) => `  ${m}`), '}', ''].join('\n')

  it('sees a phantom 25th array member that no bucket names', () => {
    // THE cell #7527's acceptance asks for. A session-tagged array added to the
    // store is RED until someone classifies it — which is the property the old
    // marker cell could only assert the ABSENCE of.
    const phantom = iface([
      'sessionStates: Record<string, SessionState>;',
      'sessionAgentRuns: AgentRunRecord[];',
    ])
    const { array, all } = declaredMembers(phantom)
    expect(array).toEqual(['sessionAgentRuns'])
    // …and it reaches `classification` as unclassified, against the REAL
    // buckets — the half that actually turns the run red.
    const classified = new Set([
      ...CLEANED,
      ...Object.keys(SESSION_KEYED_ELSEWHERE),
      ...Object.keys(SESSION_KEYED_DEFERRED),
      ...Object.keys(SESSION_TAGGED_BY_DESIGN),
      ...Object.keys(NOT_SESSION_KEYED),
    ])
    expect(all.filter((f) => !classified.has(f))).toEqual(['sessionAgentRuns'])
  })

  it('covers arrays without swallowing function-typed members', () => {
    // The guard's CLAIM, fed exactly what it says it rejects — the failure mode
    // is not that it misses something but that it reports the function members
    // as phantom "unclassified collections", and someone silences the noise by
    // widening a bucket to admit them.
    //
    // DERIVED from the real interface, not a hand-copied sample (#7551 review):
    // the first version listed four of the seven verbatim, which is the same
    // hardcoded-list-beside-a-growing-set shape the guard is about. Every member
    // whose declaration reaches a `=>` before its `;` is a function member, and
    // NONE of them may be extracted as an array — however many there are.
    const fnMembers = [...interfaceBody.matchAll(/^ {2}(\w+)\??: ([^\n]*)$/gm)]
      .filter((m) => /=>/.test(m[2]!.replace(/\/\/.*$/, '')))
      .map((m) => m[1]!)
    // Non-vacuous, and a floor rather than an equality so the interface can grow:
    // ConnectionState declares ~200 function members, seven of which mention a
    // `[]` inside their parameter list and are therefore the ones that could be
    // mistaken for collections.
    expect(fnMembers.length, 'no function members derived — the derivation is broken').toBeGreaterThan(50)
    const fnWithArrayParam = fnMembers.filter((n) =>
      new RegExp(`^ {2}${n}\\??: [^\\n]*\\[\\]`, 'm').test(interfaceBody),
    )
    expect(fnWithArrayParam.length, 'no function member has an array in its params — nothing to swallow')
      .toBeGreaterThanOrEqual(7)
    expect(
      declaredArray.filter((f) => fnMembers.includes(f)),
      'function-typed member(s) extracted as array collections',
    ).toEqual([])

    // Plus the one synthetic case the head anchor alone gets wrong: a
    // parenthesised type inside a parameter list reads as `(…)[]`. It is the only
    // input in this file where `(?![^;]*=>)` changes the verdict, so it is what
    // keeps that lookahead from being an untestable refinement — deleting it
    // turns this cell red and nothing else.
    expect(declaredMembers(iface(['checkpoints: Checkpoint[];', 'weird: (a: (b)[]) => void;'])).array)
      .toEqual(['checkpoints'])
  })

  it('sees a session-tagged array member hidden behind a trailing comment', () => {
    // PR #7551 review, the hole the whole-line lookahead reopened. The `=>` here
    // is in a COMMENT, not in the type — the member is an ordinary
    // session-tagged array, and a guard that cannot see it is green on exactly
    // the field it exists to catch.
    const phantom = iface([
      'sessionStates: Record<string, SessionState>;',
      'sessionAgentRuns: AgentRunRecord[]; // maps sessionId => run',
    ])
    expect(declaredMembers(phantom).array).toEqual(['sessionAgentRuns'])
    // …and it reaches `classification` unclassified, which is the red that matters.
    const classified = new Set([
      ...CLEANED,
      ...Object.keys(SESSION_KEYED_ELSEWHERE),
      ...Object.keys(SESSION_KEYED_DEFERRED),
      ...Object.keys(SESSION_TAGGED_BY_DESIGN),
      ...Object.keys(NOT_SESSION_KEYED),
    ])
    expect(declaredMembers(phantom).all.filter((f) => !classified.has(f))).toEqual(['sessionAgentRuns'])
  })

  it('residual: every array-mentioning member reaches a shape pattern', () => {
    // The backstop for the SPELLING axis, derived rather than enumerated
    // (#7551 review). The cell below enumerates the spellings the extraction
    // handles; this one asks the complementary question the enumeration cannot:
    // is there a member that mentions an array and reached NO pattern at all?
    //
    // Baseline is exactly zero over 31 array-mentioning members — 24 extracted
    // as arrays, 7 function-typed — so it is a live check on the real interface
    // and not a floor that a broken derivation would satisfy.
    expect(
      arrayResidual(typesSrc),
      'member(s) whose type mentions an array but which no shape pattern extracted and which are ' +
      'not function-typed. A new array SPELLING has landed that the extraction cannot see — ' +
      'widen it (and add the spelling to `covers the array spellings a real member is written ' +
      'in`), do not classify around it. #7527/#7551',
    ).toEqual([])
    // Non-vacuous in the other direction: the derivation really is looking at
    // the 31 members it claims to, not at an empty set.
    const mentioning = [...interfaceBody.matchAll(/^ {2}(\w+)\??: ([^\n]*)$/gm)]
      .filter((m) => /\[|Array</.test(m[2]!.replace(/\/\/.*$/, '')))
    expect(mentioning.length, 'no member mentions an array — the residual is vacuously empty')
      .toBeGreaterThanOrEqual(31)
  })

  it.each([
    ['an inline-object element (IN USE at types.ts:445)', 'sessionAgentRuns: { sessionId: string; runId: string }[];'],
    ['ReadonlyArray<…>', 'sessionAgentRuns: ReadonlyArray<AgentRunRecord>;'],
    ['a tuple element', 'sessionAgentRuns: [string, AgentRunRecord][];'],
    ['Array<Record<…>>', 'sessionAgentRuns: Array<Record<string, string>>;'],
    // The two holes COMPOSED, which is the input that gives the residual's own
    // comment-strip behaviour. Deleting the strip was a surviving mutant until
    // this row: without it, the `=>` in the COMMENT makes the member look
    // function-typed to the residual, so an unextractable spelling is excused
    // from the one check that would have caught it — the trailing-comment hole
    // one level up from where #7551's review found it.
    ['an unextractable spelling behind a trailing `=>` comment',
      'sessionAgentRuns: ReadonlyArray<AgentRunRecord>; // keyed sessionId => run'],
  ])('residual: flags a session-tagged array written as %s', (_label, decl) => {
    // The four spellings #7551's review named, each proven to RED the residual
    // rather than assumed to. The first is not hypothetical: `{ tool: string;
    // decision: string }[]` is declared at types.ts:445 on
    // `PermissionAuditEntry.rules` — an element of a member this very guard
    // DEFERS — so the shape is already in the codebase and one refactor away
    // from being a ConnectionState member.
    const phantom = iface(['sessionStates: Record<string, SessionState>;', decl])
    expect(declaredMembers(phantom).array, 'the extraction should NOT see this spelling yet').toEqual([])
    expect(arrayResidual(phantom)).toHaveLength(1)
    expect(arrayResidual(phantom)[0]).toContain('sessionAgentRuns')
  })

  it('covers the array spellings a real member is written in', () => {
    // Optional members, `| null` unions, generic element types, unions in
    // parens, `Array<…>`, and `readonly`. All but the last two appear in
    // ConnectionState today; the last two are covered so a future member
    // written that way is not silently invisible — which is the whole defect
    // class #7527 is an instance of.
    const phantom = iface([
      'a: Foo[];',
      'b?: Foo[];',
      'c: Foo[] | null;',
      'd: Foo<Bar>[];',
      "e: ('x' | 'y')[];",
      'f: Array<Foo>;',
      'g: readonly Foo[];',
      // The two the first draft's `;$` anchor silently dropped. They are here
      // so the anchor cannot come back as a tidy-up: both go red if it does.
      'h: Foo[]; // a trailing comment is not a change of shape',
      'i: Foo[] | Bar[];',
    ])
    expect(declaredMembers(phantom).array).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
  })

  it('does not read array members off a NEIGHBOURING interface', () => {
    // The interface slice, asserted rather than assumed. types.ts declares
    // plenty of other two-space-indented interfaces (the site of the original
    // `env?: Record<string, string>` hazard), and an array member on one of
    // them is not store state — extracting it would make `classification`
    // permanently red on something no bucket should ever name.
    const phantom = [
      'export interface ConnectionState {',
      '  checkpoints: Checkpoint[];',
      '}',
      '',
      'export interface McpServerConfig {',
      '  args: string[];',
      '  hosts: HostEntry[];',
      '}',
      '',
    ].join('\n')
    expect(declaredMembers(phantom).array).toEqual(['checkpoints'])
  })

  it('control: a bucket that loses an entry turns the phantom cell red', () => {
    // The positive control for the phantom above, and the "bucket-list
    // deletion" mutant kept as a cell. Deleting a name from a bucket must make
    // that member unclassified — if it did not, every bucket entry would be
    // decoration and the whole classify-or-fail contract would be vacuous.
    const full = new Set([
      ...CLEANED,
      ...Object.keys(SESSION_KEYED_ELSEWHERE),
      ...Object.keys(SESSION_KEYED_DEFERRED),
      ...Object.keys(SESSION_TAGGED_BY_DESIGN),
      ...Object.keys(NOT_SESSION_KEYED),
    ])
    const withoutOne = new Set(full)
    expect(withoutOne.delete('sessionNotifications'), 'the entry must have been there to delete').toBe(true)
    // The DIFFERENCE the deletion makes, not the absolute unclassified list.
    // Asserting the list outright would also go red when an unrelated new
    // member lands unclassified — a second, misleading failure beside the real
    // one in `classification`, which is the cell that owns that finding.
    const unclassifiedWithout = declared.filter((f) => !withoutOne.has(f))
    const unclassifiedFull = declared.filter((f) => !full.has(f))
    expect(
      unclassifiedWithout.filter((f) => !unclassifiedFull.includes(f)),
      'deleting a bucket entry did not make its member unclassified — the buckets are decoration',
    ).toEqual(['sessionNotifications'])
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

/**
 * #7488 — the LIFETIME axis of the `NOT_SESSION_KEYED` bucket.
 *
 * ## Why a second axis
 *
 * The bucket above answers ONE question: what is this collection keyed by. That
 * is the right question for a SESSION-death roster, and `sessionPresetSnapshots`
 * was correctly parked there: it is keyed by cwd, so `removedIds` — a list of
 * session ids — has nothing to diff against it, and no session-keyed prune
 * should ever touch it.
 *
 * The classification is also what hid #7488 for three PRs. "Not keyed by a
 * session id" says nothing about whether an entry may outlive the CONNECTION,
 * and for this field it may not: cwd paths have none of the entropy that keeps
 * two daemons' session-id spaces apart (`/home/user/project`, `/workspace`,
 * `/Users/chris/Projects/chroxy` are shared across machines routinely), and
 * `ServerSessionPresetFull` carries the full preamble + seed text and the
 * preset's approval state. A preset fetched from server A was being rendered —
 * and could be approved and applied — as server B's.
 *
 * So this describe asks the second question of every member of that bucket:
 * where does it die? Three honest answers, and nothing else:
 *
 *   1. it is cleared at BOTH full-reset sites (derived — no list to maintain),
 *   2. it is cleared by `disconnect()`, named in `CLEARED_ON_DISCONNECT` and
 *      VERIFIED against that action's own body,
 *   3. it outlives the connection ON PURPOSE, named in `OUTLIVES_BY_DESIGN`
 *      with the adjudication,
 *   4. it is not cleared at all, named in `CONNECTION_LIFECYCLE_DEFERRED` with a
 *      tracking issue.
 *
 * A member in none of them is red. That is the same classify-or-fail contract
 * the bucket above uses, one axis over — and it is why #7488's acceptance did
 * NOT get answered with a comment: a comment beside a growing set is the defect
 * this whole file is about.
 *
 * ## What it found, and what #7557 / #7559 then did about it
 *
 * The first run of this axis put TWELVE members in answer 4 — the orchestration
 * / scheduled-task / credential-test family plus `pendingPairRequests`,
 * `serverStartupLogs` and `infoNotifications` — cleared by nothing at all, and
 * filed as #7557. That bucket is now EMPTY, which was the acceptance #7557 wrote
 * for itself. Eleven of the twelve are cleared at both full-reset sites (answer
 * 1); `infoNotifications` went to answer 2 instead, with its two banner siblings.
 *
 * No tally in this docstring any more. It used to open with "Of the 46 members:
 * 17 ... 16 ... 1 ... 12" and every one of those numbers was a hand-count beside
 * a set that grows — the first recurring cause in
 * `docs/false-safety-guards.md` — and the total was already wrong (the bucket
 * held 45) by the time #7557 was picked up. The split is asserted instead, and
 * asserted as a PARTITION, by `the four answers PARTITION the bucket`.
 *
 * ## The caveat on answer 2, which was a finding and is now fixed
 *
 * `disconnect()` was NOT unconditional on the switch paths: `switchServer` and
 * `connectLocal` call it only `if (get().connectionPhase !== 'disconnected')`,
 * so a server switch made from a tab already at `'disconnected'` ran
 * `_resetSessionMemory()` alone and every `CLEARED_ON_DISCONNECT` member
 * survived it (#7559).
 *
 * ONE route reached that state with the previous server's values intact, and it
 * is worth keeping written down — PR #7564's review checked the first draft of
 * this paragraph and two of the three triggers it listed were wrong:
 *
 *   * a FAILED CONNECT — real. `onRestartGaveUp` / `onProbeGaveUp`
 *     (`connection.ts`), the `auth_fail` handler, the pinned-identity refusal
 *     and the key-exchange failures (`message-handler.ts`) all land at
 *     `'disconnected'` with server A's state fully populated.
 *   * `server_down` — NOT this. It is its OWN `ConnectionPhase`
 *     (`store-core/src/types/connection.ts`), so the `!== 'disconnected'` test
 *     is true and `disconnect()` does run.
 *   * a user Disconnect — NOT this either. `disconnect()` is what set the
 *     phase, so it has already cleared all sixteen.
 *
 * `serverCapabilities` looks like the sharpest member and is in fact the
 * weakest: `auth_ok` full-replaces it unconditionally on BOTH branches, and
 * store-core's auth handler normalises an omitted `capabilities` to `{}`, so
 * even an older server B overwrites the stale map. The genuinely sharp one is
 * `availablePermissionModes`, re-set only CONDITIONALLY (`message-handler.ts`,
 * `if (auth.availablePermissionModes)`).
 *
 * The fix did NOT touch the phase guard. What that guard protects is the SOCKET
 * teardown — `socket.close()`, the attempt-id bump and the request correlations
 * — which a tab with no socket does not need. It skips MORE than the socket,
 * though: the FIVE module-level connection-scoped buffers `disconnect()` also
 * clears — the outgoing MESSAGE QUEUE, the replay CURSORS, the transcript-fetch
 * tracking, the un-flushed streaming DELTA buffers and the batched TERMINAL
 * writes — were skipped too, so a prompt queued while disconnected survived a
 * server switch and drained onto server B (the same wrong-value class, one
 * indirection over: these are not store fields). That was #7578, now fixed
 * alongside this one: `_resetSessionMemory()` calls all five at its top
 * (`clearMessageQueue()` / `resetReplayReconcile({ clearCursors: true })` /
 * `resetTranscriptFetchTracking()` / `clearDeltaBuffers()` /
 * `clearTerminalWriteBatching()`), plus the `transcriptViewer` store slice,
 * genuinely mirroring `disconnect()` — the hand-kept lockstep that follow-on
 * #7592 replaces with one shared helper. The sixteen store-field clears were the
 * other part that was wrong to skip, so they moved into
 * `createEmptyConnectionScope()` (`utils.ts`) and are spread by BOTH
 * `disconnect()` and `_resetSessionMemory()`, the action every switch path runs
 * unconditionally. `assigns` resolves that spread from the imported roster, so
 * answer 2 still means "really cleared by disconnect()" and now holds on the
 * switch as well.
 *
 * The remaining hole, named rather than omitted: `connectToServer` goes through
 * NEITHER action — it calls `connect()`, whose `currentUrl !== url` self-clear
 * runs `forgetSession()`, and `forgetSession` does not spread this roster. A
 * `connectToServer` to a DIFFERENT daemon from a disconnected tab would still
 * carry the seventeen. Its callers target the ACTIVE server, so nothing reaches
 * it today; filed rather than folded.
 */
describe('#7488 connection lifetime: a NOT_SESSION_KEYED member still needs one', () => {
  /**
   * The whole `set({ … })` payload of each action, not the `#7470` marked span.
   * These fields are connection-scoped rather than roster-scoped, so most of
   * them sit OUTSIDE the markers by design (the `reindex*` / `container*` /
   * `wsl*` families have done since #5500) — slicing to the markers would
   * report twenty false deferrals.
   */
  function actionBody(src: string, startNeedle: string, endNeedle: string): string {
    const s = src.indexOf(startNeedle)
    expect(s, `${startNeedle} must exist`).toBeGreaterThan(-1)
    const e = src.indexOf(endNeedle, s)
    expect(e, `${endNeedle} must follow it`).toBeGreaterThan(s)
    return src.slice(s, e)
  }

  const forgetBody = actionBody(connectionSrc, '  forgetSession: () => {', '  /** Reset in-memory session state')
  const switchBody = actionBody(connectionSrc, '  _resetSessionMemory: () => {', '  setViewMode:')
  const disconnectBody = actionBody(connectionSrc, "      connectionPhase: 'disconnected',", '  forgetSession:')

  /**
   * The spread rosters an action clears THROUGH rather than naming each field
   * inline. `#7559` moved the sixteen `CLEARED_ON_DISCONNECT` literals out of
   * `disconnect()` and into `createEmptyConnectionScope()`, so that both it and
   * `_resetSessionMemory` clear the same set from one definition — a token match
   * for `serverCapabilities` in `disconnect()`'s body would otherwise report
   * "cleared by nothing" for a field the action really does clear.
   *
   * The roster is IMPORTED, not transcribed: a name added to the factory is
   * resolved here on the next run, and a name deleted from it stops being
   * resolved. Transcribing it would be the hardcoded-list-beside-a-growing-set
   * defect this whole file exists to catch.
   */
  const SPREAD_ROSTERS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['createEmptyConnectionScope()', CONNECTION_SCOPED_RESET_FIELDS],
  ]

  /**
   * Strip line comments (`//…`, including a TRAILING one on a code line) and
   * block comments, so neither `assigns`'s token match nor `spreadsRoster` can
   * be satisfied by a field named only in prose.
   *
   * #7566 / #7573 review (S1): the earlier filter rejected a line whose
   * `trimStart()` began `//`, `*` or `/*`, but a trailing comment on a code line
   * slipped through — `pairingRefreshedCount: 0, // ...createEmptyConnectionScope()`
   * resolved all seventeen fields at once, and the per-field token surface had
   * the same hole. Resolving a spread multiplies that surface by the roster's
   * length, which is why one prose mention could light up all seventeen. Copilot's
   * open thread on this PR asked for exactly this; stripping first closes both
   * surfaces in one place rather than filtering line-by-line.
   */
  const stripComments = (block: string): string =>
    block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  /**
   * #7580 — `stripComments` above is LITERAL-BLIND: its two passes match `//`,
   * `/*` and the block-close delimiter as RAW text, with no idea whether a given
   * one sits inside a string or regex literal. A genuine comment is removed
   * correctly — that is the point, and a plain trailing `// comment` on a
   * tracked-field line is harmless (the field stays, only the comment goes). The
   * hazard is a comment delimiter that lives INSIDE a string or regex literal on
   * a code line: `reconnectHint: 'ws://x', field: {}` — the `//` is inside the
   * STRING, so stripComments eats `//x', field: {}` and the real `field` clear
   * with it (line strip); a `/*` inside a string or regex is worse still,
   * swallowing every line through to the next block close (block strip).
   * `assigns()` / `spreadsRoster` — the predicates this file is built on — then
   * miss an assignment that IS present: a latent FALSE NEGATIVE (a cleared field
   * read as not-cleared, or a real spread hidden). It is non-blocking TODAY only
   * because no action body carries such a literal; a future edit that adds one
   * would defeat the guard SILENTLY.
   *
   * `stripCommentHazards` returns every code line in `block` that carries such a
   * literal (empty means safe). It is a source-text heuristic in the spirit of
   * `stripComments` / `assigns`, deliberately NOT a full lexer (the issue's
   * option 1, not option 2). It walks each code line tracking string- and
   * regex-literal state and flags a `//` / `/*` / block-close found INSIDE one; a
   * `//`-only line, the interior of a block comment, a GENUINE trailing
   * `// comment`, and a GENUINE inline block comment that closes before code are
   * all handled correctly by stripComments and are NOT flagged. The per-slice
   * cell below asserts the four real action bodies produce NONE, turning the
   * silent future false-negative into a loud failure that names this issue.
   */
  const REGEX_START_CTX = '([{=:,;!&|?+-*%^~<>'
  const lineHazard = (line: string): { hazard: string | null; opensBlock: boolean } => {
    const hit = (kind: string): { hazard: string; opensBlock: boolean } => ({
      hazard: `a '//' / '/*' / '*/' inside a ${kind} (stripComments is literal-blind and eats the real code around it)`,
      opensBlock: false,
    })
    let prevSig = ''
    for (let i = 0; i < line.length; i++) {
      const c = line[i] ?? ''
      const d = line[i + 1] ?? ''
      // A string literal. Find its (escape-aware) end, then RAW-scan the span —
      // stripComments sees `//` / `/*` / `*/` regardless of any escapes, so the
      // span is checked as raw text.
      if (c === '"' || c === "'" || c === '`') {
        let k = i + 1
        for (; k < line.length; k++) {
          if (line[k] === '\\') { k++; continue }
          if (line[k] === c) break
        }
        const span = line.slice(i + 1, k)
        if (span.includes('//') || span.includes('/*') || span.includes('*/')) return hit(`${c}…${c} string literal`)
        i = k
        prevSig = c
        continue
      }
      // A genuine line comment: everything after is comment, and stripComments
      // removes exactly it — the field before it survives. Safe; stop.
      if (c === '/' && d === '/') return { hazard: null, opensBlock: false }
      // A genuine block comment (in code position `/*` is ALWAYS a comment open,
      // never a regex). Closes on this line -> its body is a comment, skip it;
      // otherwise it opens a multi-line block the caller consumes.
      if (c === '/' && d === '*') {
        const close = line.indexOf('*/', i + 2)
        if (close === -1) return { hazard: null, opensBlock: true }
        i = close + 1
        continue
      }
      // A lone `/`: a regex literal or division.
      if (c === '/') {
        // Regex-start vs division is decided by the SINGLE preceding non-space
        // CHARACTER: a regex opens after punctuation (`(`, `,`, `=`, `:`, …, or
        // line start); a `/` after an identifier / quote / close-bracket is
        // division or a path and is left alone. KNOWN, ACCEPTED GAP: a regex
        // opened directly after a KEYWORD (`return /re/`, `typeof /re/`) reads as
        // division here — we inspect one char, not a preceding word — so that
        // regex, and any `//` / `/*` in it, is NOT detected. Accepted because
        // these bodies are object-literal `set({ … })` payloads: a regex value is
        // written `field: /re/` (opener `:`), never after a bare keyword. Widen
        // to a keyword scan if that stops holding.
        if (prevSig === '' || REGEX_START_CTX.includes(prevSig)) {
          let k = i + 1
          for (; k < line.length; k++) {
            if (line[k] === '\\') { k++; continue }
            if (line[k] === '/') break
          }
          const span = line.slice(i + 1, k)
          if (span.includes('//') || span.includes('/*') || span.includes('*/')) return hit('/…/ regex literal')
          i = k
          prevSig = '/'
          continue
        }
        // division — fall through to the prevSig update
      }
      if (c !== ' ' && c !== '\t') prevSig = c
    }
    return { hazard: null, opensBlock: false }
  }
  const stripCommentHazards = (block: string): string[] => {
    const hazards: string[] = []
    let inBlockComment = false
    for (const rawLine of block.split('\n')) {
      let line = rawLine
      // Consume a block comment we are already inside; only CODE after its close
      // on this line can bite (matches how stripComments removes the whole span).
      if (inBlockComment) {
        const close = line.indexOf('*/')
        if (close === -1) continue
        line = line.slice(close + 2)
        inBlockComment = false
      }
      const trimmed = line.trimStart()
      if (trimmed === '' || trimmed.startsWith('//')) continue
      // A line that OPENS a block comment (`/* … `) is comment prose; track
      // whether the block stays open past EOL. A `*`-leading CONTINUATION line
      // is NOT special-cased here: if it is inside a real block comment the
      // `inBlockComment` consume above already skipped it, and a `*`-leading
      // line reached here with `inBlockComment` false is CODE (`* multiplier`, a
      // wrapped expression), not prose — skipping it would let a hazard on it
      // slip through (#7590 review).
      if (trimmed.startsWith('/*')) {
        const open = line.indexOf('/*')
        if (open !== -1 && line.indexOf('*/', open + 2) === -1) inBlockComment = true
        continue
      }
      // A code line — flag a comment delimiter that sits inside a literal on it.
      const { hazard, opensBlock } = lineHazard(line)
      if (hazard) { hazards.push(`${hazard}: ${rawLine.trim()}`); continue }
      if (opensBlock) inBlockComment = true
    }
    return hazards
  }

  /**
   * Does `block` really SPREAD `call`, in code? Comments are already stripped by
   * `assigns` before this runs (this is its only caller), so a prose mention of
   * `...createEmptyConnectionScope()` is no longer present to match.
   */
  const spreadsRoster = (code: string, call: string): boolean => code.includes(`...${call}`)

  /** Token match, not substring — `reindexResults` contains `reindex`. */
  const assigns = (block: string, field: string): boolean => {
    const code = stripComments(block)
    return (
      new RegExp(`(^|[^A-Za-z0-9_$])${field}\\s*[:=][^=]`).test(code) ||
      SPREAD_ROSTERS.some(([call, fields]) => fields.includes(field) && spreadsRoster(code, call))
    )
  }

  /**
   * Answer 2: cleared by `disconnect()`, not by the two full-reset sites.
   *
   * The reason string is not decoration — the cell below asserts each of these
   * really IS assigned in `disconnect()`'s body, so a field cannot be parked
   * here with a shrug, and one that stops being cleared there goes red.
   *
   * Read with the #7559 caveat in this describe's docstring: `disconnect()` is
   * conditional on the switch paths.
   */
  const CLEARED_ON_DISCONNECT: Record<string, string> = {
    permissionInputs: 'disconnect() — a half-typed permission reply is dead with the socket',
    resolvedPermissions: 'disconnect() — the requestIds belong to the dropped connection',
    serverCapabilities:
      '#3272 review — disconnect() clears it so a reconnect against a different (or older) server ' +
      'cannot have its UI gates left enabled by stale state (empty = fail-closed)',
    availableProviders: 'disconnect() — the provider registry is per daemon',
    availableModels: 'disconnect() — the model list is per daemon/provider',
    availablePermissionModes: 'disconnect() — the mode enum is advertised per daemon',
    connectedClients: 'disconnect() — the presence roster belongs to the dropped socket',
    webTasks: 'disconnect() — web-task list is per daemon',
    slashCommands: 'disconnect() — project commands differ per daemon and per session cwd',
    filePickerFiles: "disconnect() — a listing of the OLD daemon's filesystem",
    mcpResources: 'disconnect() — the MCP resource list is per daemon',
    customAgents: 'disconnect() — project agents differ per daemon and per session cwd',
    conversationHistory: "disconnect() — transcripts pulled from the OLD daemon",
    searchResults: "disconnect() — a search over the OLD daemon's transcripts",
    checkpoints: 'disconnect() — checkpoints belong to a session on the old daemon',
    environments: 'disconnect() — container/worktree environments are per daemon',
    // #7557's twelfth field, adjudicated onto THIS answer rather than onto the
    // two full-reset sites, and it is the one member here whose home was
    // decided against a precedent rather than by its key space. #7528 ruled
    // that a notification row is a RECORD and must survive the SESSION it
    // describes; that is about session death and is untouched (nothing prunes
    // this map on a roster wipe). Its two siblings in the SAME banner list,
    // `serverErrors` and `sessionNotifications`, are cleared by `disconnect()`
    // and by neither full-reset site — so the connection boundary is already
    // where host-level notice history dies, and this field was simply the one
    // nobody added.
    infoNotifications:
      "#7557 — host-level toasts ('update available', 'Transcript copied'), bounded to the last " +
      '10. Cleared by disconnect() with its two banner siblings serverErrors / sessionNotifications, ' +
      'which #7528 (a notification is a RECORD) does not cover: that adjudication is about SESSION ' +
      'death, and no roster wipe touches this map',
  }

  /**
   * Answer 3: outlives the connection on purpose. An entry here cites the
   * adjudication, exactly as a deferral cites its tracking issue.
   */
  const OUTLIVES_BY_DESIGN: Record<string, string> = {
    serverRegistry:
      'ServerEntry[] — the multi-server picker IS this list, and it is loaded from localStorage at ' +
      'construction. Clearing it on a connection boundary would delete the user\'s servers (#5281). ' +
      'Its NOT_SESSION_KEYED reason already says it "outlives every connection by design".',
  }

  /**
   * Answer 4: not cleared anywhere. Tracked, not hidden.
   *
   * EMPTY, and that is #7557's acceptance rather than an accident. It held
   * twelve names — the orchestration / scheduled-task / credential-test family
   * plus `pendingPairRequests`, `serverStartupLogs` and `infoNotifications` —
   * and every one of them now has a real lifetime: eleven are cleared at BOTH
   * full-reset sites (answer 1, derived, so nothing lists them), and
   * `infoNotifications` sits in `CLEARED_ON_DISCONNECT` above with the reason it
   * went there instead.
   *
   * Leave it empty rather than deleting it. The `every NOT_SESSION_KEYED member
   * has a lifetime` cell needs a fourth answer to point a future field at, and
   * the per-entry contract below (cite an issue, and stop being deferred once
   * fixed) is what makes the next deferral expire on its own. The cells that
   * iterate it are VACUOUS while it is empty — stated plainly, because a
   * for-loop over `{}` passing is not evidence of anything — so the two cells
   * that carry real weight now are `the deferred bucket is EMPTY` and the
   * membership predicate below it, both of which assert against a non-empty
   * subject.
   */
  const CONNECTION_LIFECYCLE_DEFERRED: Record<string, string> = {}

  it('every NOT_SESSION_KEYED member has a lifetime, or is a tracked deferral', () => {
    const unaccounted = Object.keys(NOT_SESSION_KEYED).filter(
      (f) =>
        !(assigns(forgetBody, f) && assigns(switchBody, f)) &&
        !(f in CLEARED_ON_DISCONNECT) &&
        !(f in OUTLIVES_BY_DESIGN) &&
        !(f in CONNECTION_LIFECYCLE_DEFERRED),
    )
    expect(
      unaccounted,
      'a NOT_SESSION_KEYED collection is cleared by nothing and classified by nothing. Being keyed ' +
      'by something other than a session id does not mean it may outlive the CONNECTION — clear it ' +
      'at both full-reset sites, or name where it dies in CLEARED_ON_DISCONNECT, or state the ' +
      'adjudication in OUTLIVES_BY_DESIGN, or defer it in CONNECTION_LIFECYCLE_DEFERRED with a ' +
      'tracking issue. #7488',
    ).toEqual([])
    // Non-vacuous: the classification really is looking at the whole bucket.
    expect(Object.keys(NOT_SESSION_KEYED).length, 'the bucket is empty — nothing was classified')
      .toBeGreaterThanOrEqual(40)
  })

  it('sessionPresetSnapshots is cleared at BOTH full-reset sites', () => {
    // The site axis for #7488's fix, source-anchored beside the behavioural
    // assertions in session-preset-snapshots-lifecycle.test.ts. Named per site
    // so clearing one and not the other says which one is missing.
    expect(assigns(forgetBody, 'sessionPresetSnapshots'), 'forgetSession must clear it').toBe(true)
    expect(assigns(switchBody, 'sessionPresetSnapshots'), '_resetSessionMemory must clear it').toBe(true)
  })

  it('sessionPresetSnapshots is NOT cleared by auth_ok — the adjudication, pinned', () => {
    // A same-server reconnect keeps its presets: `auth_ok`'s non-reconnect
    // branch is reached by Disconnect → Connect to the SAME server, where a
    // preset for a cwd is still true. The server-switch route reaches it too,
    // but only after `_resetSessionMemory` has already cleared the map.
    const authokBlock = handlerSrc.slice(
      handlerSrc.indexOf('#7470 authok-reset-start'),
      handlerSrc.indexOf('#7470 authok-reset-end'),
    )
    expect(authokBlock.length, 'the authok marked block must exist').toBeGreaterThan(0)
    expect(
      assigns(authokBlock, 'sessionPresetSnapshots'),
      'auth_ok must NOT clear sessionPresetSnapshots — a same-server reconnect keeps its presets (#7488)',
    ).toBe(false)
  })

  it('control: the three action slices are real, and they disagree with each other', () => {
    // Non-vacuous in both directions. A slice that failed to match would make
    // `assigns` false for everything and turn the classification test into a
    // demand that all 29 be deferred; a slice that swallowed the whole file
    // would make it true for everything and the test would pass empty.
    for (const [name, body] of [['forget', forgetBody], ['switch', switchBody], ['disconnect', disconnectBody]] as const) {
      expect(body.length, `${name} slice is empty`).toBeGreaterThan(500)
      expect(body.length, `${name} slice swallowed the file`).toBeLessThan(connectionSrc.length / 2)
    }
    // The slices are DIFFERENT regions: `serverCapabilities` is disconnect-only,
    // `reindexResults` is full-reset-only. If either claim stopped holding, the
    // classification above would be measuring one region three times.
    expect(assigns(disconnectBody, 'serverCapabilities')).toBe(true)
    expect(assigns(forgetBody, 'serverCapabilities')).toBe(false)
    expect(assigns(forgetBody, 'reindexResults')).toBe(true)
    expect(assigns(disconnectBody, 'reindexResults')).toBe(false)
  })

  it('stripComments is trustworthy on all four action bodies — no delimiter inside a literal (#7580)', () => {
    // THE GUARD. stripComments is literal-blind, so a `//` / `/*` / `*/` that sits
    // INSIDE a string or regex literal on a code line (`hint: 'ws://x', field: {}`)
    // is read as a comment and eats the real code around it — making
    // `assigns`/`spreadsRoster` miss a real clear (a silent false negative in
    // every cell above). Safe TODAY only because no body carries such a literal;
    // this fails the day one does. A plain trailing `// comment` is NOT such a
    // literal and is left alone.
    const authokBlock = handlerSrc.slice(
      handlerSrc.indexOf('#7470 authok-reset-start'),
      handlerSrc.indexOf('#7470 authok-reset-end'),
    )
    for (const [name, body] of [
      ['forgetSession', forgetBody],
      ['_resetSessionMemory', switchBody],
      ['disconnect', disconnectBody],
      ['auth_ok', authokBlock],
    ] as const) {
      expect(
        stripCommentHazards(body),
        `${name} now carries a '//' / '/*' / '*/' INSIDE a string or regex literal on a code line ` +
        `(e.g. a 'ws://…' URL, or a regex whose body holds '/*'). stripComments is literal-blind, so ` +
        `it treats that delimiter as a comment and eats the surrounding real code: ` +
        `assigns()/spreadsRoster then silently miss a real clear (a FALSE NEGATIVE). Move the literal ` +
        `off the tracked-field line, or teach stripComments to lex string/regex literals. #7580`,
      ).toEqual([])
    }
  })

  it('red-proof: the #7580 hazards each cause a real false negative, and the detector flags each', () => {
    // Each fixture assigns a tracked field IN SOURCE, yet stripComments — and so
    // `assigns`, the guard's own predicate — reads the clear as ABSENT. That
    // silent false negative is exactly what the per-slice cell above prevents.

    // 1) a `ws://` URL with a tracked field after it — the `//…$` LINE strip.
    const urlFixture = "  reconnectUrl: 'ws://localhost:8765', serverCapabilities: {},"
    expect(urlFixture.includes('serverCapabilities: {}'), 'the field IS assigned in source').toBe(true)
    expect(
      stripComments(urlFixture).includes('serverCapabilities'),
      'stripComments truncated the line at the URL // — the assignment is gone',
    ).toBe(false)
    expect(
      assigns(urlFixture, 'serverCapabilities'),
      'so the guard predicate reads a field that IS cleared as not-cleared — the false negative',
    ).toBe(false)
    expect(stripCommentHazards(urlFixture).length, 'the detector must flag the :// line').toBeGreaterThan(0)

    // 2) a stray `//` inside a string with a tracked field after it — LINE strip.
    const slashFixture = "  hint: 'docs // here', serverCapabilities: {},"
    expect(assigns(slashFixture, 'serverCapabilities'), 'same false negative from a non-URL //').toBe(false)
    expect(stripCommentHazards(slashFixture).length).toBeGreaterThan(0)

    // 3) a regex literal whose body carries `/*`, closed by a later `*/` — the
    //    `/* … */` BLOCK strip, which swallows the tracked field on the NEXT line.
    const regexFixture = [
      '  matcher: /ab\\/*cd/,',
      '  serverCapabilities: {},',
      "  trailer: 'closes here */',",
    ].join('\n')
    expect(regexFixture.includes('serverCapabilities: {}')).toBe(true)
    expect(
      stripComments(regexFixture).includes('serverCapabilities'),
      'the block strip swallowed the field between the regex /* and the trailing */',
    ).toBe(false)
    expect(assigns(regexFixture, 'serverCapabilities'), 'block-strip false negative').toBe(false)
    expect(stripCommentHazards(regexFixture).length, 'the detector must flag the regex line').toBeGreaterThan(0)
  })

  it('control: the #7580 detector ignores comments and non-hazard code (no false positive)', () => {
    // A `://` / regex / `//` living in a COMMENT is stripped correctly, so it must
    // NOT be flagged — otherwise the guard would cry wolf and the four real bodies
    // (almost entirely comment prose) could never be green.
    const commentOnly = [
      '  // reset via ...createEmptyConnectionScope(); see ws://example.com and /a\\/b/',
      '  serverCapabilities: {},',
    ].join('\n')
    expect(stripCommentHazards(commentOnly), 'a //-only line is safe').toEqual([])
    expect(assigns(commentOnly, 'serverCapabilities'), 'and the real clear still reads present').toBe(true)

    const blockComment = [
      '  /*',
      '   * a block mentioning ws://example.com, a /regex/ and a // slash',
      '   */',
      '  serverCapabilities: {},',
    ].join('\n')
    expect(stripCommentHazards(blockComment), 'a /* … */ block is safe').toEqual([])
    expect(assigns(blockComment, 'serverCapabilities')).toBe(true)

    // division and a path string are code, but neither is a stripComments hazard.
    expect(stripCommentHazards('  ratio: total / count,'), 'division is not a regex').toEqual([])
    expect(stripCommentHazards("  cwd: '/workspace/app',"), 'a path string is not a regex').toEqual([])

    // A plain regex with no // or /* inside it does NOT corrupt stripComments, so
    // it is NOT a hazard and is not flagged (the issue's hazard is a regex whose
    // BODY carries /* or //, covered by fixture 3 above).
    expect(stripCommentHazards('  probe: /abc/,'), 'a bare regex is not a stripComments hazard').toEqual([])
  })

  it('control: a genuine trailing // comment on a tracked-field line is NOT a hazard (#7580 fold)', () => {
    // FINDING #2 (code-review fold): a plain trailing comment is not a literal —
    // stripComments' `//…$` pass removes only the comment, and `assigns` still
    // sees the field. Flagging it would RED a maintainer's ordinary edit with a
    // message about a literal that is not there. The detector must leave it alone.
    const trailingComment = '  serverCapabilities: {}, // fail-closed on a stale server (#3272)'
    const inlineBlock = '  serverCapabilities: {}, /* fail-closed */ availableModels: [],'

    // The fix: neither is flagged, and each field still reads as really cleared.
    expect(stripCommentHazards(trailingComment), 'a trailing // comment is not a literal').toEqual([])
    expect(stripCommentHazards(inlineBlock), 'an inline /* */ that closes before code is not a literal').toEqual([])
    expect(assigns(trailingComment, 'serverCapabilities'), 'the clear still reads present').toBe(true)
    expect(assigns(inlineBlock, 'serverCapabilities'), 'the clear still reads present').toBe(true)
    expect(assigns(inlineBlock, 'availableModels'), 'the field after the inline block still reads present').toBe(true)

    // BEFORE the fold: the guard was `line.includes('//')`, which is TRUE for the
    // trailing-comment line — so the pre-fold guard FALSE-POSITIVED on this exact
    // benign edit. This asserts the old predicate would have fired, so the control
    // above is the thing that changed, not decoration.
    expect(trailingComment.includes('//'), 'the pre-fold `line.includes(\'//\')` would have flagged this').toBe(true)
  })

  it('a `*`-leading CODE line is scanned, not skipped as comment prose (#7590 review)', () => {
    // The scanner used to skip any line whose trimStart() began with `*` as block-
    // comment prose. But a `*`-leading CONTINUATION line that is NOT inside a real
    // block comment (the `inBlockComment` consume already handles those) is CODE —
    // a wrapped expression — and a hazard on it would slip through undetected. Here
    // a wrapped `* 'ws://cdn'.length` carries a `//` INSIDE a string, exactly the
    // stripComments-truncation class; it must be flagged, not skipped.
    const wrappedCode = ['  size: base', "    * 'ws://cdn'.length, availableModels: [],"].join('\n')
    expect(
      stripCommentHazards(wrappedCode).length,
      'a hazard on a `*`-leading code line must be caught',
    ).toBeGreaterThan(0)
    // A genuine `*` continuation INSIDE a block comment is still safe (handled by
    // the inBlockComment consume, so it is skipped there, never reaching a scan).
    const blockCont = ['  /* a wrapped', "   * note mentioning ws://x and // and /* delimiters", '   */', '  serverCapabilities: {},'].join('\n')
    expect(stripCommentHazards(blockCont), 'a real block-comment continuation is not a hazard').toEqual([])
  })

  it('every CLEARED_ON_DISCONNECT entry is really cleared by disconnect()', () => {
    // The escape hatch, checked rather than trusted — this is what stops the
    // bucket becoming a place to park a field nobody looked at.
    for (const [field, reason] of Object.entries(CLEARED_ON_DISCONNECT)) {
      expect(reason.length, `${field} needs a reason`).toBeGreaterThan(10)
      expect(assigns(disconnectBody, field), `${field} claims disconnect() clears it, and it does not`).toBe(true)
      // …and NOT at the full-reset sites, or it belongs in answer 1. Keeping the
      // buckets disjoint is what makes #7559's caveat apply to exactly this set.
      expect(
        assigns(forgetBody, field) && assigns(switchBody, field),
        `${field} IS cleared at both full-reset sites now — drop it from CLEARED_ON_DISCONNECT`,
      ).toBe(false)
    }
  })

  it('every OUTLIVES_BY_DESIGN entry states the adjudication and is really uncleared', () => {
    for (const [field, reason] of Object.entries(OUTLIVES_BY_DESIGN)) {
      expect(reason.length, `${field} needs the adjudication written down`).toBeGreaterThan(40)
      expect(assigns(forgetBody, field), `${field} is claimed to outlive the connection`).toBe(false)
      expect(assigns(switchBody, field), `${field} is claimed to outlive the connection`).toBe(false)
      expect(assigns(disconnectBody, field), `${field} is claimed to outlive the connection`).toBe(false)
    }
  })

  it('every deferral cites a tracking issue AND is really uncleared', () => {
    for (const [field, reason] of Object.entries(CONNECTION_LIFECYCLE_DEFERRED)) {
      expect(reason, `CONNECTION_LIFECYCLE_DEFERRED.${field} must cite a tracking issue (#N)`)
        .toMatch(/#\d{3,}/)
      // The other half, and the one that makes the deferral expire on its own:
      // a field someone has since FIXED must leave this list, or the list
      // becomes a permanent excuse for work that is already done.
      expect(
        assigns(forgetBody, field) && assigns(switchBody, field),
        `${field} is deferred but IS now cleared at both full-reset sites — drop it from ` +
        'CONNECTION_LIFECYCLE_DEFERRED (that removal is the acceptance for #7557)',
      ).toBe(false)
    }
  })

  it("the deferred bucket is EMPTY — #7557's acceptance, asserted per field", () => {
    // The acceptance #7557 wrote for itself: "the guard is already derived, so
    // the deferral disappearing IS the acceptance". Asserted two ways, because
    // an empty object is also what a DELETED bucket looks like.
    //
    // SCOPE (#7573 review, C2 → #7579): "empty" is acceptance for every
    // Record/Set/Array-SHAPED member — the shapes `declaredMembers` extracts —
    // not for every connection-scoped collection. Object-typed daemon snapshots
    // (`credentialsStatus`, `orchestrationRuns`, …) are never extracted, so this
    // cell is silent about them until #7579 widens the extraction.
    expect(
      Object.keys(CONNECTION_LIFECYCLE_DEFERRED),
      'a field was deferred again. That is allowed — but say which, cite the issue, and expect ' +
      'this cell to be the thing that reminds the next reader the axis is no longer clean.',
    ).toEqual([])

    // …and the eleven really are cleared, PER FIELD and PER SITE, so clearing
    // ten of them names the eleventh instead of reporting a vague red. This is
    // the source axis; `connection-lifecycle-resets.test.ts` drives the same
    // eleven through the real store.
    const CLEARED_AT_BOTH_FULL_RESETS = [
      'orchestrationPendingActions',
      'orchestrationActionResults',
      'scheduledTaskPendingActions',
      'scheduledTaskActionResults',
      'orchestrationRunDetails',
      'orchestrationRunDetailErrors',
      'orchestrationRunDetailStale',
      'orchestrationRunDetailLoading',
      'credentialTestResults',
      'pendingPairRequests',
      'serverStartupLogs',
    ]
    for (const field of CLEARED_AT_BOTH_FULL_RESETS) {
      expect(field in NOT_SESSION_KEYED, `${field} is no longer a NOT_SESSION_KEYED member`).toBe(true)
      expect(assigns(forgetBody, field), `forgetSession must clear ${field} (#7557)`).toBe(true)
      expect(assigns(switchBody, field), `_resetSessionMemory must clear ${field} (#7557)`).toBe(true)
    }
    // The twelfth went to `disconnect()` instead — named here so the split is
    // visible from the acceptance cell rather than only from the bucket above.
    expect(assigns(disconnectBody, 'infoNotifications'), 'disconnect() must clear infoNotifications (#7557)').toBe(true)
    expect(
      assigns(forgetBody, 'infoNotifications') && assigns(switchBody, 'infoNotifications'),
      'infoNotifications is in CLEARED_ON_DISCONNECT, so it must NOT be cleared at both full-reset sites',
    ).toBe(false)
  })

  it('the four answers PARTITION the bucket — derived, so no tally can go stale', () => {
    // This docstring used to open with "Of the 46 members: 17 … 16 … 1 … 12".
    // Every one of those numbers was a hand-count beside a set that grows, which
    // is the first recurring cause in `docs/false-safety-guards.md`, and the
    // total was already wrong when #7557 was picked up (the bucket held 45).
    // A count in prose cannot be checked; this can.
    //
    // Coverage is the `every NOT_SESSION_KEYED member has a lifetime` cell
    // above. This is the other half — that the answers do not OVERLAP, so a
    // field cannot be counted as cleared twice and a genuinely unclassified one
    // cannot hide behind a double count.
    const members = Object.keys(NOT_SESSION_KEYED)
    const bothSites = members.filter((f) => assigns(forgetBody, f) && assigns(switchBody, f))
    const byDisconnect = members.filter((f) => f in CLEARED_ON_DISCONNECT)
    const byDesign = members.filter((f) => f in OUTLIVES_BY_DESIGN)
    const deferred = members.filter((f) => f in CONNECTION_LIFECYCLE_DEFERRED)
    expect(
      bothSites.length + byDisconnect.length + byDesign.length + deferred.length,
      'the four lifetime answers no longer partition NOT_SESSION_KEYED — a member is in two of ' +
      'them, or in none. The per-answer cells say WHICH.',
    ).toBe(members.length)
    // Non-vacuous: each answer is actually populated, so the sum is not being
    // satisfied by one bucket holding everything.
    expect(bothSites.length, 'nothing is cleared at both full-reset sites').toBeGreaterThan(20)
    expect(byDisconnect.length, 'nothing is cleared by disconnect()').toBeGreaterThan(10)
    expect(byDesign.length).toBe(1)
    expect(deferred.length, "#7557's acceptance").toBe(0)
  })

  it('a deferral must be a NOT_SESSION_KEYED member — the axis this describe scoped itself to', () => {
    // #7563's review, A2. The staleness cell below widened its predicate to
    // `NOT_SESSION_KEYED ∪ SESSION_TAGGED_BY_DESIGN` for a real reason
    // (`environments` moved buckets and its disconnect entry is real coverage),
    // and a consequence nobody intended came with it: a SESSION_TAGGED_BY_DESIGN
    // member could be parked in THIS bucket and nothing would object, inflating
    // an issue's roster with a field that was never in its scope.
    //
    // The tightening is per-bucket rather than a narrowing of the shared
    // predicate, exactly as A2 suggested: `CLEARED_ON_DISCONNECT` legitimately
    // holds `environments`, a by-design member, and must keep it (#7552).
    const misfiled = Object.keys(CONNECTION_LIFECYCLE_DEFERRED).filter((f) => !(f in NOT_SESSION_KEYED))
    expect(
      misfiled,
      'deferred name(s) that are not NOT_SESSION_KEYED members. This describe asks the LIFETIME ' +
      'question of that bucket alone; a by-design member parked here is out of scope for whatever ' +
      'issue the deferral cites. #7563 review (A2)',
    ).toEqual([])

    // Non-vacuous while the bucket is empty: the predicate itself is exercised
    // against a synthetic bucket holding one member of each kind. Without this,
    // the cell above is a filter over `{}` and would pass with the predicate
    // inverted, deleted, or written against the wrong bucket.
    const synthetic = {
      credentialTestResults: 'a NOT_SESSION_KEYED member — allowed',
      sessionNotifications: 'a SESSION_TAGGED_BY_DESIGN member — must be rejected',
      sessionPrMutantGhostField: 'in no bucket at all — must be rejected',
    }
    expect(
      Object.keys(synthetic).filter((f) => !(f in NOT_SESSION_KEYED)),
    ).toEqual(['sessionNotifications', 'sessionPrMutantGhostField'])
  })

  it('control: the spread roster is RESOLVED, not matched as a token', () => {
    // #7559 moved the sixteen literals out of `disconnect()`. Everything above
    // that says "disconnect() clears X" now runs through `SPREAD_ROSTERS`, so
    // this cell proves the resolution is what is doing the work — if the literals
    // were somehow still there, `assigns` would pass for the old reason and a
    // broken roster resolution would never be noticed.
    expect(
      /(^|[^A-Za-z0-9_$])serverCapabilities\s*[:=][^=]/.test(disconnectBody),
      'disconnect() names serverCapabilities inline again — the spread is no longer the mechanism ' +
      'under test here, so re-check that _resetSessionMemory still clears it too (#7559)',
    ).toBe(false)
    expect(assigns(disconnectBody, 'serverCapabilities'), 'resolved via the spread roster').toBe(true)
    expect(assigns(switchBody, 'serverCapabilities'), '_resetSessionMemory spreads the same roster').toBe(true)

    // The roster is the real one, and it is the size the two issues describe:
    // #7559's sixteen plus #7557's `infoNotifications`.
    expect(CONNECTION_SCOPED_RESET_FIELDS.length).toBe(17)
    expect([...CONNECTION_SCOPED_RESET_FIELDS].sort()).toEqual([...Object.keys(CLEARED_ON_DISCONNECT)].sort())

    // A field OUTSIDE the roster is not lit up by the spread — otherwise the
    // resolution would classify the whole store as cleared.
    expect(assigns(disconnectBody, 'reindexResults'), 'not a roster member, and not inline here').toBe(false)

    // And the resolution refuses a spread that appears only in PROSE. This is
    // the surface the line filter exists for: one comment would otherwise
    // classify all seventeen fields at once.
    const commentOnly = ['  // we could just do ...createEmptyConnectionScope() here one day', '  foo: 1,'].join('\n')
    expect(assigns(commentOnly, 'serverCapabilities'), 'a comment must not satisfy the spread').toBe(false)
    const realSpread = ['  ...createEmptyConnectionScope(),'].join('\n')
    expect(assigns(realSpread, 'serverCapabilities'), 'a real spread must satisfy it').toBe(true)
  })

  it('no field is in two lifetime answers at once', () => {
    const answers = [CLEARED_ON_DISCONNECT, OUTLIVES_BY_DESIGN, CONNECTION_LIFECYCLE_DEFERRED]
    const seen = new Map<string, number>()
    answers.forEach((bucket, i) => {
      for (const f of Object.keys(bucket)) {
        expect(seen.has(f), `${f} is in two lifetime answers (${seen.get(f)} and ${i})`).toBe(false)
        seen.set(f, i)
      }
    })
    const clearedAndDeferred = Object.keys(CONNECTION_LIFECYCLE_DEFERRED).filter(
      (f) => assigns(forgetBody, f) && assigns(switchBody, f),
    )
    expect(clearedAndDeferred).toEqual([])
  })

  it('stale allowlist: every classified name is really a classified member', () => {
    // The list-goes-stale direction: a field renamed or DELETED must not leave a
    // dangling entry here quietly excusing nothing.
    //
    // #7552 merge. This cell did its job and caught a real cross-PR collision:
    // #7552 moved `environments` out of NOT_SESSION_KEYED into
    // SESSION_TAGGED_BY_DESIGN (the `sessions` tag stopped being dead surface and
    // now carries live session ids), which left its CLEARED_ON_DISCONNECT entry
    // pointing at a name that was no longer in the scanned bucket. `git merge`
    // resolved both changes textually and produced a red suite.
    //
    // The resolution keeps BOTH intents rather than picking a side. The entry is
    // a TRUE and independently-asserted fact — `disconnect()` really does clear
    // `environments` (connection.ts, inside `disconnect()`), and the
    // `every CLEARED_ON_DISCONNECT entry is really cleared by disconnect()` cell
    // below is the ONLY thing pinning it. Dropping the entry to satisfy this one
    // would have deleted that coverage for a field #7552 made MORE sensitive, not
    // less: it now carries session ids belonging to one specific daemon, so
    // leaking it across a server switch is worse than it was when the tag was
    // permanently `[]`.
    //
    // So the predicate widens by exactly one bucket, and only in the STALENESS
    // direction. This does NOT require SESSION_TAGGED_BY_DESIGN members to have a
    // lifetime — the `every NOT_SESSION_KEYED member has a lifetime` cell above
    // still scans NOT_SESSION_KEYED alone, which is the axis #7488 scoped itself
    // to. It says only: a name parked in a lifetime map must still BE a
    // classified member somewhere, so a deleted or renamed field still goes red.
    // The other three by-design members (sessionNotifications / serverErrors /
    // logEntries) appear in no lifetime map, so nothing else moves.
    const classifiedMembers = { ...NOT_SESSION_KEYED, ...SESSION_TAGGED_BY_DESIGN }
    const stale = [
      ...Object.keys(CLEARED_ON_DISCONNECT),
      ...Object.keys(OUTLIVES_BY_DESIGN),
      ...Object.keys(CONNECTION_LIFECYCLE_DEFERRED),
    ].filter((f) => !(f in classifiedMembers))
    expect(stale, 'classified name(s) that are no longer classified members of either bucket').toEqual([])

    // Non-vacuous, and specifically that the widening did not turn the cell into
    // "anything goes": a name in NEITHER bucket is still stale.
    expect(
      ['permissionInputs', 'environments', 'sessionPrMutantGhostField']
        .filter((f) => !(f in classifiedMembers)),
      'the widened predicate must still reject a name that is in no bucket at all',
    ).toEqual(['sessionPrMutantGhostField'])
  })

  it("environments keeps its disconnect lifetime entry — #7552's stake in this axis", () => {
    // #7552 review, A3. The resolution above REFUSED to drop
    // `CLEARED_ON_DISCONNECT.environments`, because the
    // `every CLEARED_ON_DISCONNECT entry is really cleared by disconnect()` cell
    // is the only thing pinning that `disconnect()` clears it. But refusing is
    // not the same as requiring: nothing made the entry mandatory, so the
    // coverage was held by CONVENTION, not construction. Measured before this
    // cell existed: deleting the entry AND `environments: []` from
    // `disconnect()` — the two halves that only make sense together — passed
    // 137/137.
    //
    // Deliberately NOT fixed by widening the axis. `every NOT_SESSION_KEYED
    // member has a lifetime` still scans NOT_SESSION_KEYED alone, which is the
    // scope #7488 chose and the right one — demanding a connection lifetime from
    // every SESSION_TAGGED_BY_DESIGN member is a different adjudication nobody
    // has made. This pins ONE member, for a reason specific to it.
    //
    // The reason: `environments` is the only by-design member whose clear #7552
    // made MORE valuable. The tag stopped being permanently `[]` and now carries
    // live session ids belonging to ONE daemon, so an `environments` array
    // surviving a server switch shows the operator sessions that do not exist on
    // the daemon they are looking at — and the Destroy guard would be reading
    // those ids. Before #7552 the array was empty and leaking it was harmless.
    expect(
      Object.keys(CLEARED_ON_DISCONNECT),
      '`environments` lost its CLEARED_ON_DISCONNECT entry. That entry is what makes the cell ' +
      'below assert `disconnect()` really clears the array, and #7552 is why it matters: the ' +
      '`sessions` tag now carries live session ids from ONE daemon, so an array that survives a ' +
      'server switch renders another daemon\'s sessions — and gates the Destroy button on them. ' +
      'Removing the entry and the `environments: []` line together used to be green; this cell is ' +
      'why it no longer is.',
    ).toContain('environments')
    // Positive control: the entry is not decorative — the clear it names is real,
    // which is the fact this cell is protecting. (The bulk cell below asserts the
    // same thing for every entry; naming it here means THIS pin cannot pass
    // against an entry pointing at nothing.)
    expect(
      assigns(disconnectBody, 'environments'),
      'disconnect() no longer clears environments — the entry pinned above is now a false claim',
    ).toBe(true)
  })
})
})


/**
 * Roster REMOVAL sites — the SITE axis, found structurally (#7495).
 *
 * ## Why this exists
 *
 * The guard above is exhaustive on FIELDS and hand-written on SITES. Adding a
 * collection to `ConnectionState` is red until every site cleans it; adding a
 * SITE was green. `session_timeout` shipped as exactly that: a fifth caller
 * that removed a session from the roster, pruned none of the seven, and turned
 * nothing red. Twice now the site count has grown under review (the fourth in
 * #7481, the fifth in #7489), which is the definition of a class rather than an
 * oversight — docs/false-safety-guards.md's "a guard wired to only some of its
 * callers", at the site axis.
 *
 * ## What it does
 *
 * It does not read the SITES table to decide what to look for. It scans the two
 * store sources for the statements that actually REMOVE entries from the
 * session roster, and requires each one to be either
 *
 *   (a) inside a `#7470 <site>-start` … `#7470 <site>-end` span, or
 *   (b) annotated in the comment block directly above it with
 *       `#7470 not-a-removal: <reason>`.
 *
 * Anything else is red, naming the file and line. Both escapes live AT the
 * site, so neither can go stale in a list somewhere else — and (b) is what the
 * store's initial-state literal uses, because an empty roster at construction
 * time is not a session going away.
 *
 * `sessionStates` is the right thing to scan for rather than `sessions`:
 * `sessionStates` is the set `removedIds` is diffed against (store-core
 * `buildSessionListPatches`), so it is the roster whose emptying is what makes
 * everything session-scoped permanently unprunable.
 *
 * ## Known limit, stated rather than implied
 *
 * FOUR spellings are recognised (see `findRosterRemovals`): a `sessionStates:
 * {}` wipe; a `delete` against a spread COPY of the roster; a rest-destructure
 * `const { [id]: _, ...rest } = <roster|copy>` (#7506); and an
 * `Object.fromEntries(Object.entries(<roster|copy>).filter(...))` filter-out
 * (#7506). The first two are what all five real sites use; the last two are
 * forward-looking. The control below asserts the detector still sees a removal
 * inside every marked site, so none of the shapes it claims can quietly stop
 * matching.
 *
 * It is still a source-text scan, not a parser, so a removal written in one of
 * these shapes is a KNOWN blind spot rather than a silent one — a future site
 * written this way must be spelled a fifth way or added deliberately:
 *   - a chain BETWEEN `Object.entries(...)` and `.filter(`, e.g.
 *     `Object.fromEntries(Object.entries(SRC).map(f).filter(g))`;
 *   - other functional rebuilds — `Object.keys(SRC).filter(...).reduce(...)`,
 *     `Object.entries(SRC).filter(...).reduce(...)`;
 *   - an inline-arrow rest-destructure, `(({ [id]: _, ...rest }) => rest)(SRC)`;
 *   - a rest-destructure whose prefix before the computed key is itself a
 *     computed key, a default value (`x = 1`) or a nested pattern (only plain
 *     shorthand / `a: b` renames are matched before the `[id]` key).
 * Each is left to documentation on purpose: chasing every idiom by regex is the
 * brittle, endless path, and "cannot check this" must not silently read as
 * "nothing to check" (docs/false-safety-guards.md).
 */
describe('#7495 roster removal sites: every site that drops a session is accounted for', () => {
  interface Removal {
    /** Human label for the statement, e.g. ``delete newStates[…]``. */
    label: string
    /** Byte offset into the source. */
    index: number
    /** 1-based line number, for the failure message. */
    line: number
  }

  /**
   * Blank every comment, preserving byte offsets and line breaks.
   *
   * Necessary rather than tidy: this file's own prose, and the annotation in
   * `connection.ts` that the detector reads, both QUOTE the patterns below —
   * `sessionStates: {}` appears verbatim inside the comment explaining why the
   * initial state is not a removal. Scanning raw text made the detector match
   * its own documentation, which is a guard reporting on itself.
   *
   * Spaces (not deletion) so every index the caller derives still lines up with
   * the ORIGINAL source, which `spansIn` and `annotatedNotARemoval` read. The
   * `(?<!:)` keeps a `https://` inside a string literal from blanking the rest
   * of its line.
   */
  // #7552 review, F2: DELEGATES to the module-scope helper rather than carrying
  // a second copy of the regex. Two hand-written copies of the same derivation
  // is the drift shape this repo keeps paying for; the docstring above stays
  // because the REASON this scan needs it is specific to these sources.
  const blankComments = blankSourceComments

  /**
   * Every statement in `src` that removes entries from the session roster.
   *
   * Four shapes (see the docstring's "known limit"):
   *   1. `sessionStates: {}` — a wholesale wipe in an object literal.
   *   2. `delete <name>[…]` where `<name>` was bound to a spread copy of the
   *      roster. The provenance step is the whole point: `delete next[requestId]`
   *      appears a dozen times in these files and is not a roster removal, so
   *      the copy has to be identified first.
   *   3. `const { [id]: _, ...rest } = <roster|copy>` — the rest-destructure
   *      "copy every entry except one key" idiom (#7506).
   *   4. `Object.fromEntries(Object.entries(<roster|copy>).filter(…))` — the
   *      functional "rebuild the map without one entry" idiom (#7506).
   *
   * Shapes 3 and 4 are scoped to the roster the same way shape 2 is: the source
   * of the destructure / `Object.entries` call must be `sessionStates` (reached
   * directly, via `get().`, or `state.`) OR a variable already bound to a spread
   * copy of it above. `connection.ts` really writes `const { [deviceKey]: _, …`
   * over `notificationPrefs.devices`, which is NOT a session removal and must
   * stay invisible — the provenance check is what keeps these from degenerating
   * into "every rest-destructure is a site", the same trap shape 2 avoids.
   */
  function findRosterRemovals(rawSrc: string): Removal[] {
    const src = blankComments(rawSrc)
    const at = (index: number): number => src.slice(0, index).split('\n').length
    const hits: Removal[] = []

    for (const m of src.matchAll(/sessionStates:\s*\{\s*\}/g)) {
      hits.push({ label: 'sessionStates: {} (wholesale wipe)', index: m.index, line: at(m.index) })
    }

    const copies = new Set<string>()
    for (const m of src.matchAll(
      /(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=;]+)?=\s*\{\s*\.\.\.\s*(?:[A-Za-z0-9_$]+(?:\(\))?\.)*sessionStates\s*\}/g,
    )) {
      copies.add(m[1]!)
    }
    for (const name of copies) {
      for (const m of src.matchAll(
        new RegExp(`(^|[^A-Za-z0-9_$.])delete\\s+${name}\\s*\\[`, 'g'),
      )) {
        hits.push({ label: `delete ${name}[…]`, index: m.index, line: at(m.index) })
      }
    }

    // The roster reached directly (`sessionStates`, `get().sessionStates`,
    // `state.sessionStates`) or through any spread-copy variable found above.
    const rosterAccess = '(?:[A-Za-z0-9_$]+(?:\\(\\))?\\.)*sessionStates'
    const copyAlt = [...copies].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const rosterSource = copyAlt ? `(?:${rosterAccess}|${copyAlt})` : `(?:${rosterAccess})`

    // A leading `(?<![A-Za-z0-9_$.])` on shapes 3 and 4 is the same boundary
    // shape 2's `(^|[^A-Za-z0-9_$.])delete` carries: without it `myconst {…}`
    // matches the embedded `const` and `fooObject.fromEntries(…)` the embedded
    // `Object`. A lookbehind rather than a captured char so `m.index` still
    // points at the keyword and the derived line number stays true.
    const notIdentTail = '(?<![A-Za-z0-9_$.])'

    // 3. Rest-destructure removal: `const { [id]: _, ...rest } = <roster|copy>`.
    //    The computed key `[…]` is required — a session id is dynamic — which
    //    also keeps benign `const { messages, ...rest } = ss` off the radar.
    //    Plain fields may precede the computed key (`const { activeSessionId,
    //    [id]: _, ...rest }`); shorthand and `a: b` renames only — a leading
    //    computed key, default value or nested pattern is a documented gap.
    const leadingFields = '(?:[A-Za-z0-9_$]+(?:\\s*:\\s*[A-Za-z0-9_$]+)?\\s*,\\s*)*'
    for (const m of src.matchAll(
      new RegExp(
        `${notIdentTail}(?:const|let)\\s*\\{\\s*${leadingFields}\\[[^\\]]+\\]\\s*:\\s*[A-Za-z0-9_$]+\\s*,\\s*\\.\\.\\.\\s*([A-Za-z0-9_$]+)\\s*\\}\\s*=\\s*(${rosterSource})(?![A-Za-z0-9_$.])`,
        'g',
      ),
    )) {
      hits.push({ label: `rest-destructure ...${m[1]} (from ${m[2]})`, index: m.index, line: at(m.index) })
    }

    // 4. Object.fromEntries filter-out: rebuild the map without one entry. The
    //    `.filter(` is what makes it a removal rather than a plain copy; it must
    //    sit DIRECTLY on the `Object.entries(…)` call (a `.map(…).filter(…)`
    //    chain between them is a documented gap, not a match).
    for (const m of src.matchAll(
      new RegExp(
        `${notIdentTail}Object\\.fromEntries\\(\\s*Object\\.entries\\(\\s*(${rosterSource})\\s*\\)\\s*\\.filter\\(`,
        'g',
      ),
    )) {
      hits.push({ label: `Object.fromEntries filter-out (${m[1]})`, index: m.index, line: at(m.index) })
    }

    return hits.sort((a, b) => a.index - b.index)
  }

  /** `[startOffset, endOffset]` for each marked span present in `src`. */
  function spansIn(src: string, markers: [string, string][]): [number, number][] {
    const spans: [number, number][] = []
    for (const [start, end] of markers) {
      const s = src.indexOf(start)
      const e = src.indexOf(end)
      if (s > -1 && e > s) spans.push([s, e])
    }
    return spans
  }

  /**
   * True when the contiguous `//` comment block DIRECTLY above `index` carries
   * the `#7470 not-a-removal` escape. Scoped to that block rather than a window
   * of N lines so the annotation cannot be satisfied by an unrelated comment
   * further up the file — "source-level guards must be anchored".
   */
  function annotatedNotARemoval(src: string, index: number): boolean {
    const lines = src.slice(0, index).split('\n')
    lines.pop() // the (partial) line the hit is on
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line.startsWith('//')) return false
      if (line.includes('#7470 not-a-removal')) return true
    }
    return false
  }

  /** The removals in `src` that are neither inside a marked span nor annotated. */
  function unaccountedRemovals(src: string, markers: [string, string][]): Removal[] {
    const spans = spansIn(src, markers)
    return findRosterRemovals(src).filter(
      (h) =>
        !spans.some(([s, e]) => h.index > s && h.index < e) &&
        !annotatedNotARemoval(src, h.index),
    )
  }

  const markersFor = (src: string): [string, string][] =>
    SITES.filter(([, s]) => s === src).map(([, , start, end]) => [start, end] as [string, string])

  // ---- The guard itself. --------------------------------------------------

  it.each(SOURCES)('%s: every roster removal is inside a marked site block or annotated', (file, src) => {
    const unaccounted = unaccountedRemovals(src, markersFor(src))
    expect(
      unaccounted.map((h) => `${file}:${h.line} ${h.label}`),
      `unaccounted roster-removal site(s) in ${file}. A statement that drops a session from ` +
      '`sessionStates` is a "the session went away" SITE: wrap it in `#7470 <site>-start` / ' +
      '`-end` markers, prune all seven session-scoped collections inside them, and add the ' +
      'site to SITES in this file — or, if it genuinely removes nothing (the initial state), ' +
      'annotate it `#7470 not-a-removal: <reason>` in the comment directly above.',
    ).toEqual([])
  })

  // ---- Controls: the detector is not vacuous, in both directions. ---------

  it.each(SITES)('control: [%s] contains a roster removal the detector can see', (_site, src, start, end) => {
    // The non-vacuity guard that matters. If either pattern stops matching —
    // a site is rewritten to remove a session some third way, or the regex
    // rots — the `unaccounted` test above goes vacuously green while the
    // detector sees nothing at all. This fails instead.
    const s = src.indexOf(start)
    const e = src.indexOf(end)
    expect(s, `${start} must exist`).toBeGreaterThan(-1)
    expect(e, `${end} must exist and follow its start`).toBeGreaterThan(s)
    const inside = findRosterRemovals(src).filter((h) => h.index > s && h.index < e)
    expect(inside.length, `${start} encloses no roster removal the detector recognises`).toBeGreaterThan(0)
  })

  it('control: the one annotated non-removal is real and is the initial state', () => {
    // The other escape hatch, proven live rather than assumed. `connection.ts`
    // builds the store's initial state with an empty roster; that is not a
    // session going away, and it is the only `#7470 not-a-removal` in the tree.
    const annotated = findRosterRemovals(connectionSrc).filter((h) =>
      annotatedNotARemoval(connectionSrc, h.index),
    )
    expect(annotated.map((h) => h.label)).toEqual(['sessionStates: {} (wholesale wipe)'])
    expect(findRosterRemovals(handlerSrc).some((h) => annotatedNotARemoval(handlerSrc, h.index))).toBe(false)
  })

  it('control: the detector finds at least one removal per site plus the initial state', () => {
    const total = SOURCES.reduce((n, [, src]) => n + findRosterRemovals(src).length, 0)
    // Five sites + the annotated initial state. A floor, not an equality: the
    // `unaccounted` test is what handles growth.
    expect(total).toBeGreaterThanOrEqual(6)
  })

  // ---- Marker hygiene: the table and the sources must agree. --------------

  it.each(SITES)('[%s] its markers appear exactly once, in order', (_site, src, start, end) => {
    // `[site] cleans up <field>` slices with `indexOf`, so a duplicated start
    // marker would silently guard the WRONG block.
    expect(src.split(start).length - 1, `${start} must appear exactly once`).toBe(1)
    expect(src.split(end).length - 1, `${end} must appear exactly once`).toBe(1)
    expect(src.indexOf(end)).toBeGreaterThan(src.indexOf(start))
  })

  it.each(SOURCES)('%s: every #7470 site marker in the source is listed in SITES', (file, src) => {
    // The other direction. Without it, someone can mark a new site's block
    // (satisfying the detector above) and never add the SITES row — so the
    // per-cell `[site] cleans up <field>` matrix would not cover it, which is
    // most of what went wrong with the fifth site.
    const found = [...src.matchAll(/#7470 ([a-z][a-z-]*)-start/g)].map((m) => `#7470 ${m[1]}-start`)
    const listed = new Set(markersFor(src).map(([s]) => s))
    expect(
      found.filter((m) => !listed.has(m)),
      `marked site block(s) in ${file} with no row in SITES — the per-field matrix does not cover them`,
    ).toEqual([])
  })

  // ---- The detector's own contract, on synthetic sources. -----------------
  //
  // The phantom sixth site, kept as a permanent test rather than run once as a
  // mutant: these pin what the detector CLAIMS, so the claim cannot rot into
  // "matches nothing" while the guard above stays green.

  const PHANTOM_MARKERS: [string, string][] = [['#7470 evict-reset-start', '#7470 evict-reset-end']]

  it('flags a phantom sixth site that deletes from a roster copy with no marker', () => {
    const phantom = [
      "    case 'session_evicted': {",
      '      const next = { ...get().sessionStates };',
      '      delete next[evictedId];',
      '      set({ sessionStates: next });',
      '      break;',
      '    }',
    ].join('\n')
    const found = unaccountedRemovals(phantom, PHANTOM_MARKERS)
    expect(found.map((h) => h.label)).toEqual(['delete next[…]'])
    expect(found[0]!.line).toBe(3)
  })

  it('flags a phantom sixth site that wipes the roster wholesale with no marker', () => {
    const phantom = '  _nuke: () => {\n    set({ sessions: [], sessionStates: {} });\n  },'
    expect(unaccountedRemovals(phantom, PHANTOM_MARKERS).map((h) => h.label))
      .toEqual(['sessionStates: {} (wholesale wipe)'])
  })

  it('accepts the same phantom site once its removal is inside a marked block', () => {
    // The positive control for both tests above: they must be failing on the
    // MISSING MARKER, not on something about the phantom source itself.
    const phantom = [
      "    case 'session_evicted': {",
      '      // #7470 evict-reset-start',
      '      const next = { ...get().sessionStates };',
      '      delete next[evictedId];',
      '      set({ sessionStates: next });',
      '      // #7470 evict-reset-end',
      '    }',
    ].join('\n')
    expect(unaccountedRemovals(phantom, PHANTOM_MARKERS)).toEqual([])
    // …and the detector still SEES the removal — "accepted" must not mean
    // "invisible", or the marked-site control above would be satisfiable by a
    // dead pattern.
    expect(findRosterRemovals(phantom).map((h) => h.label)).toEqual(['delete next[…]'])
  })

  it('accepts a removal annotated #7470 not-a-removal in the comment above it', () => {
    const phantom = [
      '  // #7470 not-a-removal: the initial empty roster.',
      '  sessionStates: {},',
    ].join('\n')
    expect(unaccountedRemovals(phantom, PHANTOM_MARKERS)).toEqual([])
  })

  it('does not accept an annotation separated from the removal by code', () => {
    // The anchor. A `#7470 not-a-removal` anywhere above must not license a
    // removal further down the file — that is the file-wide-grep failure the
    // roster guard above was already burned by.
    const phantom = [
      '  // #7470 not-a-removal: the initial empty roster.',
      '  sessionStates: {},',
      '  activeSessionId: null,',
      '  sessionStates: {},',
    ].join('\n')
    expect(unaccountedRemovals(phantom, PHANTOM_MARKERS).map((h) => h.line)).toEqual([4])
  })

  it('ignores a removal that only appears inside a comment', () => {
    // Exercised for real by `connection.ts`, whose `#7470 not-a-removal`
    // annotation quotes `sessionStates: {}` in its own prose. Without the
    // blanking pass the detector counted that comment as a second removal —
    // and, being inside the annotated block, it silently classified itself.
    const commented = [
      '  // a wipe would be written `sessionStates: {}` and would be a site',
      '  /** and `delete newStates[id]` after `const newStates = { ...sessionStates }`. */',
      '  const real = 1;',
    ].join('\n')
    expect(findRosterRemovals(commented)).toEqual([])
  })

  it('does not flag a delete against a map that is not the session roster', () => {
    // What keeps the detector from degenerating into "every `delete` is a
    // site". Both files are full of requestId- and repoPath-keyed deletes; if
    // those counted, the guard would be noise and the escape hatch would get
    // used to silence it.
    const unrelated = [
      '    const next = { ...get().resolvedPermissions };',
      '    delete next[requestId];',
      '    const copy = { ...map };',
      '    delete copy[sessionId];',
    ].join('\n')
    expect(findRosterRemovals(unrelated)).toEqual([])
  })

  it('sees a roster copy however the store is reached', () => {
    // The three spellings that appear across these files, so a future site
    // written in any of them is still detected.
    const spellings = [
      'const a = { ...sessionStates };\ndelete a[id];',
      'const b = { ...get().sessionStates };\ndelete b[id];',
      'const c = { ...state.sessionStates };\ndelete c[id];',
    ]
    for (const src of spellings) {
      expect(findRosterRemovals(src).map((h) => h.label), src).toHaveLength(1)
    }
  })

  // ---- #7506: two more removal spellings the detector was blind to. -------
  //
  // A rest-destructure (`const { [id]: _, ...rest } = sessionStates`) and an
  // `Object.fromEntries(Object.entries(sessionStates).filter(…))` both drop a
  // session from the roster, and both returned `[]` from the pre-#7506
  // detector — a silent false negative, exactly the class this whole describe
  // exists to close.

  it('flags a rest-destructure removal that drops a session by computed key', () => {
    const phantom = [
      "    case 'session_purged': {",
      '      const { [purgedId]: _dropped, ...rest } = get().sessionStates;',
      '      set({ sessionStates: rest });',
      '      break;',
      '    }',
    ].join('\n')
    const found = unaccountedRemovals(phantom, PHANTOM_MARKERS)
    expect(found.map((h) => h.label)).toEqual(['rest-destructure ...rest (from get().sessionStates)'])
    expect(found[0]!.line).toBe(2)
  })

  it('flags an Object.fromEntries filter-out that rebuilds the roster without one entry', () => {
    const phantom = [
      "    case 'session_purged': {",
      '      set({ sessionStates: Object.fromEntries(Object.entries(get().sessionStates).filter(([id]) => id !== purgedId)) });',
      '      break;',
      '    }',
    ].join('\n')
    const found = unaccountedRemovals(phantom, PHANTOM_MARKERS)
    expect(found.map((h) => h.label)).toEqual(['Object.fromEntries filter-out (get().sessionStates)'])
    expect(found[0]!.line).toBe(2)
  })

  it('sees the rest-destructure and fromEntries spellings however the roster is reached', () => {
    // Both idioms, across every way the roster is named: direct, `get().`,
    // `state.`, and a spread-copy variable bound above — the same provenance
    // the `delete <copy>[…]` pattern already resolves.
    const restSpellings = [
      'const { [id]: _, ...rest } = sessionStates;',
      'const { [id]: _, ...rest } = get().sessionStates;',
      'const { [id]: _, ...rest } = state.sessionStates;',
      'const copy = { ...get().sessionStates };\nconst { [id]: _, ...rest } = copy;',
      // leading plain fields before the computed key (#7506 review F3)
      'const { activeSessionId, [id]: _, ...rest } = sessionStates;',
      'const { a: renamed, [id]: _, ...rest } = get().sessionStates;',
    ]
    for (const src of restSpellings) {
      const hits = findRosterRemovals(src)
      expect(hits, src).toHaveLength(1)
      expect(hits[0]!.label.startsWith('rest-destructure'), src).toBe(true)
    }
    const fromEntriesSpellings = [
      'const next = Object.fromEntries(Object.entries(sessionStates).filter(([k]) => k !== id));',
      'const next = Object.fromEntries(Object.entries(get().sessionStates).filter(([k]) => k !== id));',
      'const copy = { ...state.sessionStates };\nconst next = Object.fromEntries(Object.entries(copy).filter(([k]) => k !== id));',
    ]
    for (const src of fromEntriesSpellings) {
      const hits = findRosterRemovals(src)
      expect(hits, src).toHaveLength(1)
      expect(hits[0]!.label.startsWith('Object.fromEntries'), src).toBe(true)
    }
  })

  it('does not flag a rest-destructure over a map that is not the session roster', () => {
    // `connection.ts` really does this over `notificationPrefs.devices`; only
    // the roster (or a spread copy of it) is a session removal.
    const unrelated = [
      '    const { [deviceKey]: _removed, ...rest } = notificationPrefs.devices;',
      '    const { [id]: _, ...others } = someOtherMap;',
      '    const { [id]: _, ...more } = state.resolvedPermissions;',
    ].join('\n')
    expect(findRosterRemovals(unrelated)).toEqual([])
  })

  it('does not flag an Object.fromEntries filter-out over a non-roster map or in a comment', () => {
    const unrelated = [
      '    const cleaned = Object.fromEntries(Object.entries(resolvedPermissions).filter(([k]) => k !== id));',
      '    // Object.fromEntries(Object.entries(sessionStates).filter(([k]) => k !== id)) — prose, not code',
    ].join('\n')
    expect(findRosterRemovals(unrelated)).toEqual([])
  })

  it('flags a rest-destructure whose computed key is not the first field', () => {
    // #7506 review F3 — a plain field (`activeSessionId`) before the computed
    // key. The pre-review regex required the computed key to be first, so this
    // real-shaped spelling was missed.
    const phantom = [
      "    case 'session_purged': {",
      '      const { activeSessionId, [purgedId]: _dropped, ...rest } = get().sessionStates;',
      '      set({ sessionStates: rest });',
      '      break;',
      '    }',
    ].join('\n')
    const found = unaccountedRemovals(phantom, PHANTOM_MARKERS)
    expect(found.map((h) => h.label)).toEqual(['rest-destructure ...rest (from get().sessionStates)'])
    expect(found[0]!.line).toBe(2)
  })

  it('does not flag an embedded const/let/Object keyword (leading-identifier boundary)', () => {
    // #7506 review F4 — shapes 3 and 4 begin with `const|let` / `Object`, so
    // without a leading boundary an embedded keyword matched: `myconst { … }`
    // hit the `const`, and `fooObject.fromEntries(…)` hit the `Object`. The
    // negative lookbehind (like shape 2's `delete` guard) closes both.
    const embedded = [
      'myconst { [id]: _, ...rest } = sessionStates;',
      'somelet { [id]: _, ...rest } = get().sessionStates;',
      'fooObject.fromEntries(Object.entries(sessionStates).filter(([k]) => k !== id));',
      'app.Object.fromEntries(Object.entries(sessionStates).filter(([k]) => k !== id));',
    ].join('\n')
    expect(findRosterRemovals(embedded)).toEqual([])
  })
})
