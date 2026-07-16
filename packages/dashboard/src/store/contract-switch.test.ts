/**
 * Behavioral-contract switch-case test — DASHBOARD side (epic #5556, sub-item 5).
 *
 * Drives the SHARED {@link SWITCH_FIXTURES} (defined once in @chroxy/store-core)
 * through the dashboard's REAL `handleMessage` switch / HANDLERS map and asserts
 * the resulting `sessionStates[id].messages` match each fixture's expectation.
 *
 * The app's jest suite (`packages/app/__tests__/contract-switch.test.ts`) drives
 * the SAME fixtures through the app's REAL handler against the SAME expectations.
 * Two clients consuming one fixture source with one expected output ⇒ a drift in
 * either client's switch handler FAILS a test instead of hiding under the static
 * coverage guard (which only checks the `case` exists).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SWITCH_FIXTURES,
  type ContractFixture,
  FakeHandshakeServer,
  FakeHandshakeClient,
  type HandshakeStoreAdapter,
  type DriverMessage,
} from '@chroxy/store-core'

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

import {
  handleMessage,
  setStore,
  updateSession,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
  setConnectionContext,
} from './message-handler'
import { createEmptySessionState } from './utils'
import type { ConnectionState, SessionState } from './types'

// ---------------------------------------------------------------------------
// Harness — mirror the dashboard message-handler.test.ts mock store
// ---------------------------------------------------------------------------

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

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

const ctx = (socket: WebSocket) => ({
  url: 'wss://t',
  token: 'tok',
  socket,
  isReconnect: false,
  silent: false,
})

/**
 * Strip non-deterministic fields (generated ids that aren't asserted,
 * timestamps) so two clients' outputs are comparable to the fixture's
 * stable expectation. Keeps id only when the fixture asserts it.
 */
function normalize(messages: unknown[]): Array<Record<string, unknown>> {
  return (messages as Array<Record<string, unknown>>).map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content,
    tool: m.tool,
    toolUseId: m.toolUseId,
    // #6325: the partial-JSON accumulator (tool_input_delta) — included so a
    // fixture can assert streamed tool input. toMatchObject is partial, so
    // existing fixtures that don't assert it are unaffected.
    toolInputPartial: m.toolInputPartial,
    // #6712: the tool_result patch fields, so a fixture can assert a result was
    // attached (and flagged truncated / isError) onto its tool_use bubble.
    toolResult: m.toolResult,
    toolResultTruncated: m.toolResultTruncated,
    toolResultIsError: m.toolResultIsError,
  }))
}

/** Build a dashboard store seeded from a fixture's init. */
function seedStore(fx: ContractFixture) {
  const sessionStates: Record<string, SessionState> = {}
  for (const [id, seed] of Object.entries(fx.init?.sessions ?? {})) {
    sessionStates[id] = { ...createEmptySessionState(), ...(seed as Partial<SessionState>) }
  }
  const terminalWrites: string[] = []
  const store = createMockStore({
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: fx.init?.activeSessionId ?? null,
    sessionStates,
    messages: [],
    // #6058: the real store always initialises sessionNotifications; seed it so
    // permission_resolved's unconditional banner-drain (s.sessionNotifications.map)
    // runs against a realistic store instead of throwing on undefined.
    sessionNotifications: [],
    // #6325: flat connection-state fields the real store always initialises;
    // seed them so handlers that read them (client_joined → connectedClients,
    // activity_delta/_snapshot → activity, server_error → serverErrors) exercise
    // their real path instead of throwing on undefined. Off the asserted
    // sessions[id] slice, so existing fixtures are unaffected.
    connectedClients: [],
    activity: { bySession: {} },
    serverErrors: [],
    // #6268: web_task_error maps over state.webTasks; seed it (default []) so the
    // .map never throws, and let a fixture seed a task to flip to `failed`.
    webTasks: fx.init?.webTasks ?? [],
    // #6325: no-op stubs for the session-lifecycle handler tails
    // (session_switched calls fetchSlashCommands/fetchCustomAgents; switchSession
    // is wired below to write the flat activeSessionId for checkpoint_restored).
    fetchSlashCommands: () => {},
    fetchCustomAgents: () => {},
    // Store methods the real stream/tool handlers reach for (terminal preview
    // writes, flat addMessage). No-op-ish so the session-state assertions stand
    // alone — the terminal-preview side-channel is covered by its own tests.
    appendTerminalData: (d: string) => {
      terminalWrites.push(d)
    },
    addMessage: () => {},
    // The dashboard `error` handler routes structured errors here; stub so the
    // `error` fixture exercises the switch without a real toast store.
    addServerError: () => {},
    _terminalWrites: terminalWrites,
  } as unknown as ConnectionState)
  // #6325: checkpoint_restored calls get().switchSession(newId) — stub it to write
  // the flat activeSessionId (setState spreads prior state, so it survives writes).
  ;(store.getState() as unknown as { switchSession: unknown }).switchSession = (sessionId: string) =>
    store.setState({ activeSessionId: sessionId })
  return store
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract switch fixtures — dashboard real handleMessage (#5556.5)', () => {
  let mockSocket: WebSocket

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    mockSocket = createMockSocket()
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    setConnectionContext(null)
    vi.useRealTimers()
  })

  for (const fx of SWITCH_FIXTURES) {
    it(`${fx.name}`, () => {
      vi.useFakeTimers()
      const store = seedStore(fx)
      setStore(store)

      // #6344: dispatch any prelude messages through the real handler first to
      // establish multi-message context (e.g. a history_replay_start baseline).
      for (const pre of fx.prelude ?? []) {
        handleMessage(pre, ctx(mockSocket) as never)
      }
      handleMessage(fx.message, ctx(mockSocket) as never)
      // Stream cases buffer deltas behind a flush timer; drain it.
      vi.runAllTimers()

      const exp = fx.expect ?? fx.divergent?.dashboard
      expect(exp, `${fx.name}: fixture must declare an expectation`).toBeDefined()

      for (const [id, fields] of Object.entries(exp!.sessions ?? {})) {
        const ss = (store.getState() as unknown as { sessionStates: Record<string, SessionState> })
          .sessionStates[id]
        expect(ss, `${fx.name}: session ${id} should exist`).toBeDefined()
        if (fields.messages) {
          const expected = fields.messages as Array<Record<string, unknown>>
          const actual = normalize(ss!.messages)
          expect(actual.length, `${fx.name}: ${id} message count`).toBe(expected.length)
          expected.forEach((m, i) => {
            expect(actual[i], `${fx.name}: ${id} messages[${i}]`).toMatchObject(m)
          })
        }
        // #6325: assert any session-SCALAR fields a fixture specifies beyond
        // `messages` (isIdle, claudeReady, streamingMessageId, permissionMode, …).
        // Additive — message-only fixtures have no scalar keys, so they're
        // unaffected; this unlocks the session-field types in the drain backlog.
        const { messages: _ignoredMessages, ...scalarFields } = fields as Record<string, unknown>
        void _ignoredMessages
        if (Object.keys(scalarFields).length > 0) {
          expect(ss, `${fx.name}: ${id} scalar fields`).toMatchObject(scalarFields)
        }
      }
      // #6325: assert any flat (top-level connection-state) fields a fixture
      // specifies — serverMode, serverStatus, connectedClients, conversations,
      // searchResults, … — via toMatchObject on the whole store. Omitted slice =
      // "don't care", so existing fixtures are unaffected.
      if (exp!.flat) {
        expect(store.getState(), `${fx.name}: flat fields`).toMatchObject(exp!.flat)
      }
      // #6345: assert the ordered terminal-mirror writes (appendTerminalData args)
      // a fixture drives (raw / raw_background / terminal_output).
      if (exp!.terminalWrites) {
        expect(
          (store.getState() as unknown as { _terminalWrites: string[] })._terminalWrites,
          `${fx.name}: terminal writes`,
        ).toEqual(exp!.terminalWrites)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Targeted in-place-flip assertion for permission_resolved (#6074)
//
// The SWITCH_FIXTURES shape contract above strips non-whitelist fields via
// normalize(), so it cannot observe the in-place mutation of answered /
// answeredAt / options. This separate test drives the same real handleMessage
// path and asserts the fields that are invisible to normalize().
// ---------------------------------------------------------------------------

describe('permission_resolved flips answered + clears options (in-place)', () => {
  let mockSocket: WebSocket

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    mockSocket = createMockSocket()
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    setConnectionContext(null)
    vi.useRealTimers()
  })

  it('permission_resolved flips answered + clears options (in-place) (#6074)', () => {
    const before = Date.now()
    const store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [],
      activeSessionId: 's1',
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [
            {
              id: 'prompt-req-1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/x',
              tool: 'Bash',
              requestId: 'req-1',
              options: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }],
              answered: undefined,
              answeredAt: undefined,
            },
          ],
        },
      } as unknown as ConnectionState['sessionStates'],
      messages: [],
      sessionNotifications: [],
      appendTerminalData: () => {},
      addMessage: () => {},
      addServerError: () => {},
    } as unknown as ConnectionState)
    setStore(store)

    handleMessage(
      { type: 'permission_resolved', requestId: 'req-1', decision: 'allow' },
      ctx(mockSocket) as never,
    )
    const after = Date.now()

    const ss = (store.getState() as unknown as { sessionStates: Record<string, SessionState> })
      .sessionStates['s1']
    expect(ss!.messages).toHaveLength(1)
    const bubble = ss!.messages[0] as unknown as Record<string, unknown>
    // Shape invariant: same id/type/content/tool (not duplicated or wiped)
    expect(bubble.id).toBe('prompt-req-1')
    expect(bubble.type).toBe('prompt')
    expect(bubble.content).toBe('Bash: rm -rf /tmp/x')
    expect(bubble.tool).toBe('Bash')
    // In-place flip: answered set to the decision string, options cleared
    expect(bubble.answered).toBe('allow')
    expect(bubble.answeredAt).toBeTypeOf('number')
    expect(bubble.answeredAt as number).toBeGreaterThanOrEqual(before)
    expect(bubble.answeredAt as number).toBeLessThanOrEqual(after)
    expect(bubble.options).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Encrypted-handshake replay INTO the dashboard's real store (#5556.6)
//
// The shared fake-WS handshake driver (REAL store-core crypto — NOT the
// dashboard's mocked `./crypto`, which the driver does not import) runs the full
// keyed sequence and writes replayed/live messages through a HandshakeStoreAdapter
// backed by the dashboard's REAL `updateSession`. Same per-client-adapter pattern
// as the contract fixtures: one driver, a thin store binding per client.
// ---------------------------------------------------------------------------

describe('encrypted handshake replay into the dashboard store (#5556.6)', () => {
  beforeEach(() => {
    clearDeltaBuffers()
    resetReplayFlags()
  })
  afterEach(() => {
    setConnectionContext(null)
  })

  it('decrypts the replay burst and lands the messages in the real session state', () => {
    const sid = 's1'
    const store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [],
      activeSessionId: sid,
      sessionStates: { [sid]: { ...createEmptySessionState(), messages: [] } },
      messages: [],
    } as unknown as ConnectionState)
    setStore(store)

    // Back the driver's store adapter onto the dashboard's REAL updateSession.
    const adapter: HandshakeStoreAdapter = {
      activateEncryption: () => {},
      setMessages: (id, msgs) =>
        updateSession(id, () => ({ messages: msgs as unknown as SessionState['messages'] })),
      getMessages: (id) =>
        ((store.getState() as unknown as { sessionStates: Record<string, SessionState> })
          .sessionStates[id]?.messages ?? []) as unknown as DriverMessage[],
      applyBootstrap: () => {},
      refuse: () => {},
      pin: () => {},
    }

    const server = new FakeHandshakeServer()
    const client = new FakeHandshakeClient(adapter, { pinnedIdentityKey: server.identityPublicKey })
    const auth = client.sendAuth()
    server.keyExchangeWithClient(auth.publicKey as string)
    const decision = client.handleAuthOk(server.authOk())
    expect(decision.action).toBe('connect')

    client.receive(server.encryptFrame({ type: 'history_replay_start', sessionId: sid, fullHistory: true }))
    client.receive(
      server.encryptFrame({
        type: 'history_replay_entry',
        sessionId: sid,
        entry: { id: 'h1', type: 'response', content: 'replayed' },
        historySeq: 1,
      }),
    )
    client.receive(server.encryptFrame({ type: 'history_replay_end', sessionId: sid, latestSeq: 1 }))
    client.receive(
      server.encryptFrame({
        type: 'live_message',
        sessionId: sid,
        entry: { id: 'L1', type: 'response', content: 'live' },
      }),
    )

    const ss = (store.getState() as unknown as { sessionStates: Record<string, SessionState> })
      .sessionStates[sid]
    expect((ss!.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(['h1', 'L1'])
    expect(client.plaintextAfterActivation).toEqual([])
  })
})
