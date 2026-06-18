/**
 * Integration test for the self-hosted runner Control Room wiring (#5253).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `runner_status_snapshot` REPLACES `runnerStatus` and clears
 *     `runnerStatusLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state and
 *     WITHOUT clearing the loading flag.
 *   - a second snapshot wholesale-replaces the first (full picture, no merge).
 *   - an empty-repos survey is a valid snapshot.
 *
 * Mirrors dispatch-host-status.test.ts (the host survey's sibling test).
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
import type { ServerRunnerStatusSnapshotMessage } from '@chroxy/protocol'

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
    runnerStatus: null,
    runnerStatusLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerRunnerStatusSnapshotMessage> = {}): ServerRunnerStatusSnapshotMessage {
  return {
    type: 'runner_status_snapshot',
    generatedAt: '2026-06-06T11:50:00.000Z',
    root: '/Users/me/github-runners',
    summary: { total: 1, busy: 0, idle: 1, offline: 0, stopped: 0, unregistered: 0 },
    repos: [
      {
        name: 'medlens',
        owner: 'blamechris',
        repo: 'medlens',
        githubUrl: 'https://github.com/blamechris/medlens',
        runnersUrl: 'https://github.com/blamechris/medlens/settings/actions/runners',
        runners: [
          {
            name: 'medlens-mac-arm64',
            dir: '/Users/me/github-runners/actions-runner-medlens',
            verdict: 'idle',
            service: { manager: 'launchd', label: 'l', running: true, pid: 1778, lastExitCode: 0 },
            githubStatus: 'online',
            busy: false,
            os: 'macOS',
            labels: ['self-hosted'],
          },
        ],
      },
    ],
    ...over,
  }
}

describe('runner status dispatch (#5253)', () => {
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

  it('applies runner_status_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.runnerStatus).not.toBeNull()
    expect(s.runnerStatus!.repos.map((r) => r.name)).toEqual(['medlens'])
    expect(s.runnerStatus!.summary.idle).toBe(1)
    expect(s.runnerStatusLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({
        repos: [
          {
            name: 'ltl',
            owner: 'blamechris',
            repo: 'ltl',
            githubUrl: 'https://github.com/blamechris/ltl',
            runnersUrl: null,
            runners: [],
          },
        ],
      }),
      ctx() as never,
    )
    expect(store.getState().runnerStatus!.repos.map((r) => r.name)).toEqual(['ltl'])
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().runnerStatus
    // Missing required `summary`.
    handleMessage(
      { type: 'runner_status_snapshot', generatedAt: '2026-06-06T11:50:00.000Z', root: '/p', repos: [] },
      ctx() as never,
    )
    expect(store.getState().runnerStatus).toBe(before)
    expect(store.getState().runnerStatusLoading).toBe(true)
  })

  it('accepts an empty-repos survey as a valid snapshot', () => {
    handleMessage(
      snapshot({ repos: [], summary: { total: 0, busy: 0, idle: 0, offline: 0, stopped: 0, unregistered: 0 } }),
      ctx() as never,
    )
    expect(store.getState().runnerStatus!.repos).toEqual([])
    expect(store.getState().runnerStatusLoading).toBe(false)
  })
})
