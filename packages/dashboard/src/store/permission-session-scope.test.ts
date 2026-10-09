/**
 * #8517 -- "Allow for Session" survives the server's `permission_resolved` echo.
 *
 * The real wire sequence, end to end through the real store and the real message
 * handler: the client answers, the daemon echoes `permission_resolved` with the wire
 * decision (`allow`, never `allowSession`). The card must keep reading "allowed for
 * the session" so it stays apart from one-time allows in the compact record.
 */
import { describe, it, expect } from 'vitest'

async function setup(tool = 'Read') {
  const { useConnectionStore } = await import('./connection')
  const { _testMessageHandler } = await import('./message-handler')
  const { createEmptySessionState } = await import('./utils')
  const sent: Array<Record<string, unknown>> = []
  const socket = { readyState: 1, send: (d: string) => { sent.push(JSON.parse(d)) } } as unknown as WebSocket
  _testMessageHandler.setContext({ url: 'ws://localhost:3000', token: 't', isReconnect: false, silent: false, socket })
  useConnectionStore.setState({
    activeSessionId: 's1',
    sessions: [],
    sessionNotifications: [],
    sessionStates: {
      s1: {
        ...createEmptySessionState(),
        messages: [{ id: 'm1', type: 'prompt', content: `${tool}: /a`, timestamp: 1, requestId: 'req-1', tool }],
      },
    },
    resolvedPermissions: {},
    socket,
  })
  const answered = () => useConnectionStore.getState().sessionStates.s1!.messages.find((m) => m.requestId === 'req-1')!.answered
  return { useConnectionStore, handle: _testMessageHandler.handle, sent, answered }
}

describe('Allow for Session over the real wire (#8517)', () => {
  it('sends the wire decision allow labelled with the session scope', async () => {
    const { useConnectionStore, sent } = await setup()
    useConnectionStore.getState().sendPermissionResponse('req-1', 'allowSession')
    const response = sent.find((m) => m.type === 'permission_response')!
    expect(response.decision).toBe('allow')
    expect(response.scope).toBe('session')
    expect(sent.some((m) => m.type === 'set_permission_rules')).toBe(true)
  })

  it('a one-time allow, an allowAlways and a deny carry no scope', async () => {
    for (const decision of ['allow', 'allowAlways', 'deny'] as const) {
      const { useConnectionStore, sent } = await setup()
      useConnectionStore.getState().sendPermissionResponse('req-1', decision)
      const response = sent.find((m) => m.type === 'permission_response')!
      expect('scope' in response, decision).toBe(false)
    }
  })

  it("the echo permission_resolved {decision:'allow'} WITHOUT a scope (an older daemon) leaves answered as allowSession", async () => {
    const { useConnectionStore, handle, answered } = await setup()
    useConnectionStore.getState().sendPermissionResponse('req-1', 'allowSession')
    expect(answered()).toBe('allowSession')
    handle({ type: 'permission_resolved', requestId: 'req-1', decision: 'allow', reason: 'user', sessionId: 's1' })
    expect(answered()).toBe('allowSession')
  })

  it("the echo permission_resolved {decision:'allow', scope:'session'} leaves answered as allowSession", async () => {
    const { useConnectionStore, handle, answered } = await setup()
    useConnectionStore.getState().sendPermissionResponse('req-1', 'allowSession')
    handle({ type: 'permission_resolved', requestId: 'req-1', decision: 'allow', scope: 'session', reason: 'user', sessionId: 's1' })
    expect(answered()).toBe('allowSession')
  })

  it('another client\'s session allow is shown as one here too (this client never answered)', async () => {
    const { handle, answered } = await setup()
    handle({ type: 'permission_resolved', requestId: 'req-1', decision: 'allow', scope: 'session', reason: 'user', sessionId: 's1' })
    expect(answered()).toBe('allowSession')
  })

  it('CONTROL: a one-time allow stays allow through its echo', async () => {
    const { useConnectionStore, handle, answered } = await setup()
    useConnectionStore.getState().sendPermissionResponse('req-1', 'allow')
    handle({ type: 'permission_resolved', requestId: 'req-1', decision: 'allow', reason: 'user', sessionId: 's1' })
    expect(answered()).toBe('allow')
  })
})
