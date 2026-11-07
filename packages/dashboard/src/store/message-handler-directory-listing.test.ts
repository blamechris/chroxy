/**
 * #8303 — `directory_listing` routing in the dashboard message handler: an
 * id-tagged reply goes to its own registered request and never to the shared
 * `_directoryListingCallback` slot (autocomplete / the picker); an untagged
 * reply (an older daemon, or a caller that sent no id) goes to the slot and can
 * never reach a registered request.
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

import { handleMessage, setStore, stopHeartbeat, resetReplayFlags } from './message-handler'
import {
  registerDirectoryListingRequest,
  clearDirectoryListingRequests,
  pendingDirectoryListingRequestCount,
} from './directory-listing-requests'
import type { ConnectionState } from './types'

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

const listing = (extra: Record<string, unknown> = {}) => ({
  type: 'directory_listing',
  path: '/a',
  parentPath: '/',
  entries: [{ name: 'x', isDirectory: true }],
  error: null,
  ...extra,
})

describe('dashboard message-handler — directory_listing routing (#8303)', () => {
  let slot: ReturnType<typeof vi.fn>
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: {} as WebSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    clearDirectoryListingRequests()
    slot = vi.fn()
    setStore(createMockStore({ connectionPhase: 'connected', _directoryListingCallback: slot } as unknown as Partial<ConnectionState>))
  })

  afterEach(() => {
    stopHeartbeat()
    resetReplayFlags()
    clearDirectoryListingRequests()
  })

  it('an untagged reply goes to the shared slot', () => {
    handleMessage(listing(), ctx() as never)
    expect(slot).toHaveBeenCalledTimes(1)
    expect(slot.mock.calls[0]![0]).toMatchObject({ path: '/a', error: null })
  })

  it('a tagged reply goes to its own request, is consumed, and never reaches the slot', () => {
    const own = vi.fn()
    registerDirectoryListingRequest('probe-1', own)
    handleMessage(listing({ requestId: 'probe-1', error: 'Access denied: x' }), ctx() as never)
    expect(own).toHaveBeenCalledTimes(1)
    expect(own.mock.calls[0]![0]).toMatchObject({ error: 'Access denied: x' })
    expect(slot).not.toHaveBeenCalled()
    expect(pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('a tagged reply for an unknown id is dropped (not given to the slot)', () => {
    handleMessage(listing({ requestId: 'nobody' }), ctx() as never)
    expect(slot).not.toHaveBeenCalled()
  })

  it('an untagged reply never reaches a registered request', () => {
    const own = vi.fn()
    registerDirectoryListingRequest('probe-2', own)
    handleMessage(listing(), ctx() as never)
    expect(own).not.toHaveBeenCalled()
    expect(pendingDirectoryListingRequestCount()).toBe(1)
  })
})
