/**
 * Tests for auto-resume on server reconnect (#2408).
 *
 * Verifies that when the server restarts with an empty session list and the
 * client is reconnecting, a resume_conversation message is automatically sent
 * using the last persisted conversation ID.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockSend = jest.fn();
const mockLoadLastConversationId = jest.fn<Promise<string | null>, []>();
const mockPersistLastConversationId = jest.fn<Promise<void>, [string | null]>();

jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
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
  persistLastConversationId: (...args: unknown[]) => mockPersistLastConversationId(...args as [string | null]),
  loadLastConversationId: () => mockLoadLastConversationId(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn() })), setState: jest.fn() },
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
  useNotificationStore: { getState: jest.fn(() => ({ addNotification: jest.fn(), dismissNotification: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/conversations', () => ({
  useConversationStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@chroxy/store-core', () => ({
  ...jest.requireActual('@chroxy/store-core'),
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
} from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState, SessionState } from '../src/store/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'auto-resume-session-1';
const CONVERSATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeMockSocket(): WebSocket {
  return { readyState: WebSocket.OPEN, send: mockSend } as unknown as WebSocket;
}

function createMockState(socket?: WebSocket, overrides?: Partial<SessionState>): Partial<ConnectionState> {
  return {
    socket: socket ?? null,
    activeSessionId: SESSION_ID,
    sessions: [],
    sessionStates: {
      [SESSION_ID]: { ...createEmptySessionState(), ...overrides },
    },
    appendTerminalData: jest.fn(),
  } as unknown as Partial<ConnectionState>;
}

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  const store = {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
  return store;
}

/** Flush all pending microtasks (Promise resolutions). Works with fake timers. */
async function flushPromises(): Promise<void> {
  // Multiple awaits to drain chained promise chains
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto-resume on reconnect', () => {
  let store: ReturnType<typeof createMockStore> = createMockStore({} as ConnectionState);

  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
    mockSend.mockClear();
    mockLoadLastConversationId.mockClear();
    mockPersistLastConversationId.mockClear();
  });

  afterEach(() => {
    clearDeltaBuffers();
    jest.runAllTimers();
    jest.useRealTimers();
    setConnectionContext(null);
  });

  describe('session_list with non-empty list', () => {
    it('persists the active session conversationId when sessions list has sessions', async () => {
      mockPersistLastConversationId.mockResolvedValue(undefined);
      const socket = makeMockSocket();
      store = createMockStore(createMockState(socket));
      setStore(store);
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket, isReconnect: false } as any);

      handleMessage({
        type: 'session_list',
        sessions: [
          { sessionId: SESSION_ID, name: 'Test', cwd: '/home', conversationId: CONVERSATION_ID, status: 'ready', permissionMode: null, isBusy: false, createdAt: 1000 },
        ],
      });

      await flushPromises();

      expect(mockPersistLastConversationId).toHaveBeenCalledWith(CONVERSATION_ID);
    });

    it('does not persist when sessions have no conversationId', async () => {
      mockPersistLastConversationId.mockResolvedValue(undefined);
      const socket = makeMockSocket();
      store = createMockStore(createMockState(socket));
      setStore(store);
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket, isReconnect: false } as any);

      handleMessage({
        type: 'session_list',
        sessions: [
          { sessionId: SESSION_ID, name: 'Test', cwd: '/home', conversationId: null, status: 'ready', permissionMode: null, isBusy: false, createdAt: 1000 },
        ],
      });

      await flushPromises();

      expect(mockPersistLastConversationId).not.toHaveBeenCalled();
    });

    it('does not send resume_conversation on non-reconnect with non-empty list', async () => {
      const socket = makeMockSocket();
      store = createMockStore(createMockState(socket));
      setStore(store);
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket, isReconnect: false } as any);

      handleMessage({
        type: 'session_list',
        sessions: [
          { sessionId: SESSION_ID, name: 'Test', cwd: '/home', conversationId: CONVERSATION_ID, status: 'ready', permissionMode: null, isBusy: false, createdAt: 1000 },
        ],
      });

      await flushPromises();

      expect(mockSend).not.toHaveBeenCalledWith(expect.stringContaining('resume_conversation'));
    });
  });

  describe('session_list empty on reconnect (server restart)', () => {
    it('sends resume_conversation when reconnecting with empty session list and stored conversationId', async () => {
      mockLoadLastConversationId.mockResolvedValue(CONVERSATION_ID);
      const socket = makeMockSocket();
      store = createMockStore(createMockState(socket));
      setStore(store);
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket, isReconnect: true } as any);

      handleMessage({ type: 'session_list', sessions: [] });

      await flushPromises();

      expect(mockLoadLastConversationId).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('"resume_conversation"'),
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining(CONVERSATION_ID),
      );
    });

    it('does not send resume_conversation when no stored conversationId', async () => {
      mockLoadLastConversationId.mockResolvedValue(null);
      const socket = makeMockSocket();
      store = createMockStore(createMockState(socket));
      setStore(store);
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket, isReconnect: true } as any);

      handleMessage({ type: 'session_list', sessions: [] });

      await flushPromises();

      expect(mockLoadLastConversationId).toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not send resume_conversation on fresh connect (not a reconnect)', async () => {
      mockLoadLastConversationId.mockResolvedValue(CONVERSATION_ID);
      const socket = makeMockSocket();
      store = createMockStore(createMockState(socket));
      setStore(store);
      // isReconnect: false — brand new connection, e.g. first time connecting
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket, isReconnect: false } as any);

      handleMessage({ type: 'session_list', sessions: [] });

      await flushPromises();

      expect(mockLoadLastConversationId).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not send resume_conversation when socket is not open', async () => {
      mockLoadLastConversationId.mockResolvedValue(CONVERSATION_ID);
      const closedSocket = { readyState: WebSocket.CLOSED, send: mockSend } as unknown as WebSocket;
      store = createMockStore(createMockState(closedSocket));
      setStore(store);
      setConnectionContext({ url: 'wss://test.example.com', token: 'tok', socket: closedSocket, isReconnect: true } as any);

      handleMessage({ type: 'session_list', sessions: [] });

      await flushPromises();

      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
