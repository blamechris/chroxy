/**
 * #7430 — `requestSessionPrThreads` (the store action) and
 * `session_pr_threads` (the reply handler).
 *
 * Written as one file because the two halves only mean anything together: the
 * action's job is to set a loading flag the handler clears, and the handler's
 * job is to file a reading under the session the ACTION named. A pair of
 * separately-green halves that disagree about the key is the defect this
 * catches.
 *
 * The reply is stored WHOLE, degraded readings included. That is the
 * substantive difference from a survey that drops failures: `reason` +
 * `unresolvedCount: null` IS the payload in that case, and a consumer that
 * received nothing would have to infer — which, next to a green CI chip, means
 * inferring zero.
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

const REPLY = {
  type: 'session_pr_threads',
  requestId: null,
  sessionId: 'sess-1',
  countedAt: '2026-08-28T00:00:00.000Z',
  prNumber: 7419,
  unresolvedCount: 2,
  totalCount: 9,
  truncated: false,
  reason: null,
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
})

describe('#7430 — the session_pr_threads reply', () => {
  async function handle(msg: unknown) {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    return { useConnectionStore, handleMessage }
  }

  it('files the reading under ITS OWN session id and clears that loading flag', async () => {
    const { useConnectionStore, handleMessage } = await handle(REPLY)
    useConnectionStore.setState({
      activeSessionId: 'sess-OTHER',
      sessionPrThreads: {},
      sessionPrThreadsLoading: { 'sess-1': true, 'sess-2': true },
    } as never)

    handleMessage(REPLY as never, useConnectionStore.getState as never, useConnectionStore.setState as never, {} as never)

    const s = useConnectionStore.getState()
    // Filed under sess-1 even though sess-OTHER is active: a reply can land
    // after a tab switch, and one PR's threads must not be shown on another's.
    expect(s.sessionPrThreads['sess-1']).toMatchObject({ unresolvedCount: 2, totalCount: 9 })
    expect(s.sessionPrThreads['sess-OTHER']).toBeUndefined()
    expect(s.sessionPrThreadsLoading).toEqual({ 'sess-2': true })
  })

  it('stores a DEGRADED reading rather than dropping it', async () => {
    // The load-bearing case: silence would leave the previous (or absent)
    // count in place, and a consumer next to a green CI chip would read the
    // absence as "no threads".
    const { useConnectionStore, handleMessage } = await handle(REPLY)
    useConnectionStore.setState({ sessionPrThreads: {}, sessionPrThreadsLoading: { 'sess-1': true } } as never)
    const degraded = { ...REPLY, prNumber: null, unresolvedCount: null, totalCount: null, reason: 'gh CLI not found on PATH' }

    handleMessage(degraded as never, useConnectionStore.getState as never, useConnectionStore.setState as never, {} as never)

    const stored = useConnectionStore.getState().sessionPrThreads['sess-1']
    expect(stored?.reason).toBe('gh CLI not found on PATH')
    expect(stored?.unresolvedCount).toBeNull()
    expect(useConnectionStore.getState().sessionPrThreadsLoading).toEqual({})
  })

  it('drops a reply that is schema-invalid or has no session to attribute it to', async () => {
    const { useConnectionStore, handleMessage } = await handle(REPLY)
    useConnectionStore.setState({ sessionPrThreads: {}, sessionPrThreadsLoading: {} } as never)

    handleMessage({ ...REPLY, sessionId: null } as never, useConnectionStore.getState as never, useConnectionStore.setState as never, {} as never)
    // `truncated` is required and non-optional; a reply missing it is not a
    // reading this store can reason about.
    handleMessage({ ...REPLY, truncated: undefined } as never, useConnectionStore.getState as never, useConnectionStore.setState as never, {} as never)
    // A fabricated NEGATIVE count would be a schema violation, not a reading.
    handleMessage({ ...REPLY, unresolvedCount: -1 } as never, useConnectionStore.getState as never, useConnectionStore.setState as never, {} as never)

    expect(useConnectionStore.getState().sessionPrThreads).toEqual({})
  })

  it('positive control: the same handler DOES store a well-formed reply', async () => {
    // Guards the three negatives above against passing because the message
    // never reached the handler at all.
    const { useConnectionStore, handleMessage } = await handle(REPLY)
    useConnectionStore.setState({ sessionPrThreads: {}, sessionPrThreadsLoading: {} } as never)
    handleMessage(REPLY as never, useConnectionStore.getState as never, useConnectionStore.setState as never, {} as never)
    expect(Object.keys(useConnectionStore.getState().sessionPrThreads)).toEqual(['sess-1'])
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
    // never a file-wide grep, which the `sessionPrStatusLoading` line above it
    // would satisfy on its own.
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
