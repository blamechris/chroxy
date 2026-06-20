/**
 * Integration test for the container lifecycle action wiring (#6134, epic #5530).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `containers_action_ack` clears the environment's pending state and records
 *     the carried action + status for inline display.
 *   - a malformed ack is dropped (Zod safeParse) without mutating state.
 *   - a CONTAINER_ACTION_FAILED session_error clears the pending state for the
 *     echoed environmentId and records the message as an inline error.
 *   - other environments' pending state is never touched by an ack/error for one.
 *
 * Mirrors dispatch-integration-action.test.ts (the Reindex action's test).
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

const ENV = 'env-web'
const OTHER_ENV = 'env-api'

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
    containerActioningIds: new Set([ENV, OTHER_ENV]),
    containerActionResults: {},
    messages: [],
  }
}

function ack(over: Record<string, unknown> = {}) {
  return {
    type: 'containers_action_ack',
    action: 'stop',
    environmentId: ENV,
    requestId: 'ca-1',
    status: 'stopped',
    ...over,
  }
}

describe('container action dispatch (#6134)', () => {
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

  it('containers_action_ack clears the pending state and records the action + status', () => {
    handleMessage(ack(), ctx() as never)
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(false)
    expect(s.containerActioningIds.has(OTHER_ENV)).toBe(true) // other env untouched
    expect(s.containerActionResults[ENV]).toBeDefined()
    expect(s.containerActionResults[ENV]!.action).toBe('stop')
    expect(s.containerActionResults[ENV]!.status).toBe('stopped')
    expect(s.containerActionResults[ENV]!.error).toBeNull()
  })

  it('a destroy ack (status "destroyed") clears pending and records the outcome', () => {
    handleMessage(ack({ action: 'destroy', status: 'destroyed' }), ctx() as never)
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(false)
    expect(s.containerActionResults[ENV]!.action).toBe('destroy')
    expect(s.containerActionResults[ENV]!.status).toBe('destroyed')
    expect(s.containerActionResults[ENV]!.error).toBeNull()
  })

  it('a null-status ack still clears pending and records the run', () => {
    handleMessage(ack({ status: null }), ctx() as never)
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(false)
    expect(s.containerActionResults[ENV]!.status).toBeNull()
    expect(s.containerActionResults[ENV]!.error).toBeNull()
  })

  it('drops a malformed ack (missing environmentId) without touching pending state', () => {
    // environmentId is required — omitting it fails the schema, so no row clears.
    handleMessage({ type: 'containers_action_ack', action: 'stop', status: 'stopped' }, ctx() as never)
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(true)
    expect(s.containerActionResults[ENV]).toBeUndefined()
  })

  it('an ack for an unknown future action still clears its echoed env (forward-compat)', () => {
    // action is a permissive string (matches integration_action_ack) — a future
    // server action this client somehow has pending should still resolve.
    handleMessage(ack({ action: 'pause' }), ctx() as never)
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(false)
    expect(s.containerActionResults[ENV]!.action).toBe('pause')
  })

  it('CONTAINER_ACTION_FAILED session_error clears pending and records the inline error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage(
      {
        type: 'session_error',
        code: 'CONTAINER_ACTION_FAILED',
        message: 'docker stop failed: No such container',
        reason: 'stop-failed',
        action: 'stop',
        environmentId: ENV,
        requestId: 'ca-1',
      },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(false)
    expect(s.containerActioningIds.has(OTHER_ENV)).toBe(true) // other env untouched
    expect(s.containerActionResults[ENV]!.error).toMatch(/No such container/)
    expect(s.containerActionResults[ENV]!.status).toBeNull()
    expect(s.containerActionResults[ENV]!.action).toBe('stop')
  })

  it('a CONTAINER_ACTION_FAILED without an environmentId leaves action state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage(
      { type: 'session_error', code: 'CONTAINER_ACTION_FAILED', message: 'boom' },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.containerActioningIds.has(ENV)).toBe(true)
    expect(s.containerActionResults[ENV]).toBeUndefined()
  })

  it('a fresh ack replaces a previous inline error for the same environment', () => {
    store.setState({
      containerActionResults: { [ENV]: { action: 'stop', status: null, error: 'old failure', at: 1 } },
    } as never)
    handleMessage(ack(), ctx() as never)
    expect(store.getState().containerActionResults[ENV]!.error).toBeNull()
    expect(store.getState().containerActionResults[ENV]!.status).toBe('stopped')
  })
})
