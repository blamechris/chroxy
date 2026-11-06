/**
 * #9046 — with `--no-auth` the dashboard connects with an empty token. Two store
 * paths used to treat that as "no credential":
 *  - a successful empty-token connect overwrote a real saved token for the URL;
 *  - the wake-from-hidden reconnect required a truthy token, so it never fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const lsStore: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v },
    removeItem: (k: string) => { delete lsStore[k] },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
    get length() { return Object.keys(lsStore).length },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
  },
  writable: true,
})
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send() {}
  close() { this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }))

const { useConnectionStore } = await import('./connection')
const { loadConnection, saveConnection } = await import('./message-handler')

const URL_ = `ws://${window.location.host}/ws`

async function connectAndAuth(token: string): Promise<void> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(URL_, token)
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  window.sessionStorage.clear()
  localStorage.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  useConnectionStore.setState({
    serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected',
    wsUrl: null, userDisconnected: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('saved connection vs empty token (#9046)', () => {
  it('does not overwrite a real saved token when an empty-token connect succeeds', async () => {
    saveConnection(URL_, 'real-saved-token')
    await connectAndAuth('')
    expect(useConnectionStore.getState().connectionPhase).toBe('connected')
    expect(loadConnection()).toEqual({ url: URL_, token: 'real-saved-token' })
  })

  it('still saves a real token on connect (auth on is unchanged)', async () => {
    saveConnection(URL_, 'old-token')
    await connectAndAuth('new-token')
    expect(loadConnection()).toEqual({ url: URL_, token: 'new-token' })
  })
})

describe('wake reconnect (#9046)', () => {
  function wakeWithStaleSocket(apiToken: string | null) {
    const connect = vi.fn()
    const stale = { readyState: 3, close() {}, send() {} }
    useConnectionStore.setState({
      connectionPhase: 'connected', socket: stale as unknown as WebSocket,
      wsUrl: URL_, apiToken, connect,
    } as never)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    return connect
  }

  it('reconnects at once with an empty token', () => {
    expect(wakeWithStaleSocket('')).toHaveBeenCalledWith(URL_, '')
  })

  it('reconnects with a real token', () => {
    expect(wakeWithStaleSocket('tok')).toHaveBeenCalledWith(URL_, 'tok')
  })

  it('does not reconnect with no token at all', () => {
    expect(wakeWithStaleSocket(null)).not.toHaveBeenCalled()
  })
})
