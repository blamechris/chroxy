/**
 * Tests for the auth_ok message handler in the app.
 *
 * auth_ok is the most complex single handler (~120 lines): it sets connection
 * phase, stores server context, parses the client list, initiates encryption
 * key exchange, saves the connection, and registers push tokens.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

jest.mock('../src/utils/crypto', () => ({
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
  registerForPushNotifications: jest.fn(() => Promise.resolve('mock-push-token')),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
  persistLastConversationId: jest.fn(),
  loadLastConversationId: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

// Track calls to multi-client store methods
const mockSetMyClientId = jest.fn();
const mockSetConnectedClients = jest.fn();
jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: {
    getState: jest.fn(() => ({
      setMyClientId: mockSetMyClientId,
      setConnectedClients: mockSetConnectedClients,
    })),
    setState: jest.fn(),
  },
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

// Track calls to connection lifecycle store methods
const mockSetConnectionPhase = jest.fn();
const mockSetConnectionDetails = jest.fn();
const mockSetServerInfo = jest.fn();
const mockSetConnectionError = jest.fn();
const mockSetUserDisconnected = jest.fn();
const mockSetSavedConnection = jest.fn();
const mockSetActivePath = jest.fn();
jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: {
    getState: jest.fn(() => ({
      setConnectionPhase: mockSetConnectionPhase,
      setConnectionDetails: mockSetConnectionDetails,
      setServerInfo: mockSetServerInfo,
      setConnectionError: mockSetConnectionError,
      setUserDisconnected: mockSetUserDisconnected,
      setSavedConnection: mockSetSavedConnection,
      // #5518 — active-transport badge + dual-endpoint persistence base.
      setActivePath: mockSetActivePath,
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
  stopHeartbeat,
  resetAllHandlerState,
} from '../src/store/message-handler';
import type { ConnectionState } from '../src/store/types';
import { hapticSuccess } from '../src/utils/haptics';
import { createKeyPair } from '../src/utils/crypto';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock store compatible with setStore(). */
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

/** Create a mock WebSocket with a send spy. */
function createMockSocket(): WebSocket {
  return {
    send: jest.fn(),
    close: jest.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as WebSocket;
}

/** Build a minimal auth_ok message. */
function createAuthOkMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'auth_ok',
    serverMode: 'cli',
    cwd: '/home/user/project',
    serverVersion: '0.6.0',
    latestVersion: '0.6.1',
    serverCommit: 'abc1234',
    protocolVersion: 3,
    clientId: 'client-1',
    connectedClients: [
      { clientId: 'client-1', deviceName: 'My Phone', deviceType: 'phone', platform: 'ios' },
      { clientId: 'client-2', deviceName: 'Desktop', deviceType: 'desktop', platform: 'macos' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth_ok handler', () => {
  let store: ReturnType<typeof createMockStore>;
  let mockSocket: WebSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    clearDeltaBuffers();
    // #5555: reset module-level handler state (notably _ctx.pendingKeyPair) so
    // the eager-key-exchange fallback's `if (!_ctx.pendingKeyPair)` guard sees a
    // clean slate. Without this, a pendingKeyPair leaked from a prior test makes
    // the fallback skip createKeyPair() and the call-count assertion fails.
    resetAllHandlerState();

    mockSocket = createMockSocket();
    store = createMockStore({
      socket: null,
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      terminalBuffer: 'old terminal',
      terminalRawBuffer: 'old raw',
      customAgents: [],
      slashCommands: [],
    } as unknown as ConnectionState);
    setStore(store);
  });

  afterEach(() => {
    stopHeartbeat();
    clearDeltaBuffers();
    setConnectionContext(null);
  });

  describe('fresh connection', () => {
    it('sets connectionPhase to connected', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetConnectionPhase).toHaveBeenCalledWith('connected');
    });

    it('stores server version and commit in lifecycle store', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverVersion: '0.6.0',
        latestVersion: '0.6.1',
        serverCommit: 'abc1234',
        serverMode: 'cli',
        serverProtocolVersion: 3,
        sessionCwd: '/home/user/project',
      }));
    });

    it('stores connection details (url and token)', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetConnectionDetails).toHaveBeenCalledWith('wss://test.example.com', 'tok');
    });

    it('clears connection error and resets user disconnected', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetConnectionError).toHaveBeenCalledWith(null, 0);
      expect(mockSetUserDisconnected).toHaveBeenCalledWith(false);
    });

    it('resets terminal buffers and session state on fresh connect', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      const state = store.getState();
      expect(state.terminalBuffer).toBe('');
      expect(state.terminalRawBuffer).toBe('');
      expect(state.sessions).toEqual([]);
      expect(state.activeSessionId).toBeNull();
      expect(state.sessionStates).toEqual({});
      expect(state.customAgents).toEqual([]);
    });

    it('fires haptic feedback on fresh connect', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(hapticSuccess).toHaveBeenCalled();
    });
  });

  describe('server capabilities', () => {
    it('parses protocolVersion as integer >= 1', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ protocolVersion: 5 }), ctx as any);

      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverProtocolVersion: 5,
      }));
    });

    it('rejects invalid protocolVersion (not integer, < 1, or non-number)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };

      // Non-integer
      handleMessage(createAuthOkMessage({ protocolVersion: 2.5 }), ctx as any);
      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverProtocolVersion: null,
      }));

      jest.clearAllMocks();

      // Zero
      handleMessage(createAuthOkMessage({ protocolVersion: 0 }), ctx as any);
      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverProtocolVersion: null,
      }));

      jest.clearAllMocks();

      // String
      handleMessage(createAuthOkMessage({ protocolVersion: '3' }), ctx as any);
      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverProtocolVersion: null,
      }));
    });

    it('sets isEncrypted to false when encryption not required', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetServerInfo).toHaveBeenCalledWith({ isEncrypted: false });
    });

    it('sets isEncrypted to true when encryption is required', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ encryption: 'required' }), ctx as any);

      expect(mockSetServerInfo).toHaveBeenCalledWith({ isEncrypted: true });
    });

    it('parses webFeatures from auth_ok', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({
        webFeatures: { available: true, remote: false, teleport: true },
      }), ctx as any);

      const state = store.getState();
      expect(state.webFeatures).toEqual({ available: true, remote: false, teleport: true });
    });

    it('defaults webFeatures to all false when not provided', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      const state = store.getState();
      expect(state.webFeatures).toEqual({ available: false, remote: false, teleport: false });
    });

    // #3760: server now broadcasts its effective inactivity timeout so the
    // ActivityIndicator can render its "approaching timeout" warning against
    // the real configured value instead of a hardcoded BaseSession default.
    it('stores server resultTimeoutMs when present', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ resultTimeoutMs: 45 * 60 * 1000 }), ctx as any);

      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverResultTimeoutMs: 45 * 60 * 1000,
      }));
    });

    it('leaves serverResultTimeoutMs null when older server omits the field', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
        serverResultTimeoutMs: null,
      }));
    });

    it('ignores malformed resultTimeoutMs values (non-positive, non-finite, or non-number)', () => {
      // NaN/Infinity are explicitly rejected to mirror the server's
      // Number.isFinite guard so the client never stores an unusable timeout.
      for (const bad of [0, -1, NaN, Infinity, -Infinity, 'twenty minutes', null]) {
        jest.clearAllMocks();
        const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
        handleMessage(createAuthOkMessage({ resultTimeoutMs: bad }), ctx as any);
        expect(mockSetServerInfo).toHaveBeenCalledWith(expect.objectContaining({
          serverResultTimeoutMs: null,
        }));
      }
    });
  });

  describe('post-auth messages', () => {
    it('sends list_providers, list_slash_commands, and list_agents when no encryption', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      const sends = (mockSocket.send as jest.Mock).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string)
      );
      const types = sends.map((s: Record<string, unknown>) => s.type);
      expect(types).toContain('list_providers');
      expect(types).toContain('list_slash_commands');
      expect(types).toContain('list_agents');
    });

    it('defers post-auth messages when encryption is required', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ encryption: 'required' }), ctx as any);

      const sends = (mockSocket.send as jest.Mock).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string)
      );
      const types = sends.map((s: Record<string, unknown>) => s.type);
      // Should send key_exchange but NOT list_providers/list_slash_commands/list_agents yet
      expect(types).toContain('key_exchange');
      expect(types).not.toContain('list_providers');
      expect(types).not.toContain('list_slash_commands');
      expect(types).not.toContain('list_agents');
    });

    it('initiates key exchange with createKeyPair when encryption required', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ encryption: 'required' }), ctx as any);

      expect(createKeyPair).toHaveBeenCalled();
      const sends = (mockSocket.send as jest.Mock).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string)
      );
      const keyExchange = sends.find((s: Record<string, unknown>) => s.type === 'key_exchange');
      expect(keyExchange).toEqual({ type: 'key_exchange', publicKey: 'mock-pub', salt: 'mock-salt' });
    });
  });

  describe('client list parsing', () => {
    it('parses clients array and detects self by clientId', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({
        clientId: 'client-1',
        connectedClients: [
          { clientId: 'client-1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
          { clientId: 'client-2', deviceName: 'Desktop', deviceType: 'desktop', platform: 'macos' },
        ],
      }), ctx as any);

      expect(mockSetMyClientId).toHaveBeenCalledWith('client-1');
      expect(mockSetConnectedClients).toHaveBeenCalledWith([
        { clientId: 'client-1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios', isSelf: true },
        { clientId: 'client-2', deviceName: 'Desktop', deviceType: 'desktop', platform: 'macos', isSelf: false },
      ]);
    });

    it('filters out invalid clients (missing clientId)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({
        clientId: 'client-1',
        connectedClients: [
          { clientId: 'client-1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
          { deviceName: 'No ID' },
          null,
          42,
        ],
      }), ctx as any);

      expect(mockSetConnectedClients).toHaveBeenCalledWith([
        { clientId: 'client-1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios', isSelf: true },
      ]);
    });

    it('defaults deviceType to unknown for invalid values', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({
        clientId: 'c1',
        connectedClients: [
          { clientId: 'c1', deviceName: 'X', deviceType: 'spaceship', platform: 'mars' },
        ],
      }), ctx as any);

      expect(mockSetConnectedClients).toHaveBeenCalledWith([
        expect.objectContaining({ deviceType: 'unknown' }),
      ]);
    });

    it('handles empty connectedClients array', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ connectedClients: [] }), ctx as any);

      expect(mockSetConnectedClients).toHaveBeenCalledWith([]);
    });

    it('handles missing connectedClients (not an array)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ connectedClients: undefined }), ctx as any);

      expect(mockSetConnectedClients).toHaveBeenCalledWith([]);
    });
  });

  describe('reconnection', () => {
    it('preserves terminal buffers and session state on reconnect', () => {
      store = createMockStore({
        socket: null,
        sessions: [{ id: 'sess-1', name: 'Test' }],
        activeSessionId: 'sess-1',
        sessionStates: { 'sess-1': { messages: [{ id: 'm1', type: 'response', content: 'hello' }] } },
        terminalBuffer: 'existing terminal',
        terminalRawBuffer: 'existing raw',
        customAgents: [{ name: 'agent1' }],
      } as unknown as ConnectionState);
      setStore(store);

      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      const state = store.getState();
      // On reconnect, these should NOT be reset
      expect(state.terminalBuffer).toBe('existing terminal');
      expect(state.terminalRawBuffer).toBe('existing raw');
      expect(state.sessions).toEqual([{ id: 'sess-1', name: 'Test' }]);
      expect(state.activeSessionId).toBe('sess-1');
      expect(state.sessionStates['sess-1'].messages).toHaveLength(1);
      expect(state.customAgents).toEqual([{ name: 'agent1' }]);
    });

    it('does not fire haptic feedback on reconnect', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(hapticSuccess).not.toHaveBeenCalled();
    });

    it('still updates socket and connection lifecycle on reconnect', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetConnectionPhase).toHaveBeenCalledWith('connected');
      const state = store.getState();
      expect(state.socket).toBe(mockSocket);
    });
  });

  describe('session token from pairing', () => {
    it('uses sessionToken from auth_ok when provided (pairing flow)', () => {
      const ctx = { url: 'wss://t', token: 'original-tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage({ sessionToken: 'paired-tok' }), ctx as any);

      // Connection details should use the sessionToken, not original token
      expect(mockSetConnectionDetails).toHaveBeenCalledWith('wss://t', 'paired-tok');
      // #5518 — wss:// connect records the tunnel endpoint; no LAN candidate.
      expect(mockSetSavedConnection).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'wss://t', token: 'paired-tok', tunnelUrl: 'wss://t' }),
      );
      const saved = mockSetSavedConnection.mock.calls.at(-1)![0];
      expect(saved.lanUrl).toBeUndefined();
      expect(saved.lanVerified).toBeFalsy();
    });

    it('falls back to original token when sessionToken is absent', () => {
      const ctx = { url: 'wss://t', token: 'original-tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetConnectionDetails).toHaveBeenCalledWith('wss://t', 'original-tok');
      expect(mockSetSavedConnection).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'wss://t', token: 'original-tok', tunnelUrl: 'wss://t' }),
      );
    });
  });

  describe('saved connection', () => {
    it('saves connection for quick reconnect', () => {
      const ctx = { url: 'wss://my.server.com', token: 'my-tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetSavedConnection).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'wss://my.server.com', token: 'my-tok' }),
      );
    });

    it('#5518 — marks a ws:// LAN connect as the verified LAN candidate', () => {
      const ctx = { url: 'ws://192.168.1.5:8765', token: 'lan-tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);

      expect(mockSetActivePath).toHaveBeenCalledWith('lan');
      const saved = mockSetSavedConnection.mock.calls.at(-1)![0];
      expect(saved.lanUrl).toBe('ws://192.168.1.5:8765');
      expect(saved.lanVerified).toBe(true);
    });

    it('#5518 — sets activePath to tunnel for a wss:// connect', () => {
      const ctx = { url: 'wss://my.server.com', token: 'my-tok', socket: mockSocket, isReconnect: false, silent: false };
      handleMessage(createAuthOkMessage(), ctx as any);
      expect(mockSetActivePath).toHaveBeenCalledWith('tunnel');
    });
  });
});
