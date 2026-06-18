/**
 * #5597 (dashboard) — the connect/reconnect path re-resolves its endpoint from
 * the ACTIVE registry entry per attempt, instead of dialing the closure-captured
 * URL forever.
 *
 * The dashboard already re-read the registry TOKEN per reconnect (#5281); this
 * mirrors that for the URL. A registry entry whose `wsUrl` was repointed
 * mid-ladder (another tab edited it, or a rotated endpoint was written back) is
 * dialed on the next reconnect/health-check retry, not the dead captured URL.
 *
 * Mirrors the WebSocket/fetch fake-timer harness from
 * connection-reconnect-backoff.test.ts.
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

/** Connect via a registry server and walk to "connected". Returns the socket. */
async function openConnectedServer(serverId: string, wsUrl: string, token: string) {
  const before = MockWebSocket.instances.length
  useConnectionStore.setState({
    serverRegistry: [{ id: serverId, name: 's', wsUrl, token, lastConnectedAt: 0 }],
    activeServerId: serverId,
  })
  useConnectionStore.getState().connect(wsUrl, token)
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
  vi.spyOn(Math, 'random').mockReturnValue(0)
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

describe('#5597 — socket-close reconnect re-reads the active registry wsUrl', () => {
  it('dials the repointed wsUrl on the next reconnect, not the captured URL', async () => {
    const OLD = 'wss://old.example.com/ws'
    const NEW = 'wss://new.example.com/ws'
    const ws = await openConnectedServer('srv1', OLD, 'tok')

    // The active registry entry is repointed to a new endpoint mid-session.
    useConnectionStore.setState({
      serverRegistry: [{ id: 'srv1', name: 's', wsUrl: NEW, token: 'tok', lastConnectedAt: 0 }],
    })

    ws.onclose?.({ code: 1006 })
    const before = MockWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0])
    expect(MockWebSocket.instances.length).toBe(before + 1)
    expect(lastUrl()).toBe(NEW)
  })

  it('re-reads the registry token alongside the URL on reconnect', async () => {
    const URL = 'wss://srv.example.com/ws'
    const ws = await openConnectedServer('srv1', URL, 'old-token')

    // auth_ok-style token rotation written back to the registry.
    useConnectionStore.setState({
      serverRegistry: [{ id: 'srv1', name: 's', wsUrl: URL, token: 'new-token', lastConnectedAt: 0 }],
    })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0])
    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    next.readyState = 1
    next.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    // The auth frame carries the freshest registry token, not the captured one.
    const authFrame = next.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'auth')
    expect(authFrame?.token).toBe('new-token')
  })

  it('keeps dialing the same URL when nothing was repointed (no-op)', async () => {
    const URL = 'wss://stable.example.com/ws'
    const ws = await openConnectedServer('srv1', URL, 'tok')

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0])
    expect(lastUrl()).toBe(URL)
  })

  it('falls back to the captured URL for the local (registry-less) target', async () => {
    // No registry entry — activeServerId null (local same-origin connect).
    const URL = 'wss://localhost/ws'
    useConnectionStore.setState({ serverRegistry: [], activeServerId: null })
    const before = MockWebSocket.instances.length
    useConnectionStore.getState().connect(URL, 'tok')
    await vi.advanceTimersByTimeAsync(0)
    const ws = MockWebSocket.instances[before]!
    ws.readyState = 1
    ws.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    useConnectionStore.setState({ connectionPhase: 'connected' })

    ws.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0])
    expect(lastUrl()).toBe(URL)
  })
})
