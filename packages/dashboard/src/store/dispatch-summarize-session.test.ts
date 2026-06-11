/**
 * #5547 — tests for the summarize_session request/result wiring.
 *
 * Covers the bridge between the pending-request registry (summarizeRequests.ts)
 * and the message handler:
 *   - a `summarize_session_result` resolves the pending promise keyed by the
 *     echoed requestId (with the summary + truncated flag).
 *   - a SUMMARIZE_FAILED session_error rejects the matching pending promise
 *     with the curated message (and does NOT touch unrelated requests).
 *   - a malformed result is dropped without resolving anything.
 *   - rejectAll fails every outstanding request (the disconnect path).
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
  registerSummarizeRequest,
  resolveSummarizeRequest,
  rejectSummarizeRequest,
  rejectAllSummarizeRequests,
} from './summarizeRequests'
import type { ConnectionState } from './types'

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

function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    messages: [],
  }
}

describe('summarizeRequests registry (#5547)', () => {
  it('resolveSummarizeRequest resolves the matching pending promise', async () => {
    const p = new Promise<{ summary: string; truncated: boolean }>((resolve, reject) => {
      registerSummarizeRequest('req-1', { resolve, reject })
    })
    resolveSummarizeRequest('req-1', { summary: 'BRIEF', truncated: true })
    await expect(p).resolves.toEqual({ summary: 'BRIEF', truncated: true })
  })

  it('rejectSummarizeRequest rejects the matching pending promise', async () => {
    const p = new Promise((resolve, reject) => {
      registerSummarizeRequest('req-2', { resolve, reject })
    })
    rejectSummarizeRequest('req-2', 'nope')
    await expect(p).rejects.toThrow('nope')
  })

  it('resolve/reject of an unknown id is a no-op (no throw)', () => {
    expect(() => resolveSummarizeRequest('ghost', { summary: 's', truncated: false })).not.toThrow()
    expect(() => rejectSummarizeRequest('ghost', 'x')).not.toThrow()
  })

  it('rejectAllSummarizeRequests fails every outstanding request', async () => {
    const a = new Promise((resolve, reject) => registerSummarizeRequest('a', { resolve, reject }))
    const b = new Promise((resolve, reject) => registerSummarizeRequest('b', { resolve, reject }))
    rejectAllSummarizeRequests('disconnected')
    await expect(a).rejects.toThrow('disconnected')
    await expect(b).rejects.toThrow('disconnected')
  })
})

describe('summarize_session message dispatch (#5547)', () => {
  let store: ReturnType<typeof createMockStore>

  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: { send: vi.fn(), readyState: WebSocket.OPEN } as unknown as WebSocket,
    isReconnect: false,
    silent: false,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    store = createMockStore(baseState())
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  it('summarize_session_result resolves the pending promise by requestId', async () => {
    const p = new Promise<{ summary: string; truncated: boolean }>((resolve, reject) => {
      registerSummarizeRequest('rid', { resolve, reject })
    })
    handleMessage({
      type: 'summarize_session_result',
      sessionId: 'sess-1',
      summary: 'CONTINUATION BRIEF',
      truncated: false,
      requestId: 'rid',
    }, ctx() as never)
    await expect(p).resolves.toEqual({ summary: 'CONTINUATION BRIEF', truncated: false })
  })

  it('a malformed result (missing summary) does not resolve', async () => {
    let settled = false
    const p = new Promise((resolve, reject) => {
      registerSummarizeRequest('rid2', { resolve, reject })
    }).then(() => { settled = true }).catch(() => { settled = true })
    handleMessage({
      type: 'summarize_session_result',
      sessionId: 'sess-1',
      requestId: 'rid2',
      // no `summary` -> schema rejects
    }, ctx() as never)
    // Give microtasks a chance; the promise must still be pending.
    await Promise.resolve()
    expect(settled).toBe(false)
    // Clean up the dangling promise so the test runner doesn't warn.
    rejectSummarizeRequest('rid2', 'cleanup')
    await p
  })

  it('SUMMARIZE_FAILED session_error rejects the matching request', async () => {
    const p = new Promise((resolve, reject) => {
      registerSummarizeRequest('rid3', { resolve, reject })
    })
    handleMessage({
      type: 'session_error',
      code: 'SUMMARIZE_FAILED',
      reason: 'summarize-failed',
      message: 'Could not summarize this session — the model call failed',
      sessionId: 'sess-1',
      requestId: 'rid3',
    }, ctx() as never)
    await expect(p).rejects.toThrow(/model call failed/)
  })
})
