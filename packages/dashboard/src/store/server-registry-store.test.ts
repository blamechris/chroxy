/**
 * Server Registry — store integration tests.
 *
 * Tests the addServer/removeServer/updateServer/switchServer actions
 * wired into the Zustand connection store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock localStorage before importing the store
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value }),
  removeItem: vi.fn((key: string) => { delete store[key] }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k] }),
  get length() { return Object.keys(store).length },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

// Control getAuthToken so connectLocal's same-origin path is testable.
let mockToken: string | null = null
vi.mock('../utils/auth', () => ({
  getAuthToken: () => mockToken,
}))

// Must import after localStorage mock is set up
const { useConnectionStore } = await import('./connection')

// Capture the real action refs at import time (before any test mocks them). The
// store is a module singleton, so retryConnection tests that swap actions in via
// setState would otherwise leak mocked refs into later tests in this file — and,
// in a shared Vitest worker, other files. Restore them in beforeEach.
const realActions = {
  connect: useConnectionStore.getState().connect,
  connectToServer: useConnectionStore.getState().connectToServer,
  _resetSessionMemory: useConnectionStore.getState()._resetSessionMemory,
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(store)) delete store[k]
  mockToken = null
  // Reset store state relevant to server registry, restoring the real actions
  // any prior test may have replaced with spies.
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    ...realActions,
    // #6063: stub the network-touching `connect` so the switchServer /
    // connectToServer / connectLocal / pairServer tests — which only assert the
    // synchronous registry/scope state those actions set BEFORE delegating to
    // connect() — never open a real WebSocket. The real connect()'s async path
    // logs via console.* AFTER the test body resolves, racing the vitest worker
    // teardown ("Closing rpc while onUserConsoleLog was pending" →
    // EnvironmentTeardownError → green suite, non-zero exit, red CI job). The
    // retryConnection tests override `connect`/`connectToServer` with their own
    // spies after this, so they are unaffected.
    connect: vi.fn(),
  })
})

describe('store server registry actions', () => {
  it('addServer creates a server entry in the store', () => {
    const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    expect(entry.name).toBe('Dev')
    expect(entry.id).toMatch(/^srv_/)
    expect(useConnectionStore.getState().serverRegistry).toHaveLength(1)
    expect(useConnectionStore.getState().serverRegistry[0]!.name).toBe('Dev')
  })

  it('addServer persists to localStorage', () => {
    useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    expect(store['chroxy_server_registry']).toBeTruthy()
    const saved = JSON.parse(store['chroxy_server_registry']!)
    expect(saved).toHaveLength(1)
  })

  it('removeServer removes from registry', () => {
    const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    useConnectionStore.getState().removeServer(entry.id)
    expect(useConnectionStore.getState().serverRegistry).toHaveLength(0)
  })

  it('removeServer clears activeServerId if removing active server', () => {
    const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    useConnectionStore.setState({ activeServerId: entry.id })
    useConnectionStore.getState().removeServer(entry.id)
    expect(useConnectionStore.getState().activeServerId).toBeNull()
  })

  it('updateServer updates server properties', () => {
    const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    useConnectionStore.getState().updateServer(entry.id, { name: 'Production' })
    expect(useConnectionStore.getState().serverRegistry[0]!.name).toBe('Production')
    expect(useConnectionStore.getState().serverRegistry[0]!.wsUrl).toBe('wss://dev/ws')
  })

  it('switchServer sets activeServerId', () => {
    const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    // switchServer calls connect() which does async work — just verify it sets the ID
    useConnectionStore.getState().switchServer(entry.id)
    expect(useConnectionStore.getState().activeServerId).toBe(entry.id)
  })

  it('switchServer does nothing for unknown ID', () => {
    useConnectionStore.getState().switchServer('nonexistent')
    expect(useConnectionStore.getState().activeServerId).toBeNull()
  })

  it('connectToServer sets activeServerId', () => {
    const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    useConnectionStore.getState().connectToServer(entry.id)
    expect(useConnectionStore.getState().activeServerId).toBe(entry.id)
  })

  it('connectLocal is a no-op when no same-origin token is available', () => {
    mockToken = null
    // Pretend we are on a remote server; connectLocal must not touch it.
    useConnectionStore.setState({ activeServerId: 'srv_remote', connectionPhase: 'connected' })
    useConnectionStore.getState().connectLocal()
    expect(useConnectionStore.getState().activeServerId).toBe('srv_remote')
    expect(useConnectionStore.getState().connectionPhase).toBe('connected')
  })

  it('connectLocal switches from a remote server back to local (activeServerId → null)', () => {
    mockToken = 'local-token'
    useConnectionStore.setState({ activeServerId: 'srv_remote', connectionPhase: 'connected' })
    useConnectionStore.getState().connectLocal()
    // connect() does async work — verify the scope flipped to local synchronously.
    expect(useConnectionStore.getState().activeServerId).toBeNull()
  })

  it('connectLocal is a no-op when already connected to local', () => {
    mockToken = 'local-token'
    useConnectionStore.setState({ activeServerId: null, connectionPhase: 'connected' })
    useConnectionStore.getState().connectLocal()
    // Already local + connected → must not tear down the connection.
    expect(useConnectionStore.getState().connectionPhase).toBe('connected')
  })

  describe('retryConnection (#5284)', () => {
    it('reconnects to the active REMOTE server, not local', () => {
      const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
      const connectSpy = vi.fn()
      const connectToServerSpy = vi.fn()
      // A dropped remote session: active server set, socket down.
      useConnectionStore.setState({
        activeServerId: entry.id,
        connectionPhase: 'disconnected',
        connect: connectSpy,
        connectToServer: connectToServerSpy,
      })
      useConnectionStore.getState().retryConnection()
      // Must retry the remote registry entry — never the same-origin connect().
      expect(connectToServerSpy).toHaveBeenCalledWith(entry.id)
      expect(connectSpy).not.toHaveBeenCalled()
    })

    it('reconnects to local same-origin when no active server', () => {
      mockToken = 'local-token'
      const connectSpy = vi.fn()
      const connectToServerSpy = vi.fn()
      useConnectionStore.setState({
        activeServerId: null,
        connectionPhase: 'disconnected',
        connect: connectSpy,
        connectToServer: connectToServerSpy,
      })
      useConnectionStore.getState().retryConnection()
      expect(connectToServerSpy).not.toHaveBeenCalled()
      expect(connectSpy).toHaveBeenCalledTimes(1)
      // Same-origin /ws URL + the page token.
      expect(connectSpy.mock.calls[0]![0]).toMatch(/\/ws$/)
      expect(connectSpy.mock.calls[0]![1]).toBe('local-token')
    })

    it('is a no-op for the local path when no same-origin token is available', () => {
      mockToken = null
      const connectSpy = vi.fn()
      useConnectionStore.setState({
        activeServerId: null,
        connectionPhase: 'disconnected',
        connect: connectSpy,
      })
      useConnectionStore.getState().retryConnection()
      expect(connectSpy).not.toHaveBeenCalled()
    })

    it('no-ops when activeServerId is stale (absent from registry) — never falls back to local', () => {
      // Stale/desynced id (e.g. cross-tab registry edit): connectToServer must
      // no-op rather than reconnect to local, which would be the wrong target.
      const connectSpy = vi.fn()
      useConnectionStore.setState({
        serverRegistry: [],
        activeServerId: 'srv_gone',
        connectionPhase: 'disconnected',
        connect: connectSpy,
      })
      useConnectionStore.getState().retryConnection()
      // Real connectToServer ran and found no entry — no local fallback connect.
      expect(connectSpy).not.toHaveBeenCalled()
      expect(useConnectionStore.getState().activeServerId).toBe('srv_gone')
    })

    it('preserves session state on retry (does NOT reset session memory)', () => {
      // The core guarantee of retryConnection vs switchServer/connectLocal: a
      // retry resumes, it must not wipe session memory. Guard against a future
      // change to connectToServer that adds a reset.
      const entry = useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
      const resetSpy = vi.fn()
      useConnectionStore.setState({
        activeServerId: entry.id,
        connectionPhase: 'disconnected',
        connect: vi.fn(),
        _resetSessionMemory: resetSpy,
      })
      useConnectionStore.getState().retryConnection()
      expect(resetSpy).not.toHaveBeenCalled()
    })
  })

  it('pairServer adds a tokenless entry and makes it active (#5281 ③ PR 2)', () => {
    mockToken = null
    const entry = useConnectionStore.getState().pairServer('Studio', 'ws://192.168.1.5:8765/ws', 'PAIR123')
    // Entry persisted with an empty token (the session token arrives via auth_ok).
    expect(entry.token).toBe('')
    expect(useConnectionStore.getState().serverRegistry.some(s => s.id === entry.id)).toBe(true)
    // switchServer made it the active server (connect() does async work).
    expect(useConnectionStore.getState().activeServerId).toBe(entry.id)
  })

  it('multiple servers can coexist in registry', () => {
    useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    useConnectionStore.getState().addServer('Staging', 'wss://staging/ws', 'token2')
    useConnectionStore.getState().addServer('Prod', 'wss://prod/ws', 'token3')
    expect(useConnectionStore.getState().serverRegistry).toHaveLength(3)
    expect(useConnectionStore.getState().serverRegistry.map(s => s.name)).toEqual(['Dev', 'Staging', 'Prod'])
  })
})
