/**
 * #9065: when the Browse request cannot be sent (socket not open, or the send
 * fails) the picker shows an error naming the path instead of waiting on
 * "Loading..." for a reply that cannot come. Runs through the REAL store
 * action `requestDirectoryListingFor`, not a stand-in.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))
vi.mock('../store/crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'p', secretKey: 's' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

function fakeSocket(opts: { readyState?: number; throwOnSend?: boolean } = {}) {
  return {
    send: vi.fn(() => { if (opts.throwOnSend) throw new Error('closing') }),
    close: vi.fn(),
    readyState: opts.readyState ?? WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openBrowse(socket: WebSocket | null) {
  const { useConnectionStore } = await import('../store/connection')
  useConnectionStore.setState({ socket, serverCapabilities: { directoryListingRequestIdV1: true } })
  const { CreateSessionModal } = await import('./CreateSessionModal')
  render(
    <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd="/home/u/proj/.." knownCwds={[]} existingNames={[]} />,
  )
  fireEvent.click(screen.getByText('Browse...'))
}

describe('Browse picker when the request cannot be sent (#9065)', () => {
  it('shows an error with the path when the socket is not open', async () => {
    await openBrowse(fakeSocket({ readyState: WebSocket.CLOSED }))
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    expect(screen.getByText(/could not list \/home\/u\/proj\/\.\./i)).toBeInTheDocument()
  })

  it('shows an error with the path when there is no socket', async () => {
    await openBrowse(null)
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    expect(screen.getByText(/could not list/i)).toBeInTheDocument()
  })

  it('shows an error when the send itself fails', async () => {
    const socket = fakeSocket({ throwOnSend: true })
    await openBrowse(socket)
    expect(socket.send).toHaveBeenCalled()
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    expect(screen.getByText(/could not list/i)).toBeInTheDocument()
  })

  it('keeps Loading while a request really went out', async () => {
    await openBrowse(fakeSocket())
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    expect(screen.queryByText(/could not list/i)).not.toBeInTheDocument()
  })
})
