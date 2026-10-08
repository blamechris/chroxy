/**
 * #8374 -- the capabilities the dashboard ACTUALLY puts in its `auth` frame.
 *
 * The server downgrades a replayed `permission_outcome: 'stopped'` to `expired`
 * for any client that did not advertise `permission_outcome_stopped_v1`. A test
 * that hands the server a hand-built capability list proves nothing about the
 * dashboard: this one drives the real connection store through `connect()` and
 * `socket.onopen`, and reads the frame it sends. The server side of the same
 * list is `tests/permission-outcome-stopped-handshake.test.js`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CLIENT_CAPABILITIES } from '@chroxy/protocol'

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
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

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

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  for (const k of Object.keys(store)) delete store[k]
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the dashboard auth frame advertises the stopped-outcome capability (#8374)', () => {
  it('sends the stock desktop capability list, which names permission_outcome_stopped_v1', async () => {
    useConnectionStore.getState().connect('wss://srv.example.com/ws', 'tok')
    await vi.advanceTimersByTimeAsync(0)
    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()
    await vi.advanceTimersByTimeAsync(0)

    const frames = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
    const auth = frames.find((f) => f.type === 'auth')
    expect(auth, 'the real onopen must send an auth frame').toBeDefined()
    expect(auth!.capabilities).toEqual([...CLIENT_CAPABILITIES.desktop])
    expect(auth!.capabilities as string[]).toContain('permission_outcome_stopped_v1')
    // #6630: without it the server sends this client no recorded errors in a replay.
    expect(auth!.capabilities as string[]).toContain('history_error_replay_v1')
    expect(auth!.capabilities as string[]).toContain('history_thinking_replay_v1')
  })

  // The pair branch is a SECOND handshake frame, and the server records an EMPTY
  // capability set for a `pair` that carries none (ws-auth.js) -- which downgrades
  // every replayed `stopped` outcome to `expired` for a freshly paired client.
  it('the pairing frame carries the same capability list', async () => {
    useConnectionStore.getState().pairServer('LAN', 'ws://192.168.1.50:8765/ws', 'PAIR-1')
    await vi.advanceTimersByTimeAsync(0)
    const ws = MockWebSocket.instances.find((w) => w.url.includes('192.168.1.50'))!
    expect(ws, 'pairServer must open a socket').toBeDefined()
    ws.readyState = 1
    ws.onopen?.()
    await vi.advanceTimersByTimeAsync(0)

    const pair = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f.type === 'pair')
    expect(pair, 'the real onopen must send a pair frame').toBeDefined()
    expect(pair!.pairingId).toBe('PAIR-1')
    expect(pair!.capabilities).toEqual([...CLIENT_CAPABILITIES.desktop])
    expect(pair!.capabilities as string[]).toContain('permission_outcome_stopped_v1')
  })
})
