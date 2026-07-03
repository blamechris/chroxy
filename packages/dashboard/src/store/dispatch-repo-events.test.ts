/**
 * Integration test for the Control Room repo-events survey wiring (#5966, epic
 * #5422 phase 5). Guards: snapshot REPLACES repoEventsSnapshot + clears loading;
 * a refusal (error + empty events) is a valid state; malformed dropped without
 * clearing loading. Mirrors dispatch-external-sessions.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import { handleMessage, setStore, clearDeltaBuffers, clearPermissionSplits, stopHeartbeat, resetReplayFlags } from './message-handler'
import type { ConnectionState } from './types'
import type { ServerRepoEventsSnapshotMessage, ServerRepoEventsDeltaMessage } from '@chroxy/protocol'

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
function baseState(): Partial<ConnectionState> {
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, repoEventsSnapshot: null, repoEventsLoading: true, messages: [] }
}
function snapshot(over: Partial<ServerRepoEventsSnapshotMessage> = {}): ServerRepoEventsSnapshotMessage {
  return {
    type: 'repo_events_snapshot',
    generatedAt: '2026-07-02T12:00:00.000Z',
    events: [
      { kind: 'push', repo: 'blamechris/chroxy', actor: 'blamechris', at: '2026-07-02T11:59:00.000Z', branch: 'main', title: 'fix', url: 'https://github.com/blamechris/chroxy/commit/a', summary: 'pushed 1 commit to main' },
      { kind: 'pull_request', repo: 'blamechris/chroxy', actor: 'blamechris', at: '2026-07-02T12:00:00.000Z', action: 'opened', number: 42, title: 'feat', url: 'https://github.com/blamechris/chroxy/pull/42', summary: 'opened PR #42' },
    ],
    ...over,
  } as ServerRepoEventsSnapshotMessage
}

describe('repo events dispatch (#5966)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('applies repo_events_snapshot and clears loading', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.repoEventsSnapshot!.events.map((x) => x.kind)).toEqual(['push', 'pull_request'])
    expect(s.repoEventsSnapshot!.events[1]!.number).toBe(42)
    expect(s.repoEventsLoading).toBe(false)
  })

  it('relays a refusal snapshot (error + empty events) as a valid state', () => {
    handleMessage(snapshot({ events: [], error: { code: 'FORBIDDEN', message: 'nope' } }), ctx() as never)
    const s = store.getState()
    expect(s.repoEventsSnapshot!.events).toEqual([])
    expect(s.repoEventsSnapshot!.error!.code).toBe('FORBIDDEN')
    expect(s.repoEventsLoading).toBe(false)
  })

  it('drops a malformed snapshot without clearing loading', () => {
    handleMessage({ type: 'repo_events_snapshot', events: 'not-an-array' }, ctx() as never)
    expect(store.getState().repoEventsSnapshot).toBeNull()
    expect(store.getState().repoEventsLoading).toBe(true)
  })
})

function delta(over: Partial<ServerRepoEventsDeltaMessage> = {}): ServerRepoEventsDeltaMessage {
  return {
    type: 'repo_events_delta',
    generatedAt: '2026-07-02T12:01:00.000Z',
    event: { kind: 'issues', repo: 'blamechris/chroxy', actor: 'octocat', at: '2026-07-02T12:01:00.000Z', action: 'closed', number: 9, title: 'bug', url: 'https://github.com/blamechris/chroxy/issues/9', summary: 'closed issue #9' },
    ...over,
  } as ServerRepoEventsDeltaMessage
}

describe('repo events live delta (#6536)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('appends a delta event to an existing snapshot (most-recent-last)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(delta(), ctx() as never)
    const events = store.getState().repoEventsSnapshot!.events
    expect(events).toHaveLength(3)
    expect(events[2]!.summary).toBe('closed issue #9') // appended at the end (newest)
  })

  it('ignores a delta when no survey has landed yet (no snapshot)', () => {
    handleMessage(delta(), ctx() as never)
    expect(store.getState().repoEventsSnapshot).toBeNull()
  })

  it('drops a malformed delta (invalid event) without mutating the snapshot', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage({ type: 'repo_events_delta', generatedAt: '2026-07-02T12:01:00.000Z', event: { kind: 'bogus' } }, ctx() as never)
    expect(store.getState().repoEventsSnapshot!.events).toHaveLength(2)
  })

  it('bounds the appended list to 200 (mirrors REPO_EVENT_STORE_CAP)', () => {
    // Seed a snapshot at the cap, then append one more — oldest is evicted.
    const seeded = snapshot({
      events: Array.from({ length: 200 }, (_, i) => ({
        kind: 'push' as const, repo: 'blamechris/chroxy', actor: 'a', at: '2026-07-02T00:00:00.000Z',
        branch: 'main', title: `c${i}`, url: null, summary: `push ${i}`,
      })),
    })
    handleMessage(seeded, ctx() as never)
    handleMessage(delta(), ctx() as never)
    const events = store.getState().repoEventsSnapshot!.events
    expect(events).toHaveLength(200)
    expect(events[199]!.summary).toBe('closed issue #9') // newest kept
    expect(events[0]!.summary).toBe('push 1')            // oldest ('push 0') evicted
  })
})
