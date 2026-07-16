/**
 * Behavioral-contract switch-case test — APP side (epic #5556, sub-item 5).
 *
 * Drives the SHARED {@link SWITCH_FIXTURES} (defined once in @chroxy/store-core)
 * through the mobile app's REAL `handleMessage` switch and asserts the resulting
 * `sessionStates[id].messages` match each fixture's expectation.
 *
 * The dashboard's vitest suite (`packages/dashboard/src/store/contract-switch.test.ts`)
 * drives the SAME fixtures through the dashboard's REAL handler against the SAME
 * expectations. One fixture source + one expected output, exercised through both
 * clients' real switches ⇒ a behavioural drift in either client fails a test,
 * unlike the static handler-coverage guard (which only checks the `case` exists).
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (mirrors message-handler.test.ts)
// ---------------------------------------------------------------------------

jest.mock('../src/utils/crypto', () => ({
  // #6344: key_exchange_ok's prelude (encryption auth_ok) stashes _pendingKeyPair =
  // createKeyPair() and reads .publicKey — return a stub so it's non-falsy (mirrors
  // the dashboard crypto mock).
  createKeyPair: jest.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
  // #6325: session_list persists the active conversation id as a side effect.
  persistLastConversationId: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  // #6325: client_joined calls addClient on the roster store.
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn(), addClient: jest.fn(), removeClient: jest.fn(), setMyClientId: jest.fn(), setConnectedClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  // #6325: permission_timeout/server_error/session_warning reach for more of the
  // notification store than addNotification — seed the full surface so they
  // exercise their real switch path instead of throwing on an undefined method.
  useNotificationStore: {
    getState: jest.fn(() => ({
      addNotification: jest.fn(),
      dismissNotification: jest.fn(),
      sessionNotifications: [],
      addSessionNotification: jest.fn(),
      dismissSessionNotification: jest.fn(),
      setTimeoutWarning: jest.fn(),
      addServerError: jest.fn(),
      setShutdown: jest.fn(),
    })),
    setState: jest.fn(),
  },
}));

jest.mock('../src/store/conversations', () => ({
  // #6325: conversations_list/search_results mirror into the conversation store.
  useConversationStore: {
    getState: jest.fn(() => ({ setConversationHistory: jest.fn(), setSearchResults: jest.fn() })),
    setState: jest.fn(),
  },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  // #6325: server_mode/auth_ok/auth_fail/pair_fail route connection state into
  // the lifecycle store — provide the full setter surface they reach for.
  useConnectionLifecycleStore: {
    getState: jest.fn(() => ({
      setServerInfo: jest.fn(),
      setConnectionPhase: jest.fn(),
      setConnectionDetails: jest.fn(),
      setActivePath: jest.fn(),
      setConnectionError: jest.fn(),
      setUserDisconnected: jest.fn(),
      setSavedConnection: jest.fn(),
      savedConnection: null,
    })),
    setState: jest.fn(),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@chroxy/store-core', () => ({
  ...jest.requireActual('../../store-core/src/index'),
  parseUserInputMessage: jest.fn((text: string) => ({ type: 'text', content: text })),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
  updateSession,
  resetReplayFlags,
} from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState, SessionState } from '../src/store/types';
import {
  SWITCH_FIXTURES,
  type ContractFixture,
  FakeHandshakeServer,
  FakeHandshakeClient,
  type HandshakeStoreAdapter,
  type DriverMessage,
} from '@chroxy/store-core';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
}

const mockCtx = {
  url: 'wss://test.example.com',
  token: 'test-token',
  // #6325/#6344: auth_fail/pair_fail call ctx.socket.close(); the key_exchange_ok
  // prelude (encryption auth_ok) sends a discrete key_exchange via ctx.socket.send.
  socket: { close: jest.fn(), send: jest.fn() } as unknown as WebSocket,
  isReconnect: false,
  silent: false,
};

/** Strip non-deterministic fields so the output matches the stable fixture. */
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
  }));
}

/** Seed an app store from a fixture's init. */
function seedStore(fx: ContractFixture) {
  const sessionStates: Record<string, SessionState> = {};
  for (const [id, seed] of Object.entries(fx.init?.sessions ?? {})) {
    sessionStates[id] = { ...createEmptySessionState(), ...(seed as Partial<SessionState>) };
  }
  // #6345: capture appendTerminalData args so a fixture can assert terminal-mirror
  // writes (raw / raw_background / terminal_output) via expect.terminalWrites,
  // mirroring the dashboard harness's _terminalWrites.
  const terminalWrites: string[] = [];
  const store = createMockStore({
    activeSessionId: fx.init?.activeSessionId ?? null,
    sessions: [],
    availableProviders: [],
    sessionStates,
    messages: [],
    addMessage: jest.fn(),
    // The app's stream/tool handlers reach for the store's appendTerminalData.
    appendTerminalData: (d: string) => {
      terminalWrites.push(d);
    },
    _terminalWrites: terminalWrites,
    // #6325: flat connection-state fields the real store always initialises;
    // seed them so handlers that read them (client_joined → connectedClients,
    // activity_delta/_snapshot → activity, server_error → serverErrors,
    // plan_ready/permission_timeout → sessionNotifications) exercise their real
    // path instead of throwing on undefined. Off the asserted sessions[id] slice,
    // so existing fixtures are unaffected.
    connectedClients: [],
    activity: { bySession: {} },
    serverErrors: [],
    sessionNotifications: [],
    // #6268: web_task_error maps over state.webTasks; seed it (default []) so the
    // .map never throws, and let a fixture seed a task to flip to `failed`.
    webTasks: fx.init?.webTasks ?? [],
    // #6325: store methods the session-lifecycle handlers call at their tail —
    // no-op stubs so session_switched/checkpoint_restored don't throw on an
    // undefined method. switchSession is wired below (it must write activeSessionId).
    fetchSlashCommands: jest.fn(),
    fetchCustomAgents: jest.fn(),
  } as unknown as ConnectionState);
  // #6325: checkpoint_restored calls get().switchSession(newId) — stub it to
  // write the flat activeSessionId (the both-clients converged effect the fixture
  // asserts). setState spreads prior state, so the method survives later writes.
  (store.getState() as unknown as { switchSession: unknown }).switchSession = jest.fn((sessionId: string) =>
    store.setState({ activeSessionId: sessionId }),
  );
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract switch fixtures — app real handleMessage (#5556.5)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
    // #6325: reset the per-context replay flags between fixtures (the dashboard
    // twin already does). Without this a prior history-replay fixture leaves a
    // session in `_ctx.replayingSessions`, which gates off activity_delta's
    // inactivity-warning clear (test-order contamination).
    resetReplayFlags();
  });

  afterEach(() => {
    clearDeltaBuffers();
    jest.runAllTimers();
    jest.useRealTimers();
    setConnectionContext(null);
  });

  for (const fx of SWITCH_FIXTURES) {
    it(`${fx.name}`, () => {
      const store = seedStore(fx);
      setStore(store);
      setConnectionContext(mockCtx as never);

      // #6344: dispatch any prelude messages through the real handler first to
      // establish multi-message context (e.g. a history_replay_start baseline).
      for (const pre of fx.prelude ?? []) {
        handleMessage(pre);
      }
      handleMessage(fx.message);
      // Stream cases buffer deltas behind a flush timer; drain it.
      jest.runAllTimers();

      const exp = fx.expect ?? fx.divergent?.app;
      expect(exp).toBeDefined();

      for (const [id, fields] of Object.entries(exp!.sessions ?? {})) {
        const ss = (store.getState() as unknown as { sessionStates: Record<string, SessionState> })
          .sessionStates[id];
        expect(ss).toBeDefined();
        if (fields.messages) {
          const expected = fields.messages as Array<Record<string, unknown>>;
          const actual = normalize(ss.messages);
          expect(actual).toHaveLength(expected.length);
          expected.forEach((m, i) => {
            expect(actual[i]).toMatchObject(m);
          });
        }
        // #6325: assert any session-SCALAR fields a fixture specifies beyond
        // `messages` (isIdle, claudeReady, streamingMessageId, permissionMode, …).
        // Additive — message-only fixtures have no scalar keys, so they're
        // unaffected; this unlocks the session-field types in the drain backlog.
        const { messages: _ignoredMessages, ...scalarFields } = fields as Record<string, unknown>;
        void _ignoredMessages;
        if (Object.keys(scalarFields).length > 0) {
          expect(ss).toMatchObject(scalarFields);
        }
      }
      // #6325: assert any flat (top-level connection-state) fields a fixture
      // specifies — server_mode, serverStatus, connectedClients, conversations,
      // searchResults, … — via toMatchObject on the whole store. Omitted slice =
      // "don't care", so existing fixtures are unaffected.
      if (exp!.flat) {
        expect(store.getState()).toMatchObject(exp!.flat);
      }
      // #6345: assert the ordered terminal-mirror writes (appendTerminalData args)
      // a fixture drives (raw / raw_background / terminal_output).
      if (exp!.terminalWrites) {
        expect((store.getState() as unknown as { _terminalWrites: string[] })._terminalWrites).toEqual(
          exp!.terminalWrites,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Targeted in-place-flip assertion for permission_resolved (#6074)
//
// The SWITCH_FIXTURES shape contract above strips non-whitelist fields via
// normalize(), so it cannot observe the in-place mutation of answered /
// answeredAt / options. This separate test drives the same real handleMessage
// path and asserts the fields that are invisible to normalize().
// ---------------------------------------------------------------------------

describe('permission_resolved flips answered + clears options (in-place)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
  });

  afterEach(() => {
    clearDeltaBuffers();
    jest.runAllTimers();
    jest.useRealTimers();
    setConnectionContext(null);
  });

  it('permission_resolved flips answered + clears options (in-place) (#6074)', () => {
    const before = Date.now();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      availableProviders: [],
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
      addMessage: jest.fn(),
      appendTerminalData: jest.fn(),
    } as unknown as ConnectionState);
    setStore(store);
    setConnectionContext(mockCtx as never);

    handleMessage({ type: 'permission_resolved', requestId: 'req-1', decision: 'allow' });
    const after = Date.now();

    const ss = (store.getState() as unknown as { sessionStates: Record<string, SessionState> })
      .sessionStates['s1'];
    expect(ss.messages).toHaveLength(1);
    const bubble = ss.messages[0] as unknown as Record<string, unknown>;
    // Shape invariant: same id/type/content/tool (not duplicated or wiped)
    expect(bubble.id).toBe('prompt-req-1');
    expect(bubble.type).toBe('prompt');
    expect(bubble.content).toBe('Bash: rm -rf /tmp/x');
    expect(bubble.tool).toBe('Bash');
    // In-place flip: answered set to the decision string, options cleared
    expect(bubble.answered).toBe('allow');
    expect(typeof bubble.answeredAt).toBe('number');
    expect(bubble.answeredAt as number).toBeGreaterThanOrEqual(before);
    expect(bubble.answeredAt as number).toBeLessThanOrEqual(after);
    expect(bubble.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Encrypted-handshake replay INTO the app's real store (#5556.6)
//
// The shared fake-WS handshake driver (REAL store-core crypto) runs the full
// keyed sequence and writes replayed/live messages through a HandshakeStoreAdapter
// backed by the app's REAL `updateSession`. Same per-client-adapter pattern as the
// contract fixtures: one driver, a thin store binding per client.
// ---------------------------------------------------------------------------

describe('encrypted handshake replay into the app store (#5556.6)', () => {
  afterEach(() => {
    setConnectionContext(null);
  });

  it('decrypts the replay burst and lands the messages in the real session state', () => {
    const sid = 's1';
    const store = createMockStore({
      activeSessionId: sid,
      sessions: [],
      availableProviders: [],
      sessionStates: { [sid]: { ...createEmptySessionState(), messages: [] } },
      messages: [],
      addMessage: jest.fn(),
    } as unknown as ConnectionState);
    setStore(store);

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
    };

    const server = new FakeHandshakeServer();
    const client = new FakeHandshakeClient(adapter, { pinnedIdentityKey: server.identityPublicKey });
    const auth = client.sendAuth();
    server.keyExchangeWithClient(auth.publicKey as string);
    const decision = client.handleAuthOk(server.authOk());
    expect(decision.action).toBe('connect');

    client.receive(server.encryptFrame({ type: 'history_replay_start', sessionId: sid, fullHistory: true }));
    client.receive(
      server.encryptFrame({
        type: 'history_replay_entry',
        sessionId: sid,
        entry: { id: 'h1', type: 'response', content: 'replayed' },
        historySeq: 1,
      }),
    );
    client.receive(server.encryptFrame({ type: 'history_replay_end', sessionId: sid, latestSeq: 1 }));
    client.receive(
      server.encryptFrame({
        type: 'live_message',
        sessionId: sid,
        entry: { id: 'L1', type: 'response', content: 'live' },
      }),
    );

    const ss = (store.getState() as unknown as { sessionStates: Record<string, SessionState> })
      .sessionStates[sid];
    expect((ss.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(['h1', 'L1']);
    expect(client.plaintextAfterActivation).toEqual([]);
  });
});
