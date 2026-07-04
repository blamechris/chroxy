/**
 * #6577 (dashboard) — a token-served dashboard that has a STALE saved
 * `activeServerId` (+ a registry entry whose `wsUrl` is a dead tunnel) must NOT
 * re-dial that dead registry endpoint after `connectLocal()`. It should scope to
 * the local same-origin daemon and, on reconnect, keep dialing the local origin.
 *
 * The issue was filed as a bug but investigation confirmed the behavior is
 * ALREADY correct on main:
 *   - `connectLocal()` sets `activeServerId: null`; the store subscription
 *     persists that via `persistActiveServer(null)`, which `removeItem()`s the
 *     `chroxy_persist_active_server_id` localStorage key.
 *   - The socket-close reconnect path resolves its endpoint through
 *     `resolveActiveEndpoint(url, token)` — with `activeServerId` null it returns
 *     the closure-captured same-origin fallback URL/token, NOT the stale
 *     registry `wsUrl`.
 *
 * This is a REGRESSION LOCK for that correct behavior. Unlike the sibling
 * connection-reconnect-endpoint.test.ts (which forces `getAuthToken` → null),
 * this file mocks the page auth token as TRUTHY so `connectLocal()` actually
 * dials (it early-returns on a null token). A module-level vi.mock can't be
 * flipped per-test, hence the separate file.
 *
 * Mirrors the WebSocket/fetch fake-timer harness from
 * connection-reconnect-endpoint.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// --- localStorage mock (same in-memory shape as the sibling suite) ----------
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

// The one difference from the sibling suite: the page token is TRUTHY, so
// connectLocal() dials instead of early-returning.
vi.mock('../utils/auth', () => ({ getAuthToken: () => 'page-token' }))

// Local same-origin daemon the token-served dashboard is served from.
const LOCAL_HOST = 'localhost:8765'
const LOCAL_WS_URL = `ws://${LOCAL_HOST}/ws` // http: protocol → ws (not wss)
// connectLocal() reads window.location.host/.protocol to build the same-origin
// URL. Overwrite location/window so the origin is deterministic (jsdom's default
// host is unrelated), but CAPTURE the originals and restore them in afterAll so
// this suite can't leak the mutation into other files sharing the Vitest worker.
const _origLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
const _origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'location', {
  value: { host: LOCAL_HOST, protocol: 'http:', href: `http://${LOCAL_HOST}/` },
  writable: true,
  configurable: true,
})
Object.defineProperty(globalThis, 'window', {
  value: globalThis,
  writable: true,
  configurable: true,
})
afterAll(() => {
  if (_origLocation) Object.defineProperty(globalThis, 'location', _origLocation)
  else delete (globalThis as unknown as { location?: unknown }).location
  if (_origWindow) Object.defineProperty(globalThis, 'window', _origWindow)
  else delete (globalThis as unknown as { window?: unknown }).window
})

// Exact production localStorage key names (verified against source):
//   persistence.ts  → const KEY_ACTIVE_SERVER = `${KEY_PREFIX}active_server_id`
//                     with KEY_PREFIX = 'chroxy_persist_'
//   server-registry.ts → const STORAGE_KEY = 'chroxy_server_registry'
const KEY_ACTIVE_SERVER = 'chroxy_persist_active_server_id'
const KEY_SERVER_REGISTRY = 'chroxy_server_registry'

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
const mh = await import('./message-handler')
const { resetReconnectAttempt } = mh

const lastUrl = () =>
  MockWebSocket.instances[MockWebSocket.instances.length - 1]?.url

// The stale saved server: a dead tunnel URL, exactly the kind #6577 feared
// would be re-dialed after connectLocal().
const DEAD_ID = 'srv-dead'
const DEAD_WS_URL = 'wss://dead.trycloudflare.com/ws'
const DEAD_ENTRY = { id: DEAD_ID, name: 'dead-tunnel', wsUrl: DEAD_WS_URL, token: 'dead-token', lastConnectedAt: 0 }

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  for (const k of Object.keys(store)) delete store[k]
  // Baseline: no active server, empty registry, disconnected.
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

/** Seed the STALE state: persisted active-server id + a dead registry entry. */
function seedStaleServer() {
  // Persisted localStorage (the reload-restored view the bug worried about).
  store[KEY_ACTIVE_SERVER] = DEAD_ID
  store[KEY_SERVER_REGISTRY] = JSON.stringify([DEAD_ENTRY])
  // In-memory store: mirror the restored state. Prime the persistence
  // subscription's _prevActiveServerId to DEAD_ID by transitioning through it,
  // so the later connectLocal() null-write is observed as a change → removeItem.
  useConnectionStore.setState({ serverRegistry: [DEAD_ENTRY], activeServerId: DEAD_ID })
}

describe('#6577 — token-served connectLocal() scopes to origin, not a stale dead-tunnel registry entry', () => {
  it('nulls activeServerId and removes the persisted active-server-id key', () => {
    seedStaleServer()
    expect(store[KEY_ACTIVE_SERVER]).toBe(DEAD_ID) // precondition

    useConnectionStore.getState().connectLocal()

    // In-memory scope switched to local.
    expect(useConnectionStore.getState().activeServerId).toBe(null)
    // Persisted active-server-id key was removed (persistActiveServer(null)).
    expect(store[KEY_ACTIVE_SERVER]).toBeUndefined()
    expect(localStorage.getItem(KEY_ACTIVE_SERVER)).toBe(null)
  })

  it('dials the local origin URL, not the dead registry wsUrl', async () => {
    seedStaleServer()
    const before = MockWebSocket.instances.length

    useConnectionStore.getState().connectLocal()
    // connect() health-checks (async) before opening the socket in openSocket().
    await vi.advanceTimersByTimeAsync(0)

    // connectLocal() → connect() opens exactly one socket, at the local origin.
    expect(MockWebSocket.instances.length).toBe(before + 1)
    expect(lastUrl()).toBe(LOCAL_WS_URL)
    expect(lastUrl()).not.toBe(DEAD_WS_URL)
  })

  it('reconnects to the local origin after a socket close, despite the stale registry entry', async () => {
    seedStaleServer()

    // connectLocal() then drive the socket to "connected".
    useConnectionStore.getState().connectLocal()
    await vi.advanceTimersByTimeAsync(0)
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    expect(ws.url).toBe(LOCAL_WS_URL)
    ws.readyState = 1
    ws.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected', userDisconnected: false })

    // Transport drop → the reconnect ladder resolves the endpoint via
    // resolveActiveEndpoint. activeServerId is null, so it returns the
    // closure-captured local origin URL — NOT the stale registry wsUrl.
    ws.onclose?.({ code: 1006 })
    const beforeReconnect = MockWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0])

    expect(MockWebSocket.instances.length).toBe(beforeReconnect + 1)
    expect(lastUrl()).toBe(LOCAL_WS_URL)
    expect(lastUrl()).not.toBe(DEAD_WS_URL)
    // And the stale registry entry is still on disk — we did NOT dial it, we
    // just scoped away from it. Assert the parsed fields (not the raw JSON
    // string, which is brittle to whitespace/key-order/serialization changes).
    const rawRegistry = store[KEY_SERVER_REGISTRY]
    expect(rawRegistry).toBeDefined()
    const persistedRegistry = JSON.parse(rawRegistry as string) as Array<{ id: string; wsUrl: string }>
    expect(persistedRegistry).toHaveLength(1)
    expect(persistedRegistry[0]).toMatchObject({ id: DEAD_ID, wsUrl: DEAD_WS_URL })
  })
})
