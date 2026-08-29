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
 * The store's one session-went-away path is the `session_list` handler's
 * `removedIds` block, where `sessionStates` and the Control Room `activity`
 * tree are already pruned. The fix lives there.
 *
 * ## What these tests are shaped to catch
 *
 * A per-map assertion for EACH of the five, never one blanket "the maps no
 * longer mention sess-dead" check: a blanket assertion is satisfied by pruning
 * four of five, which is exactly the adjacent-field failure this issue is an
 * instance of. Mutating away any single prune call must turn exactly one
 * assertion red, and the message must name the map.
 *
 * Plus a POSITIVE CONTROL in every case: the surviving session's entries must
 * come through byte-identical. Without it, `set({ sessionPrStatus: {} })` —
 * clearing everything — would pass every "dead key is gone" assertion.
 *
 * Plus a roster guard derived from `types.ts` rather than from a list written
 * here, so a SIXTH map added to the family without a prune goes red.
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
import { createEmptySessionState } from './utils'
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
 * Roster coverage — the adjacent-field guard.
 *
 * Each of the three cleanup sites names its maps explicitly (a loop over a
 * string list would be the same hardcoded roster, just less visible). That is
 * only safe if something notices when the family grows, so this derives the
 * roster from the PRODUCER — the `ConnectionState` declaration in `types.ts` —
 * and asserts every session-keyed PR/CI map appears at EVERY site. A sixth map
 * added without cleanup goes red here, naming both the field and the site it
 * was missed at.
 *
 * Three sites, because "the session went away" has three spellings in this
 * store and covering only the one the issue named is the same adjacent-field
 * mistake one level up:
 *
 *   1. `session_list` removedIds        — one session closed  (message-handler.ts)
 *   2. `forgetSession`                  — disconnect + forget (connection.ts)
 *   3. `_resetSessionMemory`            — switchServer        (connection.ts)
 */
describe('#7470 roster coverage: every session-keyed PR/CI map is cleaned up', () => {
  const typesSrc = readFileSync(resolve(__dirname, 'types.ts'), 'utf8')
  const handlerSrc = readFileSync(resolve(__dirname, 'message-handler.ts'), 'utf8')
  const connectionSrc = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')

  /** `[site label, source text, start marker, end marker]`. */
  const SITES: [string, string, string, string][] = [
    ['session_list removedIds', handlerSrc, '#7470 prune-block-start', '#7470 prune-block-end'],
    ['forgetSession', connectionSrc, '#7470 forget-reset-start', '#7470 forget-reset-end'],
    ['_resetSessionMemory', connectionSrc, '#7470 switch-reset-start', '#7470 switch-reset-end'],
  ]

  /**
   * `sessionPresetSnapshots` matches the `sessionPr` prefix by accident and is
   * keyed by CWD, not by session id (#5553) — so it has no business in a
   * session-lifecycle prune. Excluded BY NAME with the reason, rather than by
   * narrowing the pattern until only today's five fields match: a pattern
   * tightened around the current answer stops being a guard.
   */
  const NOT_SESSION_KEYED = new Set(['sessionPresetSnapshots'])

  const declared = [...typesSrc.matchAll(/^\s{2}(sessionPr\w*):\s*Record<string,/gm)]
    .map((m) => m[1]!)
    .filter((name) => !NOT_SESSION_KEYED.has(name))

  it('finds the known PR/CI maps in types.ts (control: the extraction actually matched)', () => {
    // Guards the guard: if the declaration style in types.ts changes and the
    // regex stops matching, `declared` goes empty and the per-field loop below
    // passes vacuously — the "cannot check this treated as nothing to check"
    // entry in docs/false-safety-guards.md.
    //
    // Deliberately a CONTAINMENT check, not an exact list. An exact list is a
    // hardcoded roster beside a growing set — the same defect the loop below
    // exists to catch — and would make a legitimately-added sixth map fail
    // HERE, in the control, instead of on the prune assertion that is the
    // actual finding.
    expect(declared).toEqual(expect.arrayContaining([
      'sessionPrStatus',
      'sessionPrStatusLoading',
      'sessionPrStatusRequestedAt',
      'sessionPrThreads',
      'sessionPrThreadsLoading',
    ]))
  })

  const CASES: [string, string][] = SITES.flatMap(([site]) => declared.map((f) => [site, f] as [string, string]))

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
    // That is docs/false-safety-guards.md's substring-standing-in-for-a-token
    // entry, reproduced inside the guard written to prevent its cousin.
    //
    // Requiring the field to be followed by `:` or `=` pins it to an actual
    // assignment (`sessionPrStatus: {}` / `patch.sessionPrStatus = ...`) and
    // rejects a longer identifier that merely starts with it.
    const assigned = new RegExp(`(^|[^A-Za-z0-9_$])${field}\\s*[:=][^=]`)
    expect(assigned.test(block), `${site} must assign ${field} (token match, not substring)`).toBe(true)
  })
})
