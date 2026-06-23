/**
 * #6308 — closing-socket TOCTOU: wsSend's false return must not be ignored.
 *
 * #6293 hardened wsSend to catch the InvalidStateError socket.send() throws when
 * the socket flips OPEN → CLOSING mid-send over a flaky tunnel, returning `false`
 * instead of throwing. sendInput was taught to check that (fall back to enqueue),
 * but four sibling actions kept reporting success while mutating local state — a
 * "sent it and nothing happened" silent failure (the #6278 durability north star).
 *
 * These tests pin the fixed behaviour with a socket whose readyState is OPEN but
 * whose send() throws (the exact TOCTOU). The real wsSend catches the throw, warns,
 * and returns false; each action must then NOT report a plain 'sent' nor leave the
 * UI asserting something the server never received.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SessionState } from './types'

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

/** OPEN socket whose send() throws — models the OPEN→CLOSING TOCTOU window. */
function closingSocket(): WebSocket {
  return {
    send: vi.fn(() => {
      throw new Error('InvalidStateError: socket is closing')
    }),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

/** Healthy OPEN socket that records sent frames. */
function liveSocket(sent: unknown[]): WebSocket {
  return {
    send: vi.fn((raw: string) => { try { sent.push(JSON.parse(raw)) } catch { /* noop */ } }),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

const sendCalls = (socket: WebSocket): unknown[][] => (socket.send as unknown as ReturnType<typeof vi.fn>).mock.calls

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('#6308 — dashboard sendCancelQueued', () => {
  it('returns false and preserves the queued entry + bubble when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          messages: [{ id: 'cmid-1', type: 'user_input', content: 'a', timestamp: 1 }],
          queuedMessages: [{ clientMessageId: 'cmid-1', text: 'a', queuedAt: 1, status: 'confirmed' }],
        } as unknown as SessionState,
      },
      socket,
    } as never)

    const result = useConnectionStore.getState().sendCancelQueued('cmid-1', 'sess-1')

    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    const ss = useConnectionStore.getState().sessionStates['sess-1']!
    expect(ss.queuedMessages.map((m) => m.clientMessageId)).toEqual(['cmid-1'])
    expect(ss.messages.map((m) => m.id)).toEqual(['cmid-1'])
  })

  it('drops the entry on a healthy send (happy-path regression guard)', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          messages: [{ id: 'cmid-1', type: 'user_input', content: 'a', timestamp: 1 }],
          queuedMessages: [{ clientMessageId: 'cmid-1', text: 'a', queuedAt: 1, status: 'confirmed' }],
        } as unknown as SessionState,
      },
      socket,
    } as never)

    expect(useConnectionStore.getState().sendCancelQueued('cmid-1', 'sess-1')).toBe('sent')
    expect(sent).toHaveLength(1)
    const ss = useConnectionStore.getState().sessionStates['sess-1']!
    expect(ss.queuedMessages).toHaveLength(0)
    expect(ss.messages).toHaveLength(0)
  })
})

describe('#6308 — dashboard sendCancelActivity', () => {
  it('returns false and does NOT mark the node cancelling when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      cancellingActivityIds: new Set<string>(),
      socket,
    } as never)

    const result = useConnectionStore.getState().sendCancelActivity('act-1', 'sess-1')

    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    // The node must stay actionable — marking "Cancelling…" with no ack/failure
    // ever arriving would strand it forever.
    expect(useConnectionStore.getState().cancellingActivityIds.size).toBe(0)
  })

  it('marks the node cancelling on a healthy send (happy-path regression guard)', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      cancellingActivityIds: new Set<string>(),
      socket,
    } as never)

    expect(useConnectionStore.getState().sendCancelActivity('act-1', 'sess-1')).toBe('sent')
    expect(useConnectionStore.getState().cancellingActivityIds.has('sess-1:act-1')).toBe(true)
  })
})

describe('#6308 — dashboard sendPermissionResponse', () => {
  it('returns false and leaves the prompt un-answered when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          messages: [{ id: 'p1', type: 'prompt', requestId: 'req-1', tool: 'Read', timestamp: 1 }],
        } as unknown as SessionState,
      },
      sessionNotifications: [],
      socket,
    } as never)

    const result = useConnectionStore.getState().sendPermissionResponse('req-1', 'allow')

    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    const ss = useConnectionStore.getState().sessionStates['sess-1']!
    const prompt = ss.messages.find((m) => m.requestId === 'req-1')
    expect(prompt?.answered).toBeUndefined()
  })

  it('marks the prompt answered on a healthy send (happy-path regression guard)', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          messages: [{ id: 'p1', type: 'prompt', requestId: 'req-1', tool: 'Read', timestamp: 1 }],
        } as unknown as SessionState,
      },
      sessionNotifications: [],
      socket,
    } as never)

    expect(useConnectionStore.getState().sendPermissionResponse('req-1', 'allow')).toBe('sent')
    const ss = useConnectionStore.getState().sessionStates['sess-1']!
    const prompt = ss.messages.find((m) => m.requestId === 'req-1')
    expect(prompt?.answered).toBe('allow')
  })
})

describe('#6308 — dashboard sendInterrupt / sendUserQuestionResponse', () => {
  it('sendInterrupt does NOT report a plain sent when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': { ...createEmptySessionState(), streamingMessageId: 'live-1' } as unknown as SessionState,
      },
      socket,
    } as never)

    const result = useConnectionStore.getState().sendInterrupt('sess-1')

    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).not.toBe('sent')
  })

  it('sendUserQuestionResponse does NOT report a plain sent when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)

    const result = useConnectionStore.getState().sendUserQuestionResponse('Option A', 'tool-1')

    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).not.toBe('sent')
  })
})
