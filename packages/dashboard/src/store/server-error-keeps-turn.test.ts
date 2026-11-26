/**
 * #9336 -- a sessionless `server_error` is informational unless it can be the
 * failure of the send that is still pending. It must not end a turn that has
 * started streaming. Through the real store and the real message handler.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

async function setup(s1: Record<string, unknown>) {
  const { useConnectionStore } = await import('./connection')
  const { _testMessageHandler } = await import('./message-handler')
  const { createEmptySessionState } = await import('./utils')
  _testMessageHandler.setContext({
    url: 'ws://localhost:3000', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
  useConnectionStore.setState({
    activeSessionId: 's1',
    serverErrors: [],
    sessionStates: {
      s1: { ...createEmptySessionState(), ...s1 },
      s2: { ...createEmptySessionState(), streamingMessageId: 'resp-2' },
    },
  })
  const ss = (id: string) => useConnectionStore.getState().sessionStates[id]!
  const errRows = () => ss('s1').messages.filter((m) => m.type === 'error')
  return { handle: _testMessageHandler.handle, ss, errRows, useConnectionStore }
}

const midStream = {
  streamingMessageId: 'resp-1',
  pendingClientMessageId: 'client-1',
  messages: [
    { id: 'resp-1', type: 'response', content: 'hel', timestamp: 1 },
    { id: 'thinking', type: 'thinking', content: '', timestamp: 1 },
  ],
}

afterEach(async () => {
  const { useConnectionStore } = await import('./connection')
  const { _testMessageHandler } = await import('./message-handler')
  _testMessageHandler.clearContext()
  useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, serverErrors: [] })
})

describe('sessionless server_error keeps a live turn (#9336)', () => {
  it('a tunnel error mid-turn only appends the error row', async () => {
    const { handle, ss, errRows, useConnectionStore } = await setup(midStream)
    handle({ type: 'server_error', category: 'tunnel', message: 'Tunnel connection lost', recoverable: true })
    expect(ss('s1').streamingMessageId).toBe('resp-1')
    expect(ss('s1').pendingClientMessageId).toBe('client-1')
    expect(ss('s1').messages.some((m) => m.id === 'thinking')).toBe(true)
    expect(errRows()).toHaveLength(1)
    expect(useConnectionStore.getState().serverErrors).toHaveLength(1)
  })

  it('a general sessionless error mid-stream leaves the turn', async () => {
    const { handle, ss, errRows } = await setup(midStream)
    handle({ type: 'server_error', message: 'Failed to list repos', recoverable: true })
    expect(ss('s1').streamingMessageId).toBe('resp-1')
    expect(ss('s1').pendingClientMessageId).toBe('client-1')
    expect(ss('s1').messages.some((m) => m.id === 'thinking')).toBe(true)
    expect(errRows()).toHaveLength(1)
  })

  it('a tunnel error while the send is pending leaves the pending turn', async () => {
    const { handle, ss, errRows } = await setup({ ...midStream, streamingMessageId: 'pending' })
    handle({ type: 'server_error', category: 'tunnel', message: 'Tunnel connection lost', recoverable: true })
    expect(ss('s1').streamingMessageId).toBe('pending')
    expect(ss('s1').pendingClientMessageId).toBe('client-1')
    expect(ss('s1').messages.some((m) => m.id === 'thinking')).toBe(true)
    expect(errRows()).toHaveLength(1)
  })

  it('a delta still lands on the streaming message after the error row', async () => {
    const { handle, ss } = await setup({})
    vi.useFakeTimers()
    try {
      handle({ type: 'stream_start', messageId: 'resp-1', sessionId: 's1' })
      handle({ type: 'stream_delta', sessionId: 's1', messageId: 'resp-1', delta: 'hel' })
      handle({ type: 'server_error', message: 'Failed to list repos', recoverable: true })
      handle({ type: 'stream_delta', sessionId: 's1', messageId: 'resp-1', delta: 'lo' })
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
    }
    expect(ss('s1').streamingMessageId).toBe('resp-1')
    expect(ss('s1').messages.find((m) => m.id === 'resp-1')?.content).toBe('hello')
  })

  it('a general sessionless error while the send is pending settles the turn', async () => {
    const { handle, ss, errRows } = await setup({
      ...midStream, streamingMessageId: 'pending',
    })
    handle({ type: 'server_error', message: 'Failed to send', recoverable: true })
    expect(ss('s1').streamingMessageId).toBeNull()
    expect(ss('s1').pendingClientMessageId).toBeNull()
    expect(ss('s1').messages.some((m) => m.id === 'thinking')).toBe(false)
    expect(errRows()).toHaveLength(1)
  })

  it('a tagged error still ends that session mid-stream, and only that session', async () => {
    const { handle, ss } = await setup(midStream)
    handle({ type: 'server_error', sessionId: 's1', category: 'session', message: 'Process exited', recoverable: true })
    expect(ss('s1').streamingMessageId).toBeNull()
    expect(ss('s1').pendingClientMessageId).toBeNull()
    expect(ss('s1').messages.some((m) => m.id === 'thinking')).toBe(false)
    expect(ss('s2').streamingMessageId).toBe('resp-2')
  })
})
