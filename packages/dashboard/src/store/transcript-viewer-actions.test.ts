/**
 * requestConversationTranscript / closeTranscriptViewer store actions
 * (#6863, epic #6765).
 *
 * Covers the send-side of the read-only transcript viewer: the wire payload
 * sent for `request_conversation_transcript` (#6860), the loading/error/timeout
 * transitions, and the end-to-end flow through `handleMessage` (connection.ts
 * wires message-handler.ts's module store to this same real Zustand store —
 * see the `setStore(...)` call near the bottom of connection.ts — so driving
 * `handleMessage` here exercises the exact same interception path production
 * traffic takes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function createMockSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('requestConversationTranscript / closeTranscriptViewer (#6863)', () => {
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: undefined, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends request_conversation_transcript with the conversationId and opens the viewer in loading state', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({
      socket,
      transcriptViewer: { conversationId: null, status: 'idle', messages: [], error: null },
    })

    useConnectionStore.getState().requestConversationTranscript('conv-1')

    expect(socket.send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((socket.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string)
    expect(payload.type).toBe('request_conversation_transcript')
    expect(payload.conversationId).toBe('conv-1')
    expect(payload.cwd).toBeUndefined()

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe('conv-1')
    expect(viewer.status).toBe('loading')
    expect(viewer.messages).toEqual([])
    expect(viewer.error).toBeNull()
  })

  it('includes cwd on the wire payload when provided', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-2', '/home/user/project')

    const payload = JSON.parse((socket.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string)
    expect(payload.cwd).toBe('/home/user/project')
  })

  it('surfaces an immediate error (no crash) when the socket is not open — #6308/#6309 wsSend return-value check', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: null })

    expect(() => useConnectionStore.getState().requestConversationTranscript('conv-3')).not.toThrow()

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe('conv-3')
    expect(viewer.status).toBe('error')
    expect(viewer.error).toBeTruthy()
  })

  it('closeTranscriptViewer resets to idle', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })
    useConnectionStore.getState().requestConversationTranscript('conv-4')
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')

    useConnectionStore.getState().closeTranscriptViewer()

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBeNull()
    expect(viewer.status).toBe('idle')
    expect(viewer.messages).toEqual([])
    expect(viewer.error).toBeNull()
  })

  it('a fetch still loading after the watchdog window surfaces a timeout error instead of spinning forever', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-5')
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')

    vi.advanceTimersByTime(15_000)

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('error')
    expect(viewer.error).toMatch(/timed out/i)
    vi.useRealTimers()
  })

  it('a completed fetch before the watchdog window does NOT get overwritten by the timeout', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-6')
    handleMessage({ type: 'history_replay_start', sessionId: 'conv-6', conversationId: 'conv-6' }, ctx() as never)
    handleMessage({ type: 'history_replay_end', sessionId: 'conv-6' }, ctx() as never)
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('ready')

    vi.advanceTimersByTime(15_000)

    // Still ready — the (cleared) watchdog must not clobber a completed fetch.
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('ready')
    vi.useRealTimers()
  })

  it('end-to-end: request -> replay frames -> ready, with messages accumulated in order', async () => {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-7', '/home/user/proj')
    handleMessage({ type: 'history_replay_start', sessionId: 'conv-7', conversationId: 'conv-7' }, ctx() as never)
    handleMessage(
      { type: 'message', messageType: 'user_input', content: 'hello', sessionId: 'conv-7', timestamp: 1 },
      ctx() as never,
    )
    handleMessage(
      { type: 'message', messageType: 'response', content: 'hi there', sessionId: 'conv-7', timestamp: 2 },
      ctx() as never,
    )
    handleMessage({ type: 'history_replay_end', sessionId: 'conv-7' }, ctx() as never)

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('ready')
    expect(viewer.messages.map(m => m.content)).toEqual(['hello', 'hi there'])
  })

  it('a subsequent View request for a DIFFERENT conversation resets messages (no bleed-through)', async () => {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    const socket = createMockSocket()
    useConnectionStore.setState({ socket })

    useConnectionStore.getState().requestConversationTranscript('conv-8')
    handleMessage({ type: 'history_replay_start', sessionId: 'conv-8', conversationId: 'conv-8' }, ctx() as never)
    handleMessage(
      { type: 'message', messageType: 'response', content: 'first conversation', sessionId: 'conv-8', timestamp: 1 },
      ctx() as never,
    )
    handleMessage({ type: 'history_replay_end', sessionId: 'conv-8' }, ctx() as never)
    expect(useConnectionStore.getState().transcriptViewer.messages).toHaveLength(1)

    useConnectionStore.getState().requestConversationTranscript('conv-9')
    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.conversationId).toBe('conv-9')
    expect(viewer.status).toBe('loading')
    expect(viewer.messages).toEqual([])
  })
})
