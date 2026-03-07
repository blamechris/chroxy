/**
 * Server Registry — tests for multi-server connection management.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadServerRegistry,
  saveServerRegistry,
  addServerEntry,
  removeServerEntry,
  updateServerEntry,
  markServerConnected,
  findServerByUrl,
  type ServerEntry,
} from './server-registry'

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

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(store)) delete store[k]
})

describe('loadServerRegistry', () => {
  it('returns empty array when no data stored', () => {
    expect(loadServerRegistry()).toEqual([])
  })

  it('returns parsed server entries', () => {
    const entries: ServerEntry[] = [
      { id: 'srv_1', name: 'Dev', wsUrl: 'wss://dev.example.com/ws', token: 'abc', lastConnectedAt: 1000 },
    ]
    store['chroxy_server_registry'] = JSON.stringify(entries)
    expect(loadServerRegistry()).toEqual(entries)
  })

  it('returns empty array on invalid JSON', () => {
    store['chroxy_server_registry'] = 'not-json'
    expect(loadServerRegistry()).toEqual([])
  })

  it('returns empty array on non-array JSON', () => {
    store['chroxy_server_registry'] = '{"foo":"bar"}'
    expect(loadServerRegistry()).toEqual([])
  })
})

describe('saveServerRegistry', () => {
  it('persists entries to localStorage', () => {
    const entries: ServerEntry[] = [
      { id: 'srv_1', name: 'Dev', wsUrl: 'wss://dev.example.com/ws', token: 'abc', lastConnectedAt: null },
    ]
    saveServerRegistry(entries)
    expect(store['chroxy_server_registry']).toBe(JSON.stringify(entries))
  })
})

describe('addServerEntry', () => {
  it('adds a new entry with generated ID', () => {
    const [updated, entry] = addServerEntry([], 'My Server', 'wss://example.com/ws', 'token123')
    expect(updated).toHaveLength(1)
    expect(entry.name).toBe('My Server')
    expect(entry.wsUrl).toBe('wss://example.com/ws')
    expect(entry.token).toBe('token123')
    expect(entry.id).toMatch(/^srv_/)
    expect(entry.lastConnectedAt).toBeNull()
  })

  it('trims whitespace from inputs', () => {
    const [, entry] = addServerEntry([], '  Spaced  ', '  wss://url  ', '  tok  ')
    expect(entry.name).toBe('Spaced')
    expect(entry.wsUrl).toBe('wss://url')
    expect(entry.token).toBe('tok')
  })

  it('defaults empty name to "Unnamed Server"', () => {
    const [, entry] = addServerEntry([], '  ', 'wss://url', 'tok')
    expect(entry.name).toBe('Unnamed Server')
  })

  it('appends to existing list', () => {
    const existing: ServerEntry[] = [
      { id: 'srv_1', name: 'Old', wsUrl: 'wss://old/ws', token: 'x', lastConnectedAt: null },
    ]
    const [updated] = addServerEntry(existing, 'New', 'wss://new/ws', 'y')
    expect(updated).toHaveLength(2)
    expect(updated[0]!.name).toBe('Old')
    expect(updated[1]!.name).toBe('New')
  })

  it('persists to localStorage', () => {
    addServerEntry([], 'Test', 'wss://test/ws', 'tok')
    expect(store['chroxy_server_registry']).toBeTruthy()
    const saved = JSON.parse(store['chroxy_server_registry']!)
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('Test')
  })
})

describe('removeServerEntry', () => {
  const servers: ServerEntry[] = [
    { id: 'srv_1', name: 'A', wsUrl: 'wss://a/ws', token: 'x', lastConnectedAt: null },
    { id: 'srv_2', name: 'B', wsUrl: 'wss://b/ws', token: 'y', lastConnectedAt: null },
  ]

  it('removes the specified server', () => {
    const updated = removeServerEntry(servers, 'srv_1')
    expect(updated).toHaveLength(1)
    expect(updated[0]!.name).toBe('B')
  })

  it('does nothing when ID not found', () => {
    const updated = removeServerEntry(servers, 'srv_nope')
    expect(updated).toHaveLength(2)
  })

  it('persists to localStorage', () => {
    removeServerEntry(servers, 'srv_1')
    const saved = JSON.parse(store['chroxy_server_registry']!)
    expect(saved).toHaveLength(1)
  })
})

describe('updateServerEntry', () => {
  const servers: ServerEntry[] = [
    { id: 'srv_1', name: 'A', wsUrl: 'wss://a/ws', token: 'x', lastConnectedAt: null },
    { id: 'srv_2', name: 'B', wsUrl: 'wss://b/ws', token: 'y', lastConnectedAt: null },
  ]

  it('updates the name of a server', () => {
    const updated = updateServerEntry(servers, 'srv_1', { name: 'Updated' })
    expect(updated[0]!.name).toBe('Updated')
    expect(updated[0]!.wsUrl).toBe('wss://a/ws')
  })

  it('updates multiple fields', () => {
    const updated = updateServerEntry(servers, 'srv_2', { name: 'New B', token: 'newtoken' })
    expect(updated[1]!.name).toBe('New B')
    expect(updated[1]!.token).toBe('newtoken')
  })

  it('does not modify other entries', () => {
    const updated = updateServerEntry(servers, 'srv_1', { name: 'Changed' })
    expect(updated[1]).toEqual(servers[1])
  })
})

describe('markServerConnected', () => {
  it('sets lastConnectedAt to current time', () => {
    const servers: ServerEntry[] = [
      { id: 'srv_1', name: 'A', wsUrl: 'wss://a/ws', token: 'x', lastConnectedAt: null },
    ]
    const before = Date.now()
    const updated = markServerConnected(servers, 'srv_1')
    expect(updated[0]!.lastConnectedAt).toBeGreaterThanOrEqual(before)
    expect(updated[0]!.lastConnectedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('findServerByUrl', () => {
  const servers: ServerEntry[] = [
    { id: 'srv_1', name: 'A', wsUrl: 'wss://a.example.com/ws', token: 'x', lastConnectedAt: null },
    { id: 'srv_2', name: 'B', wsUrl: 'wss://b.example.com/ws', token: 'y', lastConnectedAt: null },
  ]

  it('finds by exact URL match', () => {
    expect(findServerByUrl(servers, 'wss://a.example.com/ws')?.id).toBe('srv_1')
  })

  it('returns undefined when not found', () => {
    expect(findServerByUrl(servers, 'wss://nope/ws')).toBeUndefined()
  })
})
