/**
 * #7430 — `requestSessionPrThreads`, the store action behind the CI chip's
 * Refresh and the prefill click.
 *
 * Mirrors `session-pr-status-request.test.ts` deliberately, including the
 * #6310 pin: a loading flag flipped before `wsSend` has confirmed the frame
 * went out disables a control with nothing in flight to ever clear it.
 *
 * The dispatch half lives in `dispatch-session-pr-threads.test.ts`, split for
 * the same reason the sibling pair is split — the action tests re-import the
 * store under `vi.resetModules()`, and the dispatch tests drive
 * `message-handler`'s module-level store handle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('#7430 — requestSessionPrThreads', () => {
  it('sends the request and sets loading for the target session', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 'sess-1', sessionPrThreadsLoading: {} } as never)

    expect(useConnectionStore.getState().requestSessionPrThreads('sess-1')).toBe(true)
    expect(sent).toEqual([{ type: 'session_pr_threads_request', sessionId: 'sess-1' }])
    expect(useConnectionStore.getState().sessionPrThreadsLoading).toEqual({ 'sess-1': true })
  })

  it('defaults to the active session when no id is passed', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 'sess-A', sessionPrThreadsLoading: {} } as never)

    expect(useConnectionStore.getState().requestSessionPrThreads()).toBe(true)
    expect(sent).toEqual([{ type: 'session_pr_threads_request', sessionId: 'sess-A' }])
  })

  it('does NOT set loading when wsSend fails on a closing socket (#6310)', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({ socket, activeSessionId: 'sess-1', sessionPrThreadsLoading: {} } as never)

    expect(useConnectionStore.getState().requestSessionPrThreads('sess-1')).toBe(false)
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(useConnectionStore.getState().sessionPrThreadsLoading).toEqual({})
  })

  it('returns false without sending on a closed socket or with no session', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closedSocket()
    useConnectionStore.setState({ socket, activeSessionId: 'sess-1', sessionPrThreadsLoading: {} } as never)
    expect(useConnectionStore.getState().requestSessionPrThreads('sess-1')).toBe(false)
    expect(socket.send).not.toHaveBeenCalled()

    const live = liveSocket([])
    useConnectionStore.setState({ socket: live, activeSessionId: null } as never)
    expect(useConnectionStore.getState().requestSessionPrThreads()).toBe(false)
    expect(live.send).not.toHaveBeenCalled()
  })

  it('is NOT rate-limited client-side — every click reaches the wire', async () => {
    // Unlike `requestSessionPrStatus`, which bounds an AUTOMATIC caller that
    // re-fires on tab switches. Here every caller is a click, and the daemon
    // throttles the read; a second client-side window would only make a
    // deliberate Refresh silently do nothing.
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent), activeSessionId: 's1', sessionPrThreadsLoading: {} } as never)

    useConnectionStore.getState().requestSessionPrThreads('s1')
    useConnectionStore.getState().requestSessionPrThreads('s1')
    expect(sent).toHaveLength(2)
  })

  it('the socket-drop reset covers the session-keyed loading flag (#6153 family)', () => {
    // A count in flight when the socket died must not leave its control
    // disabled forever — the disabled control cannot issue the request that
    // would clear it.
    //
    // Asserted at SOURCE level, and the reason is worth stating rather than
    // hiding: the reset lives on `socket.onclose`, not on `disconnect()`, and
    // no unit test in this package drives a real close (the sibling
    // `sessionPrStatusLoading` reset is likewise unpinned). A behavioural test
    // written against `disconnect()` would pass for the wrong reason. So this
    // pins the line inside the ONCLOSE region specifically — an anchored slice,
    // never a file-wide grep, which the initial-state declaration would satisfy
    // on its own.
    const src = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')
    const start = src.indexOf('socket.onclose = (event?: CloseEvent) =>')
    expect(start, 'connection.ts should define socket.onclose').toBeGreaterThan(-1)
    const region = src.slice(start, src.indexOf('socket.onerror', start))
    expect(region.length).toBeGreaterThan(0)
    expect(region.includes('sessionPrThreadsLoading: {}')).toBe(true)
  })

  it('positive control: the onclose slice does NOT reach the whole file', () => {
    // Without this, a slice that silently spanned the file would make the
    // assertion above satisfiable by the store's INITIAL-STATE declaration
    // (`sessionPrThreadsLoading: {}` near the top) — the exact line that
    // survives deleting the reset.
    const src = readFileSync(resolve(__dirname, 'connection.ts'), 'utf8')
    const start = src.indexOf('socket.onclose = (event?: CloseEvent) =>')
    const region = src.slice(start, src.indexOf('socket.onerror', start))
    expect(region.includes('requestSessionPrThreads:')).toBe(false)
  })
})
