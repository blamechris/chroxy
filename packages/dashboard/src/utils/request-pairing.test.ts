/**
 * request-pairing — requester side of the pairing-approval primitive (#5510).
 *
 * Drives a fake WebSocket through the round-trip and asserts the phase
 * transitions: requesting → code-shown → approved/denied/expired/error. The
 * verify code is only ever DISPLAYED (received on pair_request_pending), never
 * sent back, so a mismatch is impossible by construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { requestPairing, type PairRequestState } from './request-pairing'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  // test helpers
  open() { this.readyState = 1; this.onopen?.() }
  recv(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

describe('requestPairing (#5510)', () => {
  let states: PairRequestState[]
  beforeEach(() => {
    FakeWebSocket.instances = []
    states = []
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-req-id' })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  function run(deviceName = 'Desktop') {
    requestPairing('wss://host/ws', deviceName, (s) => states.push(s))
    return FakeWebSocket.instances[0]
  }

  it('sends pair_request on open and surfaces the verify code', () => {
    const ws = run('Pixel 8')
    ws.open()
    const sent = JSON.parse(ws.sent[0])
    expect(sent.type).toBe('pair_request')
    expect(sent.requestId).toBe('fixed-req-id')
    expect(sent.deviceName).toBe('Pixel 8')

    ws.recv({ type: 'pair_request_pending', requestId: 'fixed-req-id', verifyCode: '424242' })
    const last = states[states.length - 1]
    expect(last.phase).toBe('code-shown')
    expect(last.verifyCode).toBe('424242')
  })

  it('reaches approved with the token on a successful pair_result', () => {
    const ws = run()
    ws.open()
    ws.recv({ type: 'pair_request_pending', requestId: 'fixed-req-id', verifyCode: '000000' })
    ws.recv({ type: 'pair_result', requestId: 'fixed-req-id', ok: true, token: 'sess-tok-xyz' })
    const last = states[states.length - 1]
    expect(last.phase).toBe('approved')
    expect(last.token).toBe('sess-tok-xyz')
    expect(ws.readyState).toBe(3) // closed after terminal state
  })

  it('maps a denied result to the denied phase', () => {
    const ws = run()
    ws.open()
    ws.recv({ type: 'pair_result', requestId: 'fixed-req-id', ok: false, reason: 'denied' })
    expect(states[states.length - 1].phase).toBe('denied')
  })

  it('maps an expired result to the expired phase', () => {
    const ws = run()
    ws.open()
    ws.recv({ type: 'pair_result', requestId: 'fixed-req-id', ok: false, reason: 'expired' })
    expect(states[states.length - 1].phase).toBe('expired')
  })

  it('ignores frames addressed to a different requestId', () => {
    const ws = run()
    ws.open()
    ws.recv({ type: 'pair_request_pending', requestId: 'someone-else', verifyCode: '999999' })
    expect(states[states.length - 1].verifyCode).toBeNull()
  })

  it('never echoes the verify code back to the server', () => {
    const ws = run()
    ws.open()
    ws.recv({ type: 'pair_request_pending', requestId: 'fixed-req-id', verifyCode: '424242' })
    // Only the initial pair_request was ever sent — no follow-up carries the code.
    expect(ws.sent).toHaveLength(1)
    expect(JSON.stringify(ws.sent)).not.toContain('424242')
  })

  it('surfaces an error if the socket closes before a terminal result', () => {
    const ws = run()
    ws.open()
    ws.onclose?.()
    expect(states[states.length - 1].phase).toBe('error')
  })
})
