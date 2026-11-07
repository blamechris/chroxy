/**
 * #8303 — the REAL `requestDirectoryListingFor` store action (the modal tests
 * replace it): the id is on the wire, nothing is sent or registered for a closed
 * socket or a daemon that does not advertise `directoryListingRequestIdV1`, and a
 * failed send drops the registration so the map cannot grow.
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

function fakeSocket(opts: { readyState?: number; throwOnSend?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const socket = {
    send: vi.fn((raw: string) => {
      if (opts.throwOnSend) throw new Error('InvalidStateError: socket is closing')
      sent.push(JSON.parse(raw))
    }),
    close: vi.fn(),
    readyState: opts.readyState ?? WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
  return { socket, sent }
}

const CAP = { directoryListingRequestIdV1: true }

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

async function load() {
  const { useConnectionStore } = await import('./connection')
  const registry = await import('./directory-listing-requests')
  registry.clearDirectoryListingRequests()
  return { useConnectionStore, registry }
}

describe('requestDirectoryListingFor (#8303)', () => {
  it('puts the requestId on the wire with the path, and registers the callback', async () => {
    const { useConnectionStore, registry } = await load()
    const { socket, sent } = fakeSocket()
    useConnectionStore.setState({ socket, serverCapabilities: CAP })
    const cb = vi.fn()
    useConnectionStore.getState().requestDirectoryListingFor('/tmp/x', 'probe-1', cb)
    expect(sent).toEqual([{ type: 'list_directory', path: '/tmp/x', requestId: 'probe-1' }])
    expect(registry.pendingDirectoryListingRequestCount()).toBe(1)
    // and the registered callback is the one that answers that id
    registry.routeDirectoryListing('probe-1', { path: '/tmp/x', parentPath: null, entries: [], error: null }, null)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('the returned cancel drops the registration', async () => {
    const { useConnectionStore, registry } = await load()
    const { socket } = fakeSocket()
    useConnectionStore.setState({ socket, serverCapabilities: CAP })
    const cancel = useConnectionStore.getState().requestDirectoryListingFor('/a', 'p', vi.fn())
    expect(registry.pendingDirectoryListingRequestCount()).toBe(1)
    cancel()
    expect(registry.pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('a closed or missing socket is a no-op: nothing sent, nothing registered', async () => {
    const { useConnectionStore, registry } = await load()
    const closed = fakeSocket({ readyState: WebSocket.CLOSED })
    useConnectionStore.setState({ socket: closed.socket, serverCapabilities: CAP })
    const cancel = useConnectionStore.getState().requestDirectoryListingFor('/a', 'p', vi.fn())
    expect(closed.sent).toEqual([])
    expect(registry.pendingDirectoryListingRequestCount()).toBe(0)
    expect(() => cancel()).not.toThrow()
    useConnectionStore.setState({ socket: null })
    useConnectionStore.getState().requestDirectoryListingFor('/a', 'p2', vi.fn())
    expect(registry.pendingDirectoryListingRequestCount()).toBe(0)
  })

  it('sends no probe to a daemon that does not advertise the capability', async () => {
    const { useConnectionStore, registry } = await load()
    for (const serverCapabilities of [{} as Record<string, boolean>, { directoryListingRequestIdV1: false }, { inputContextV1: true }]) {
      const { socket, sent } = fakeSocket()
      useConnectionStore.setState({ socket, serverCapabilities })
      useConnectionStore.getState().requestDirectoryListingFor('/a', 'p', vi.fn())
      expect(sent).toEqual([])
      expect(registry.pendingDirectoryListingRequestCount()).toBe(0)
    }
  })

  it('when the send fails (wsSend returns false) the registration is cancelled', async () => {
    const { useConnectionStore, registry } = await load()
    const { socket } = fakeSocket({ throwOnSend: true })
    useConnectionStore.setState({ socket, serverCapabilities: CAP })
    useConnectionStore.getState().requestDirectoryListingFor('/a', 'p', vi.fn())
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(registry.pendingDirectoryListingRequestCount()).toBe(0)
  })
})
