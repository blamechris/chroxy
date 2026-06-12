/**
 * App-side MITM-defence wiring for the `auth_ok` handler (#5635).
 *
 * The pure decision tree (decideKeyPinWithPairingIdentity / decodeEncryptionGate)
 * is exhaustively unit-tested in `packages/store-core/src/key-pinning.test.ts`.
 * What was NOT covered is the APP wiring that ACTS on a `refuse` decision:
 * `verifyServerIdentityOrRefuse`, `enforceEncryptionGateOrRefuse` (the
 * plaintext-downgrade gate), and `applyIdentityRefusal`. This drives the real
 * `handleMessage('auth_ok', …)` path and asserts the terminal refusal
 * side-effects (socket closed, phase → disconnected, user-disconnected latched,
 * Alert fired, pairing identity consumed) and the happy pin-on-first-use path.
 *
 * The store-core decision logic is the REAL implementation (jest.requireActual);
 * only `parseUserInputMessage` is stubbed, exactly as in auth-ok-handler.test.ts.
 * Identities and signatures are minted with the real crypto so the verified /
 * mismatch branches exercise the genuine signature check.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (mirrors auth-ok-handler.test.ts)
// ---------------------------------------------------------------------------

jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  // deriveSharedKey is only reached on the verified/pin-on-first-use path; a
  // 32-byte key keeps deriveConnectionKey happy.
  deriveSharedKey: jest.fn(() => new Uint8Array(32)),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
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

// The lifecycle store is the heart of these assertions. savedConnection is
// mutable so each test can install (or clear) a pinned identity. The setters
// are spies so we can assert the refusal effects.
const mockSetConnectionPhase = jest.fn();
const mockSetConnectionDetails = jest.fn();
const mockSetServerInfo = jest.fn();
const mockSetConnectionError = jest.fn();
const mockSetUserDisconnected = jest.fn();
const mockSetSavedConnection = jest.fn();
const mockSetActivePath = jest.fn();
let mockSavedConnection: Record<string, unknown> | null = null;
jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: {
    getState: jest.fn(() => ({
      setConnectionPhase: mockSetConnectionPhase,
      setConnectionDetails: mockSetConnectionDetails,
      setServerInfo: mockSetServerInfo,
      setConnectionError: mockSetConnectionError,
      setUserDisconnected: mockSetUserDisconnected,
      setSavedConnection: mockSetSavedConnection,
      setActivePath: mockSetActivePath,
      savedConnection: mockSavedConnection,
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

import { Alert } from 'react-native';
import {
  createKeyPair,
  createSigningKeyPair,
  signExchangeKey,
} from '../../store-core/src/index';
import {
  handleMessage,
  setStore,
  setConnectionContext,
  setPendingPairingIdentityKey,
  setPendingKeyPair,
  pendingPairingIdentityKey,
  clearDeltaBuffers,
  stopHeartbeat,
  resetAllHandlerState,
} from '../src/store/message-handler';
import type { ConnectionState } from '../src/store/types';

// jest-expo does not auto-mock react-native's Alert; spy so we can assert on it.
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
// Silence the intentional console.error / console.warn the refusal path emits.
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  return {
    getState: () => state,
    setState: (
      s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>),
    ) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
}

function createMockSocket(): WebSocket {
  return {
    send: jest.fn(),
    close: jest.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as WebSocket;
}

/**
 * Mint a real server handshake: a long-lived identity, an ephemeral exchange
 * key, and the identity's signature over that exchange key. This is what an
 * honest daemon offers in `auth_ok` on the eager-encryption path.
 */
function makeServerHandshake() {
  const identity = createSigningKeyPair();
  const exchange = createKeyPair();
  const serverKeySig = signExchangeKey(exchange.publicKey, identity.secretKey);
  return { identity, exchange, serverKeySig };
}

/** Build an `auth_ok` payload. Encryption defaults to 'required'. */
function authOk(overrides: Record<string, unknown> = {}) {
  return {
    type: 'auth_ok',
    serverMode: 'cli',
    cwd: '/home/user/project',
    serverVersion: '0.9.45',
    protocolVersion: 3,
    clientId: 'client-1',
    connectedClients: [
      { clientId: 'client-1', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
    ],
    encryption: 'required',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth_ok encryption / identity refusal gate (#5635 / #5536 / #5614)', () => {
  let store: ReturnType<typeof createMockStore>;
  let mockSocket: WebSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    clearDeltaBuffers();
    resetAllHandlerState();
    // resetAllHandlerState does NOT touch the module-level pairing identity —
    // clear it explicitly so a leak between tests can't change the decision.
    setPendingPairingIdentityKey(null);
    mockSavedConnection = null;

    // Stash an ephemeral keypair the way socket.onopen's prepareEagerKeyExchange
    // would, so the `auth_ok` handler enters the EAGER encryption branch (the one
    // that runs verifyServerIdentityOrRefuse against auth.serverPublicKey). Values
    // are placeholders — deriveSharedKey is mocked, so only presence matters.
    setPendingKeyPair({ publicKey: 'eager-pub', secretKey: 'eager-sec' } as never);

    mockSocket = createMockSocket();
    store = createMockStore({
      socket: mockSocket,
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      terminalBuffer: '',
      terminalRawBuffer: '',
      customAgents: [],
      slashCommands: [],
    } as unknown as ConnectionState);
    setStore(store);
  });

  afterEach(() => {
    stopHeartbeat();
    clearDeltaBuffers();
    setConnectionContext(null);
    setPendingPairingIdentityKey(null);
  });

  function ctx(overrides: Record<string, unknown> = {}) {
    return {
      url: 'wss://paired.example.com',
      token: 'tok',
      socket: mockSocket,
      isReconnect: false,
      silent: false,
      ...overrides,
    } as any;
  }

  /** Assert the full terminal-refusal side-effect bundle. */
  function expectRefused(expectedMessage?: string) {
    // Socket torn down.
    expect(mockSocket.close).toHaveBeenCalled();
    expect(store.getState().socket).toBeNull();
    // Phase forced to disconnected (a hard refusal, not a retry).
    expect(mockSetConnectionPhase).toHaveBeenCalledWith('disconnected');
    // Retry countdown cleared (attemptCount 0) so the banner reads terminal.
    if (expectedMessage) {
      expect(mockSetConnectionError).toHaveBeenCalledWith(expectedMessage, 0);
    } else {
      expect(mockSetConnectionError).toHaveBeenCalledWith(expect.any(String), 0);
    }
    // User-disconnected latched so the reconnect ladder does not re-dial.
    expect(mockSetUserDisconnected).toHaveBeenCalledWith(true);
    // Loud, specific Alert (not silent).
    expect(mockAlert).toHaveBeenCalledWith('Server Identity Changed', expect.any(String));
    // The pairing identity is consumed so the next dial cannot reuse it.
    expect(pendingPairingIdentityKey).toBeNull();
  }

  // -- (a) pinned identity + plaintext downgrade -----------------------------

  describe('(a) plaintext-downgrade gate', () => {
    it('REFUSES a pinned connection whose auth_ok did not negotiate encryption', () => {
      const { identity } = makeServerHandshake();
      mockSavedConnection = { pinnedIdentityKey: identity.publicKey };

      handleMessage(authOk({ encryption: 'none' }), ctx());

      expectRefused();
      // Never reached the encryption branch → no key_exchange sent.
      const sentTypes = (mockSocket.send as jest.Mock).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string).type,
      );
      expect(sentTypes).not.toContain('key_exchange');
    });

    it('REFUSES a pinned connection whose auth_ok OMITS the encryption field', () => {
      const { identity } = makeServerHandshake();
      mockSavedConnection = { pinnedIdentityKey: identity.publicKey };

      handleMessage(authOk({ encryption: undefined }), ctx());

      expectRefused();
    });

    it('REFUSES a pairing-time-pinned first connect that arrives unencrypted', () => {
      const { identity } = makeServerHandshake();
      // No committed pin yet, but a pairing identity was captured this dial.
      setPendingPairingIdentityKey(identity.publicKey);

      handleMessage(authOk({ encryption: 'none' }), ctx());

      expectRefused();
    });
  });

  // -- (b) serverKeySig mismatch vs the pin ----------------------------------

  describe('(b) signature mismatch against the committed pin', () => {
    it('REFUSES when the offered key is signed by a DIFFERENT (attacker) identity', () => {
      const real = createSigningKeyPair();
      const attacker = createSigningKeyPair();
      const attackerExchange = createKeyPair();
      const attackerSig = signExchangeKey(attackerExchange.publicKey, attacker.secretKey);
      // We pinned the REAL daemon; the handshake is signed by the attacker.
      mockSavedConnection = { pinnedIdentityKey: real.publicKey };

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: attackerExchange.publicKey,
          serverKeySig: attackerSig,
        }),
        ctx(),
      );

      expectRefused();
    });

    it('REFUSES when the exchange key was substituted (valid sig over a different key)', () => {
      const { identity, serverKeySig } = makeServerHandshake();
      const substituted = createKeyPair();
      mockSavedConnection = { pinnedIdentityKey: identity.publicKey };

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: substituted.publicKey, // not what was signed
          serverKeySig,
        }),
        ctx(),
      );

      expectRefused();
    });

    it('REFUSES a first-connect whose sig does not match the captured pairing identity', () => {
      const pairingIdentity = createSigningKeyPair();
      const mitm = createSigningKeyPair();
      const mitmExchange = createKeyPair();
      const mitmSig = signExchangeKey(mitmExchange.publicKey, mitm.secretKey);
      setPendingPairingIdentityKey(pairingIdentity.publicKey);

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: mitmExchange.publicKey,
          serverKeySig: mitmSig,
        }),
        ctx(),
      );

      expectRefused();
    });
  });

  // -- (c) unsigned-when-pinned ---------------------------------------------

  describe('(c) pinned-but-unsigned downgrade', () => {
    it('REFUSES a pinned connection whose encrypted handshake carries NO signature', () => {
      const { identity, exchange } = makeServerHandshake();
      mockSavedConnection = { pinnedIdentityKey: identity.publicKey };

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: exchange.publicKey,
          serverKeySig: undefined, // MITM stripped the signature to force TOFU
        }),
        ctx(),
      );

      expectRefused();
    });

    it('REFUSES a pairing-time-pinned first connect that is unsigned', () => {
      const { identity, exchange } = makeServerHandshake();
      setPendingPairingIdentityKey(identity.publicKey);

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: exchange.publicKey,
          serverKeySig: undefined,
        }),
        ctx(),
      );

      expectRefused();
    });
  });

  // -- (d) first-connect pin-and-connect happy path --------------------------

  describe('(d) pin-on-first-use happy path', () => {
    it('PINS the pairing identity, clears it, and does NOT refuse on a verified first connect', () => {
      const { identity, exchange, serverKeySig } = makeServerHandshake();
      setPendingPairingIdentityKey(identity.publicKey);
      // No committed pin — this is the first connect after pairing.
      mockSavedConnection = null;

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: exchange.publicKey,
          serverKeySig,
        }),
        ctx(),
      );

      // NO refusal.
      expect(mockSocket.close).not.toHaveBeenCalled();
      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockSetUserDisconnected).not.toHaveBeenCalledWith(true);
      expect(mockSetConnectionPhase).not.toHaveBeenCalledWith('disconnected');
      // Connected normally.
      expect(mockSetConnectionPhase).toHaveBeenCalledWith('connected');
      // The pairing identity was consumed once adopted.
      expect(pendingPairingIdentityKey).toBeNull();
      // The verified identity is persisted as the pin via the saved connection.
      const savedCalls = mockSetSavedConnection.mock.calls;
      expect(savedCalls.length).toBeGreaterThan(0);
      const lastSaved = savedCalls.at(-1)![0];
      expect(lastSaved.pinnedIdentityKey).toBe(identity.publicKey);
    });

    it('CONNECTS a verified reconnect against the committed pin without refusing', () => {
      const { identity, exchange, serverKeySig } = makeServerHandshake();
      mockSavedConnection = { pinnedIdentityKey: identity.publicKey };

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: exchange.publicKey,
          serverKeySig,
        }),
        ctx(),
      );

      expect(mockSocket.close).not.toHaveBeenCalled();
      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockSetConnectionPhase).toHaveBeenCalledWith('connected');
      expect(mockSetConnectionPhase).not.toHaveBeenCalledWith('disconnected');
    });

    it('keeps TOFU for an UNPINNED connection with no pairing identity (no refusal)', () => {
      const { exchange, serverKeySig } = makeServerHandshake();
      mockSavedConnection = null;
      // No pairing identity captured.

      handleMessage(
        authOk({
          encryption: 'required',
          serverPublicKey: exchange.publicKey,
          serverKeySig,
        }),
        ctx(),
      );

      expect(mockSocket.close).not.toHaveBeenCalled();
      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockSetConnectionPhase).toHaveBeenCalledWith('connected');
    });
  });

  // -- silent refusal suppresses the Alert (but still tears down) ------------

  describe('silent refusal', () => {
    it('does NOT fire the Alert when ctx.silent is true, but still refuses', () => {
      const { identity } = makeServerHandshake();
      mockSavedConnection = { pinnedIdentityKey: identity.publicKey };

      handleMessage(authOk({ encryption: 'none' }), ctx({ silent: true }));

      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockSocket.close).toHaveBeenCalled();
      expect(mockSetConnectionPhase).toHaveBeenCalledWith('disconnected');
      expect(mockSetUserDisconnected).toHaveBeenCalledWith(true);
    });
  });
});
