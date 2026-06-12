/**
 * #5632 — post-handshake plaintext guard (consensus C3 / Adversary F1).
 *
 * Once E2E encryption is established, the socket.onmessage handler in
 * connection.ts must reject any non-`encrypted` frame that is not a permitted
 * cleartext handshake frame, failing closed on the same path a decrypt failure
 * takes (log + socket.close, no dispatch). These tests drive the real connect()
 * → socket.onmessage path with a mock WebSocket and exercise the guard directly.
 */
import { Alert } from 'react-native';
import { useConnectionStore } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { clearAllCallbacks } from '../../store/imperative-callbacks';
import {
  setEncryptionState,
  getEncryptionState,
} from '../../store/message-handler';
import {
  createKeyPair,
  deriveSharedKey,
  encrypt,
  DIRECTION_SERVER,
} from '../../utils/crypto';

// Spy on Alert.alert — avoids jest.mock('react-native') which triggers native modules
jest.spyOn(Alert, 'alert').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flushPromises(): Promise<void> {
  return new Promise((resolve) => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));
}

function mockResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  } as unknown as Response;
}

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  send: jest.Mock;
  close: jest.Mock;
}

const wsInstances: FakeSocket[] = [];
const originalFetch = global.fetch;
const OriginalWebSocket = global.WebSocket;

beforeEach(() => {
  jest.useFakeTimers();
  clearAllCallbacks();
  wsInstances.length = 0;
  useConnectionStore.setState({
    terminalBuffer: '',
    terminalRawBuffer: '',
    serverErrors: [],
    connectedClients: [],
    myClientId: null,
    primaryClientId: null,
    sessionStates: {},
    activeSessionId: null,
    socket: null,
    shutdownReason: null,
    restartEtaMs: null,
    restartingSince: null,
  });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'disconnected',
    connectionError: null,
    connectionRetryCount: 0,
    wsUrl: null,
  });

  global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
  // @ts-expect-error — mock WebSocket constructor
  global.WebSocket = class MockWebSocket implements FakeSocket {
    static OPEN = 1;
    url: string;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(url: string) {
      this.url = url;
      wsInstances.push(this as unknown as FakeSocket);
    }
  };
});

afterEach(() => {
  setEncryptionState(null);
  useConnectionStore.getState().disconnect();
  global.fetch = originalFetch;
  global.WebSocket = OriginalWebSocket;
  jest.useRealTimers();
});

/** Drive connect() to the point a mock socket exists with onmessage wired. */
async function connectAndGetSocket(): Promise<FakeSocket> {
  useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });
  await flushPromises();
  const socket = wsInstances[0];
  if (!socket || !socket.onmessage) {
    throw new Error('mock socket onmessage was not wired');
  }
  return socket;
}

/** Install a deterministic encryption state shared with a peer "server" key. */
function establishEncryption(): { serverShared: Uint8Array } {
  const clientKp = createKeyPair();
  const serverKp = createKeyPair();
  const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey);
  const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey);
  setEncryptionState({ sharedKey: clientShared, sendNonce: 0, recvNonce: 0 });
  return { serverShared };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#5632 post-handshake plaintext guard', () => {
  it('rejects a plaintext app frame received AFTER encryption is established', async () => {
    const socket = await connectAndGetSocket();
    establishEncryption();

    expect(useConnectionStore.getState().serverErrors).toHaveLength(0);

    // A forged plaintext server_error (not an `encrypted` envelope, not a
    // handshake frame) must be dropped and the socket closed.
    socket.onmessage!({ data: JSON.stringify({ type: 'server_error', error: 'pwned' }) });

    expect(socket.close).toHaveBeenCalledTimes(1);
    // The frame must NOT have been dispatched — serverErrors stays empty.
    expect(useConnectionStore.getState().serverErrors).toHaveLength(0);
  });

  it('still DISPATCHES cleartext terminal handshake frames (auth_fail) when encryption is active', async () => {
    const socket = await connectAndGetSocket();
    establishEncryption();

    // auth_fail is a terminal handshake frame the server may legitimately emit
    // cleartext — the guard must allow-list it so it reaches handleMessage. The
    // handler itself tears the connection down (sets a connectionError +
    // disconnected phase), which the guard's reject path never does. Asserting on
    // that handler side effect proves the frame was DISPATCHED, not rejected.
    socket.onmessage!({ data: JSON.stringify({ type: 'auth_fail', reason: 'token-expired' }) });

    const err = useConnectionLifecycleStore.getState().connectionError;
    expect(err).toMatch(/Auth failed/i);
    expect(err).toMatch(/token-expired/);
  });

  it('DROPS a late plaintext auth_ok after encryption — no dispatch, socket stays open (#5632 Copilot)', async () => {
    const socket = await connectAndGetSocket();
    establishEncryption();

    // Seed identity/UI state that a re-entered handshake would clobber.
    useConnectionStore.setState({
      myClientId: 'client-real',
      connectedClients: [{ clientId: 'client-real', deviceName: 'real' } as never],
    });

    // A MITM injects a plaintext auth_ok AFTER encryption is established. It must
    // be DROPPED (logged + return) — not re-dispatched into the handshake state
    // machine — and the socket must stay OPEN (closing would let a forged frame
    // DoS the connection).
    socket.onmessage!({
      data: JSON.stringify({ type: 'auth_ok', clientId: 'attacker', connectedClients: [] }),
    });

    expect(socket.close).not.toHaveBeenCalled();
    // State the forged handshake would have overwritten is untouched.
    expect(useConnectionStore.getState().myClientId).toBe('client-real');
    expect(useConnectionStore.getState().connectedClients).toHaveLength(1);
  });

  it('DROPS a late plaintext key_exchange_ok after encryption — no dispatch, socket stays open (#5632 Copilot)', async () => {
    const socket = await connectAndGetSocket();
    establishEncryption();

    const before = getEncryptionState();
    // A forged key_exchange_ok would re-enter the key-exchange path and could
    // force a fresh re-key. It must be dropped without dispatch and without
    // tearing the socket down.
    socket.onmessage!({ data: JSON.stringify({ type: 'key_exchange_ok', publicKey: 'attacker' }) });

    expect(socket.close).not.toHaveBeenCalled();
    // Encryption state untouched — the drop happened before any handler ran.
    expect(getEncryptionState()).toBe(before);
  });

  it('REJECTS a forged plaintext `error` frame after encryption (server now sends it encrypted) — closes socket', async () => {
    const socket = await connectAndGetSocket();
    establishEncryption();

    // Since #5632 the server routes sendError() through the encrypting
    // transport, so a legitimate post-handshake `error` arrives as an
    // `encrypted` envelope. A plaintext `error` is therefore a forged/downgrade
    // frame and must be rejected + closed.
    socket.onmessage!({
      data: JSON.stringify({ type: 'error', code: 'INVALID_MODEL', message: 'pwned' }),
    });

    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('decrypts and dispatches a genuine encrypted frame when encryption is active', async () => {
    const socket = await connectAndGetSocket();
    const { serverShared } = establishEncryption();

    // Server encrypts a server_error at recvNonce 0 — the guard's `encrypted`
    // branch should decrypt it and dispatch normally.
    const envelope = encrypt(
      JSON.stringify({ type: 'server_error', error: 'real' }),
      serverShared,
      0,
      DIRECTION_SERVER,
    );
    socket.onmessage!({ data: JSON.stringify(envelope) });

    expect(socket.close).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().serverErrors.length).toBeGreaterThan(0);
    // recvNonce advanced after a successful decrypt.
    expect(getEncryptionState()?.recvNonce).toBe(1);
  });

  it('leaves plaintext-mode (encryption disabled) sessions unaffected', async () => {
    const socket = await connectAndGetSocket();
    // No encryption established — encState is null.
    expect(getEncryptionState()).toBeNull();

    socket.onmessage!({ data: JSON.stringify({ type: 'server_error', error: 'plain' }) });

    // The guard must NOT fire: the frame is dispatched and the socket stays open.
    expect(socket.close).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().serverErrors.length).toBeGreaterThan(0);
  });
});
