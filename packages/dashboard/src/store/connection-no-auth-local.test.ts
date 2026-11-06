/**
 * #9033 — a dashboard served by a `--no-auth` daemon has no page token, yet must
 * still connect to its own origin. The daemon says so in the chroxy-config meta
 * (`authRequired: false`). With auth ON and no token the dashboard stays
 * disconnected, exactly as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

const store: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  },
  writable: true,
})

// No page token: neither ?token= nor the cookie.
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

const LOCAL_HOST = 'localhost:9999'
const _origLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
Object.defineProperty(globalThis, 'location', {
  value: { host: LOCAL_HOST, protocol: 'http:', href: `http://${LOCAL_HOST}/` },
  writable: true,
  configurable: true,
})
afterAll(() => {
  if (_origLocation) Object.defineProperty(globalThis, 'location', _origLocation)
  else delete (globalThis as unknown as { location?: unknown }).location
})

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore } = await import('./connection')
const { resetReconnectAttempt } = await import('./message-handler')

function setConfig(content: string | null) {
  document.head.querySelectorAll('meta[name="chroxy-config"]').forEach(m => m.remove())
  if (content === null) return
  const m = document.createElement('meta')
  m.setAttribute('name', 'chroxy-config')
  m.setAttribute('content', content)
  document.head.appendChild(m)
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  setConfig(null)
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    userDisconnected: false,
  })
})

afterEach(() => {
  setConfig(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#9033 — connectLocal() without a page token', () => {
  it('dials the local origin when the server says auth is off', async () => {
    setConfig('{"port":9999,"noEncrypt":false,"authRequired":false}')
    useConnectionStore.getState().connectLocal()
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWebSocket.instances.length).toBe(1)
    expect(MockWebSocket.instances[0]!.url).toBe(`ws://${LOCAL_HOST}/ws`)
  })

  it('does not dial when auth is required and there is no token', async () => {
    setConfig('{"port":9999,"noEncrypt":false,"authRequired":true}')
    useConnectionStore.getState().connectLocal()
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWebSocket.instances.length).toBe(0)
    expect(useConnectionStore.getState().connectionPhase).toBe('disconnected')
  })

  it('does not dial when the page carries no config at all', async () => {
    useConnectionStore.getState().connectLocal()
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWebSocket.instances.length).toBe(0)
  })

  it('retryConnection also dials the local origin under --no-auth', async () => {
    setConfig('{"authRequired":false}')
    useConnectionStore.getState().retryConnection()
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWebSocket.instances.length).toBe(1)
    expect(MockWebSocket.instances[0]!.url).toBe(`ws://${LOCAL_HOST}/ws`)
  })
})
