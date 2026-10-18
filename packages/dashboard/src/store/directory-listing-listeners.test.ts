/**
 * Issue 8303 — directory_listing replies reach registered listeners as well as
 * the single callback slot, so a caller that must see a specific reply (the New
 * Session prefilled-cwd probe) is not at the mercy of whoever holds the slot.
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

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
  registerDirectoryListingListener,
} from './message-handler'
import type { ConnectionState } from './types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (
      s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>),
    ) => {
      state = { ...state, ...(typeof s === 'function' ? s(state) : s) }
    },
  }
}

const REPLY = { type: 'directory_listing', path: '/srv/outside', parentPath: null, entries: [], error: 'Access denied: x' }

describe('directory_listing dispatch (issue 8303)', () => {
  const unsubscribers: Array<() => void> = []
  afterEach(() => {
    while (unsubscribers.length) unsubscribers.pop()!()
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    setConnectionContext(null)
  })

  function setup(slot: ((l: unknown) => void) | null) {
    const store = createMockStore({
      connectionPhase: 'connected',
      sessions: [],
      sessionStates: {},
      messages: [],
      activeSessionId: null,
      _directoryListingCallback: slot,
    } as unknown as Partial<ConnectionState>)
    setStore(store)
    const ctx = { url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false }
    setConnectionContext(ctx as any)
    return ctx
  }

  it('offers the reply to a registered listener even when no callback holds the slot', () => {
    const ctx = setup(null)
    const seen: unknown[] = []
    unsubscribers.push(registerDirectoryListingListener((l) => seen.push(l)))
    handleMessage(REPLY, ctx as any)
    expect(seen).toHaveLength(1)
    expect((seen[0] as { path: string }).path).toBe('/srv/outside')
  })

  it('offers the reply to the listener AND the slot holder', () => {
    const slot = vi.fn()
    const ctx = setup(slot)
    const seen: unknown[] = []
    unsubscribers.push(registerDirectoryListingListener((l) => seen.push(l)))
    handleMessage(REPLY, ctx as any)
    expect(seen).toHaveLength(1)
    expect(slot).toHaveBeenCalledTimes(1)
  })

  it('stops offering replies once unsubscribed', () => {
    const ctx = setup(null)
    const seen: unknown[] = []
    const off = registerDirectoryListingListener((l) => seen.push(l))
    off()
    handleMessage(REPLY, ctx as any)
    expect(seen).toHaveLength(0)
  })
})
