/**
 * Integration test for the BYOK pool action wiring (#6135 slice 3, epic #5530).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `byok_pool_action_ack` clears the action TARGET's pending state and records
 *     a human note for inline display. The target id is 'drain' / 'recycle:<key>'
 *     / 'resize', matching sendByokPoolAction's keys.
 *   - a malformed ack is dropped (Zod safeParse) without mutating state.
 *   - a BYOK_POOL_ACTION_FAILED session_error clears the echoed target's pending
 *     state and records the message as an inline error.
 *   - other targets' pending state is never touched by an ack/error for one.
 *
 * Mirrors dispatch-containers-action.test.ts (the container action's test).
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

const BUCKET = 'node:22|/p|2g|2|chroxy'
const RECYCLE_TARGET = `recycle:${BUCKET}`

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
    byokPoolActioningIds: new Set(['drain', RECYCLE_TARGET, 'resize']),
    byokPoolActionResults: {},
    messages: [],
  }
}

describe('byok pool action dispatch (#6135 slice 3)', () => {
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

  it('a drain ack clears the drain target and records an evicted-count note', () => {
    handleMessage({ type: 'byok_pool_action_ack', action: 'drain', requestId: 'a', drained: 3 }, ctx() as never)
    const s = store.getState()
    expect(s.byokPoolActioningIds.has('drain')).toBe(false)
    expect(s.byokPoolActioningIds.has(RECYCLE_TARGET)).toBe(true) // others untouched
    expect(s.byokPoolActioningIds.has('resize')).toBe(true)
    expect(s.byokPoolActionResults['drain']!.error).toBeNull()
    expect(s.byokPoolActionResults['drain']!.note).toMatch(/Drained — evicted 3/)
  })

  it('a recycle ack clears the recycle:<key> target keyed by the echoed key', () => {
    handleMessage({ type: 'byok_pool_action_ack', action: 'recycle', key: BUCKET, drained: 2 }, ctx() as never)
    const s = store.getState()
    expect(s.byokPoolActioningIds.has(RECYCLE_TARGET)).toBe(false)
    expect(s.byokPoolActioningIds.has('drain')).toBe(true)
    expect(s.byokPoolActionResults[RECYCLE_TARGET]!.note).toMatch(/Recycled — evicted 2/)
  })

  it('a resize ack clears the resize target and notes evicted + new caps', () => {
    handleMessage(
      {
        type: 'byok_pool_action_ack',
        action: 'resize',
        evicted: 4,
        limits: { idleTimeoutMs: 300000, maxPerKey: 1, maxTotal: 2, maxAgeMs: null },
        configured: { maxPerKey: 2, maxTotal: 8 },
      },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.byokPoolActioningIds.has('resize')).toBe(false)
    expect(s.byokPoolActionResults['resize']!.note).toMatch(/Resized — evicted 4 \(caps now 1\/key, 2 total\)/)
  })

  it('drops a malformed ack (missing action) without touching pending state', () => {
    handleMessage({ type: 'byok_pool_action_ack', drained: 1 }, ctx() as never)
    const s = store.getState()
    expect(s.byokPoolActioningIds.has('drain')).toBe(true)
    expect(s.byokPoolActionResults['drain']).toBeUndefined()
  })

  it('BYOK_POOL_ACTION_FAILED clears the echoed target and records the inline error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage(
      {
        type: 'session_error',
        code: 'BYOK_POOL_ACTION_FAILED',
        message: 'docker rm -f failed',
        reason: 'drain-failed',
        action: 'drain',
        requestId: 'a',
      },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.byokPoolActioningIds.has('drain')).toBe(false)
    expect(s.byokPoolActioningIds.has(RECYCLE_TARGET)).toBe(true)
    expect(s.byokPoolActionResults['drain']!.error).toMatch(/docker rm -f failed/)
    expect(s.byokPoolActionResults['drain']!.note).toBeNull()
  })

  it('a recycle failure clears the recycle:<key> target keyed by the echoed key', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage(
      {
        type: 'session_error',
        code: 'BYOK_POOL_ACTION_FAILED',
        message: 'unknown key',
        reason: 'unknown-key',
        action: 'recycle',
        key: BUCKET,
      },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.byokPoolActioningIds.has(RECYCLE_TARGET)).toBe(false)
    expect(s.byokPoolActioningIds.has('drain')).toBe(true)
    expect(s.byokPoolActionResults[RECYCLE_TARGET]!.error).toMatch(/unknown key/)
  })

  it('a BYOK_POOL_ACTION_FAILED without an action leaves action state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'BYOK_POOL_ACTION_FAILED', message: 'boom' }, ctx() as never)
    const s = store.getState()
    expect(s.byokPoolActioningIds.has('drain')).toBe(true)
  })
})
