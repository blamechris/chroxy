/**
 * Mailbox snapshot dispatch (#5914 follow-up).
 *
 * Mirrors dispatch-host-status.test.ts:
 *   - `mailbox_status_snapshot` REPLACES `mailboxStatus` and clears
 *     `mailboxStatusLoading`.
 *   - a malformed payload is dropped (Zod) and leaves the spinner up so a buggy
 *     server doesn't make Refresh silently lie.
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
import type { ServerMailboxStatusSnapshotMessage } from '@chroxy/protocol'

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
    mailboxStatus: null,
    mailboxStatusLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerMailboxStatusSnapshotMessage> = {}): ServerMailboxStatusSnapshotMessage {
  return {
    type: 'mailbox_status_snapshot',
    requestId: null,
    generatedAt: '2026-06-16T07:00:00.000Z',
    registrations: [
      { agentCommId: 'coder', sessionId: 'sid-1', sessionName: 'Coder', isBusy: false, isTui: true },
    ],
    recentEvents: [
      { at: 1718521200000, to: 'coder', from: 'alice', unreadCount: 3, outcome: 'injected' },
    ],
    ...over,
  }
}

describe('Mailbox snapshot dispatch', () => {
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

  it('applies mailbox_status_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.mailboxStatus).not.toBeNull()
    expect(s.mailboxStatus!.registrations.map((r) => r.agentCommId)).toEqual(['coder'])
    expect(s.mailboxStatus!.recentEvents[0]!.outcome).toBe('injected')
    expect(s.mailboxStatusLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({
        registrations: [{ agentCommId: 'builder', sessionId: 'sid-2', sessionName: 'Builder', isBusy: true, isTui: true }],
        recentEvents: [],
      }),
      ctx() as never,
    )
    const s = store.getState()
    expect(s.mailboxStatus!.registrations.map((r) => r.agentCommId)).toEqual(['builder'])
    expect(s.mailboxStatus!.recentEvents).toEqual([])
  })

  it('accepts an empty snapshot (no registrations / no traffic)', () => {
    handleMessage(snapshot({ registrations: [], recentEvents: [] }), ctx() as never)
    const s = store.getState()
    expect(s.mailboxStatus!.registrations).toEqual([])
    expect(s.mailboxStatusLoading).toBe(false)
  })

  it('drops a malformed snapshot and leaves the loading flag up', () => {
    handleMessage(
      { type: 'mailbox_status_snapshot', generatedAt: '2026-06-16T07:00:00.000Z', registrations: 'nope', recentEvents: [] } as never,
      ctx() as never,
    )
    const s = store.getState()
    expect(s.mailboxStatus).toBeNull()
    expect(s.mailboxStatusLoading).toBe(true)
  })

  it('drops an event with an unknown outcome (enum is the source of truth)', () => {
    handleMessage(
      snapshot({ recentEvents: [{ at: 1, to: 'x', from: 'y', unreadCount: 0, outcome: 'bogus' as never }] }),
      ctx() as never,
    )
    // Whole snapshot rejected (one bad event) — prior state (null) retained.
    expect(store.getState().mailboxStatus).toBeNull()
  })
})
