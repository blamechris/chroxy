/**
 * Server auth persistence — tests for per-server credential storage.
 *
 * Tests persistence of active server ID, auto-restore on init,
 * and credential clearing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock localStorage
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

import {
  persistActiveServer,
  loadPersistedActiveServer,
} from './persistence'

import {
  loadServerRegistry,
  saveServerRegistry,
  addServerEntry,
  removeServerEntry,
  type ServerEntry,
} from './server-registry'

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(store)) delete store[k]
})

describe('persistActiveServer', () => {
  it('saves server ID to localStorage', () => {
    persistActiveServer('srv_123')
    expect(store['chroxy_persist_active_server_id']).toBe('srv_123')
  })

  it('removes key when null', () => {
    store['chroxy_persist_active_server_id'] = 'srv_123'
    persistActiveServer(null)
    expect(store['chroxy_persist_active_server_id']).toBeUndefined()
  })
})

describe('loadPersistedActiveServer', () => {
  it('returns null when nothing saved', () => {
    expect(loadPersistedActiveServer()).toBeNull()
  })

  it('returns saved server ID', () => {
    store['chroxy_persist_active_server_id'] = 'srv_456'
    expect(loadPersistedActiveServer()).toBe('srv_456')
  })
})

describe('credential lifecycle', () => {
  it('preserves token through add and load cycle', () => {
    const [servers] = addServerEntry([], 'Dev', 'wss://dev/ws', 'secret-token')
    const loaded = loadServerRegistry()
    expect(loaded[0]!.token).toBe('secret-token')
  })

  it('removes credentials when server is removed', () => {
    const [servers, entry] = addServerEntry([], 'Dev', 'wss://dev/ws', 'secret')
    const updated = removeServerEntry(servers, entry.id)
    saveServerRegistry(updated)
    const loaded = loadServerRegistry()
    expect(loaded).toHaveLength(0)
  })

  it('multiple server credentials are independent', () => {
    let servers: ServerEntry[] = []
    let entry1: ServerEntry
    ;[servers, entry1] = addServerEntry(servers, 'A', 'wss://a/ws', 'token-a')
    ;[servers] = addServerEntry(servers, 'B', 'wss://b/ws', 'token-b')

    // Remove first, second should remain
    servers = removeServerEntry(servers, entry1.id)
    const loaded = loadServerRegistry()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.name).toBe('B')
    expect(loaded[0]!.token).toBe('token-b')
  })

  it('active server ID persists across load cycles', () => {
    const [, entry] = addServerEntry([], 'Dev', 'wss://dev/ws', 'tok')
    persistActiveServer(entry.id)
    const loadedId = loadPersistedActiveServer()
    expect(loadedId).toBe(entry.id)

    // Verify the server exists in the registry
    const loadedRegistry = loadServerRegistry()
    const found = loadedRegistry.find(s => s.id === loadedId)
    expect(found).toBeTruthy()
    expect(found!.token).toBe('tok')
  })
})
