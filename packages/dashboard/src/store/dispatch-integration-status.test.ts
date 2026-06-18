/**
 * Integration test for the Control Room Integrations tab wiring (#5499).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `integration_status_snapshot` REPLACES `integrationStatus` and clears
 *     `integrationStatusLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state and
 *     WITHOUT clearing the loading flag.
 *   - a second snapshot wholesale-replaces the first (full picture, no merge).
 *   - an empty-repos survey and a degraded (error / missing-CLI) survey are
 *     valid snapshots.
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
import type { ServerIntegrationStatusSnapshotMessage } from '@chroxy/protocol'

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
    integrationStatus: null,
    integrationStatusLoading: true,
    messages: [],
  }
}

function snapshot(over: Partial<ServerIntegrationStatusSnapshotMessage> = {}): ServerIntegrationStatusSnapshotMessage {
  return {
    type: 'integration_status_snapshot',
    generatedAt: '2026-06-10T11:50:00.000Z',
    root: '/Users/me/Projects',
    summary: { total: 2, configured: 1, notConfigured: 1, degraded: 0 },
    repos: [
      {
        name: 'chroxy',
        path: '/Users/me/Projects/chroxy',
        repoMemory: {
          configured: true,
          summarizer: 'ast',
          toolGroups: ['telemetry'],
          cache: { present: true, sizeBytes: 2310144, lastModified: '2026-06-09T22:00:00.000Z' },
          report: {
            totalEvents: 120,
            cacheHits: 90,
            cacheMisses: 30,
            cacheHitRatio: 0.75,
            estimatedTokensSaved: 48211,
            cacheEntryCount: 1391,
            staleEntryCount: 2,
            lastActivity: null,
          },
          reason: null,
        },
      },
      {
        name: 'scratch',
        path: '/Users/me/Projects/scratch',
        repoMemory: { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null },
      },
    ],
    repoMemoryCli: { found: true, path: '/usr/local/bin/repo-memory', note: null },
    ...over,
  }
}

describe('integration status dispatch (#5499)', () => {
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

  it('applies integration_status_snapshot and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.integrationStatus).not.toBeNull()
    expect(s.integrationStatus!.repos.map((r) => r.name)).toEqual(['chroxy', 'scratch'])
    expect(s.integrationStatus!.summary.configured).toBe(1)
    expect(s.integrationStatus!.repos[0]!.repoMemory!.report!.cacheHitRatio).toBe(0.75)
    expect(s.integrationStatusLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({
        summary: { total: 1, configured: 0, notConfigured: 1, degraded: 0 },
        repos: [
          {
            name: 'ltl',
            path: '/Users/me/Projects/ltl',
            repoMemory: { configured: false, summarizer: null, toolGroups: [], cache: null, report: null, reason: null },
          },
        ],
      }),
      ctx() as never,
    )
    expect(store.getState().integrationStatus!.repos.map((r) => r.name)).toEqual(['ltl'])
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().integrationStatus
    // Missing required `summary`.
    handleMessage(
      { type: 'integration_status_snapshot', generatedAt: '2026-06-10T11:50:00.000Z', root: '/p', repos: [] },
      ctx() as never,
    )
    expect(store.getState().integrationStatus).toBe(before)
    expect(store.getState().integrationStatusLoading).toBe(true)
  })

  it('accepts an empty-repos survey as a valid snapshot', () => {
    handleMessage(
      snapshot({ repos: [], summary: { total: 0, configured: 0, notConfigured: 0, degraded: 0 } }),
      ctx() as never,
    )
    expect(store.getState().integrationStatus!.repos).toEqual([])
    expect(store.getState().integrationStatusLoading).toBe(false)
  })

  it('accepts a degraded error snapshot (no repoMemoryCli, error annotation)', () => {
    handleMessage(
      {
        type: 'integration_status_snapshot',
        requestId: 'r1',
        generatedAt: '2026-06-10T11:50:00.000Z',
        root: '/p',
        summary: { total: 0, configured: 0, notConfigured: 0, degraded: 0 },
        repos: [],
        error: { code: 'SURVEY_FAILED', message: 'boom' },
      },
      ctx() as never,
    )
    expect(store.getState().integrationStatus!.error).toEqual({ code: 'SURVEY_FAILED', message: 'boom' })
    expect(store.getState().integrationStatusLoading).toBe(false)
  })
})
