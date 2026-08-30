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
import { createEmptySessionState, pruneSessionKeyedMap, pruneSessionScopedKeySet } from './utils'
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
 * `environments` sits in NOT_SESSION_KEYED because `EnvironmentInfo.sessions` is
 * dead surface — see its reason. That is a claim about server code, so it is
 * checked against server code rather than asserted from the dashboard. Tests are
 * deliberately excluded: `environment-manager.test.js` is the ONLY caller of the
 * writer, and counting it would make the check permanently red on the state the
 * classification is correct for.
 */
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
      'session_list / session_timeout and emptied by `messages: []` at auth_ok / forgetSession ' +
      '/ _resetSessionMemory (#7527)',
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
    // #7551 review, Critical. This row was in SESSION_TAGGED_BY_DESIGN with a
    // reason that cited a mechanism which DOES NOT EXIST: "`environment_list`
    // replaces the whole array on every change, so the server is the authority".
    // The server does re-send the list, but not on session lifecycle — all four
    // `environment_list` emit sites are in `handlers/feature-handlers.js`
    // (env list / create / destroy requests) and NONE is on a session opening or
    // closing. The reason was a plausible story, not the code.
    //
    // The code is simpler and the honest reason is different: the `sessions` tag
    // is DEAD SURFACE. `environmentManager.addSession` / `removeSession`
    // (`packages/server/src/environment-manager.js`) are the only writers, and
    // they have ZERO production callers — the only call sites in the repo are
    // five lines of `tests/environment-manager.test.js`. `sessions: []` at
    // creation and `env.sessions = []` on boot reconnect are the only other
    // touches. So the tag is `[]` at runtime, always, and a dead session id
    // cannot be stranded in it because a LIVE one never gets in.
    //
    // That makes the bucket right for the ordinary reason — the element is keyed
    // by `id` — rather than for an invented one. It is pinned rather than
    // asserted in prose by `EnvironmentInfo.sessions has no production writer`
    // below, because "this classification is correct while a surface stays dead"
    // is exactly the claim that rots silently. Dead-surface cleanup: #7552.
    environments:
      'EnvironmentInfo[] — keyed by `EnvironmentInfo.id`. The element also declares ' +
      '`sessions: string[]`, but that tag is dead surface: its only writers ' +
      '(`environmentManager.addSession` / `removeSession`) have zero production callers, so it ' +
      'is `[]` at runtime and no session id — live or dead — is ever in it. If it gains a writer ' +
      'the classification must be revisited; the cell below is what forces that. #7551 / #7552',
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
    return sources.flatMap(([file, src]) =>
      [...src.matchAll(/[A-Za-z0-9_$)\]]\s*\??\.\s*addSession\s*\(/g)].map(
        (m) => `${file}:${src.slice(0, m.index).split('\n').length}`,
      ),
    )
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
  })

  it('EnvironmentInfo.sessions has no production writer', () => {
    // #7551 review, Critical. `environments` was classified SESSION_TAGGED_BY_DESIGN
    // with a reason that described a mechanism which does not exist — an
    // `environment_list` re-broadcast "on every change" that is not wired to
    // session lifecycle at all. The row is now NOT_SESSION_KEYED for the real
    // reason: `EnvironmentInfo.sessions` is never written in production, so no
    // session id — live or dead — is ever in it, so nothing can be stranded.
    //
    // "Correct while a surface stays dead" is exactly the claim that rots
    // silently, so it is a check rather than a comment. `addSession` is the only
    // thing that can put a session id into that array (`removeSession` only ever
    // takes one out), which makes it the precise thing to pin: if it gains a
    // production caller, `environments` becomes genuinely session-tagged and the
    // classification must be revisited. Cleanup / decision: #7552.
    //
    // Positive controls FIRST, so a scan that reached the wrong tree — or no
    // tree — cannot report a clean zero. This is the "validate the control, not
    // just the experiment" failure: a mutant that never loads reports 0 hits.
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
      callers,
      'production call site(s) of environmentManager.addSession. `EnvironmentInfo.sessions` is no ' +
      'longer dead surface, so `environments` is genuinely session-tagged and its ' +
      'NOT_SESSION_KEYED reason is now false — re-adjudicate it (SESSION_TAGGED_BY_DESIGN, or the ' +
      'prune roster) and close #7552.',
    ).toEqual([])
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
 * Two spellings are recognised — a `sessionStates: {}` wipe, and a `delete`
 * against a spread COPY of the roster — because those are the two all five real
 * sites use. A future site that removed a session by rest-destructuring
 * (`const { [id]: _, ...rest } = sessionStates`) or by
 * `Object.fromEntries(Object.entries(...).filter(...))` would not be seen. That
 * is a narrower hole than "no site detector at all", and the control below
 * asserts the detector still sees a removal inside every marked site — so the
 * two shapes it does claim cannot quietly stop matching.
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
  function blankComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  }

  /**
   * Every statement in `src` that removes entries from the session roster.
   *
   * Two shapes (see the docstring's "known limit"):
   *   1. `sessionStates: {}` — a wholesale wipe in an object literal.
   *   2. `delete <name>[…]` where `<name>` was bound to a spread copy of the
   *      roster. The provenance step is the whole point: `delete next[requestId]`
   *      appears a dozen times in these files and is not a roster removal, so
   *      the copy has to be identified first.
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
})
