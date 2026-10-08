/**
 * #8485 — a frame delivered by a SUPERSEDED socket must not touch the store.
 *
 * `disconnect()` only nulled `socket.onclose`, and `connect()` retired only the
 * socket the store already held (`socket` is written at `auth_ok`, so a socket
 * still mid-handshake was invisible to it). Nothing in `dispatchFrame` checks
 * that a frame came from the CURRENT socket, so a late `credentials_status` from
 * daemon A, delivered after daemon B's `auth_ok`, overwrote B's state — and a
 * late `encrypted` envelope also advanced B's receive nonce.
 *
 * A closing browser WebSocket should not deliver messages, but that is
 * unverified, and the same holds for a frame already queued on the event loop.
 * These tests hold on to each superseded socket's handler and invoke it AFTER
 * the new socket authenticated: the worst case, driven through the real store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const lsStore: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = v },
  removeItem: (k: string) => { delete lsStore[k] },
  clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
  get length() { return Object.keys(lsStore).length },
  key: (i: number) => Object.keys(lsStore)[i] ?? null,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  sent: string[] = []
  closed = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed += 1; this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok' }),
}))

const { useConnectionStore } = await import('./connection')
const mh = await import('./message-handler')

type Handler = (e: { data: string }) => void

const URL_A = 'wss://daemon-a.example.com/ws'
const URL_B = 'wss://daemon-b.example.com/ws'

/** Open a socket for `url` and run it through onopen. */
async function open(url: string): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(url, 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  return ws
}

async function authOk(ws: MockWebSocket): Promise<void> {
  ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
  await vi.advanceTimersByTimeAsync(0)
}

function credentialsFrame(label: string) {
  return {
    data: JSON.stringify({
      type: 'credentials_status',
      credentials: [{ key: 'ANTHROPIC_API_KEY', provider: 'anthropic', label, kind: 'api-key', status: 'set', source: 'store', masked: 'sk-…AAAA', oauth: false }],
      fileExists: true,
    }),
  }
}

function credentialLabel(): string | null {
  return useConnectionStore.getState().credentialsStatus?.credentials[0]?.label ?? null
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  mh.resetReconnectAttempt()
  for (const k of Object.keys(lsStore)) delete lsStore[k]
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    socket: null,
    userDisconnected: false,
    serverErrors: [],
    connectionError: null,
    credentialsStatus: null,
  })
})

afterEach(() => {
  useConnectionStore.getState().disconnect()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#8485 a superseded socket cannot write to the new connection', () => {
  it('control: the CURRENT socket still delivers frames', async () => {
    const a = await open(URL_A)
    await authOk(a)
    a.onmessage?.(credentialsFrame('from-A'))
    expect(credentialLabel()).toBe('from-A')
  })

  it('a late frame from A, after a switch to B has authenticated, leaves B alone', async () => {
    const a = await open(URL_A)
    await authOk(a)
    const lateA = a.onmessage as Handler // the handler the socket held before the switch

    const b = await open(URL_B)
    await authOk(b)
    expect(useConnectionStore.getState().wsUrl).toBe(URL_B)
    b.onmessage?.(credentialsFrame('from-B'))
    expect(credentialLabel()).toBe('from-B')

    lateA(credentialsFrame('from-A'))
    expect(credentialLabel()).toBe('from-B')
  })

  it('a socket still MID-HANDSHAKE when the user switches is retired too', async () => {
    // The store's `socket` is written at auth_ok, so connect() cannot find A there.
    const a = await open(URL_A)
    const lateA = a.onmessage as Handler

    const b = await open(URL_B)
    await authOk(b)
    expect(useConnectionStore.getState().wsUrl).toBe(URL_B)

    // A's late auth_ok must not re-run the handshake against B's state…
    lateA({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'terminal' }) })
    expect(useConnectionStore.getState().wsUrl).toBe(URL_B)
    expect(useConnectionStore.getState().socket).toBe(b)
    // …and its socket was closed rather than left half-open.
    expect(a.closed).toBeGreaterThanOrEqual(1)
  })

  it('same-daemon reconnect: a late frame from the dropped socket leaves the new one alone', async () => {
    const a = await open(URL_A)
    await authOk(a)
    const lateA = a.onmessage as Handler

    // Transport drop on A; onclose (still the CURRENT socket's) schedules the reconnect.
    a.readyState = 3
    a.onclose?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(useConnectionStore.getState().connectionPhase).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(10_000) // past the first reconnect rung
    const b = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    expect(b).not.toBe(a)
    b.readyState = 1
    b.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    await authOk(b)
    b.onmessage?.(credentialsFrame('from-B'))
    expect(credentialLabel()).toBe('from-B')

    lateA(credentialsFrame('from-A'))
    expect(credentialLabel()).toBe('from-B')
  })

  it('a late encrypted envelope from A does not advance the new connection\'s receive nonce', async () => {
    const a = await open(URL_A)
    const lateA = a.onmessage as Handler
    const b = await open(URL_B)
    await authOk(b)

    // Simulate B having completed its key exchange.
    mh.setEncryptionState({ sharedKey: new Uint8Array(32), sendNonce: 0, recvNonce: 0 } as never)
    lateA({ data: JSON.stringify({ type: 'encrypted', d: 'AAAA', n: 0 }) })
    expect(mh.getEncryptionState()?.recvNonce).toBe(0)
    // A's decrypt failure must not have closed B either.
    expect(b.closed).toBe(0)
  })

  it('disconnect() retires the socket: a late frame afterwards changes nothing', async () => {
    const a = await open(URL_A)
    await authOk(a)
    const lateA = a.onmessage as Handler

    useConnectionStore.getState().disconnect()
    expect(a.onmessage).toBeNull()
    expect(a.onerror).toBeNull()
    expect(a.onclose).toBeNull()

    lateA(credentialsFrame('from-A'))
    expect(credentialLabel()).toBeNull()
  })

  it('disconnect() retires a socket that never authenticated', async () => {
    const a = await open(URL_A)
    useConnectionStore.getState().disconnect()
    expect(a.closed).toBeGreaterThanOrEqual(1)
    expect(a.onmessage).toBeNull()
    expect(a.onopen).toBeNull()
  })

  it('the CURRENT socket\'s onclose still drives auto-reconnect after another switch', async () => {
    const a = await open(URL_A)
    await authOk(a)
    const b = await open(URL_B)
    await authOk(b)
    const before = MockWebSocket.instances.length

    b.readyState = 3
    b.onclose?.()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances.length).toBe(before + 1)
  })
})
