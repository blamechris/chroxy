/**
 * Integration test for the per-repo runtime config Control Room wiring
 * (#6139, epic #5530).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `repo_runtime_config_snapshot` REPLACES `repoRuntimeConfig` and clears
 *     `repoRuntimeConfigLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state and
 *     WITHOUT clearing the loading flag.
 *   - a second snapshot wholesale-replaces the first (full picture, no merge).
 *   - an empty-repos survey is a valid snapshot.
 *
 * Mirrors dispatch-containers-status.test.ts (the containers survey's sibling test).
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
import type { ServerRepoRuntimeConfigSnapshotMessage } from '@chroxy/protocol'

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
    repoRuntimeConfig: null,
    repoRuntimeConfigLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerRepoRuntimeConfigSnapshotMessage> = {}): ServerRepoRuntimeConfigSnapshotMessage {
  return {
    type: 'repo_runtime_config_snapshot',
    generatedAt: '2026-06-19T11:50:00.000Z',
    backend: 'docker',
    backendSource: 'default',
    isolation: 'worktree-before-docker',
    allowlist: { source: 'default', patterns: ['node:*'] },
    repos: [
      {
        name: 'app',
        path: '/Users/me/Projects/app',
        devcontainer: { present: true, path: '/Users/me/Projects/app/.devcontainer/devcontainer.json' },
        compose: { present: false, files: [] },
        image: 'node:22',
        imageSource: 'devcontainer',
        imageAllowed: true,
        error: null,
      },
    ],
    summary: { total: 1, withDevcontainer: 1, withCompose: 0, imagesDenied: 0, errored: 0 },
    ...over,
  }
}

describe('repo runtime config dispatch (#6139)', () => {
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

  it('applies repo_runtime_config_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.repoRuntimeConfig).not.toBeNull()
    expect(s.repoRuntimeConfig!.repos.map((r) => r.path)).toEqual(['/Users/me/Projects/app'])
    expect(s.repoRuntimeConfig!.backend).toBe('docker')
    expect(s.repoRuntimeConfig!.summary.withDevcontainer).toBe(1)
    expect(s.repoRuntimeConfigLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({
        backend: 'k8s',
        backendSource: 'config',
        repos: [
          {
            name: 'lib',
            path: '/Users/me/Projects/lib',
            devcontainer: { present: false, path: null },
            compose: { present: false, files: [] },
            image: 'node:22-slim',
            imageSource: 'default',
            imageAllowed: null,
            error: null,
          },
        ],
        summary: { total: 1, withDevcontainer: 0, withCompose: 0, imagesDenied: 0, errored: 0 },
      }),
      ctx() as never,
    )
    const s = store.getState()
    expect(s.repoRuntimeConfig!.repos.map((r) => r.path)).toEqual(['/Users/me/Projects/lib'])
    expect(s.repoRuntimeConfig!.backend).toBe('k8s')
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().repoRuntimeConfig
    // Missing required `summary` / `backend`.
    handleMessage(
      { type: 'repo_runtime_config_snapshot', generatedAt: '2026-06-19T11:50:00.000Z', repos: [] },
      ctx() as never,
    )
    expect(store.getState().repoRuntimeConfig).toBe(before)
    expect(store.getState().repoRuntimeConfigLoading).toBe(true)
  })

  it('accepts an empty-repos survey as a valid snapshot', () => {
    handleMessage(
      snapshot({ repos: [], summary: { total: 0, withDevcontainer: 0, withCompose: 0, imagesDenied: 0, errored: 0 } }),
      ctx() as never,
    )
    expect(store.getState().repoRuntimeConfig!.repos).toEqual([])
    expect(store.getState().repoRuntimeConfigLoading).toBe(false)
  })
})
