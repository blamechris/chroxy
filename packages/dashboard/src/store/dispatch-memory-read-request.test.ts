/**
 * `requestMemoryRead` action contract (#6867, epic #6760; sessionId +
 * requestId nonce added per #6996 review).
 *
 * Mirrors dispatch-host-status-request.test.ts's mocking idiom.
 *   - WS OPEN → sends `memory_read` with an explicit sessionId (when one is
 *     active) and a fresh requestId nonce, sets memoryStackLoading + records
 *     lastMemoryStackRequestId, returns true.
 *   - WS CLOSED / no socket → sends nothing, leaves loading untouched,
 *     returns false.
 *   - No active session → still sends `memory_read` (server falls back to
 *     the client's bound/implicit session), just without a sessionId field.
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

interface SentPayload {
  type: string
  [k: string]: unknown
}

function createMockSocket(sent: SentPayload[], readyState: number = WebSocket.OPEN): WebSocket {
  return {
    send: vi.fn((raw: string) => {
      try { sent.push(JSON.parse(raw) as SentPayload) } catch { /* noop */ }
    }),
    close: vi.fn(),
    readyState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('#6996 review — requestMemoryRead sessionId + requestId', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sends memory_read with the active sessionId and a requestId, and records it as lastMemoryStackRequestId', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.OPEN)
    useConnectionStore.setState({ socket, activeSessionId: 's1', memoryStackLoading: false, lastMemoryStackRequestId: null })

    const result = useConnectionStore.getState().requestMemoryRead()

    expect(result).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('memory_read')
    expect(sent[0].sessionId).toBe('s1')
    expect(typeof sent[0].requestId).toBe('string')
    expect((sent[0].requestId as string).length).toBeGreaterThan(0)

    const state = useConnectionStore.getState()
    expect(state.memoryStackLoading).toBe(true)
    expect(state.lastMemoryStackRequestId).toBe(sent[0].requestId)
  })

  it('sends a fresh requestId on each call (never reuses the previous nonce)', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.OPEN)
    useConnectionStore.setState({ socket, activeSessionId: 's1', memoryStackLoading: false, lastMemoryStackRequestId: null })

    useConnectionStore.getState().requestMemoryRead()
    useConnectionStore.getState().requestMemoryRead()

    expect(sent).toHaveLength(2)
    expect(sent[0].requestId).not.toBe(sent[1].requestId)
    expect(useConnectionStore.getState().lastMemoryStackRequestId).toBe(sent[1].requestId)
  })

  it('omits sessionId when there is no active session, but still sends a requestId', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.OPEN)
    useConnectionStore.setState({ socket, activeSessionId: null, memoryStackLoading: false, lastMemoryStackRequestId: null })

    const result = useConnectionStore.getState().requestMemoryRead()

    expect(result).toBe(true)
    expect(sent[0]).not.toHaveProperty('sessionId')
    expect(typeof sent[0].requestId).toBe('string')
  })

  it('returns false and sends nothing when WS is CLOSED', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent, WebSocket.CLOSED)
    useConnectionStore.setState({ socket, activeSessionId: 's1', memoryStackLoading: false, lastMemoryStackRequestId: null })

    const result = useConnectionStore.getState().requestMemoryRead()

    expect(result).toBe(false)
    expect(sent).toHaveLength(0)
    expect(useConnectionStore.getState().memoryStackLoading).toBe(false)
    expect(useConnectionStore.getState().lastMemoryStackRequestId).toBeNull()
  })

  it('returns false when there is no socket at all', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: null, activeSessionId: 's1', memoryStackLoading: false, lastMemoryStackRequestId: null })
    expect(useConnectionStore.getState().requestMemoryRead()).toBe(false)
    expect(useConnectionStore.getState().memoryStackLoading).toBe(false)
  })
})
