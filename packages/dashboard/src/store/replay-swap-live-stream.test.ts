/**
 * #8960 -- a response still streaming when a FULL replay window opens (tab switch
 * mid-turn) keeps its already-received text across the swap, through the
 * dashboard's real handler. The shared rule is pinned in store-core's
 * replay-live-stream-carry.test.ts.
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

const SID = 'sess-order'
const TURN = 'turn-1'

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


describe('a streaming response survives a full replay swap (#8960)', () => {
  let store: ReturnType<typeof createMockStore>
  const ctx = () => ({
    url: 'wss://t', token: 'tok',
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    isReconnect: false, silent: false,
  })
  const send = (msg: Record<string, unknown>) => handleMessage({ sessionId: SID, ...msg }, ctx() as never)
  const msgs = () => store.getState().sessionStates[SID]!.messages

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [{ sessionId: SID, name: 'A', provider: 'claude-tui' }],
      activeSessionId: SID,
      sessionStates: { [SID]: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null } },
      messages: [], terminalBuffer: '', terminalRawBuffer: '', customAgents: [], slashCommands: [],
      connectedClients: [], serverErrors: [], addServerError: () => undefined,
      appendTerminalData: () => undefined, serverProtocolVersion: null,
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
    vi.useRealTimers()
  })

  it('stream part one, replay window, stream part two reads "part one part two"', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'part one ' })
    vi.advanceTimersByTime(500)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    send({ type: 'stream_delta', messageId: TURN, delta: 'part two' })
    vi.advanceTimersByTime(500)
    const rows = msgs().filter((m) => m.id === TURN)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('part one part two')
  })
})
