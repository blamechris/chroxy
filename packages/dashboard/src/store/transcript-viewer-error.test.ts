/**
 * A refused transcript request ends the viewer's loading state with the
 * server's reason (#7828). Correlated by the echoed conversationId + code,
 * never by message text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { TRANSCRIPT_INACTIVITY_MS } from '@chroxy/protocol'

const ctx = () => ({ url: 'wss://t', token: 'tok', socket: undefined, isReconnect: false, silent: false })
const sock = () => ({
  readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn(),
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
} as unknown as WebSocket)

describe('transcript request refusal (#7828)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('shows the server reason immediately and stops loading', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    useConnectionStore.setState({ socket: sock() })
    useConnectionStore.getState().requestConversationTranscript('conv-e1')
    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')

    handleMessage({
      type: 'session_error', code: 'TRANSCRIPT_UNAVAILABLE', conversationId: 'conv-e1',
      message: 'Transcript file not found',
    }, ctx() as never)

    const viewer = useConnectionStore.getState().transcriptViewer
    expect(viewer.status).toBe('error')
    expect(viewer.error).toBe('Transcript file not found')
    // No timer is left to rewrite the reason as a timeout.
    vi.advanceTimersByTime(TRANSCRIPT_INACTIVITY_MS * 2)
    expect(useConnectionStore.getState().transcriptViewer.error).toBe('Transcript file not found')
  })

  it('an unrelated session_error leaves the viewer loading', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const { handleMessage } = await import('./message-handler')
    useConnectionStore.setState({ socket: sock() })
    useConnectionStore.getState().requestConversationTranscript('conv-e2')

    handleMessage({ type: 'session_error', message: 'Something else failed' }, ctx() as never)
    handleMessage({
      type: 'session_error', code: 'TRANSCRIPT_UNAVAILABLE', conversationId: 'some-other-conv', message: 'nope',
    }, ctx() as never)

    expect(useConnectionStore.getState().transcriptViewer.status).toBe('loading')
    useConnectionStore.getState().closeTranscriptViewer()
  })
})
