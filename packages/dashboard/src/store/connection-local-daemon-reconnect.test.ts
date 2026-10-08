/**
 * #8268 — a dashboard served BY the daemon it talks to keeps retrying with no cap.
 *
 * After a daemon update the window sat on "Disconnected" until the user clicked the
 * server entry: the daemon takes minutes to come back and the client gave up after
 * ~20 s (the health-probe ladder, #5698) or ~60 s (the socket reconnect ladder).
 * That cap is deliberate for the mobile app and for a registry server, so the control
 * cases below pin that a remote target is still capped.
 *
 * "Served by" is same origin, and jsdom's page is http://localhost:3000.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RECONNECT_MAX_RUNG } from '@chroxy/store-core'

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

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) })
const downFetch = async () => { throw new TypeError('Failed to fetch') }
const setFetch = (fn: unknown) => { (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(fn as () => Promise<unknown>) }

const { useConnectionStore } = await import('./connection')
const realClearSavedConnection = useConnectionStore.getState().clearSavedConnection
const { resetReconnectAttempt } = await import('./message-handler')

const OWN = `ws://${window.location.host}/ws`
const REMOTE = 'wss://other-host.example.com/ws'

async function openConnected(url: string): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(url, 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  useConnectionStore.setState({ connectionPhase: 'connected', userDisconnected: false })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  setFetch(okFetch)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useConnectionStore.setState({
    serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected',
    wsUrl: null, userDisconnected: false, connectionError: null,
    reconnectUncapped: false, reconnectRetryAt: null,
  })
})

afterEach(() => {
  useConnectionStore.setState({ clearSavedConnection: realClearSavedConnection })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the daemon that served this page is retried with no cap (#8268)', () => {
  it('the socket-close ladder never goes server_down, however many rungs it climbs', async () => {
    await openConnected(OWN)
    expect(useConnectionStore.getState().reconnectUncapped).toBe(true)
    // Past the point where a registry server gives up (RECONNECT_MAX_RUNG rungs).
    for (let i = 0; i < RECONNECT_MAX_RUNG + 8; i++) {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
      const before = MockWebSocket.instances.length
      socket.onclose?.({ code: 1006 })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(MockWebSocket.instances.length, `a reconnect socket after drop ${i + 1}`).toBe(before + 1)
      const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
      next.onopen?.() // opened, never authenticated: the ladder keeps climbing
      await vi.advanceTimersByTimeAsync(0)
      useConnectionStore.setState({ connectionPhase: 'connected' })
      expect(useConnectionStore.getState().connectionPhase).not.toBe('server_down')
    }
  })

  it('a daemon that stays down for many minutes never lands on "Disconnected", and the window reconnects by itself when it returns', async () => {
    setFetch(downFetch)
    useConnectionStore.getState().connect(OWN, 'tok')
    // 10 minutes: the capped probe ladder gives up after ~20 s.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).not.toBe('disconnected')
    expect(s.connectionPhase).toBe('reconnecting')
    expect(MockWebSocket.instances.length).toBe(0)
    // The next attempt is armed and visible.
    expect(s.reconnectRetryAt).not.toBeNull()

    // The daemon comes back: the very next probe succeeds and a socket opens, no click.
    // After 10 minutes the ladder has backed off to its 30 s tail.
    setFetch(okFetch)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(MockWebSocket.instances.length).toBe(1)
    expect(MockWebSocket.instances[0]!.url).toBe(OWN)
  })

  // beforeEach pins Math.random to 0, so the ladder's 0-50% jitter is ZERO here and the
  // 8 s rung is exactly 8 s. With real jitter the wait can reach ~12 s (#8385); this
  // test pins the base delay, not the worst case.
  it('with jitter pinned to zero, finds a daemon that returns within the first minutes within the 8 s base delay', async () => {
    expect(Math.random()).toBe(0)
    setFetch(downFetch)
    useConnectionStore.getState().connect(OWN, 'tok')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances.length).toBe(0)
    setFetch(okFetch)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(MockWebSocket.instances.length).toBe(1)
  })

  it('backs off to a slow tail on a long outage instead of probing every 8 s for ever', async () => {
    const probes = vi.fn(downFetch)
    ;(globalThis as unknown as { fetch: unknown }).fetch = probes
    useConnectionStore.getState().connect(OWN, 'tok')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const before = probes.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const inSecondTenMinutes = probes.mock.calls.length - before
    // 30 s apart: ~20. The unbacked-off 8 s ladder would make ~75.
    expect(inSecondTenMinutes).toBeGreaterThanOrEqual(15)
    expect(inSecondTenMinutes).toBeLessThanOrEqual(25)
  })

  it('a 401/403 probe ends the ladder with the auth error and KEEPS the saved connection (#8385)', async () => {
    for (const status of [401, 403]) {
      MockWebSocket.instances = []
      const probes = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }))
      ;(globalThis as unknown as { fetch: unknown }).fetch = probes
      const cleared = vi.fn()
      useConnectionStore.setState({ connectionPhase: 'disconnected', connectionError: null, clearSavedConnection: cleared })
      useConnectionStore.getState().connect(OWN, 'tok')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      const s = useConnectionStore.getState()
      expect(probes, `HTTP ${status}: probed once, never retried`).toHaveBeenCalledTimes(1)
      expect(s.connectionPhase).toBe('disconnected')
      expect(s.connectionError).toBe(`The server at this address refused the connection (HTTP ${status}) — check the address and token`)
      expect(s.reconnectRetryAt).toBeNull()
      expect(MockWebSocket.instances.length).toBe(0)
      expect(cleared).not.toHaveBeenCalled()
    }
  })

  it('arms a visible retry time on each drop (what the banner counts down to)', async () => {
    const ws = await openConnected(OWN)
    const t0 = Date.now()
    ws.onclose?.({ code: 1006 })
    // Rung 0 with zero jitter is 1000 ms.
    expect(useConnectionStore.getState().reconnectRetryAt).toBe(t0 + 1000)
  })
})

describe('a target this page did not come from keeps the cap (#5698, #5725)', () => {
  it('a 401 probe is still retried up to the cap, then "Could not reach server" (unchanged)', async () => {
    const probes = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    ;(globalThis as unknown as { fetch: unknown }).fetch = probes
    const cleared = vi.fn()
    useConnectionStore.setState({ clearSavedConnection: cleared })
    useConnectionStore.getState().connect(REMOTE, 'tok')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(probes).toHaveBeenCalledTimes(6)
    expect(useConnectionStore.getState().connectionError).toBe('Could not reach server')
    // The capped path's give-up still clears the saved connection (unchanged by #8385).
    expect(cleared).toHaveBeenCalledTimes(1)
  })

  it('the probe ladder still ends on "Disconnected" with "Could not reach server"', async () => {
    setFetch(downFetch)
    useConnectionStore.getState().connect(REMOTE, 'tok')
    expect(useConnectionStore.getState().reconnectUncapped).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).toBe('disconnected')
    expect(s.connectionError).toBe('Could not reach server')
  })

  it('the socket-close ladder still goes server_down after RECONNECT_MAX_RUNG rungs', async () => {
    await openConnected(REMOTE)
    let cycles = 0
    for (; cycles < RECONNECT_MAX_RUNG + 3; cycles++) {
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
      const before = MockWebSocket.instances.length
      socket.onclose?.({ code: 1006 })
      await vi.advanceTimersByTimeAsync(20_000)
      if (MockWebSocket.instances.length === before) break
      const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
      next.onopen?.()
      await vi.advanceTimersByTimeAsync(0)
      useConnectionStore.setState({ connectionPhase: 'connected' })
    }
    expect(cycles).toBe(RECONNECT_MAX_RUNG)
    expect(useConnectionStore.getState().connectionPhase).toBe('server_down')
  })
})

describe('uncapped is judged per attempt, not fixed for the ladder (#8268)', () => {
  it('a registry entry repointed from a remote host to this origin mid-ladder stops being capped', async () => {
    setFetch(downFetch)
    const entry = { id: 'srv1', name: 'x', wsUrl: REMOTE, token: 'tok', lastConnectedAt: null }
    useConnectionStore.setState({ serverRegistry: [entry as never], activeServerId: 'srv1' })
    useConnectionStore.getState().connect(REMOTE, 'tok')
    // Two attempts in, the entry is repointed at the daemon that served this page.
    await vi.advanceTimersByTimeAsync(4_000)
    useConnectionStore.setState({ serverRegistry: [{ ...entry, wsUrl: OWN } as never] })
    // The capped ladder would have given up ("Disconnected") after ~20 s.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const s = useConnectionStore.getState()
    expect(s.connectionPhase).not.toBe('disconnected')
    expect(s.reconnectUncapped).toBe(true)
  })
})
