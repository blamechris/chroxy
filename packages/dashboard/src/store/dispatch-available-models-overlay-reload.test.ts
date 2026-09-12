/**
 * #7722 / #7728 — what a models-overlay hot-reload leaves in the store, driven
 * through the real dispatch path.
 *
 * `dispatchAvailableModels` (store-core/src/dispatch-table.ts) still applies
 * every `available_models` message it is handed — there is no provider filter on
 * the client side, and there must not be one: a client cannot know which rosters
 * it is entitled to. What #7728 changed is the SLOT each one lands in. A roster
 * is stored under its own provider key, and `selectModelsForProvider` answers
 * the only question the UI ever asks — "what does THIS session's provider
 * offer?" — so an unrouted burst can no longer leave a codex client reading the
 * gemini roster.
 *
 * The server-side routing (#7722, #7733) is still worth having and still tested
 * on its own side; these tests pin the client half, which is now robust rather
 * than dependent on it:
 *
 *   - the routed delivery (ONE codex-tagged message) leaves the codex roster
 *     readable, with the new row;
 *   - the UNROUTED burst — every roster to every client, which is what the fix
 *     would degrade into if the routing were dropped — leaves the codex roster
 *     EQUALLY readable, and every other provider's roster beside it. That is the
 *     regression #7728 fixes.
 *
 * The server-side half (that a codex client really is delivered only the
 * codex-tagged message) is asserted in
 * packages/server/tests/models-overlay-reload-broadcast.test.js — these tests
 * cannot reach across the package boundary to prove it, and deliberately do not
 * claim to. `App.test.tsx` covers the third link: what the picker actually
 * renders for the active session.
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

import { selectModelsForProvider } from '@chroxy/store-core'
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
    modelsByProvider: {
      codex: {
        models: [{ id: 'gpt-5.5-codex', fullId: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }],
        defaultModelId: 'gpt-5.5-codex',
      },
    },
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

describe('dashboard store — models-overlay reload rosters (#7722 / #7728)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  const rosterFor = (provider: string) =>
    selectModelsForProvider(store.getState().modelsByProvider, provider)
  const idsFor = (provider: string) => rosterFor(provider).models.map((m) => m.fullId)

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

  it('the ROUTED delivery leaves the codex roster readable, with the new row', () => {
    // What the server actually sends this client: its own roster, nothing else.
    handleMessage(CODEX_ROSTER, ctx() as never)

    expect(idsFor('codex')).toContain('gpt-5.5')
    expect(rosterFor('codex').defaultModelId).toBe('gpt-5.5-codex')
  })

  it('the UNROUTED burst leaves EVERY roster readable, the codex one included', () => {
    // #7728 — the regression. Deliver the whole set to this one client, as an
    // unrouted broadcast would. Pre-#7728 the last message in the burst owned
    // the single slot, so a codex session was left reading gemini's models and
    // App.tsx hid its picker.
    for (const msg of [CLAUDE_ROSTER, CODEX_ROSTER, GEMINI_ROSTER]) {
      handleMessage(msg, ctx() as never)
    }

    expect(idsFor('codex')).toEqual(['gpt-5.5-codex', 'gpt-5.5'])
    expect(idsFor('claude-sdk')).toEqual(['claude-sonnet-4-6'])
    expect(idsFor('gemini')).toEqual(['gemini-3-pro'])
    // Each provider keeps its OWN default, not the last one broadcast.
    expect(rosterFor('codex').defaultModelId).toBe('gpt-5.5-codex')
    expect(rosterFor('gemini').defaultModelId).toBe('gemini-3-pro')
  })

  it('a claude-sdk roster delivered to a codex client no longer clobbers it', () => {
    // The pre-#7722/#7728 behaviour, stated as its own case: the single
    // hardcoded claude-sdk broadcast is what hid the picker on a live codex
    // session. The claude roster now lands BESIDE the codex one.
    handleMessage(CLAUDE_ROSTER, ctx() as never)
    expect(idsFor('claude-sdk')).toEqual(['claude-sonnet-4-6'])
    expect(idsFor('codex')).toEqual(['gpt-5.5-codex'])
  })

  it('a re-broadcast for the SAME provider still replaces that provider roster', () => {
    // Keyed storage must not turn into append-only: a model the server dropped
    // has to disappear from that provider's list.
    handleMessage(CODEX_ROSTER, ctx() as never)
    handleMessage(
      { type: 'available_models', models: [{ id: 'gpt-5.5', fullId: 'gpt-5.5', label: 'GPT-5.5' }], provider: 'codex' },
      ctx() as never,
    )
    expect(idsFor('codex')).toEqual(['gpt-5.5'])
  })
})
