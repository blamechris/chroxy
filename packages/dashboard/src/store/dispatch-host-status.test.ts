/**
 * Integration test for the Host/Repo Status Control Room wiring (#5175,
 * epic #5170).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `host_status_snapshot` REPLACES `hostStatus` and clears `hostStatusLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state and
 *     WITHOUT clearing the loading flag (so a buggy server can't make Refresh
 *     silently lie).
 *   - a second snapshot wholesale-replaces the first (full picture, no merge).
 *
 * The `requestHostStatus` action's wire behaviour is exercised in
 * dispatch-host-status-request.test.ts (kept separate so this file stays
 * handler-only, mirroring dispatch-control-room-activity.test.ts).
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
import type { ServerHostStatusSnapshotMessage } from '@chroxy/protocol'

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
    hostStatus: null,
    hostStatusLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerHostStatusSnapshotMessage> = {}): ServerHostStatusSnapshotMessage {
  return {
    type: 'host_status_snapshot',
    generatedAt: '2026-06-04T11:50:00.000Z',
    root: '/Users/me/Projects',
    summary: { live: 1, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 },
    repos: [
      {
        name: 'chroxy',
        path: '/Users/me/Projects/chroxy',
        branch: 'main',
        verdict: 'live',
        live: true,
        tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
        worktrees: 1,
        ahead: 0,
        behind: 0,
        openPRs: null,
        prChecks: null,
        attribution: null,
        onboarding: 'deferred (live)',
        lastTouched: '2026-06-04T11:47:00.000Z',
      },
    ],
    ...over,
  }
}

describe('Host/Repo Status dispatch (#5175)', () => {
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

  it('applies host_status_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.hostStatus).not.toBeNull()
    expect(s.hostStatus!.repos.map((r) => r.name)).toEqual(['chroxy'])
    expect(s.hostStatusLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({
        repos: [
          {
            name: 'other',
            path: '/p/other',
            branch: 'dev',
            verdict: 'onboarded',
            live: false,
            tree: { state: 'clean', untracked: 0, modified: 0, staged: 0 },
            worktrees: 0,
            ahead: null,
            behind: null,
            openPRs: 2,
            prChecks: { failing: 0, pending: 1, approved: 1, changesRequested: 0 },
            attribution: true,
            onboarding: '✓ onboarded',
            lastTouched: '2026-06-04T11:00:00.000Z',
          },
        ],
      }),
      ctx() as never,
    )
    expect(store.getState().hostStatus!.repos.map((r) => r.name)).toEqual(['other'])
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().hostStatus
    // Missing required `summary`.
    handleMessage(
      { type: 'host_status_snapshot', generatedAt: '2026-06-04T11:50:00.000Z', root: '/p', repos: [] },
      ctx() as never,
    )
    expect(store.getState().hostStatus).toBe(before)
    // Loading flag is untouched on a malformed payload.
    expect(store.getState().hostStatusLoading).toBe(true)
  })

  it('accepts an empty-repos survey as a valid snapshot', () => {
    handleMessage(
      snapshot({ repos: [], summary: { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 } }),
      ctx() as never,
    )
    expect(store.getState().hostStatus!.repos).toEqual([])
    expect(store.getState().hostStatusLoading).toBe(false)
  })
})
