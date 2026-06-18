/**
 * approvePairRequest / denyPairRequest store actions (#5510, epic #5509).
 *
 * Each sends only `{ type, requestId }` (the verify code never leaves the host
 * — the operator compared it out-of-band) and optimistically drops the request
 * from `pendingPairRequests`. Returns false (no wire write) when the socket is
 * closed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

interface Sent { type: string; requestId?: string; [k: string]: unknown }

function seedState(useConnectionStore: typeof import('./connection').useConnectionStore, readyState: number = WebSocket.OPEN) {
  const sent: Sent[] = []
  const socket = {
    send: vi.fn((raw: string) => { try { sent.push(JSON.parse(raw)) } catch { /* noop */ } }),
    close: vi.fn(),
    readyState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
  useConnectionStore.setState({
    socket,
    pendingPairRequests: [
      { type: 'pair_pending', requestId: 'r1', deviceName: 'A', verifyCode: '111111', expiresAt: Date.now() + 1000 },
      { type: 'pair_pending', requestId: 'r2', deviceName: 'B', verifyCode: '222222', expiresAt: Date.now() + 1000 },
    ],
  })
  return sent
}

describe('approvePairRequest / denyPairRequest (#5510)', () => {
  beforeEach(() => { vi.resetModules() })

  it('approve sends pair_approve with only the requestId and drops it locally', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent = seedState(useConnectionStore)
    expect(useConnectionStore.getState().approvePairRequest('r1')).toBe(true)
    expect(sent).toEqual([{ type: 'pair_approve', requestId: 'r1' }])
    expect(useConnectionStore.getState().pendingPairRequests.map((p) => p.requestId)).toEqual(['r2'])
  })

  it('deny sends pair_deny with only the requestId and drops it locally', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent = seedState(useConnectionStore)
    expect(useConnectionStore.getState().denyPairRequest('r2')).toBe(true)
    expect(sent).toEqual([{ type: 'pair_deny', requestId: 'r2' }])
    expect(useConnectionStore.getState().pendingPairRequests.map((p) => p.requestId)).toEqual(['r1'])
  })

  it('returns false and writes nothing when the socket is closed', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent = seedState(useConnectionStore, WebSocket.CLOSED)
    expect(useConnectionStore.getState().approvePairRequest('r1')).toBe(false)
    expect(useConnectionStore.getState().denyPairRequest('r1')).toBe(false)
    expect(sent).toHaveLength(0)
    expect(useConnectionStore.getState().pendingPairRequests).toHaveLength(2)
  })

  it('never includes the verify code on the wire', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent = seedState(useConnectionStore)
    useConnectionStore.getState().approvePairRequest('r1')
    expect(JSON.stringify(sent)).not.toContain('111111')
  })
})
