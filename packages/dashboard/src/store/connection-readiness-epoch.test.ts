import { it, expect, vi } from 'vitest'

it('new socket epoch must wait for its own provider readiness snapshot', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) })))
  class WS {
    static OPEN = 1
    static instances: WS[] = []
    readyState = 1
    onopen: any = null
    onmessage: any = null
    onclose: any = null
    onerror: any = null
    sent: any[] = []
    constructor(_url: string) { WS.instances.push(this) }
    send(raw: string) { this.sent.push(JSON.parse(raw)) }
    close() { this.readyState = 3 }
  }
  vi.stubGlobal('WebSocket', WS)
  const { useConnectionStore, createEmptySessionState } = await import('./connection')
  const url = 'ws://localhost:3000/ws'
  const auth = { type: 'auth_ok', clientId: 'c1', encryption: 'disabled', serverMode: 'cli' }
  useConnectionStore.getState().connect(url, 'fixture-token')
  await vi.advanceTimersByTimeAsync(0)
  const first = WS.instances[0]!
  first.onopen?.()
  first.onmessage?.({ data: JSON.stringify(auth) })
  const snapshot = { provider: 'codex', inputRequiresReady: true, capabilities: [{ name: 'inputReady', state: true }] }
  useConnectionStore.setState({
    activeSessionId: 's1', sessions: [{ sessionId: 's1', name: 'Codex', provider: 'codex' }],
    sessionStates: { s1: { ...createEmptySessionState(), providerRuntimeInfo: snapshot } },
  } as never)
  useConnectionStore.getState().connect(url, 'fixture-token')
  await vi.advanceTimersByTimeAsync(0)
  const second = WS.instances[1]!
  expect(first.onclose).toBe(null)
  second.onopen?.()
  second.onmessage?.({ data: JSON.stringify(auth) })
  expect(useConnectionStore.getState().connectionPhase).toBe('connected')
  try {
    expect(useConnectionStore.getState().sendInput('must stay in draft')).toBe(false)
    expect(second.sent.filter(frame => frame.type === 'input')).toHaveLength(0)
    second.onmessage?.({ data: JSON.stringify({ type: 'provider_runtime_info', sessionId: 's1', ...snapshot }) })
    expect(useConnectionStore.getState().sendInput('explicit send')).toBe('sent')
    expect(second.sent.filter(frame => frame.type === 'input')).toHaveLength(1)
  } finally {
    useConnectionStore.getState().disconnect()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
