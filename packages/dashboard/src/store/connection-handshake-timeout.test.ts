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
import { PONG_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from '@chroxy/store-core'

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
// Namespace import so `mh.reconnectAttempt` reflects the live module-level
// counter — destructuring a `let` export copies the value at import time and
// would always read 0 (mirrors connection-reconnect-backoff.test.ts).
const mh = await import('./message-handler')
const { HANDSHAKE_TIMEOUT_MS } = mh

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
  mh.resetReconnectAttempt() // deterministic backoff ladder per test (#6066)
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
    // A transport error schedules a reconnect AND clears the handshake timer
    // (onerror's teardown clear), so the timeout window is now a no-op…
    ws.onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    const afterError = MockWebSocket.instances.length

    // …advancing past the handshake budget adds nothing (the timer was cleared;
    // and even if it weren't, scheduleReconnect's per-socket `scheduled` dedupe
    // would suppress a second reconnect). Exactly one reconnect socket appears.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(10_000) // let the single scheduled rung fire
    expect(MockWebSocket.instances.length).toBe(afterError + 1)
  })
})

// ---------------------------------------------------------------------------
// #6066 — real-socket reconnect-parity validation after the #6065 connection-
// runtime extraction. These exercise the SAME shared controller as the cases
// above, but at the real-socket integration level (drive onopen/onmessage/
// onclose through connect()), asserting the timer mechanics survive the
// extraction without behavior drift.
// ---------------------------------------------------------------------------
describe('#6066 reconnect parity (real socket, dashboard)', () => {
  // (1) The stale handshake timer from the FIRST socket must not also fire after
  //     a reconnect re-enters onopen and re-arms it — exactly one reconnect per
  //     window, not two.
  it('handshake timeout does not double-fire on reconnect re-entry', async () => {
    const first = await openConnected()

    // First handshake times out → close + scheduled reconnect.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
    expect(first.closed).toBe(1)

    // The reconnect rung fires and builds a fresh socket, whose onopen re-arms
    // the handshake timer (clearHandshakeTimer-then-set, so the stale first timer
    // can never also fire).
    const afterFirstTimeout = MockWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances.length).toBe(afterFirstTimeout + 1)
    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    second.readyState = 1
    second.onopen?.()
    await vi.advanceTimersByTimeAsync(0)

    // Advance one full handshake window: the SECOND timer fires once → exactly
    // one further reconnect socket. A surviving stale first timer would schedule
    // a second reconnect in this same window.
    const beforeSecondTimeout = MockWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(10_000) // let the (single) scheduled rung fire
    expect(MockWebSocket.instances.length).toBe(beforeSecondTimeout + 1) // one, not two
  })

  // (2) BLACK BOX: once connected+authed, an unanswered ping → pong-timeout
  //     reaper closes the dead socket and STOPS the heartbeat (no further pings).
  //     Asserted purely via observable behavior — socket.close() (ws.closed) and
  //     the send count — with no reliance on any exposed internal
  //     `isHeartbeatRunning` flag (no source change).
  it('pong timeout closes the dead socket and stops the heartbeat', async () => {
    const ws = await openConnected()

    // Complete the handshake so the heartbeat starts (it does NOT start before
    // auth_ok). Past this point pings flow on HEARTBEAT_INTERVAL_MS.
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.closed).toBe(0)

    // Baseline the send count AFTER auth_ok settles (auth_ok triggers list_*
    // requests), then advance one heartbeat interval → exactly one ping is sent.
    const sendsAfterAuth = ws.sent.length
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    const sendsAfterFirstPing = ws.sent.length
    expect(sendsAfterFirstPing).toBe(sendsAfterAuth + 1) // the ping went out

    // Do NOT answer the pong; advance past the pong timeout → the reaper closes
    // the dead socket.
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS)
    expect(ws.closed).toBe(1)

    // The heartbeat is stopped: advancing two more intervals sends nothing more
    // (observable proof, no internal-flag peek).
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    expect(ws.sent.length).toBe(sendsAfterFirstPing)
  })

  // (3) The backoff ladder ADVANCES when the reconnect is triggered by a
  //     handshake timeout (not just by a socket close/error). A socket that opens
  //     but never authenticates keeps climbing the ladder.
  it('backoff ladder advances on a handshake-timeout-triggered reconnect', async () => {
    await openConnected()
    expect(mh.reconnectAttempt).toBe(0) // fresh ladder (reset in beforeEach)

    // First handshake never completes → the timeout schedules a reconnect that
    // burns rung 0.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(10_000) // rung 0 (1000ms) fires → fresh socket
    expect(mh.reconnectAttempt).toBe(1) // advanced past rung 0

    // The reconnect socket opens but again never authenticates → its handshake
    // also times out and burns rung 1.
    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    second.readyState = 1
    second.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(10_000) // rung 1 (2000ms) fires
    expect(mh.reconnectAttempt).toBe(2) // climbed again on a handshake-timeout reconnect
  })

  // (4) No fake timer survives a user-initiated disconnect() — the handshake
  //     timer, the heartbeat interval, and the pong-timeout are all cleared, so
  //     nothing leaks into the next test.
  it('leaves no pending timer after disconnect()', async () => {
    const ws = await openConnected()
    // Authenticate so the heartbeat interval is also live (the richest timer set:
    // handshake cleared by auth_ok, heartbeat interval armed, pong-timeout armed
    // after a ping).
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS) // arm the pong-timeout too
    expect(vi.getTimerCount()).toBeGreaterThan(0) // timers live pre-disconnect

    useConnectionStore.getState().disconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0) // every timer cleared — no leak
  })
})
