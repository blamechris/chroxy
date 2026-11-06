/**
 * #8965 -- in-progress turn content that `streamingMessageId` does not name must
 * survive a FULL replay swap in the mobile app, as it does in the dashboard
 * (packages/dashboard/src/store/replay-swap-live-stream.test.ts): a response
 * split at a permission prompt, a response whose stream_end lands inside the
 * replay window, and a still-running tool card. The shared rule is pinned in
 * store-core's replay-inflight-turn-carry.test.ts.
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
  clearPermissionSplits,
  resetReplayFlags,
} from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState, SessionState } from '../src/store/types';

const SID = 'sess-inflight';
const TURN = 'turn-1';

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
  socket: { close: jest.fn(), send: jest.fn() } as unknown as WebSocket,
  isReconnect: false,
  silent: false,
};

describe('in-flight turn content survives a full replay swap -- app (#8965)', () => {
  let store: ReturnType<typeof createMockStore>;
  const send = (msg: Record<string, unknown>) => handleMessage({ sessionId: SID, ...msg });
  const session = () =>
    (store.getState() as unknown as { sessionStates: Record<string, SessionState> }).sessionStates[SID];
  const msgs = () => session().messages;

  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
    resetReplayFlags();
    store = createMockStore({
      activeSessionId: SID,
      sessions: [],
      availableProviders: [],
      sessionStates: { [SID]: createEmptySessionState() as SessionState },
      messages: [],
      addMessage: jest.fn(),
      appendTerminalData: jest.fn(),
      addInfoNotification: jest.fn(),
      connectedClients: [],
      activity: { bySession: {} },
      serverErrors: [],
      sessionNotifications: [],
      webTasks: [],
      fetchSlashCommands: jest.fn(),
      fetchCustomAgents: jest.fn(),
    } as unknown as ConnectionState);
    setStore(store);
    setConnectionContext(mockCtx as never);
  });

  afterEach(() => {
    clearDeltaBuffers();
    clearPermissionSplits();
    jest.runAllTimers();
    jest.useRealTimers();
    resetReplayFlags();
    setConnectionContext(null);
  });

  it('keeps the pre-permission text when a permission prompt split the stream', () => {
    send({ type: 'agent_busy' });
    send({ type: 'stream_start', messageId: TURN });
    send({ type: 'stream_delta', messageId: TURN, delta: 'before the prompt' });
    jest.advanceTimersByTime(500);
    send({ type: 'permission_request', requestId: 'perm-1', tool: 'Bash', input: { command: 'ls' } });
    expect(session().streamingMessageId).toBeNull();
    send({ type: 'history_replay_start', fullHistory: true });
    send({ type: 'history_replay_end' });
    const rows = msgs().filter((m) => m.id === TURN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('before the prompt');
  });

  it('keeps a response whose stream_end lands inside the replay window', () => {
    send({ type: 'stream_start', messageId: TURN });
    send({ type: 'stream_delta', messageId: TURN, delta: 'whole answer' });
    jest.advanceTimersByTime(500);
    send({ type: 'history_replay_start', fullHistory: true });
    send({ type: 'stream_end', messageId: TURN });
    send({ type: 'history_replay_end' });
    const rows = msgs().filter((m) => m.id === TURN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('whole answer');
  });

  it('does not duplicate a response the replay already delivers', () => {
    send({ type: 'stream_start', messageId: TURN });
    send({ type: 'stream_delta', messageId: TURN, delta: 'whole answer' });
    jest.advanceTimersByTime(500);
    send({ type: 'history_replay_start', fullHistory: true });
    send({ type: 'message', messageType: 'response', messageId: TURN, content: 'whole answer', timestamp: 1, historySeq: 1 });
    send({ type: 'stream_end', messageId: TURN });
    send({ type: 'history_replay_end', latestSeq: 1 });
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(1);
  });

  it('does not resurrect a stream whose stream_end was missed once the session went idle', () => {
    send({ type: 'stream_start', messageId: TURN });
    send({ type: 'stream_delta', messageId: TURN, delta: 'partial, never persisted' });
    jest.advanceTimersByTime(500);
    send({ type: 'agent_idle' });
    // A NEXT turn is in flight, so the turnInFlight gate alone would let the stale
    // stream through; only the turn-end clear of the ledger keeps it out.
    send({ type: 'agent_busy' });
    send({ type: 'history_replay_start', fullHistory: true });
    send({ type: 'history_replay_end' });
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(0);
  });

  it('keeps a tool card that is still running', () => {
    send({ type: 'agent_busy' })
    send({ type: 'tool_start', messageId: 'tool-1', tool: 'Bash', toolUseId: 'tu-1', input: { command: 'sleep 9' } });
    send({ type: 'history_replay_start', fullHistory: true });
    send({ type: 'history_replay_end' });
    expect(msgs().filter((m) => m.type === 'tool_use').map((m) => m.id)).toEqual(['tool-1']);
  });
});
