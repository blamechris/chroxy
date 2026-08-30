/**
 * #7456 — the replay window and its live-arrival ledger are per-CONNECTION
 * state, and until now nothing released them on a transport drop.
 *
 * `resetReplayReconcile()` was called from exactly one production path on each
 * client — `auth_ok` — so a socket that dropped mid-replay left the session's
 * window open and its ledger populated until the NEXT successful auth, which
 * for a tab left open on a dead tunnel may never come.
 *
 * Since #7455 the window is a REFCOUNT, which makes this load-bearing rather
 * than merely untidy: a `history_replay_start` with no matching `_end` strands
 * a +1, so every later end decrements from a too-high base and the window never
 * closes again for that session — the ledger is never released and every later
 * prompt is protected forever.
 *
 * Cursors are deliberately NOT cleared here: they are what makes the reconnect
 * a delta replay instead of a full rebuild (#5555.3).
 *
 * Harness mirrors connection-reconnect-backoff.test.ts.
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

const {
  reconcileReplayStart,
  recordHistorySeq,
  resetReplayReconcile,
  noteLivePromptDuringReplay,
  wasPromptLiveDuringReplay,
  getReplayWindowDepth,
  getLiveReplayLedgerSessionIds,
  getHistoryCursor,
  isRebuildInProgress,
} = await import('@chroxy/store-core')
const { useConnectionStore } = await import('./connection')
const { resetReconnectAttempt } = await import('./message-handler')

/** Open a connection and return the freshly constructed (current-attempt) socket. */
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

/** Open a replay window for `s1` with one live question inside it. */
function openReplayWindowWithRacer(): void {
  reconcileReplayStart('s1', true, [])
  noteLivePromptDuringReplay('s1', 'live-q')
  recordHistorySeq('s1', 42)
  // Positive controls — the fixture took effect, so the assertions below are
  // about the teardown and not about state that was never there.
  expect(getReplayWindowDepth('s1')).toBe(1)
  expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(true)
  expect(isRebuildInProgress('s1')).toBe(true)
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  resetReconnectAttempt()
  resetReplayReconcile({ clearCursors: true })
  useConnectionStore.setState({ socket: null, connectionPhase: 'disconnected', userDisconnected: false })
})

afterEach(() => {
  resetReplayReconcile({ clearCursors: true })
  vi.useRealTimers()
})

describe('transport teardown releases the replay window + live-arrival ledger (#7456)', () => {
  it('socket.onclose releases the window and ledger but keeps the history cursor', async () => {
    const socket = await openConnected()
    openReplayWindowWithRacer()

    socket.onclose?.({ code: 1006 })

    expect(getReplayWindowDepth('s1')).toBe(0)
    expect(getLiveReplayLedgerSessionIds()).toEqual([])
    expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getHistoryCursor('s1')).toBe(42)
  })

  it('socket.onerror releases the window and ledger but keeps the history cursor', async () => {
    const socket = await openConnected()
    openReplayWindowWithRacer()

    socket.onerror?.()

    expect(getReplayWindowDepth('s1')).toBe(0)
    expect(getLiveReplayLedgerSessionIds()).toEqual([])
    expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(false)
    expect(getHistoryCursor('s1')).toBe(42)
  })

  it('a stale socket close does not tear down the CURRENT attempt state', async () => {
    const stale = await openConnected()
    // A new attempt supersedes it (bumps the module-level attempt id).
    await openConnected()
    openReplayWindowWithRacer()

    stale.onclose?.({ code: 1006 })

    expect(getReplayWindowDepth('s1')).toBe(1)
    expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(true)
  })
})
