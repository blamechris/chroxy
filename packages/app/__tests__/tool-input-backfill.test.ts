/**
 * #8415 -- a `tool_input_backfill` frame through the REAL mobile-app handler.
 *
 * The frame gives a tool card the client already holds the input it lacks. It is
 * reconcile-only: no new card, no running tool (`activeTools` stays as it was) and
 * no terminal line. Routing it through the `tool_start` path would do all three.
 * The dashboard has the same cases in
 * packages/dashboard/src/store/tool-input-backfill.test.ts.
 */

// A `mock`-prefixed name so the hoisted jest.mock factory may reference it.
const mockTerminalAppend = jest.fn();

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
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: mockTerminalAppend })), setState: jest.fn() },
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

const SID = 's1';
const INPUT = { command: 'ls -la' };

function boot(messages: Array<Record<string, unknown>>) {
  clearDeltaBuffers();
  clearPermissionSplits();
  resetReplayFlags();
  const appendTerminalData = jest.fn();
  let state = {
    activeSessionId: SID,
    sessions: [],
    availableProviders: [],
    sessionStates: {
      [SID]: { ...createEmptySessionState(), messages, activeTools: [] } as unknown as SessionState,
    },
    messages: [],
    addMessage: jest.fn(),
    appendTerminalData,
    addInfoNotification: jest.fn(),
    connectedClients: [],
    activity: { bySession: {} },
    serverErrors: [],
    sessionNotifications: [],
    webTasks: [],
    fetchSlashCommands: jest.fn(),
    fetchCustomAgents: jest.fn(),
  } as unknown as ConnectionState;
  setStore({
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  } as never);
  setConnectionContext({
    url: 'wss://test.example.com',
    token: 'test-token',
    socket: { close: jest.fn(), send: jest.fn() } as unknown as WebSocket,
    isReconnect: false,
    silent: false,
  } as never);
  const session = () =>
    (state as unknown as { sessionStates: Record<string, SessionState> }).sessionStates[SID]!;
  return { session, appendTerminalData };
}

const bare = { id: 'tool-1', type: 'tool_use', tool: 'Bash', content: 'Bash', timestamp: 1 };
const frame = { type: 'tool_input_backfill', sessionId: SID, messageId: 'tool-1', input: INPUT };

describe('tool_input_backfill through the mobile handler (#8415)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fills the held card once, and a repeated frame changes nothing', () => {
    const { session, appendTerminalData } = boot([bare]);
    const activeBefore = session().activeTools;

    handleMessage({ ...frame });
    const filled = session().messages;
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ id: 'tool-1', toolInput: INPUT, content: JSON.stringify(INPUT) });

    for (let i = 0; i < 3; i++) handleMessage({ ...frame });
    expect(session().messages).toBe(filled);
    expect(session().activeTools).toBe(activeBefore);
    expect(session().activeTools).toEqual([]);
    expect(appendTerminalData).not.toHaveBeenCalled();
    expect(mockTerminalAppend).not.toHaveBeenCalled();
  });

  it('adds nothing for a card the client does not hold', () => {
    const { session, appendTerminalData } = boot([bare]);
    const before = session().messages;
    handleMessage({ ...frame, messageId: 'tool-gone' });
    expect(session().messages).toEqual(before);
    expect(session().activeTools).toEqual([]);
    expect(appendTerminalData).not.toHaveBeenCalled();
    expect(mockTerminalAppend).not.toHaveBeenCalled();
  });

  it('leaves a card that already has an input alone', () => {
    const { session } = boot([{ ...bare, content: '{"command":"pwd"}', toolInput: { command: 'pwd' } }]);
    handleMessage({ ...frame });
    expect(session().messages).toHaveLength(1);
    expect(session().messages[0]).toMatchObject({ toolInput: { command: 'pwd' }, content: '{"command":"pwd"}' });
  });

  it('positive control: a real terminal frame through the same handler DOES reach both terminal spies (they can fire)', () => {
    // The mobile tool_start has no terminal side effect (that is dashboard-only), so
    // terminal_output is the real frame that proves both spies are wired to the handler.
    const { appendTerminalData } = boot([bare]);
    handleMessage({ type: 'terminal_output', sessionId: SID, data: 'hello' });
    expect(appendTerminalData).toHaveBeenCalled();
    expect(mockTerminalAppend).toHaveBeenCalled();
  });
});
