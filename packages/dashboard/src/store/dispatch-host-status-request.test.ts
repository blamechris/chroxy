/**
 * `requestHostStatus` action contract (#5175, epic #5170).
 *
 * The Control Room Refresh button calls this action to pull a fresh
 * Host/Repo Status survey. Mirrors the #4559 fail-loud contract:
 *   - WS OPEN  → sends `host_status_request`, sets `hostStatusLoading`, returns true.
 *   - WS CLOSED / no socket → sends nothing, leaves loading untouched, returns false.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

interface SentPayload {
  type: string
  [k: string]: unknown
}

function createMockSocket(sent: SentPayload[], readyState: number = WebSocket.OPEN): WebSocket {
  return {
    send: vi.fn((raw: string) => {
      try { sent.push(JSON.parse(raw) as SentPayload) } catch { /* noop */ }
    }),
    close: vi.fn(),
    readyState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('#5175 — requestHostStatus action', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sends host_status_request and sets loading when WS is OPEN', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.OPEN)
    useConnectionStore.setState({ socket, hostStatusLoading: false })

    const result = useConnectionStore.getState().requestHostStatus()

    expect(result).toBe(true)
    expect(sent).toEqual([{ type: 'host_status_request' }])
    expect(useConnectionStore.getState().hostStatusLoading).toBe(true)
  })

  it('returns false and sends nothing when WS is CLOSED', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.CLOSED)
    useConnectionStore.setState({ socket, hostStatusLoading: false })

    const result = useConnectionStore.getState().requestHostStatus()

    expect(result).toBe(false)
    expect(sent).toHaveLength(0)
    // Loading must NOT flip on a dropped request — otherwise the button would
    // spin forever with no snapshot ever coming.
    expect(useConnectionStore.getState().hostStatusLoading).toBe(false)
  })

  it('returns false when there is no socket at all', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: null, hostStatusLoading: false })
    expect(useConnectionStore.getState().requestHostStatus()).toBe(false)
    expect(useConnectionStore.getState().hostStatusLoading).toBe(false)
  })
})
