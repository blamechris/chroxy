/**
 * #5555.5 — reconnect backoff on the socket-close/error path (dashboard).
 *
 * The close/error handlers used to schedule reconnects at a FIXED delay
 * (AUTO_RECONNECT_DELAY=1500ms / ERROR_RECONNECT_DELAY=2000ms). They now climb
 * the shared RETRY_DELAYS ladder ([1000, 2000, 3000, 5000, 8000], jittered) via
 * a module-level counter that RESETS on `auth_ok` (a successful connect), NOT on
 * mere socket-open.
 *
 * Math.random is pinned to 0 so withJitter() is the identity and each rung's
 * delay is exactly RETRY_DELAYS[N]. Mirrors the WebSocket/fetch mock harness in
 * connection-pairing.test.ts, with fake timers so we can assert exact delays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RECONNECT_MAX_RUNG } from '@chroxy/store-core'

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

const RETRY_DELAYS: [number, number, number, number, number] = [1000, 2000, 3000, 5000, 8000]

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
// Import the namespace (not a destructured binding) so `mh.reconnectAttempt`
// reflects the live module-level counter — destructuring a `let` export copies
// the value at import time and would always read 0.
const mh = await import('./message-handler')
const { resetReconnectAttempt, nextReconnectAttempt } = mh

/**
 * Open a connection, walk it through the health check + WS handshake, and mark
 * it connected so a subsequent onclose takes the auto-reconnect branch.
 * Returns the freshly opened socket.
 */
async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
  // Flush the health-check fetch (microtasks) so the WS is constructed.
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.readyState = 1
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  useConnectionStore.setState({ connectionPhase: 'connected', userDisconnected: false })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  vi.spyOn(Math, 'random').mockReturnValue(0) // zero jitter
  // Silence the per-cycle reconnect logging. These tests drive many
  // close→reconnect cycles (the #5698 give-up test alone runs 11), and that
  // console.log volume races vitest's onUserConsoleLog RPC at worker teardown
  // ("Closing rpc while onUserConsoleLog was pending"), surfacing as a flaky
  // EnvironmentTeardownError in CI even though every test passes. Restored by
  // vi.restoreAllMocks() in afterEach.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const k of Object.keys(store)) delete store[k]
  useConnectionStore.setState({
    serverRegistry: [],
    activeServerId: null,
    connectionPhase: 'disconnected',
    wsUrl: null,
    userDisconnected: false,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Ladder math
// ---------------------------------------------------------------------------

describe('reconnect backoff ladder counter (#5555.5)', () => {
  it('nextReconnectAttempt advances and resetReconnectAttempt rewinds', () => {
    expect(mh.reconnectAttempt).toBe(0)
    expect(nextReconnectAttempt()).toBe(0)
    expect(nextReconnectAttempt()).toBe(1)
    resetReconnectAttempt()
    expect(mh.reconnectAttempt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// End-to-end close-path backoff
// ---------------------------------------------------------------------------

describe('socket-close reconnect backoff (#5555.5)', () => {
  /**
   * Drives one drop → reconnect cycle and asserts the reconnect fires at exactly
   * `expectedDelay` ms (no sooner). Marks the new socket connected for reuse.
   */
  async function expectReconnectAt(expectedDelay: number) {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    const before = MockWebSocket.instances.length

    socket.onclose?.({ code: 1006 })

    // One tick short: no reconnect yet.
    await vi.advanceTimersByTimeAsync(expectedDelay - 1)
    expect(MockWebSocket.instances.length).toBe(before)

    // Cross the boundary: connect() → fetch → new socket.
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances.length).toBe(before + 1)

    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    next.readyState = 1
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })
  }

  it('escalates through the RETRY_DELAYS ladder across consecutive drops', async () => {
    await openConnected()
    await expectReconnectAt(RETRY_DELAYS[0])
    await expectReconnectAt(RETRY_DELAYS[1])
    await expectReconnectAt(RETRY_DELAYS[2])
    await expectReconnectAt(RETRY_DELAYS[3])
  })

  it('caps at the top rung (8000ms) once the ladder is exhausted', async () => {
    await openConnected()
    await expectReconnectAt(RETRY_DELAYS[0])
    await expectReconnectAt(RETRY_DELAYS[1])
    await expectReconnectAt(RETRY_DELAYS[2])
    await expectReconnectAt(RETRY_DELAYS[3])
    await expectReconnectAt(RETRY_DELAYS[4])
    await expectReconnectAt(RETRY_DELAYS[4]) // clamps
  })

  it('a user-disconnect short-circuit does NOT burn a ladder rung', async () => {
    const ws = await openConnected()
    // Mark a user disconnect: scheduleReconnect returns before advancing the ladder.
    useConnectionStore.setState({ userDisconnected: true })
    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[4])
    expect(mh.reconnectAttempt).toBe(0) // never advanced
  })
})

// ---------------------------------------------------------------------------
// Reset-on-auth_ok (NOT on socket-open)
// ---------------------------------------------------------------------------

describe('backoff ladder resets on auth_ok, not socket-open (#5555.5)', () => {
  it('a successful auth_ok rewinds the ladder back to the bottom rung', async () => {
    const s0 = await openConnected()

    s0.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]) // rung 0 fires
    const s1 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    s1.readyState = 1
    s1.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })

    s1.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]) // rung 1 fires
    const s2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    s2.readyState = 1
    s2.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(mh.reconnectAttempt).toBe(2) // climbed, not yet reset

    // Drive a real auth_ok through the production onmessage path.
    s2.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(mh.reconnectAttempt).toBe(0) // auth_ok reset it
  })

  it('socket-open alone does NOT reset the ladder (only auth_ok does)', async () => {
    const s0 = await openConnected()

    s0.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]) // rung 0 fires
    const s1 = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    s1.readyState = 1
    s1.onopen?.() // opened but never authenticated
    await vi.advanceTimersByTimeAsync(0)
    expect(mh.reconnectAttempt).toBe(1) // NOT reset by socket-open
  })
})

// ---------------------------------------------------------------------------
// #5698 — ladder gives up → terminal server_down + manual-retry recovery
// ---------------------------------------------------------------------------

describe('reconnect ladder gives up → server_down (#5698)', () => {
  // Drive one drop. If a reconnect socket is created, mark it connected (but
  // never auth_ok, so the ladder keeps climbing) and return true; if the ladder
  // gave up (no new socket), return false.
  async function driveDrop(): Promise<boolean> {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    const before = MockWebSocket.instances.length
    socket.onclose?.({ code: 1006 })
    // Advance well past the top rung so any armed timer fires.
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[4] * 2)
    if (MockWebSocket.instances.length === before) return false // gave up
    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    next.readyState = 1
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })
    return true
  }

  it('goes terminal after RECONNECT_MAX_RUNG failed reconnects and a manual retry resets the ladder', async () => {
    await openConnected()
    let cycles = 0
    while (await driveDrop()) {
      cycles++
      if (cycles > RECONNECT_MAX_RUNG + 2) throw new Error('ladder never gave up')
    }
    // The ladder armed rungs 0..RECONNECT_MAX_RUNG-1 (that many reconnects), then
    // the next drop hit the cap and gave up instead of arming.
    expect(cycles).toBe(RECONNECT_MAX_RUNG)
    expect(useConnectionStore.getState().connectionPhase).toBe('server_down')

    // A user-initiated retry resets the ladder (resetReconnectAttempt runs even
    // though the local-daemon connect no-ops here — getAuthToken is mocked null).
    useConnectionStore.getState().retryConnection()
    expect(mh.reconnectAttempt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// #5731 T4 — onclose clears transient streaming/plan state for EVERY session,
// not just the active one (a background tab mid-stream otherwise keeps a
// phantom "thinking" bubble that handleSessionSwitched surfaces on tab switch).
// ---------------------------------------------------------------------------

describe('onclose clears transient state across all sessions (#5731 T4)', () => {
  it('nulls streamingMessageId / plan / inactivity on background sessions too', async () => {
    const ws = await openConnected()

    // Active session "a" and a background session "b", both mid-stream, with
    // a pending plan + inactivity chip on the background session.
    useConnectionStore.setState({
      activeSessionId: 'a',
      streamingMessageId: 'msg-a',
      sessionStates: {
        a: {
          messages: [],
          streamingMessageId: 'msg-a',
          isPlanPending: false,
          planAllowedPrompts: [],
          pendingEvaluatorClarify: null,
          inactivityWarning: null,
        },
        b: {
          messages: [],
          streamingMessageId: 'msg-b',
          isPlanPending: true,
          planAllowedPrompts: ['go'],
          pendingEvaluatorClarify: { question: 'why?' },
          inactivityWarning: { sinceMs: 1 },
        },
      } as never,
    })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)

    const st = useConnectionStore.getState()
    // Active session cleared (and its flat mirror).
    expect(st.sessionStates.a!.streamingMessageId).toBeNull()
    expect(st.streamingMessageId).toBeNull()
    // Background session cleared too — the bug was that it stayed set.
    expect(st.sessionStates.b!.streamingMessageId).toBeNull()
    expect(st.sessionStates.b!.isPlanPending).toBe(false)
    expect(st.sessionStates.b!.planAllowedPrompts).toEqual([])
    expect(st.sessionStates.b!.pendingEvaluatorClarify).toBeNull()
    expect(st.sessionStates.b!.inactivityWarning).toBeNull()
  })
})
