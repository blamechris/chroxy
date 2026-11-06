/**
 * A server that ends a connection because the pairing token it authenticated
 * with is no longer valid (close code 4401) is not retried with that token: the
 * client forgets that server entry's credential and lands on the unpaired state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// The literal the server sends (ws-server.js WS_CLOSE_CREDENTIAL_INVALID).
const WS_CLOSE_CREDENTIAL_INVALID = 4401

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

const { useConnectionStore } = await import('./connection')
const { resetReconnectAttempt } = await import('./message-handler')

const URL_A = 'wss://server-a.example.com/ws'
const URL_B = 'wss://server-b.example.com/ws'

async function connectToA(): Promise<{ socket: MockWebSocket; serverId: string }> {
  const s = useConnectionStore.getState()
  const a = s.addServer('A', URL_A, 'tok-a')
  vi.advanceTimersByTime(5) // ids are time + random based; both are frozen here
  s.addServer('B', URL_B, 'tok-b')
  useConnectionStore.setState({ activeServerId: a.id, savedConnection: { url: URL_A, token: 'tok-a' } })
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(URL_A, 'tok-a')
  await vi.advanceTimersByTimeAsync(0)
  const socket = MockWebSocket.instances[before]!
  socket.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  useConnectionStore.setState({ connectionPhase: 'connected', userDisconnected: false })
  return { socket, serverId: a.id }
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(okFetch)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useConnectionStore.setState({
    serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected',
    wsUrl: null, userDisconnected: false, connectionError: null, savedConnection: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('close code 4401 (the credential for this connection is no longer valid)', () => {
  it('control: an ordinary drop reconnects with the saved credential', async () => {
    const { socket } = await connectToA()
    const before = MockWebSocket.instances.length
    socket.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(MockWebSocket.instances.length).toBeGreaterThan(before)
  })

  it('does not reconnect', async () => {
    const { socket } = await connectToA()
    const before = MockWebSocket.instances.length
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    socket.onerror?.()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockWebSocket.instances.length).toBe(before)
    expect(useConnectionStore.getState().connectionPhase).toBe('disconnected')
  })

  it('forgets the credential of that server entry only', async () => {
    const { socket, serverId } = await connectToA()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    const { serverRegistry, savedConnection } = useConnectionStore.getState()
    expect(serverRegistry.find((e) => e.id === serverId)?.token).toBe('')
    expect(serverRegistry.find((e) => e.wsUrl === URL_B)?.token).toBe('tok-b')
    expect(savedConnection).toBeNull()
  })

  it('tells the user to pair again', async () => {
    const { socket } = await connectToA()
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID })
    expect(useConnectionStore.getState().connectionError).toMatch(/pair it again/i)
  })
})
