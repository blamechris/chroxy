/**
 * Integration test for the containers & environments Control Room wiring
 * (#6133, epic #5530).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `containers_status_snapshot` REPLACES `containersStatus` and clears
 *     `containersStatusLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state and
 *     WITHOUT clearing the loading flag.
 *   - a second snapshot wholesale-replaces the first (full picture, no merge).
 *   - an empty-containers survey is a valid snapshot.
 *
 * Mirrors dispatch-runner-status.test.ts (the runner survey's sibling test).
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
import type { ServerContainersStatusSnapshotMessage } from '@chroxy/protocol'

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
    containersStatus: null,
    containersStatusLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerContainersStatusSnapshotMessage> = {}): ServerContainersStatusSnapshotMessage {
  return {
    type: 'containers_status_snapshot',
    generatedAt: '2026-06-19T11:50:00.000Z',
    summary: { total: 1, running: 1, stopped: 0, other: 0 },
    containers: [
      {
        id: 'env-1',
        name: 'web',
        cwd: '/Users/me/Projects/app',
        image: 'node:22-slim',
        status: 'running',
        backend: 'docker',
        containerId: 'abcdef123456789',
        composeProject: null,
        sessionCount: 2,
        createdAt: '2026-06-19T11:00:00.000Z',
        uptimeMs: 3000000,
        stats: { cpuPercent: 0.5, memBytes: 47400000, memPercent: 2.26 },
      },
    ],
    dockerStatsNote: null,
    ...over,
  }
}

describe('containers status dispatch (#6133)', () => {
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

  it('applies containers_status_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.containersStatus).not.toBeNull()
    expect(s.containersStatus!.containers.map((c) => c.id)).toEqual(['env-1'])
    expect(s.containersStatus!.summary.running).toBe(1)
    expect(s.containersStatusLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({
        summary: { total: 1, running: 0, stopped: 1, other: 0 },
        containers: [
          {
            id: 'env-2',
            name: 'api',
            cwd: '/Users/me/Projects/other',
            image: null,
            status: 'stopped',
            backend: 'compose',
            containerId: null,
            composeProject: 'chroxy-env-2',
            sessionCount: 0,
            createdAt: null,
            uptimeMs: null,
            stats: null,
          },
        ],
      }),
      ctx() as never,
    )
    expect(store.getState().containersStatus!.containers.map((c) => c.id)).toEqual(['env-2'])
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().containersStatus
    // Missing required `summary`.
    handleMessage(
      { type: 'containers_status_snapshot', generatedAt: '2026-06-19T11:50:00.000Z', containers: [] },
      ctx() as never,
    )
    expect(store.getState().containersStatus).toBe(before)
    expect(store.getState().containersStatusLoading).toBe(true)
  })

  it('accepts an empty-containers survey as a valid snapshot', () => {
    handleMessage(
      snapshot({ containers: [], summary: { total: 0, running: 0, stopped: 0, other: 0 } }),
      ctx() as never,
    )
    expect(store.getState().containersStatus!.containers).toEqual([])
    expect(store.getState().containersStatusLoading).toBe(false)
  })
})
