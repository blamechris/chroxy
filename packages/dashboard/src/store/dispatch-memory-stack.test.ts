/**
 * Integration test for the dashboard memory panel wiring (#6867, epic #6760).
 *
 * Guards the wire path between the dashboard message handler and the store:
 *   - `memory_stack_result` REPLACES memoryStackEntries/memoryStackFile and
 *     clears memoryStackLoading.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state
 *     and WITHOUT clearing the loading flag (so a buggy server can't make
 *     Refresh silently lie).
 *   - a request-level `error` (memory unavailable in this mode / session cwd
 *     unresolvable) is stored separately from a per-entry error.
 *   - a second snapshot wholesale-replaces the first (full picture, no merge).
 *
 * Mirrors dispatch-host-status.test.ts's mocking idiom exactly.
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
import type { ConnectionState, MemoryFileDescriptor, MemoryStackEntry } from './types'

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
    memoryStackEntries: null,
    memoryStackFile: null,
    memoryStackError: null,
    memoryStackLoading: true,
    lastMemoryStackRequestId: null,
    messages: [],
  }
}

const GLOBAL_ENTRY: MemoryStackEntry = {
  path: '/home/me/.claude/CLAUDE.md',
  exists: true,
  content: '# Global memory',
  truncated: false,
  skipped: false,
  error: null,
  scope: 'global',
  importedFrom: null,
}

const PROJECT_ENTRY: MemoryStackEntry = {
  path: '/repo/CLAUDE.md',
  exists: true,
  content: '# Project memory',
  truncated: false,
  skipped: false,
  error: null,
  scope: 'project',
  importedFrom: null,
}

const LOCAL_ENTRY_MISSING: MemoryStackEntry = {
  path: '/repo/CLAUDE.local.md',
  exists: false,
  content: null,
  truncated: false,
  skipped: false,
  error: null,
  scope: 'local',
  importedFrom: null,
}

const MEMORY_FILE: MemoryFileDescriptor = {
  path: '/home/me/.claude/projects/repo/memory/MEMORY.md',
  exists: true,
  content: '# Auto memory',
  truncated: false,
  skipped: false,
  error: null,
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    type: 'memory_stack_result',
    entries: [GLOBAL_ENTRY, PROJECT_ENTRY, LOCAL_ENTRY_MISSING],
    memoryFile: MEMORY_FILE,
    error: null,
    ...over,
  }
}

describe('dashboard memory panel dispatch (#6867)', () => {
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

  it('applies memory_stack_result and clears the loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.memoryStackEntries).toEqual([GLOBAL_ENTRY, PROJECT_ENTRY, LOCAL_ENTRY_MISSING])
    expect(s.memoryStackFile).toEqual(MEMORY_FILE)
    expect(s.memoryStackError).toBeNull()
    expect(s.memoryStackLoading).toBe(false)
  })

  it('preserves precedence order (global, project, local) as sent by the server', () => {
    handleMessage(snapshot(), ctx() as never)
    const scopes = store.getState().memoryStackEntries!.map((e) => e.scope)
    expect(scopes).toEqual(['global', 'project', 'local'])
  })

  it('surfaces a missing file as exists: false rather than dropping the entry', () => {
    handleMessage(snapshot(), ctx() as never)
    const local = store.getState().memoryStackEntries!.find((e) => e.scope === 'local')
    expect(local).toBeDefined()
    expect(local!.exists).toBe(false)
    expect(local!.content).toBeNull()
  })

  it('stores a request-level error separately without a crash', () => {
    handleMessage(
      snapshot({ entries: [], memoryFile: null, error: 'Memory is not available in this mode' }),
      ctx() as never,
    )
    const s = store.getState()
    expect(s.memoryStackError).toBe('Memory is not available in this mode')
    expect(s.memoryStackEntries).toEqual([])
    expect(s.memoryStackFile).toBeNull()
    expect(s.memoryStackLoading).toBe(false)
  })

  it('replaces a prior snapshot wholesale (no merge)', () => {
    handleMessage(snapshot(), ctx() as never)
    handleMessage(
      snapshot({ entries: [PROJECT_ENTRY] }),
      ctx() as never,
    )
    expect(store.getState().memoryStackEntries).toEqual([PROJECT_ENTRY])
  })

  it('drops a malformed snapshot without mutating state or clearing loading', () => {
    const before = store.getState().memoryStackEntries
    // `entries` must be an array — this payload sends a string instead.
    handleMessage(
      { type: 'memory_stack_result', entries: 'not-an-array', memoryFile: null, error: null },
      ctx() as never,
    )
    expect(store.getState().memoryStackEntries).toBe(before)
    // Loading flag is untouched on a malformed payload.
    expect(store.getState().memoryStackLoading).toBe(true)
  })

  it('drops a malformed entry (missing required scope) without mutating state', () => {
    const before = store.getState().memoryStackEntries
    handleMessage(
      snapshot({ entries: [{ path: '/x', exists: true, content: 'x', truncated: false, skipped: false, error: null }] }),
      ctx() as never,
    )
    expect(store.getState().memoryStackEntries).toBe(before)
    expect(store.getState().memoryStackLoading).toBe(true)
  })

  // #6996 review — requestMemoryRead() stamps each memory_read with a fresh
  // requestId nonce (tracked as lastMemoryStackRequestId); a reply that
  // echoes a stale requestId is a superseded answer (e.g. a rapid session
  // switch fired a second request before the first one's reply landed) and
  // must be dropped without touching state or clearing the loading flag —
  // the *new* request's own reply is what should clear it.
  describe('requestId correlation', () => {
    it('drops a reply whose requestId does not match the latest request', () => {
      store = createMockStore({ ...baseState(), lastMemoryStackRequestId: 'req-2' })
      setStore(store)
      handleMessage(snapshot({ requestId: 'req-1' }), ctx() as never)
      const s = store.getState()
      expect(s.memoryStackEntries).toBeNull()
      expect(s.memoryStackLoading).toBe(true)
    })

    it('applies a reply whose requestId matches the latest request', () => {
      store = createMockStore({ ...baseState(), lastMemoryStackRequestId: 'req-2' })
      setStore(store)
      handleMessage(snapshot({ requestId: 'req-2' }), ctx() as never)
      const s = store.getState()
      expect(s.memoryStackEntries).toEqual([GLOBAL_ENTRY, PROJECT_ENTRY, LOCAL_ENTRY_MISSING])
      expect(s.memoryStackLoading).toBe(false)
    })

    it('applies a reply with no requestId at all (older-server fallback)', () => {
      store = createMockStore({ ...baseState(), lastMemoryStackRequestId: 'req-2' })
      setStore(store)
      handleMessage(snapshot(), ctx() as never)
      const s = store.getState()
      expect(s.memoryStackEntries).toEqual([GLOBAL_ENTRY, PROJECT_ENTRY, LOCAL_ENTRY_MISSING])
      expect(s.memoryStackLoading).toBe(false)
    })
  })
})
