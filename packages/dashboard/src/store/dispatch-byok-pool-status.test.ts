/**
 * Integration test for the BYOK pool survey Control Room wiring (#6135, epic
 * #5530).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `byok_pool_status_snapshot` REPLACES `byokPoolStatus` and clears
 *     `byokPoolStatusLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state and
 *     WITHOUT clearing the loading flag.
 *   - a disabled-pool snapshot is a valid, first-class state.
 *
 * Mirrors dispatch-containers-status.test.ts (the containers survey's sibling).
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
import type { ConnectionState } from './types'
import type { ServerByokPoolStatusSnapshotMessage } from '@chroxy/protocol'

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
    activeSessionId: null,
    sessionStates: {},
    byokPoolStatus: null,
    byokPoolStatusLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerByokPoolStatusSnapshotMessage> = {}): ServerByokPoolStatusSnapshotMessage {
  return {
    type: 'byok_pool_status_snapshot',
    generatedAt: '2026-06-19T11:50:00.000Z',
    enabled: true,
    note: null,
    limits: { idleTimeoutMs: 300000, maxPerKey: 2, maxTotal: 8, maxAgeMs: 1800000 },
    stats: {
      hits: 5, misses: 2, releases: 4, shutdowns: 1, hitRate: 0.71, totalSize: 3,
      buckets: [{ key: 'node:22|/p|2g|2|chroxy', size: 2, oldestIdleMs: 12000 }],
      evictionsByReason: { idle: 3 },
      recentEvictions: [{ key: 'node:22|/p|2g|2|chroxy', containerId: 'abc123', reason: 'idle', timestamp: 1000 }],
    },
    ...over,
  } as ServerByokPoolStatusSnapshotMessage
}

describe('byok pool status dispatch (#6135)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

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

  it('applies byok_pool_status_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.byokPoolStatus).not.toBeNull()
    expect(s.byokPoolStatus!.enabled).toBe(true)
    expect(s.byokPoolStatus!.stats!.hits).toBe(5)
    expect(s.byokPoolStatus!.stats!.buckets.map((b) => b.key)).toEqual(['node:22|/p|2g|2|chroxy'])
    expect(s.byokPoolStatusLoading).toBe(false)
  })

  it('relays a disabled-pool snapshot as a first-class enabled:false state', () => {
    handleMessage(
      snapshot({ enabled: false, note: 'BYOK container pool is disabled.', limits: null, stats: null }),
      ctx() as never,
    )
    const s = store.getState()
    expect(s.byokPoolStatus!.enabled).toBe(false)
    expect(s.byokPoolStatus!.limits).toBeNull()
    expect(s.byokPoolStatus!.stats).toBeNull()
    expect(s.byokPoolStatusLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(snapshot({ stats: { ...snapshot().stats!, hits: 99, buckets: [] } }), ctx() as never)
    const s = store.getState()
    expect(s.byokPoolStatus!.stats!.hits).toBe(99)
    expect(s.byokPoolStatus!.stats!.buckets).toEqual([])
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().byokPoolStatus
    // Missing required `enabled`.
    handleMessage({ type: 'byok_pool_status_snapshot', generatedAt: '2026-06-19T11:50:00.000Z' }, ctx() as never)
    expect(store.getState().byokPoolStatus).toBe(before)
    expect(store.getState().byokPoolStatusLoading).toBe(true)
  })
})
