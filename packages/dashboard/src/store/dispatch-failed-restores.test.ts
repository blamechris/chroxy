/**
 * #7625 — dashboard wire path for the failed-restore roster and the retry ack.
 *
 * Guards the claims the Control Room tab depends on:
 *   - `failed_restores_list` replaces the snapshot wholesale and ALWAYS clears
 *     the loading flag, refusal included (a refused survey that left it set
 *     would disable its own Refresh button for good).
 *   - a refusal is distinguishable from a genuinely empty roster.
 *   - `retry_failed_restore_result` clears only ITS target's pending state, and
 *     records the outcome the row renders.
 *   - a SUCCESS re-asks for the roster (server truth) while a FAILURE does not,
 *     because the row is still parked and must stay on screen.
 *
 * Mirrors dispatch-byok-pool-action.test.ts.
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

vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
  setConnectionContext,
} from './message-handler'
import type { ConnectionState } from './types'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function row(sessionId: string) {
  return {
    sessionId,
    name: `Parked ${sessionId.slice(0, 2)}`,
    provider: 'claude',
    cwd: '/srv/work',
    errorCode: 'ENVIRONMENT_STOPPED',
    errorMessage: 'environment is not running',
    needsAttention: true,
    historyLength: 4,
  }
}

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

describe('failed-restore dispatch (#7625)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  let requested: number

  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  function baseState(): Partial<ConnectionState> {
    return {
      connectionPhase: 'connected',
      socket: null,
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      messages: [],
      failedRestores: null,
      failedRestoresLoading: true,
      retryingRestoreIds: new Set([A, B]),
      retryRestoreResults: {},
      // The dispatch calls this on a successful retry; count the calls rather
      // than stubbing it away, so "re-asks the server" is an assertion and not
      // an assumption.
      requestFailedRestores: () => {
        requested += 1
        return true
      },
    } as unknown as Partial<ConnectionState>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    requested = 0
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store as never)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    setConnectionContext(null)
  })

  const snapshot = () => store.getState().failedRestores

  it('stores the roster and clears the loading flag', () => {
    handleMessage(
      { type: 'failed_restores_list', generatedAt: '2026-09-04T00:00:00.000Z', restores: [row(A)] },
      ctx() as never,
    )

    expect(snapshot()?.restores).toHaveLength(1)
    expect(snapshot()?.restores[0]!.sessionId).toBe(A)
    // generatedAt is kept: the tab strip's staleness line reads it.
    expect(snapshot()?.generatedAt).toBe('2026-09-04T00:00:00.000Z')
    expect(store.getState().failedRestoresLoading).toBe(false)
  })

  it('clears the loading flag on a REFUSAL too, and marks it refused', () => {
    handleMessage(
      { type: 'failed_restores_list', generatedAt: 'x', restores: [], refused: true, code: 'FAILED_RESTORES_LIST_FORBIDDEN_BOUND_CLIENT' },
      ctx() as never,
    )

    expect(snapshot()?.refused).toBe(true)
    // The load-bearing half: a refusal that left this true would permanently
    // disable Refresh, since refreshDisabled = loading || !connected.
    expect(store.getState().failedRestoresLoading).toBe(false)
  })

  it('distinguishes a refusal from a genuinely empty roster', () => {
    handleMessage({ type: 'failed_restores_list', generatedAt: 'x', restores: [] }, ctx() as never)

    expect(snapshot()?.restores).toEqual([])
    expect(snapshot()?.refused).not.toBe(true)
  })

  it('normalises a non-array `restores` instead of letting it reach the renderer', () => {
    handleMessage(
      { type: 'failed_restores_list', generatedAt: 'x', restores: 'not-an-array' } as never,
      ctx() as never,
    )

    // The renderer maps over this; a string would throw and blank the tab.
    expect(snapshot()?.restores).toEqual([])
  })

  it('a successful retry clears only its own pending id and re-asks the server', () => {
    handleMessage({ type: 'retry_failed_restore_result', sessionId: A, ok: true }, ctx() as never)

    expect(store.getState().retryingRestoreIds.has(A)).toBe(false)
    expect(store.getState().retryingRestoreIds.has(B)).toBe(true)
    expect(store.getState().retryRestoreResults[A]!.ok).toBe(true)
    expect(requested).toBe(1)
  })

  it('a FAILED retry records the code and does NOT re-ask', () => {
    handleMessage(
      { type: 'retry_failed_restore_result', sessionId: A, ok: false, code: 'ENVIRONMENT_STOPPED', message: 'still down' },
      ctx() as never,
    )

    expect(store.getState().retryingRestoreIds.has(A)).toBe(false)
    const result = store.getState().retryRestoreResults[A]!
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ENVIRONMENT_STOPPED')
    expect(result.message).toBe('still down')
    // The row is still parked, so the roster does not need re-fetching — and
    // re-fetching would drop the inline error the row is about to render.
    expect(requested).toBe(0)
  })
})
