/**
 * #7722 — what a models-overlay hot-reload leaves in the store, driven through
 * the real dispatch path.
 *
 * The dashboard keeps ONE `availableModels` list plus ONE
 * `availableModelsProvider` tag, and `dispatchAvailableModels`
 * (store-core/src/dispatch-table.ts) replaces both UNCONDITIONALLY on every
 * `available_models` message — there is no provider filter on the client side.
 * `App.tsx`'s `modelsMatchProvider` then hides the model picker whenever that
 * tag disagrees with the active session's provider.
 *
 * That is the whole reason the server routes each overlay-reload roster to the
 * clients its provider owns (`overlayBroadcastReachesProvider`,
 * packages/server/src/server-cli.js) instead of broadcasting the set to
 * everyone. These tests pin the client half of that contract:
 *
 *   - the routed delivery (ONE codex-tagged message) leaves a codex client on
 *     the codex tag, so the picker survives the reload;
 *   - the UNROUTED burst — every roster to every client, which is what the fix
 *     would degrade into if the routing were dropped — leaves that same codex
 *     client on whichever provider was broadcast LAST. That control is the
 *     reason the first test is not vacuous: without it, both tests would pass
 *     just as well with the tag ignored entirely.
 *
 * The server-side half (that a codex client really is delivered only the
 * codex-tagged message) is asserted in
 * packages/server/tests/models-overlay-reload-broadcast.test.js — these tests
 * cannot reach across the package boundary to prove it, and deliberately do not
 * claim to. `App.test.tsx` covers the third link: the tag's effect on whether
 * the picker actually renders.
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
import type { ConnectionState } from './types'

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
    activeSessionId: 'codex-session',
    sessionStates: {},
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
    // What a codex client holds after its connect-time provider-scoped push.
    availableModels: [{ id: 'gpt-5.5-codex', fullId: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }],
    availableModelsProvider: 'codex',
    defaultModelId: 'gpt-5.5-codex',
  } as unknown as Partial<ConnectionState>
}

// The three rosters one overlay save can produce on a daemon that has built the
// codex and gemini registries. `gemini` sorts after `codex`, which is exactly
// how the pre-review burst could end on the wrong tag.
const CLAUDE_ROSTER = {
  type: 'available_models',
  models: [{ id: 'sonnet', fullId: 'claude-sonnet-4-6', label: 'Sonnet' }],
  defaultModel: 'claude-sonnet-4-6',
  provider: 'claude-sdk',
}
const CODEX_ROSTER = {
  type: 'available_models',
  models: [
    { id: 'gpt-5.5-codex', fullId: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' },
    { id: 'gpt-5.5', fullId: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  defaultModel: 'gpt-5.5-codex',
  provider: 'codex',
}
const GEMINI_ROSTER = {
  type: 'available_models',
  models: [{ id: 'gemini-3-pro', fullId: 'gemini-3-pro', label: 'Gemini 3 Pro' }],
  defaultModel: 'gemini-3-pro',
  provider: 'gemini',
}

describe('dashboard store — models-overlay reload rosters (#7722)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
    setConnectionContext(ctx() as any)
  })

  afterEach(() => {
    stopHeartbeat()
    setConnectionContext(null)
  })

  it('the ROUTED delivery leaves a codex client on the codex tag, with the new row', () => {
    // What the server actually sends this client: its own roster, nothing else.
    handleMessage(CODEX_ROSTER, ctx() as any)

    expect(store.getState().availableModelsProvider).toBe('codex')
    expect(store.getState().availableModels.map((m: { fullId: string }) => m.fullId))
      .toContain('gpt-5.5')
  })

  it('the UNROUTED burst leaves the same client on the LAST provider broadcast', () => {
    // The control. Deliver the whole set to this one client, as an unrouted
    // broadcast would. `dispatchAvailableModels` has no provider filter, so the
    // tag ends up wherever the burst ended — App.tsx then hides the picker.
    for (const msg of [CLAUDE_ROSTER, CODEX_ROSTER, GEMINI_ROSTER]) {
      handleMessage(msg, ctx() as any)
    }

    expect(store.getState().availableModelsProvider).toBe('gemini')
    expect(store.getState().availableModels.map((m: { fullId: string }) => m.fullId))
      .not.toContain('gpt-5.5')
  })

  it('a claude-sdk roster delivered to a codex client would clobber it too', () => {
    // The pre-#7722 behaviour, stated as its own case: the single hardcoded
    // claude-sdk broadcast is what hid the picker on a live codex session.
    handleMessage(CLAUDE_ROSTER, ctx() as any)
    expect(store.getState().availableModelsProvider).toBe('claude-sdk')
  })
})
