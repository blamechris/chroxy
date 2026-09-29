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
import type { SessionState, EvaluatorResultPayload } from './types'

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

describe('#7822 — selected context delivery', () => {
  const context = {
    version: 1 as const,
    items: [{
      id: 'ocr-1', kind: 'text' as const, provenance: { source: 'ocr' as const },
      mediaType: 'text/plain', sizeBytes: 5, lifetime: 'one_turn' as const,
      content: { type: 'text' as const, text: 'hello' },
    }],
  }

  it('marks an ambiguous socket send uncertain and never adds it to the reconnect queue', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      serverCapabilities: { inputContextV1: true },
      socket,
    } as never)

    const result = useConnectionStore.getState().sendInput('compare', undefined, { context })

    expect(result).toBe('uncertain')
    expect(sendCalls(socket)).toHaveLength(1)
    const { _testQueueInternals } = await import('./message-handler')
    expect(_testQueueInternals.getQueue()).toHaveLength(0)
    const deliveries = useConnectionStore.getState().sessionStates['sess-1']!.inputDeliveries
    expect(Object.values(deliveries)).toHaveLength(1)
    expect(Object.values(deliveries)[0]).toMatchObject({ status: 'uncertain', pendingContextItemIds: ['ocr-1'] })
  })

  it('serializes context on a capable server and refuses an older server before writing', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      serverCapabilities: { inputContextV1: true },
      socket,
    } as never)
    expect(useConnectionStore.getState().sendInput('compare', undefined, { context })).toBe('sent')
    expect(sent[0]).toMatchObject({ type: 'input', data: 'compare', context })

    useConnectionStore.setState({ serverCapabilities: {} } as never)
    expect(useConnectionStore.getState().sendInput('blocked', undefined, { context })).toBe(false)
    expect(sent).toHaveLength(1)
  })
})

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

  it('#6543: an approve carries editedInput on the wire; plain allow / deny omit it', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          messages: [{ id: 'p1', type: 'prompt', requestId: 'req-1', tool: 'Write', timestamp: 1 }],
        } as unknown as SessionState,
      },
      sessionNotifications: [],
      socket,
    } as never)
    const last = () => sent[sent.length - 1] as { decision?: string; editedInput?: unknown }

    useConnectionStore.getState().sendPermissionResponse('req-1', 'allow', { content: 'edited' })
    expect(last().decision).toBe('allow')
    expect(last().editedInput).toEqual({ content: 'edited' })

    useConnectionStore.getState().sendPermissionResponse('req-1', 'allow') // plain Allow
    expect(last().editedInput).toBeUndefined()

    useConnectionStore.getState().sendPermissionResponse('req-1', 'deny', { content: 'x' }) // deny drops it
    expect(last().editedInput).toBeUndefined()
  })

  it('#6773: a deny carries a trimmed reason on the wire; allow / blank omit it', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          messages: [{ id: 'p1', type: 'prompt', requestId: 'req-1', tool: 'Bash', timestamp: 1 }],
        } as unknown as SessionState,
      },
      sessionNotifications: [],
      socket,
    } as never)
    const last = () => sent[sent.length - 1] as { decision?: string; reason?: unknown }

    useConnectionStore.getState().sendPermissionResponse('req-1', 'deny', null, '  use rg  ')
    expect(last().decision).toBe('deny')
    expect(last().reason).toBe('use rg') // trimmed

    useConnectionStore.getState().sendPermissionResponse('req-1', 'deny', null, '   ') // blank → omitted
    expect(last().reason).toBeUndefined()

    useConnectionStore.getState().sendPermissionResponse('req-1', 'allow', null, 'ignored on allow')
    expect(last().reason).toBeUndefined() // reason never rides an allow
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
    // interrupt is offline-queueable (5s TTL) — a failed live send falls through
    // to the queue (retries on reconnect), never the pre-fix phantom 'sent'.
    expect(result).toBe('queued')
  })

  it('sendUserQuestionResponse falls through to the queue (optimistic flips run) when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': {
          ...createEmptySessionState(),
          isIdle: true,
          activeTools: [{ toolUseId: 'tool-1' }],
          messages: [{ id: 'tool-1', type: 'tool_use', tool: 'AskUserQuestion', timestamp: 1 }],
        } as unknown as SessionState,
      },
      socket,
    } as never)

    const result = useConnectionStore.getState().sendUserQuestionResponse('Option A', 'tool-1')

    expect(sendCalls(socket)).toHaveLength(1)
    // user_question_response IS offline-queueable in the dashboard, so a failed
    // live send falls through to the queue rather than reporting a phantom 'sent'.
    expect(result).toBe('queued')
    // The optimistic isIdle/activeTools flips run before the send and are kept on
    // the queue fallback (identical to the offline path; the server reconciles).
    const ss = useConnectionStore.getState().sessionStates['sess-1']!
    expect(ss.isIdle).toBe(false)
    expect(ss.activeTools.find((t) => t.toolUseId === 'tool-1')).toBeUndefined()
  })
})

describe('#6310 — dashboard notification-prefs setters do not lie on a closing socket', () => {
  const seedPrefs = (store: { setState: (s: never) => void }, socket: WebSocket): void => {
    store.setState({
      socket,
      notificationPrefs: {
        categories: {},
        devices: { 'dev-1': { categories: {} } },
        quietHours: null,
        bypassCategories: [],
      },
    } as never)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prefs = (store: { getState: () => { notificationPrefs: unknown } }): any => store.getState().notificationPrefs

  it('setNotificationPrefsCategory: returns false + no optimistic flip when the send throws', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    seedPrefs(useConnectionStore, socket)
    const result = useConnectionStore.getState().setNotificationPrefsCategory('push', false)
    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    expect(prefs(useConnectionStore).categories.push).toBeUndefined()
  })

  it('setNotificationPrefsCategory: applies the optimistic flip on a healthy send', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    seedPrefs(useConnectionStore, socket)
    expect(useConnectionStore.getState().setNotificationPrefsCategory('push', false)).toBe(true)
    expect(prefs(useConnectionStore).categories.push).toBe(false)
  })

  it('setNotificationPrefsDevice: returns false + no optimistic patch when the send throws', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    seedPrefs(useConnectionStore, socket)
    const result = useConnectionStore.getState().setNotificationPrefsDevice('dev-1', 'push', false)
    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    expect(prefs(useConnectionStore).devices['dev-1'].categories.push).toBeUndefined()
  })

  it('deleteNotificationPrefsDevice: returns false + keeps the row when the send throws', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    seedPrefs(useConnectionStore, socket)
    const result = useConnectionStore.getState().deleteNotificationPrefsDevice('dev-1')
    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    expect(prefs(useConnectionStore).devices['dev-1']).toBeDefined()
  })

  it('setNotificationPrefsQuietHours: returns false + no optimistic set when the send throws', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    seedPrefs(useConnectionStore, socket)
    const result = useConnectionStore.getState().setNotificationPrefsQuietHours({ start: '22:00', end: '07:00', timezone: 'UTC' })
    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    expect(prefs(useConnectionStore).quietHours).toBeNull()
  })

  it('setNotificationPrefsBypassCategories: returns false + no optimistic set when the send throws', async () => {
    const { useConnectionStore } = await import('./connection')
    const socket = closingSocket()
    seedPrefs(useConnectionStore, socket)
    const result = useConnectionStore.getState().setNotificationPrefsBypassCategories(['errors'])
    expect(sendCalls(socket)).toHaveLength(1)
    expect(result).toBe(false)
    expect(prefs(useConnectionStore).bypassCategories).toEqual([])
  })
})

describe('#6313 — dashboard terminal resync sends', () => {
  it('subscribeTerminalMirror sends terminal_subscribe then terminal_resync', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent) } as never)
    useConnectionStore.getState().subscribeTerminalMirror('s1')
    expect(sent).toEqual([
      { type: 'terminal_subscribe', sessionId: 's1' },
      { type: 'terminal_resync', sessionId: 's1' },
    ])
  })

  it('requestTerminalResync sends a standalone terminal_resync (manual refresh)', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({ socket: liveSocket(sent) } as never)
    useConnectionStore.getState().requestTerminalResync('s1')
    expect(sent).toEqual([{ type: 'terminal_resync', sessionId: 's1' }])
  })

  it('both are no-ops on a closed socket (best-effort)', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({ socket: null } as never)
    expect(() => useConnectionStore.getState().subscribeTerminalMirror('s1')).not.toThrow()
    expect(() => useConnectionStore.getState().requestTerminalResync('s1')).not.toThrow()
  })
})

describe('#7029 — addMcpServer / removeMcpServer resolve immediately when the send fails', () => {
  it('addMcpServer: calls back NOT_CONNECTED synchronously and leaves no pending op when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const { _testMcpServerOpPendingSize } = await import('./message-handler')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)

    const cb = vi.fn()
    useConnectionStore.getState().addMcpServer('filesystem', { command: 'npx', args: ['x'] }, 'user', cb)

    expect(sendCalls(socket)).toHaveLength(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ ok: false, code: 'NOT_CONNECTED', message: 'Not connected to the daemon.' })
    expect(_testMcpServerOpPendingSize()).toBe(0)
  })

  it('removeMcpServer: calls back NOT_CONNECTED synchronously and leaves no pending op when the send throws', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const { _testMcpServerOpPendingSize } = await import('./message-handler')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)

    const cb = vi.fn()
    useConnectionStore.getState().removeMcpServer('filesystem', 'user', cb)

    expect(sendCalls(socket)).toHaveLength(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ ok: false, code: 'NOT_CONNECTED', message: 'Not connected to the daemon.' })
    expect(_testMcpServerOpPendingSize()).toBe(0)
  })

  it('the 15s timeout never fires a second callback after a send-failed addMcpServer (exactly-once)', async () => {
    vi.useFakeTimers()
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const { _testMcpServerOpPendingSize, MCP_SERVER_OP_TIMEOUT_MS } = await import('./message-handler')
    const socket = closingSocket()
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)

    const cb = vi.fn()
    useConnectionStore.getState().addMcpServer('filesystem', {}, 'user', cb)
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(MCP_SERVER_OP_TIMEOUT_MS)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(_testMcpServerOpPendingSize()).toBe(0)
    vi.useRealTimers()
  })

  it('addMcpServer: a healthy send still arms the one-shot and does not call back synchronously', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const { _testMcpServerOpPendingSize, clearPendingMcpServerOps } = await import('./message-handler')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)

    const cb = vi.fn()
    useConnectionStore.getState().addMcpServer('filesystem', { command: 'npx' }, 'user', cb)
    expect(sent).toHaveLength(1)
    expect(cb).not.toHaveBeenCalled()
    expect(_testMcpServerOpPendingSize()).toBe(1)
    clearPendingMcpServerOps()
  })

  it('removeMcpServer: a healthy send still arms the one-shot and does not call back synchronously', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const { _testMcpServerOpPendingSize, clearPendingMcpServerOps } = await import('./message-handler')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)

    const cb = vi.fn()
    useConnectionStore.getState().removeMcpServer('filesystem', 'user', cb)
    expect(sent).toHaveLength(1)
    expect(cb).not.toHaveBeenCalled()
    expect(_testMcpServerOpPendingSize()).toBe(1)
    clearPendingMcpServerOps()
  })
})

describe('#6321 — dashboard setPermissionMode does not leave a phantom mode on a closing socket', () => {
  // setPermissionMode self-heals on a server PERMISSION_MODE_NOT_APPLIED rejection,
  // but a failed send has no round-trip → no rejection. The optimistic flip +
  // pending registration are gated on a real send. ('plan' skips the destructive
  // 'auto' window.confirm.) confirmPermissionMode has no optimistic flip on the
  // dashboard, so only setPermissionMode needs covering.
  async function seed(socket: WebSocket) {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [{ sessionId: 'sess-1', name: 'sess-1', provider: 'claude-sdk' }],
      sessionStates: {
        'sess-1': { ...createEmptySessionState(), permissionMode: 'default' } as unknown as SessionState,
      },
      permissionMode: 'default',
      previousPermissionMode: null,
      socket,
    } as never)
    return useConnectionStore
  }

  it('no optimistic permissionMode flip when the send throws', async () => {
    const socket = closingSocket()
    const store = await seed(socket)
    store.getState().setPermissionMode('plan')
    expect(sendCalls(socket)).toHaveLength(1)
    expect(store.getState().sessionStates['sess-1']!.permissionMode).toBe('default')
    expect(store.getState().previousPermissionMode).toBeNull()
  })

  it('applies the optimistic flip on a healthy send', async () => {
    const sent: Array<Record<string, unknown>> = []
    const socket = liveSocket(sent)
    const store = await seed(socket)
    store.getState().setPermissionMode('plan')
    expect(sent).toEqual([expect.objectContaining({ type: 'set_permission_mode', mode: 'plan' })])
    expect(store.getState().sessionStates['sess-1']!.permissionMode).toBe('plan')
  })
})

// #8086 — sibling of #7029/#6321: setModel / setThinkingLevel /
// grantCommunitySkillTrust / evaluateDraft all armed a one-shot correlation
// (a pending revert, a pending trust grant, a promise + timeout) and then
// called wsSend WITHOUT checking its boolean return. A send that fails the
// OPEN→CLOSING TOCTOU (#6283) then left the armed state dangling — a
// phantom optimistic value, a stuck SkillsPanel row with no timeout at all,
// or a promise waiting out a misleading timeout for something already known
// to have failed. Each is fixed by gating the arm on wsSend's return,
// mirroring setPermissionMode (#6321) above / setNotificationPrefsCategory
// (#6310) / sendMcpServerOp (#8085).
describe('#8086 — setModel does not leave a phantom activeModel or dangling revert on a closing socket', () => {
  async function seed(socket: WebSocket) {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': { ...createEmptySessionState(), activeModel: 'claude-sonnet-4' } as unknown as SessionState,
      },
      activeModel: 'claude-sonnet-4',
      socket,
    } as never)
    return useConnectionStore
  }

  it('no optimistic activeModel flip and no dangling pending revert when the send throws', async () => {
    const socket = closingSocket()
    const store = await seed(socket)
    const { _testModelRevertPendingSize } = await import('./message-handler')
    store.getState().setModel('claude-opus-4')
    expect(sendCalls(socket)).toHaveLength(1)
    expect(store.getState().sessionStates['sess-1']!.activeModel).toBe('claude-sonnet-4')
    expect(_testModelRevertPendingSize()).toBe(0)
  })

  it('applies the optimistic flip and arms the revert on a healthy send', async () => {
    const sent: Array<Record<string, unknown>> = []
    const socket = liveSocket(sent)
    const store = await seed(socket)
    const { _testModelRevertPendingSize } = await import('./message-handler')
    store.getState().setModel('claude-opus-4')
    expect(sent).toEqual([expect.objectContaining({ type: 'set_model', model: 'claude-opus-4' })])
    expect(store.getState().sessionStates['sess-1']!.activeModel).toBe('claude-opus-4')
    expect(_testModelRevertPendingSize()).toBe(1)
  })

  it('a send that THROWS (serialization bug, not the TOCTOU) never arms the revert either', async () => {
    // JSON.stringify happens OUTSIDE wsSend's try (#6283 keeps a real
    // serialization bug loud rather than swallowing it as a transient send
    // failure). Because setModel now checks-then-arms (wsSend before
    // registerModelChangeRequest), the throw happens before anything is
    // armed — nothing to roll back, and socket.send is never reached.
    const sent: Array<Record<string, unknown>> = []
    const socket = liveSocket(sent)
    const store = await seed(socket)
    const { _testModelRevertPendingSize } = await import('./message-handler')
    const setModelUnsafe = store.getState().setModel as unknown as (model: unknown) => void
    expect(() => setModelUnsafe(BigInt(1))).toThrow(TypeError)
    expect(sent).toHaveLength(0)
    expect(_testModelRevertPendingSize()).toBe(0)
    expect(store.getState().sessionStates['sess-1']!.activeModel).toBe('claude-sonnet-4')
  })

  it('still flips locally with no live socket (offline behavior unchanged)', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': { ...createEmptySessionState(), activeModel: 'claude-sonnet-4' } as unknown as SessionState,
      },
      activeModel: 'claude-sonnet-4',
      socket: null,
    } as never)
    useConnectionStore.getState().setModel('claude-opus-4')
    expect(useConnectionStore.getState().sessionStates['sess-1']!.activeModel).toBe('claude-opus-4')
  })
})

describe('#8086 — setThinkingLevel does not leave a phantom level or dangling revert on a closing socket', () => {
  async function seed(socket: WebSocket) {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: {
        'sess-1': { ...createEmptySessionState(), thinkingLevel: 'default' } as unknown as SessionState,
      },
      socket,
    } as never)
    return useConnectionStore
  }

  it('no optimistic thinkingLevel flip and no dangling pending revert when the send throws', async () => {
    const socket = closingSocket()
    const store = await seed(socket)
    const { _testThinkingLevelRevertPendingSize } = await import('./message-handler')
    store.getState().setThinkingLevel('high')
    expect(sendCalls(socket)).toHaveLength(1)
    expect(store.getState().sessionStates['sess-1']!.thinkingLevel).toBe('default')
    expect(_testThinkingLevelRevertPendingSize()).toBe(0)
  })

  it('applies the optimistic flip and arms the revert on a healthy send', async () => {
    const sent: Array<Record<string, unknown>> = []
    const socket = liveSocket(sent)
    const store = await seed(socket)
    const { _testThinkingLevelRevertPendingSize } = await import('./message-handler')
    store.getState().setThinkingLevel('high')
    expect(sent).toEqual([expect.objectContaining({ type: 'set_thinking_level', level: 'high' })])
    expect(store.getState().sessionStates['sess-1']!.thinkingLevel).toBe('high')
    expect(_testThinkingLevelRevertPendingSize()).toBe(1)
  })
})

describe('#8086 — grantCommunitySkillTrust never renders a row in-flight for a send that never went out', () => {
  async function seed(socket: WebSocket) {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      activeSessionId: 'sess-1',
      sessionStates: { 'sess-1': createEmptySessionState() },
      socket,
    } as never)
    return useConnectionStore
  }

  it('no pending-trust-grant registration and no pendingTrustGrants row when the send throws', async () => {
    const socket = closingSocket()
    const store = await seed(socket)
    const { _testTrustGrantPendingSize } = await import('./message-handler')
    store.getState().grantCommunitySkillTrust('my-skill', 'someone')
    expect(sendCalls(socket)).toHaveLength(1)
    expect(_testTrustGrantPendingSize()).toBe(0)
    expect(store.getState().sessionStates['sess-1']!.pendingTrustGrants ?? []).toHaveLength(0)
  })

  it('registers the pending grant and renders the row on a healthy send', async () => {
    const sent: Array<Record<string, unknown>> = []
    const socket = liveSocket(sent)
    const store = await seed(socket)
    const { _testTrustGrantPendingSize } = await import('./message-handler')
    store.getState().grantCommunitySkillTrust('my-skill', 'someone')
    expect(sent).toEqual([expect.objectContaining({ type: 'skill_trust_grant', skillName: 'my-skill', author: 'someone' })])
    expect(_testTrustGrantPendingSize()).toBe(1)
    expect(store.getState().sessionStates['sess-1']!.pendingTrustGrants).toHaveLength(1)
  })
})

describe('#8086 — evaluateDraft rejects immediately instead of waiting out the 60s timeout', () => {
  it('rejects synchronously with no pending entry and no timer armed when the send throws', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const { _testEvaluatorPendingSize } = await import('./message-handler')
    const socket = closingSocket()
    useConnectionStore.setState({ activeSessionId: 'sess-1', socket } as never)

    const rejection = useConnectionStore.getState().evaluateDraft('some draft text')
    await expect(rejection).rejects.toThrow('Not connected to server')
    expect(sendCalls(socket)).toHaveLength(1)
    expect(_testEvaluatorPendingSize()).toBe(0)

    // Exactly-once: nothing was armed, so advancing past the 60s window must
    // not throw an unhandled rejection or otherwise touch a second listener.
    const rejectSpy = vi.fn()
    rejection.catch(rejectSpy)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rejectSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('a send that THROWS (serialization bug, not the TOCTOU) rejects via the Promise constructor, no dangling entry', async () => {
    // JSON.stringify happens OUTSIDE wsSend's try (#6283 keeps a real
    // serialization bug loud). evaluateDraft now sends BEFORE arming the
    // timeout/pending-map entry, so nothing has been armed when this throws —
    // the Promise constructor catches the synchronous throw and rejects with
    // it automatically; socket.send is never reached.
    const { useConnectionStore } = await import('./connection')
    const { _testEvaluatorPendingSize } = await import('./message-handler')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({ activeSessionId: 'sess-1', socket } as never)

    const evaluateDraftUnsafe = useConnectionStore.getState().evaluateDraft as unknown as (draft: unknown) => Promise<EvaluatorResultPayload>
    await expect(evaluateDraftUnsafe(BigInt(1))).rejects.toThrow(TypeError)
    expect(sent).toHaveLength(0)
    expect(_testEvaluatorPendingSize()).toBe(0)
  })

  it('a healthy send still arms the pending request and does not resolve/reject synchronously', async () => {
    const { useConnectionStore } = await import('./connection')
    const { _testEvaluatorPendingSize } = await import('./message-handler')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({ activeSessionId: 'sess-1', socket } as never)

    let settled = false
    const promise = useConnectionStore.getState().evaluateDraft('some draft text')
    promise.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(settled).toBe(false)
    expect(_testEvaluatorPendingSize()).toBe(1)
  })
})

describe('#8086 — summarizeSession (extra site found in the #8086 sweep) rejects immediately instead of waiting out the 5min timeout', () => {
  it('rejects synchronously with no pending entry when the send throws', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await import('./connection')
    const { _testSummarizePendingSize } = await import('./summarizeRequests')
    const socket = closingSocket()
    useConnectionStore.setState({ activeSessionId: 'sess-1', socket } as never)

    const rejection = useConnectionStore.getState().summarizeSession('sess-1')
    await expect(rejection).rejects.toThrow()
    expect(sendCalls(socket)).toHaveLength(1)
    expect(_testSummarizePendingSize()).toBe(0)

    const rejectSpy = vi.fn()
    rejection.catch(rejectSpy)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(rejectSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('a healthy send still arms the pending request and does not resolve/reject synchronously', async () => {
    const { useConnectionStore } = await import('./connection')
    const { _testSummarizePendingSize } = await import('./summarizeRequests')
    const sent: unknown[] = []
    const socket = liveSocket(sent)
    useConnectionStore.setState({ activeSessionId: 'sess-1', socket } as never)

    let settled = false
    const promise = useConnectionStore.getState().summarizeSession('sess-1')
    promise.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(settled).toBe(false)
    expect(_testSummarizePendingSize()).toBe(1)
  })
})
