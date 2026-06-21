/**
 * #6023 — the client consumes the supervisor terminal-down health signal
 * (#6022/#6130: `GET /health` → 200 `{ status: 'down', reason: 'supervisor_gave_up' }`)
 * and latches the terminal `server_down` phase IMMEDIATELY, instead of climbing
 * the full reconnect ladder against a host that has explicitly given up.
 *
 * The decision tree itself is unit-tested in store-core (connect-flow.test.ts);
 * this pins the dashboard wiring: probe parses status:'down' → terminal_down,
 * and onTerminalDown writes server_down + does NOT open a socket or arm a retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

class MockWebSocket {
  static OPEN = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  readyState = 0
  constructor(_url: string) { MockWebSocket.count++ }
  send(): void { /* no-op */ }
  close(): void { this.readyState = 3 }
  static count = 0
}

describe('dashboard reconnect — terminal server-down signal (#6023)', () => {
  beforeEach(() => {
    MockWebSocket.count = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  async function flushMicrotasks() {
    const real = globalThis.setTimeout
    await new Promise((r) => real(r, 0))
    await new Promise((r) => real(r, 0))
  }

  it('latches server_down on a status:down health body — no socket, no re-probe', async () => {
    const { useConnectionStore } = await import('./connection')

    // A retry would re-run the probe, so fetch-called-once proves the ladder
    // stopped (a robust signal — unlike counting timers, which would also catch
    // the probe's own 5000ms fetch-abort timeout).
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'down', reason: 'supervisor_gave_up' }),
    }))
    vi.stubGlobal('fetch', fetchSpy)

    void useConnectionStore.getState().connect('wss://example.invalid', 'tok')
    await flushMicrotasks()

    expect(useConnectionStore.getState().connectionPhase).toBe('server_down')
    expect(useConnectionStore.getState().connectionError).toBe('Server appears to be down')
    expect(MockWebSocket.count).toBe(0)   // never opened a socket
    expect(fetchSpy).toHaveBeenCalledTimes(1) // never re-probed (no retry ladder)
  })

  it('still connects normally on a healthy probe (no false-positive)', async () => {
    const { useConnectionStore } = await import('./connection')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) })))
    void useConnectionStore.getState().connect('wss://example.invalid', 'tok')
    await flushMicrotasks()
    expect(MockWebSocket.count).toBe(1)
    expect(useConnectionStore.getState().connectionPhase).not.toBe('server_down')
  })
})
