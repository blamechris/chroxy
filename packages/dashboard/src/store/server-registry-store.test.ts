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

// Must import after localStorage mock is set up
const { useConnectionStore } = await import('./connection')

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(store)) delete store[k]
  // Reset store state relevant to server registry
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
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

  it('multiple servers can coexist in registry', () => {
    useConnectionStore.getState().addServer('Dev', 'wss://dev/ws', 'token1')
    useConnectionStore.getState().addServer('Staging', 'wss://staging/ws', 'token2')
    useConnectionStore.getState().addServer('Prod', 'wss://prod/ws', 'token3')
    expect(useConnectionStore.getState().serverRegistry).toHaveLength(3)
    expect(useConnectionStore.getState().serverRegistry.map(s => s.name)).toEqual(['Dev', 'Staging', 'Prod'])
  })
})
