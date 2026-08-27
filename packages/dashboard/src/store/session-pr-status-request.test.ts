/**
 * #7344 — `requestSessionPrStatus`, the store action behind the header chip's
 * Refresh and the App-level auto-pull.
 *
 * This exists because the action shipped with NO test: a review mutation that
 * reintroduced the #6310 defect (flip the loading flag before `wsSend` has
 * confirmed the frame went out) passed the entire dashboard suite. A loading
 * flag set on a send that never happened disables the chip's Refresh with
 * nothing in flight to ever clear it — the exact "sent it and nothing happened"
 * silent failure the #6278 durability work targets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))

/** OPEN socket whose send() throws — the OPEN→CLOSING TOCTOU wsSend catches. */
function closingSocket(): WebSocket {
  return {
    send: vi.fn(() => { throw new Error('InvalidStateError: socket is closing') }),
    close: vi.fn(), readyState: WebSocket.OPEN,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

/** Healthy OPEN socket that records sent frames. */
function liveSocket(sent: unknown[]): WebSocket {
  return {
    send: vi.fn((raw: string) => { try { sent.push(JSON.parse(raw)) } catch { /* noop */ } }),
    close: vi.fn(), readyState: WebSocket.OPEN,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function closedSocket(): WebSocket {
  return {
    send: vi.fn(), close: vi.fn(), readyState: WebSocket.CLOSED,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('#7344 — requestSessionPrStatus', () => {
  it('sends the request and sets loading for the target session', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 'sess-1', sessionPrStatusLoading: {} } as never)

    const result = useConnectionStore.getState().requestSessionPrStatus('sess-1')

    expect(result).toBe(true)
    expect(sent).toEqual([{ type: 'session_pr_status_request', sessionId: 'sess-1' }])
    expect(useConnectionStore.getState().sessionPrStatusLoading).toEqual({ 'sess-1': true })
  })

  it('defaults to the active session when no id is passed', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 'sess-A', sessionPrStatusLoading: {} } as never)

    expect(useConnectionStore.getState().requestSessionPrStatus()).toBe(true)
    expect(sent).toEqual([{ type: 'session_pr_status_request', sessionId: 'sess-A' }])
  })

  it('preserves loading flags for OTHER sessions', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: liveSocket([]), activeSessionId: 'sess-1', sessionPrStatusLoading: { 'sess-2': true } } as never)

    useConnectionStore.getState().requestSessionPrStatus('sess-1')

    expect(useConnectionStore.getState().sessionPrStatusLoading).toEqual({ 'sess-1': true, 'sess-2': true })
  })

  it('does NOT set loading when wsSend fails on a closing socket (#6310)', async () => {
    // The mutation that exposed this gap: flipping loading before checking
    // wsSend's return leaves Refresh disabled with nothing in flight.
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({ socket, activeSessionId: 'sess-1', sessionPrStatusLoading: {} } as never)

    const result = useConnectionStore.getState().requestSessionPrStatus('sess-1')

    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(result).toBe(false)
    expect(useConnectionStore.getState().sessionPrStatusLoading).toEqual({})
  })

  it('returns false without sending when the socket is closed', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closedSocket()
    useConnectionStore.setState({ socket, activeSessionId: 'sess-1', sessionPrStatusLoading: {} } as never)

    expect(useConnectionStore.getState().requestSessionPrStatus('sess-1')).toBe(false)
    expect(socket.send).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().sessionPrStatusLoading).toEqual({})
  })

  describe('auto-pull freshness window (Copilot review)', () => {
    it('suppresses a second AUTO request inside the window', async () => {
      // Without this the App effect spawns a git + `gh pr list` pair on every
      // tab switch.
      const { useConnectionStore } = await import('./connection')
      const sent: unknown[] = []
      useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 's1', sessionPrStatusLoading: {}, sessionPrStatusRequestedAt: {} } as never)

      expect(useConnectionStore.getState().requestSessionPrStatus('s1', 30_000)).toBe(true)
      expect(useConnectionStore.getState().requestSessionPrStatus('s1', 30_000)).toBe(false)
      expect(sent).toHaveLength(1)
    })

    it('does NOT suppress a request for a DIFFERENT session', async () => {
      // The window is per session; switching tabs must still pull the new one.
      const { useConnectionStore } = await import('./connection')
      const sent: unknown[] = []
      useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 's1', sessionPrStatusLoading: {}, sessionPrStatusRequestedAt: {} } as never)

      useConnectionStore.getState().requestSessionPrStatus('s1', 30_000)
      expect(useConnectionStore.getState().requestSessionPrStatus('s2', 30_000)).toBe(true)
      expect(sent).toHaveLength(2)
    })

    it('NEVER suppresses a manual Refresh, which passes no window', async () => {
      // The load-bearing half: a Refresh button that silently does nothing
      // inside the window would be worse than no button.
      const { useConnectionStore } = await import('./connection')
      const sent: unknown[] = []
      useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 's1', sessionPrStatusLoading: {}, sessionPrStatusRequestedAt: {} } as never)

      useConnectionStore.getState().requestSessionPrStatus('s1', 30_000)
      expect(useConnectionStore.getState().requestSessionPrStatus('s1')).toBe(true)
      expect(useConnectionStore.getState().requestSessionPrStatus('s1')).toBe(true)
      expect(sent).toHaveLength(3)
    })

    it('re-requests once the window has elapsed', async () => {
      // Positive control for the suppression: a window that never expired would
      // pin the chip to its first reading forever.
      const { useConnectionStore } = await import('./connection')
      const sent: unknown[] = []
      useConnectionStore.setState({
        socket: liveSocket(sent), activeSessionId: 's1', sessionPrStatusLoading: {},
        sessionPrStatusRequestedAt: { s1: Date.now() - 60_000 },
      } as never)

      expect(useConnectionStore.getState().requestSessionPrStatus('s1', 30_000)).toBe(true)
      expect(sent).toHaveLength(1)
    })
  })
  it('returns false without sending when there is no session to ask about', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = liveSocket([])
    useConnectionStore.setState({ socket, activeSessionId: null, sessionPrStatusLoading: {} } as never)

    expect(useConnectionStore.getState().requestSessionPrStatus()).toBe(false)
    expect(socket.send).not.toHaveBeenCalled()
  })
})
