/**
 * Integration test for the repo-memory Reindex action wiring (#5500).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `integration_action_ack` clears the repo's pending "Reindexing…" state
 *     and records the carried counts (or null counts) for inline display.
 *   - a malformed ack is dropped (Zod safeParse) without mutating state.
 *   - an INTEGRATION_ACTION_FAILED session_error clears the pending state for
 *     the echoed repoPath and records the message as an inline error.
 *   - other repos' pending state is never touched by an ack/error for one.
 *
 * Mirrors dispatch-integration-status.test.ts (the observe half's test).
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

const REPO = '/Users/me/Projects/chroxy'
const OTHER_REPO = '/Users/me/Projects/other'
const COUNTS = { scanned: 412, summarized: 12, fresh: 398, skipped: 2 }

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
    reindexingRepoPaths: new Set([REPO, OTHER_REPO]),
    reindexResults: {},
    messages: [],
  }
}

function ack(over: Record<string, unknown> = {}) {
  return {
    type: 'integration_action_ack',
    action: 'repo_memory_reindex',
    repoPath: REPO,
    requestId: 'rx-1',
    counts: COUNTS,
    ...over,
  }
}

describe('integration action dispatch (#5500)', () => {
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

  it('integration_action_ack clears the pending state and records the counts', () => {
    handleMessage(ack(), ctx() as never)
    const s = store.getState()
    expect(s.reindexingRepoPaths.has(REPO)).toBe(false)
    expect(s.reindexingRepoPaths.has(OTHER_REPO)).toBe(true) // other repo untouched
    expect(s.reindexResults[REPO]).toBeDefined()
    expect(s.reindexResults[REPO]!.counts).toEqual(COUNTS)
    expect(s.reindexResults[REPO]!.error).toBeNull()
  })

  it('a null-counts ack (unparseable index output) still clears pending and records the run', () => {
    handleMessage(ack({ counts: null }), ctx() as never)
    const s = store.getState()
    expect(s.reindexingRepoPaths.has(REPO)).toBe(false)
    expect(s.reindexResults[REPO]!.counts).toBeNull()
    expect(s.reindexResults[REPO]!.error).toBeNull()
  })

  it('drops a malformed ack without touching pending state', () => {
    // counts must be present (object or null) — undefined fails the schema.
    handleMessage({ type: 'integration_action_ack', action: 'repo_memory_reindex', repoPath: REPO }, ctx() as never)
    // partial counts fail too.
    handleMessage(ack({ counts: { scanned: 1, summarized: 2 } }), ctx() as never)
    const s = store.getState()
    expect(s.reindexingRepoPaths.has(REPO)).toBe(true)
    expect(s.reindexResults[REPO]).toBeUndefined()
  })

  it('INTEGRATION_ACTION_FAILED session_error clears pending and records the inline error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage(
      {
        type: 'session_error',
        code: 'INTEGRATION_ACTION_FAILED',
        message: 'A reindex is already in progress for /Users/me/Projects/chroxy',
        reason: 'reindex-in-progress',
        action: 'repo_memory_reindex',
        repoPath: REPO,
        requestId: 'rx-1',
      },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.reindexingRepoPaths.has(REPO)).toBe(false)
    expect(s.reindexingRepoPaths.has(OTHER_REPO)).toBe(true) // other repo untouched
    expect(s.reindexResults[REPO]!.error).toMatch(/already in progress/)
    expect(s.reindexResults[REPO]!.counts).toBeNull()
  })

  it('a session_error without a repoPath leaves reindex state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage(
      { type: 'session_error', code: 'INTEGRATION_ACTION_FAILED', message: 'boom' },
      ctx() as never,
    )
    const s = store.getState()
    expect(s.reindexingRepoPaths.has(REPO)).toBe(true)
    expect(s.reindexResults[REPO]).toBeUndefined()
  })

  it('a fresh ack replaces a previous inline error for the same repo', () => {
    store.setState({
      reindexResults: { [REPO]: { counts: null, error: 'old failure', at: 1 } },
    } as never)
    handleMessage(ack(), ctx() as never)
    expect(store.getState().reindexResults[REPO]!.error).toBeNull()
    expect(store.getState().reindexResults[REPO]!.counts).toEqual(COUNTS)
  })
})
