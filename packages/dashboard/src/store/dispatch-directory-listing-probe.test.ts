/**
 * `directory_listing` dispatch: path-matched one-shot probes sit beside the
 * single-slot callback (#8303). Drives the real handleMessage + real store
 * state (no store mock), so the slot's behaviour is proven unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'p', secretKey: 's' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import { handleMessage, setStore } from './message-handler'
import { addDirectoryListingProbe } from './directory-listing-probes'
import type { ConnectionState, DirectoryListing } from './types'

function listing(path: string, error: string | null = null) {
  return { type: 'directory_listing', path, parentPath: null, entries: [], error }
}

describe('directory_listing probes', () => {
  let slot: ((l: DirectoryListing) => void) | null
  const ctx = () => ({ url: 'wss://t', token: 't', socket: {} as WebSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    slot = null
    let state = { get _directoryListingCallback() { return slot } } as unknown as ConnectionState
    setStore({ getState: () => state, setState: () => {} })
  })

  it('delivers to the slot callback exactly as before, and to a matching probe', () => {
    const slotCb = vi.fn()
    slot = slotCb
    const probeCb = vi.fn()
    addDirectoryListingProbe('/srv/work', probeCb)
    handleMessage(listing('/srv/work', 'Access denied'), ctx() as any)
    expect(slotCb).toHaveBeenCalledTimes(1)
    expect(slotCb.mock.calls[0]![0]).toMatchObject({ path: '/srv/work', error: 'Access denied' })
    expect(probeCb).toHaveBeenCalledTimes(1)
  })

  it('a probe works with no slot callback installed, fires once, ignores other paths', () => {
    const probeCb = vi.fn()
    addDirectoryListingProbe('/srv/work/', probeCb)
    handleMessage(listing('/other'), ctx() as any)
    expect(probeCb).not.toHaveBeenCalled()
    handleMessage(listing('/srv/work'), ctx() as any)
    handleMessage(listing('/srv/work'), ctx() as any)
    expect(probeCb).toHaveBeenCalledTimes(1)
  })

  it('an unsubscribed probe never fires', () => {
    const probeCb = vi.fn()
    addDirectoryListingProbe('/srv/work', probeCb)()
    handleMessage(listing('/srv/work'), ctx() as any)
    expect(probeCb).not.toHaveBeenCalled()
  })
})
