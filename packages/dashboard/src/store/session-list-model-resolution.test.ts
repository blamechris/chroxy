/**
 * #7728 — `session_list` resolves the active session's full model id to the
 * SHORT id the picker uses, and it must do that against THAT SESSION'S provider
 * roster.
 *
 * The wire carries full ids (`claude-sonnet-4-5-20250929`) while the picker is
 * keyed by short ids (`sonnet`), so the handler looks the model up in the model
 * list. It used to look it up in the single global `availableModels` slot —
 * whichever roster was broadcast last — which on a mixed-provider machine could
 * only ever match by coincidence: a codex session's model resolved against a
 * Claude roster finds nothing, and the header then shows a raw full id.
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

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import { handleMessage, setStore, setConnectionContext, stopHeartbeat } from './message-handler'
import { createEmptySessionState } from './utils'
import type { ConnectionState } from './types'

const CODEX_SESSION = 'codex-session'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (
      s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>),
    ) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function baseState(): Partial<ConnectionState> {
  const serverErrors: unknown[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: CODEX_SESSION,
    sessionStates: { [CODEX_SESSION]: createEmptySessionState() },
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectedClients: [],
    serverErrors,
    addServerError: (e: unknown) => { serverErrors.push(e) },
    appendTerminalData: () => undefined,
    serverProtocolVersion: null,
    activeModel: null,
    // Both providers have broadcast. Only ONE of them can resolve the codex
    // session's model, and it is not the one that arrived last.
    modelsByProvider: {
      'claude-sdk': {
        models: [{ id: 'sonnet', fullId: 'claude-sonnet-4-6', label: 'Sonnet' }],
        defaultModelId: 'sonnet',
      },
      codex: {
        models: [{ id: 'gpt-5.5', fullId: 'gpt-5.5-2026-01', label: 'GPT-5.5' }],
        defaultModelId: 'gpt-5.5',
      },
    },
  } as unknown as Partial<ConnectionState>
}

describe('session_list activeModel resolution (#7728)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
    setConnectionContext(ctx() as never)
  })

  afterEach(() => {
    stopHeartbeat()
    setConnectionContext(null)
  })

  it("resolves the full model id against the active session's OWN provider roster", () => {
    handleMessage({
      type: 'session_list',
      sessions: [
        { sessionId: CODEX_SESSION, name: 'Codex', cwd: '/tmp', type: 'cli', provider: 'codex', model: 'gpt-5.5-2026-01' },
      ],
    }, ctx() as never)

    // The short id the picker is keyed by — NOT the raw full id, which is what
    // a lookup against another provider's roster (or against no roster at all)
    // leaves behind.
    expect(store.getState().activeModel).toBe('gpt-5.5')
  })

  it('falls back to the raw full id when that provider has no roster yet', () => {
    // A cannot-check: the header shows what the server said rather than a model
    // id borrowed from a provider this session does not run.
    store.setState({ modelsByProvider: {
      'claude-sdk': { models: [{ id: 'sonnet', fullId: 'claude-sonnet-4-6', label: 'Sonnet' }], defaultModelId: 'sonnet' },
      gemini: { models: [{ id: 'flash', fullId: 'gemini-3-flash', label: 'Flash' }], defaultModelId: 'flash' },
    } } as unknown as Partial<ConnectionState>)

    handleMessage({
      type: 'session_list',
      sessions: [
        { sessionId: CODEX_SESSION, name: 'Codex', cwd: '/tmp', type: 'cli', provider: 'codex', model: 'gpt-5.5-2026-01' },
      ],
    }, ctx() as never)

    expect(store.getState().activeModel).toBe('gpt-5.5-2026-01')
  })
})
