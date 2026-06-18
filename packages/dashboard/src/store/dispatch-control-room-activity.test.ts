/**
 * Integration test for the Control Room activity wiring (#5163, epic #5159).
 *
 * Guards the wire path between the dashboard message handler and the store-core
 * activity reducer:
 *   - `activity_snapshot` REPLACES the target session's tree.
 *   - `activity_delta` upserts the carried entry by id (self-healing).
 *   - malformed payloads are dropped (Zod safeParse) without crashing.
 *   - a no-op delta short-circuits without re-allocating `activity`.
 *   - `session_list` removal drops a closed session's activity tree.
 *
 * The reducer + selector have their own unit tests in store-core
 * (activity-reducer.test.ts); this file covers ONLY the handler glue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import {
  createEmptyActivityState,
  selectActivityTree,
  type ActivityEntry,
} from '@chroxy/store-core'
import { createEmptySessionState } from './utils'
import type { ConnectionState } from './types'

const SESSION_ID = 'sess-cr-1'
const OTHER_SESSION_ID = 'sess-cr-2'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: SESSION_ID,
    sessionStates: { [SESSION_ID]: createEmptySessionState() },
    activity: createEmptyActivityState(),
    messages: [],
  }
}

function runningEntry(id: string, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    kind: 'agent',
    label: `entry-${id}`,
    status: 'running',
    startedAt: 1000,
    ...over,
  }
}

function snapshot(entries: ActivityEntry[], sessionId = SESSION_ID) {
  return { type: 'activity_snapshot', sessionId, schemaVersion: 1, entries }
}

function delta(op: 'started' | 'updated' | 'ended', entry: ActivityEntry, sessionId = SESSION_ID) {
  return { type: 'activity_delta', sessionId, schemaVersion: 1, op, entry }
}

describe('Control Room activity dispatch (#5163)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: mockSocket,
    isReconnect: false,
    silent: false,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  it('#5277: cancel_activity_ack clears the composite key, scoped by session', () => {
    // Keys are `${sessionId}:${activityId}`; an ack for SESSION_ID:a must not
    // touch an identically-ided node in another session (OTHER:a).
    store.setState({ cancellingActivityIds: new Set([`${SESSION_ID}:a`, `${SESSION_ID}:b`, `${OTHER_SESSION_ID}:a`]) })
    handleMessage({ type: 'cancel_activity_ack', activityId: 'a', sessionId: SESSION_ID, requestId: 'req-1' }, ctx() as never)
    const set = store.getState().cancellingActivityIds
    expect(set.has(`${SESSION_ID}:a`)).toBe(false)
    expect(set.has(`${SESSION_ID}:b`)).toBe(true)
    expect(set.has(`${OTHER_SESSION_ID}:a`)).toBe(true) // other session unaffected
  })

  it('#5277: CANCEL_ACTIVITY_FAILED session_error clears the composite key', () => {
    // The generic session_error branch surfaces the message via addServerError;
    // stub it so the handler runs cleanly in this harness.
    store.setState({ cancellingActivityIds: new Set([`${SESSION_ID}:a`]), addServerError: vi.fn() } as never)
    handleMessage(
      { type: 'session_error', code: 'CANCEL_ACTIVITY_FAILED', message: 'Could not cancel activity: no-task-id', reason: 'no-task-id', activityId: 'a', sessionId: SESSION_ID, requestId: 'req-1' },
      ctx() as never,
    )
    expect(store.getState().cancellingActivityIds.has(`${SESSION_ID}:a`)).toBe(false)
  })

  it('#5277: SESSION_NOT_FOUND clears all pending cancels for that session', () => {
    store.setState({ cancellingActivityIds: new Set([`${SESSION_ID}:a`, `${SESSION_ID}:b`, `${OTHER_SESSION_ID}:a`]), addServerError: vi.fn(), setSessionNotFoundError: vi.fn() } as never)
    handleMessage(
      { type: 'session_error', code: 'SESSION_NOT_FOUND', message: 'Session not found', attemptedSessionId: SESSION_ID },
      ctx() as never,
    )
    const set = store.getState().cancellingActivityIds
    expect(set.has(`${SESSION_ID}:a`)).toBe(false)
    expect(set.has(`${SESSION_ID}:b`)).toBe(false)
    expect(set.has(`${OTHER_SESSION_ID}:a`)).toBe(true) // other session untouched
  })

  it('#5277: a terminal (ended) activity_delta clears the pending composite key', () => {
    handleMessage(snapshot([runningEntry('a')]), ctx() as never)
    store.setState({ cancellingActivityIds: new Set([`${SESSION_ID}:a`]) })
    handleMessage(delta('ended', runningEntry('a', { status: 'done', endedAt: 2000 })), ctx() as never)
    expect(store.getState().cancellingActivityIds.has(`${SESSION_ID}:a`)).toBe(false)
  })

  it('applies activity_snapshot, replacing the session tree', () => {
    handleMessage(snapshot([runningEntry('a'), runningEntry('b')]), ctx() as never)
    const tree = selectActivityTree(store.getState().activity, SESSION_ID)
    expect(tree.map((n) => n.entry.id)).toEqual(['a', 'b'])

    // A second snapshot REPLACES (not merges) the prior entries.
    handleMessage(snapshot([runningEntry('c')]), ctx() as never)
    const tree2 = selectActivityTree(store.getState().activity, SESSION_ID)
    expect(tree2.map((n) => n.entry.id)).toEqual(['c'])
  })

  it('applies activity_delta upserts by id (started then ended)', () => {
    handleMessage(delta('started', runningEntry('x')), ctx() as never)
    expect(selectActivityTree(store.getState().activity, SESSION_ID).map((n) => n.entry.status)).toEqual([
      'running',
    ])

    handleMessage(
      delta('ended', runningEntry('x', { status: 'done', endedAt: 5000 })),
      ctx() as never,
    )
    const tree = selectActivityTree(store.getState().activity, SESSION_ID)
    expect(tree).toHaveLength(1)
    expect(tree[0]!.entry.status).toBe('done')
    expect(tree[0]!.entry.endedAt).toBe(5000)
  })

  it('builds parent→child hierarchy from a delta with parentId', () => {
    handleMessage(delta('started', runningEntry('parent', { kind: 'agent' })), ctx() as never)
    handleMessage(
      delta('started', runningEntry('child', { kind: 'tool', parentId: 'parent' })),
      ctx() as never,
    )
    const tree = selectActivityTree(store.getState().activity, SESSION_ID)
    expect(tree).toHaveLength(1)
    expect(tree[0]!.entry.id).toBe('parent')
    expect(tree[0]!.children.map((c) => c.entry.id)).toEqual(['child'])
  })

  it('keeps per-session trees isolated', () => {
    handleMessage(snapshot([runningEntry('a')], SESSION_ID), ctx() as never)
    handleMessage(snapshot([runningEntry('b')], OTHER_SESSION_ID), ctx() as never)
    expect(selectActivityTree(store.getState().activity, SESSION_ID).map((n) => n.entry.id)).toEqual(['a'])
    expect(selectActivityTree(store.getState().activity, OTHER_SESSION_ID).map((n) => n.entry.id)).toEqual([
      'b',
    ])
  })

  it('drops a malformed activity_snapshot without crashing or mutating state', () => {
    const before = store.getState().activity
    // Missing required `entries` array.
    handleMessage({ type: 'activity_snapshot', sessionId: SESSION_ID, schemaVersion: 1 }, ctx() as never)
    expect(store.getState().activity).toBe(before)
  })

  it('drops a malformed activity_delta (terminal status without endedAt)', () => {
    const before = store.getState().activity
    handleMessage(
      delta('ended', { id: 'bad', kind: 'tool', label: 'b', status: 'done', startedAt: 1 }),
      ctx() as never,
    )
    expect(store.getState().activity).toBe(before)
  })

  it('short-circuits a no-op delta without re-allocating activity state', () => {
    // End the entry, then send a STALE running update for the same id. The
    // reducer's terminal-precedence guard rejects it (returns the same state
    // reference), and the handler must NOT call set() for that no-op.
    handleMessage(delta('started', runningEntry('y')), ctx() as never)
    handleMessage(delta('ended', runningEntry('y', { status: 'done', endedAt: 5000 })), ctx() as never)
    const after = store.getState().activity
    handleMessage(delta('updated', runningEntry('y', { status: 'running' })), ctx() as never)
    expect(store.getState().activity).toBe(after)
  })

  it('bumps lastClientActivityAt and clears inactivityWarning on activity_delta', () => {
    // Seed the active session with a stale activity timestamp + an outstanding
    // inactivity warning, then deliver a delta. The handler treats the delta as
    // activity-bearing: it bumps lastClientActivityAt and clears the warning.
    const seeded = createEmptySessionState()
    store.setState({
      sessionStates: {
        [SESSION_ID]: {
          ...seeded,
          lastClientActivityAt: 1,
          inactivityWarning: { idleMs: 1000, prefab: 'quiet', receivedAt: 1 },
        },
      },
    })
    handleMessage(delta('started', runningEntry('z')), ctx() as never)
    const ss = store.getState().sessionStates[SESSION_ID]!
    expect(ss.lastClientActivityAt).toBeGreaterThan(1)
    expect(ss.inactivityWarning).toBeNull()
  })

  it('does NOT bump activity on activity_snapshot (resync, not fresh work)', () => {
    const seeded = createEmptySessionState()
    store.setState({
      sessionStates: { [SESSION_ID]: { ...seeded, lastClientActivityAt: 1 } },
    })
    handleMessage(snapshot([runningEntry('a')]), ctx() as never)
    expect(store.getState().sessionStates[SESSION_ID]!.lastClientActivityAt).toBe(1)
  })

  it('clears a session activity tree when session_list drops it', () => {
    handleMessage(snapshot([runningEntry('a')], SESSION_ID), ctx() as never)
    handleMessage(snapshot([runningEntry('b')], OTHER_SESSION_ID), ctx() as never)

    // session_list now only lists OTHER_SESSION_ID — SESSION_ID is removed.
    handleMessage(
      {
        type: 'session_list',
        sessions: [{ sessionId: OTHER_SESSION_ID, name: 'keep', cwd: '/tmp', provider: 'claude-cli' }],
      },
      ctx() as never,
    )

    expect(selectActivityTree(store.getState().activity, SESSION_ID)).toEqual([])
    expect(selectActivityTree(store.getState().activity, OTHER_SESSION_ID).map((n) => n.entry.id)).toEqual([
      'b',
    ])
  })
})
