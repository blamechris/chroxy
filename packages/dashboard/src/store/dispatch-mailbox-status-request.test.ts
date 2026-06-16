/**
 * `requestMailboxStatus` action contract (#5914 follow-up).
 *
 * The Control Room "Mailbox" tab Refresh button calls this to pull a fresh
 * mailbox snapshot. Mirrors `requestHostStatus`'s fail-loud contract:
 *   - WS OPEN  → sends `mailbox_status_request`, sets `mailboxStatusLoading`, returns true.
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

describe('requestMailboxStatus action', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sends mailbox_status_request and sets loading when WS is OPEN', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.OPEN)
    useConnectionStore.setState({ socket, mailboxStatusLoading: false })

    const result = useConnectionStore.getState().requestMailboxStatus()

    expect(result).toBe(true)
    expect(sent).toEqual([{ type: 'mailbox_status_request' }])
    expect(useConnectionStore.getState().mailboxStatusLoading).toBe(true)
  })

  it('returns false and sends nothing when WS is CLOSED', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.CLOSED)
    useConnectionStore.setState({ socket, mailboxStatusLoading: false })

    const result = useConnectionStore.getState().requestMailboxStatus()

    expect(result).toBe(false)
    expect(sent).toHaveLength(0)
    expect(useConnectionStore.getState().mailboxStatusLoading).toBe(false)
  })

  it('returns false when there is no socket at all', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: null, mailboxStatusLoading: false })
    expect(useConnectionStore.getState().requestMailboxStatus()).toBe(false)
    expect(useConnectionStore.getState().mailboxStatusLoading).toBe(false)
  })
})
