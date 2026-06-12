/**
 * #5555 (sub-item 7) — the dashboard repoints the active server-registry entry
 * when a quick-tunnel rotation pushes a new URL (`tunnel_url_changed`) or
 * re-advertises it on reconnect (`auth_bootstrap` burst's `tunnelUrl`).
 *
 * Only a NON-localhost entry (activeServerId !== null) and only a `wss://`
 * (tunnel) entry are repointed; the same-origin connection and `ws://` LAN
 * entries are left alone. The update flows through the store's `updateServer`
 * action, which persists to localStorage.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

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

import { handleMessage, setStore, stopHeartbeat, clearDeltaBuffers } from './message-handler'
import type { ConnectionState } from './types'
import type { ServerEntry } from './server-registry'

interface MockStoreOpts {
  activeServerId: string | null
  serverRegistry: ServerEntry[]
}

function createMockStore({ activeServerId, serverRegistry }: MockStoreOpts) {
  let state = {
    activeServerId,
    serverRegistry,
    activeSessionId: null,
    availableProviders: [],
    slashCommands: [],
    customAgents: [],
    // The real store action the helper calls. Mutates the registry in place
    // (the production action also re-saves to localStorage; here we just track
    // the resulting list so the test can assert on it).
    updateServer: (serverId: string, patch: Partial<Pick<ServerEntry, 'name' | 'wsUrl' | 'token'>>) => {
      state = {
        ...state,
        serverRegistry: state.serverRegistry.map((s) =>
          s.id === serverId ? { ...s, ...patch } : s,
        ),
      }
    },
  } as unknown as ConnectionState

  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function entry(id: string, wsUrl: string): ServerEntry {
  return { id, name: id, wsUrl, token: 'tok', lastConnectedAt: null }
}

/** Read a registry entry's wsUrl by index, asserting it exists (test-only). */
function urlAt(store: { getState: () => ConnectionState }, idx: number): string {
  const e = store.getState().serverRegistry[idx]
  expect(e).toBeDefined()
  return e!.wsUrl
}

const ctx = { url: 'wss://old.trycloudflare.com', token: 'tok', isReconnect: false, silent: false }

describe('dashboard tunnel_url_changed (#5555 sub-item 7)', () => {
  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
  })

  it('repoints the active wss entry to the rotated URL', () => {
    const store = createMockStore({
      activeServerId: 'srv1',
      serverRegistry: [entry('srv1', 'wss://old.trycloudflare.com')],
    })
    setStore(store as any)

    handleMessage(
      { type: 'tunnel_url_changed', url: 'wss://new.trycloudflare.com', previousUrl: 'wss://old.trycloudflare.com' },
      ctx as any,
    )

    expect(urlAt(store, 0)).toBe('wss://new.trycloudflare.com')
  })

  it('is a no-op for the same-origin connection (activeServerId === null)', () => {
    const store = createMockStore({
      activeServerId: null,
      serverRegistry: [entry('srv1', 'wss://old.trycloudflare.com')],
    })
    setStore(store as any)

    handleMessage({ type: 'tunnel_url_changed', url: 'wss://new.trycloudflare.com' }, ctx as any)

    expect(urlAt(store, 0)).toBe('wss://old.trycloudflare.com')
  })

  it('does NOT repoint a ws:// LAN entry', () => {
    const store = createMockStore({
      activeServerId: 'lan1',
      serverRegistry: [entry('lan1', 'ws://192.168.1.5:8765')],
    })
    setStore(store as any)

    handleMessage({ type: 'tunnel_url_changed', url: 'wss://new.trycloudflare.com' }, ctx as any)

    expect(urlAt(store, 0)).toBe('ws://192.168.1.5:8765')
  })

  it('does NOT repoint when previousUrl is given but does not match the stored entry', () => {
    const store = createMockStore({
      activeServerId: 'srv1',
      serverRegistry: [entry('srv1', 'wss://current.trycloudflare.com')],
    })
    setStore(store as any)

    handleMessage(
      { type: 'tunnel_url_changed', url: 'wss://new.trycloudflare.com', previousUrl: 'wss://some-other.trycloudflare.com' },
      ctx as any,
    )

    expect(urlAt(store, 0)).toBe('wss://current.trycloudflare.com')
  })

  it('an auth_bootstrap burst with tunnelUrl re-learns the rotated URL', () => {
    const store = createMockStore({
      activeServerId: 'srv1',
      serverRegistry: [entry('srv1', 'wss://old.trycloudflare.com')],
    })
    setStore(store as any)

    handleMessage(
      {
        type: 'auth_bootstrap',
        providers: [],
        slashCommands: [],
        agents: [],
        tunnelUrl: 'wss://new.trycloudflare.com',
      },
      ctx as any,
    )

    expect(urlAt(store, 0)).toBe('wss://new.trycloudflare.com')
  })

  it('ignores a malformed push (no url) without throwing', () => {
    const store = createMockStore({
      activeServerId: 'srv1',
      serverRegistry: [entry('srv1', 'wss://old.trycloudflare.com')],
    })
    setStore(store as any)

    expect(() => handleMessage({ type: 'tunnel_url_changed' }, ctx as any)).not.toThrow()
    expect(urlAt(store, 0)).toBe('wss://old.trycloudflare.com')
  })
})
