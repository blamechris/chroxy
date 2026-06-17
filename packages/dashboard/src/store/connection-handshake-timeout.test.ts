/**
 * #5721 (item 2) — client-side handshake timeout (dashboard).
 *
 * The heartbeat does not start until `auth_ok` is processed, so the handshake
 * window (socket OPEN + `auth` sent, awaiting `auth_ok`/`key_exchange_ok`) had
 * no liveness coverage. A dedicated HANDSHAKE_TIMEOUT_MS timer now fires
 * "Handshake failed — reconnecting" and hands off to the normal reconnect ladder
 * instead of a silent stall. These tests drive the production onopen/onmessage/
 * onerror/disconnect paths with a mock socket + fake timers (mirrors
 * connection-encryption-guard.test.ts / connection-reconnect-backoff.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
  clear: () => { for (const k of Object.keys(store)) delete store[k] },
  get length() { return Object.keys(store).length },
  key: (i: number) => Object.keys(store)[i] ?? null,
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
const { HANDSHAKE_TIMEOUT_MS } = await import('./message-handler')

/** Open a connection and walk it through health check + WS construction + onopen. */
async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  for (const k of Object.keys(store)) delete store[k]
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    userDisconnected: false,
    serverErrors: [],
    connectionError: null,
  })
})

afterEach(() => {
  // Make sure no timer (handshake or reconnect-ladder) survives into the next
  // test — module-level timers persist across tests in the same file.
  useConnectionStore.getState().disconnect()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#5721 client-side handshake timeout (dashboard)', () => {
  it('fires after HANDSHAKE_TIMEOUT_MS when no auth_ok arrives, then reconnects', async () => {
    const ws = await openConnected()
    // The auth handshake frame went out…
    expect(ws.sent.some(s => s.includes('"type":"auth"'))).toBe(true)
    expect(ws.closed).toBe(0)

    // …but no auth_ok / key_exchange_ok ever completes it.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)

    // The wedged socket is dropped and the UX shows the reconnecting state.
    expect(ws.closed).toBe(1)
    expect(useConnectionStore.getState().connectionPhase).toBe('reconnecting')
    expect(useConnectionStore.getState().connectionError).toMatch(/Handshake failed/i)

    // It hands off to the normal reconnect ladder — a fresh socket is built.
    const before = MockWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(10_000) // past the (jittered) first rung
    expect(MockWebSocket.instances.length).toBeGreaterThan(before)
  })

  it('clears the timer on auth_ok — no spurious fire on a healthy connect', async () => {
    const ws = await openConnected()
    const socketsBefore = MockWebSocket.instances.length

    // Drive a real auth_ok through the production onmessage path — a healthy
    // handshake completion.
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(useConnectionStore.getState().connectionPhase).toBe('connected')

    // Past the handshake budget (but before the 15s+5s heartbeat reaper that
    // auth_ok started — advancing into that would close the socket for an
    // unrelated reason) — the handshake timer was cleared, so it must NOT fire:
    // the socket stays open, no reconnect socket is built, and the
    // handshake-timeout error never appears.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 2_000)
    expect(ws.closed).toBe(0)
    expect(MockWebSocket.instances.length).toBe(socketsBefore) // no reconnect socket
    expect(useConnectionStore.getState().connectionError ?? '').not.toMatch(/Handshake failed/i)
  })

  it('does not fire after a user-initiated disconnect', async () => {
    const ws = await openConnected()
    const socketsBefore = MockWebSocket.instances.length

    useConnectionStore.getState().disconnect()
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS * 2)

    // disconnect() cleared the timer; it must not close again or reconnect.
    expect(ws.closed).toBeLessThanOrEqual(1) // disconnect itself may close once
    expect(MockWebSocket.instances.length).toBe(socketsBefore)
    expect(useConnectionStore.getState().connectionPhase).not.toBe('reconnecting')
  })

  it('does not schedule a second reconnect when the socket already errored', async () => {
    const ws = await openConnected()
    // A transport error arms the reconnect scheduler first…
    ws.onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    const afterError = MockWebSocket.instances.length

    // …then the handshake timer fires. scheduleReconnect's per-socket dedupe
    // (reconnectScheduler.scheduled) must make this a no-op — exactly one
    // reconnect socket should appear, not two.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(10_000) // let the single scheduled rung fire
    // One new socket from the single scheduled reconnect (not two).
    expect(MockWebSocket.instances.length).toBe(afterError + 1)
  })
})
