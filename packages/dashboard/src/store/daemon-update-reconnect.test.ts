/**
 * #8331 — the update banner's state does not survive an AUTOMATIC reconnect.
 *
 * `disconnect()` clears it, but a transport drop goes through `socket.onclose`, and
 * a reconnect starts with `connect()`. A reconnect can land on a different build (a
 * manual rollback, a switched checkout) that never sends a replacement
 * `daemon_update_status`, so a stale "Restarting…", "Updated to" or confirm dialog
 * would sit there for ever. Same mock-WebSocket harness as connection-reconnect-backoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }))

const { useConnectionStore } = await import('./connection')
const { isDaemonUpdateWatchdogArmed } = await import('./daemon-update-watchdog')
const mh = await import('./message-handler')

const B = 'b'.repeat(40)
const dirty = () => useConnectionStore.setState({
  daemonUpdate: { type: 'daemon_update_status', running: 'a'.repeat(40), pending: null, lastDeploy: null, postponedUntil: null, requestPending: true, applying: false },
  daemonUpdateAction: { requestId: 'r1', action: 'restart-now', target: B },
  daemonUpdateConfirm: { type: 'daemon_update_confirm_required', requestId: 'r1', target: B, reasons: ['busy'], sessions: [] },
  daemonUpdateError: 'from before the drop',
})
const fields = () => {
  const s = useConnectionStore.getState()
  return [s.daemonUpdate, s.daemonUpdateAction, s.daemonUpdateConfirm, s.daemonUpdateError]
}

async function openConnected(): Promise<MockWebSocket> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok')
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
  mh.resetReconnectAttempt()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useConnectionStore.setState({ serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected', wsUrl: null, userDisconnected: false })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('update banner state vs automatic reconnects (#8331)', () => {
  it('a transport drop (socket.onclose) clears the status, the in-flight action, the confirm dialog and the error', async () => {
    const ws = await openConnected()
    dirty()
    expect(fields().every((f) => f !== null)).toBe(true)
    ws.onclose?.({ code: 1006 })
    expect(fields()).toEqual([null, null, null, null])
  })

  it('starting a new handshake (connect) clears them too, so a reconnect to an older daemon shows nothing stale', async () => {
    await openConnected()
    dirty()
    useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok', { silent: true })
    expect(fields()).toEqual([null, null, null, null])
  })

  it('the action watchdog is cancelled the moment the transport drops (before any reconnect is attempted)', async () => {
    const ws = await openConnected()
    useConnectionStore.setState({ socket: ws as unknown as WebSocket })
    expect(useConnectionStore.getState().requestDaemonUpdateAction('postpone', B)).toBe(true)
    expect(isDaemonUpdateWatchdogArmed()).toBe(true)
    ws.onclose?.({ code: 1006 })
    expect(isDaemonUpdateWatchdogArmed()).toBe(false)
  })
})
