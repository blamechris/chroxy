/**
 * #7393 — client half of the late-thinking fix (the server stopped pinging the
 * session busy for it). A thinking stream_start / delta / stream_end that arrives
 * after the turn ended must land as a completed thinking message and leave the
 * session idle and not streaming. See app/src/__tests__/store/
 * message-handler-late-thinking-idle.test.ts for the mobile twin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'
import type { ConnectionState } from './types'

const SID = 'sess-late-thinking'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

describe('a thinking stream that arrives after the turn ended (#7393)', () => {
  let store: ReturnType<typeof createMockStore>
  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    isReconnect: false,
    silent: false,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [{ sessionId: SID, name: 'A', provider: 'claude-tui' }],
      activeSessionId: SID,
      sessionStates: { [SID]: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null } },
      messages: [],
      terminalBuffer: '',
      terminalRawBuffer: '',
      customAgents: [],
      slashCommands: [],
      connectedClients: [],
      serverErrors: [],
      addServerError: () => undefined,
      appendTerminalData: () => undefined,
      serverProtocolVersion: null,
    } as unknown as Partial<ConnectionState>)
    setStore(store)
    setConnectionContext(ctx() as never)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    setConnectionContext(null)
  })

  it('lands as a completed thinking message and leaves the session idle and not streaming', () => {
    handleMessage({ type: 'stream_start', sessionId: SID, messageId: 'turn-1-thinking-0', thinking: true }, ctx() as never)
    expect(store.getState().sessionStates[SID]!.isIdle).toBe(true)
    expect(store.getState().sessionStates[SID]!.streamingMessageId).toBeNull()
    handleMessage({ type: 'stream_delta', sessionId: SID, messageId: 'turn-1-thinking-0', delta: 'late reasoning', thinking: true }, ctx() as never)
    handleMessage({ type: 'stream_end', sessionId: SID, messageId: 'turn-1-thinking-0', thinking: true, thinkingDurationMs: 900 }, ctx() as never)

    const ss = store.getState().sessionStates[SID]!
    expect(ss.isIdle).toBe(true)
    expect(ss.streamingMessageId).toBeNull()
    const thinking = ss.messages.filter((m) => m.type === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0]).toMatchObject({
      id: 'turn-1-thinking-0',
      content: 'late reasoning',
      thinkingStreaming: false,
      thinkingDurationMs: 900,
    })
  })
})
