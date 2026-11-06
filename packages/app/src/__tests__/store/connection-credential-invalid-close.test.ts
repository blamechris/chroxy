/**
 * A server that ends a connection because the pairing token it authenticated
 * with is no longer valid sends an authenticated `credential_invalidated` notice
 * and then closes with 4401. The close code alone (forgeable on a plain ws://
 * link) only stops auto-reconnect; the notice is what forgets the credential.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// The literal the server sends (ws-server.js WS_CLOSE_CREDENTIAL_INVALID).
const WS_CLOSE_CREDENTIAL_INVALID = 4401;
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { resetReconnectAttempt, setLastConnectedUrl, handleMessage, setEncryptionState } from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';

function flushPromises(): Promise<void> {
  return new Promise((resolve) =>
    jest.requireActual<typeof globalThis>('timers').setImmediate(resolve),
  );
}

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  send: jest.Mock;
  close: jest.Mock;
}

function installMockWebSocket(): { instances: FakeSocket[]; restore: () => void } {
  const instances: FakeSocket[] = [];
  const Original = global.WebSocket;
  // @ts-expect-error — mock WebSocket constructor
  global.WebSocket = class MockWebSocket {
    static OPEN = 1;
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((event?: unknown) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as FakeSocket);
    }
  };
  return { instances, restore: () => { global.WebSocket = Original; } };
}

const originalFetch = global.fetch;
let randomSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  clearAllCallbacks();
  __resetDeviceIdCacheForTests();
  resetReconnectAttempt();
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'ok' }),
    text: () => Promise.resolve('{}'),
  }) as unknown as typeof fetch;
  useConnectionStore.setState({ socket: null, sessionStates: {}, activeSessionId: null });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'disconnected',
    connectionError: null,
    connectionRetryCount: 0,
    wsUrl: null,
    userDisconnected: false,
    savedConnection: { url: 'wss://tunnel.example.com', token: 'tok' },
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  randomSpy.mockRestore();
  setLastConnectedUrl(null);
  global.fetch = originalFetch;
  jest.useRealTimers();
});

async function openConnectedSocket(ws: { instances: FakeSocket[] }, authenticate = true, url = 'wss://tunnel.example.com'): Promise<FakeSocket> {
  useConnectionStore.getState().connect(url, 'tok', { silent: true });
  await flushPromises();
  const socket = ws.instances[ws.instances.length - 1];
  socket.onopen?.();
  if (authenticate) {
    // A real auth_ok through the production onmessage path.
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
    await flushPromises();
  }
  return socket;
}

const frame = (socket: FakeSocket, msg: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(msg) });
const SAVED = { url: 'wss://tunnel.example.com', token: 'tok' };

describe('close code 4401 alone (not authenticated evidence)', () => {
  it('control: an ordinary drop reconnects', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    const before = ws.instances.length;
    socket.onclose?.({ code: 1006 });
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('reconnecting');
    await jest.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(ws.instances.length).toBeGreaterThan(before);
    ws.restore();
  });

  it('stops reconnecting, shows the pair-again copy, and erases nothing', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    const before = ws.instances.length;
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    await jest.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(ws.instances.length).toBe(before);
    const lifecycle = useConnectionLifecycleStore.getState();
    expect(lifecycle.connectionPhase).toBe('disconnected');
    expect(lifecycle.connectionError).toMatch(/pair it again/i);
    expect(lifecycle.savedConnection).toEqual(SAVED);
    ws.restore();
  });

  it('does not reconnect when an error armed the retry before the close arrived', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    const before = ws.instances.length;
    socket.onerror?.({});
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    await jest.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(ws.instances.length).toBe(before);
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('disconnected');
    ws.restore();
  });

  it('a 4401 on a connection that never authenticated erases nothing', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws, false);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    ws.restore();
  });
});

// An ENCRYPTED frame is the authenticated evidence: the production transport hands
// handleMessage `encryptedFrame = true` only after decrypting under the session key.
const encryptedNotice = (reason: string) => handleMessage({ type: 'credential_invalidated', reason }, undefined, true);

describe('the credential_invalidated notice', () => {
  it('an encrypted notice forgets the saved credential and does not reconnect', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    const before = ws.instances.length;
    encryptedNotice('revoked');
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    await jest.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    const lifecycle = useConnectionLifecycleStore.getState();
    expect(lifecycle.savedConnection).toBeNull();
    expect(lifecycle.connectionPhase).toBe('disconnected');
    expect(lifecycle.connectionError).toMatch(/pair it again/i);
    expect(ws.instances.length).toBe(before);
    ws.restore();
  });

  it('the close that follows still runs the connection teardown', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    expect(useConnectionStore.getState().socket).not.toBeNull();
    encryptedNotice('expired');
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    expect(useConnectionStore.getState().socket).toBeNull();
    ws.restore();
  });

  it('an accepted notice closes the socket', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    encryptedNotice('revoked');
    expect(socket.close).toHaveBeenCalled();
    ws.restore();
  });

  it('a notice that does not forget still marks the token suspect, so a later invalid_token erases it', async () => {
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    encryptedNotice('destroyed');
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    const next = await openConnectedSocket(ws, false);
    frame(next, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
    ws.restore();
  });

  it('an accepted notice does not clear a saved connection that belongs to a different server', async () => {
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);
    const OTHER = { url: 'wss://other.example.com', token: 'other-token' };
    useConnectionLifecycleStore.setState({ savedConnection: OTHER });
    encryptedNotice('revoked');
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(OTHER);
    ws.restore();
  });

  it('an accepted notice does not clear a saved connection with the same url but a newer token', async () => {
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);
    const NEWER = { url: SAVED.url, token: 'newer-token' };
    useConnectionLifecycleStore.setState({ savedConnection: NEWER });
    encryptedNotice('revoked');
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(NEWER);
    ws.restore();
  });

  it('does not reconnect after notice then error', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    const before = ws.instances.length;
    encryptedNotice('expired');
    socket.onerror?.({});
    await jest.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(ws.instances.length).toBe(before);
    ws.restore();
  });

  it.each(['destroyed', 'invalid', 'something-new'])('an encrypted notice with reason %s stops reconnecting but erases nothing', async (reason) => {
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    encryptedNotice(reason);
    await flushPromises();
    const lifecycle = useConnectionLifecycleStore.getState();
    expect(lifecycle.connectionPhase).toBe('disconnected');
    expect(lifecycle.savedConnection).toEqual(SAVED);
    ws.restore();
  });

  it('a plaintext notice before auth_ok is dropped: nothing erased', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws, false);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    frame(socket, { type: 'credential_invalidated', reason: 'revoked' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    expect(useConnectionLifecycleStore.getState().connectionPhase).not.toBe('disconnected');
    ws.restore();
  });

  it('a plaintext notice while encryption is in use is dropped', async () => {
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    setEncryptionState({ sharedKey: new Uint8Array(32), sendNonce: 0, recvNonce: 0 });
    try {
      handleMessage({ type: 'credential_invalidated', reason: 'revoked' }, undefined, false);
    } finally {
      setEncryptionState(null);
    }
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('connected');
    ws.restore();
  });

  it('a plaintext notice on an authenticated unencrypted connection only stops reconnecting', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    frame(socket, { type: 'credential_invalidated', reason: 'revoked' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('disconnected');
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    ws.restore();
  });
});

describe('an auth_fail on a later attempt', () => {
  async function laterAttempt(ws: { instances: FakeSocket[] }): Promise<FakeSocket> {
    return openConnectedSocket(ws, false);
  }

  it('invalid_token for the token a bare 4401 ended on forgets it', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    const next = await laterAttempt(ws);
    frame(next, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
    ws.restore();
  });

  it('invalid_token with no preceding authenticated drop erases nothing', async () => {
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    const next = await laterAttempt(ws);
    frame(next, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    ws.restore();
  });

  it('signing in again clears the suspect token, so a later invalid_token erases nothing', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    await openConnectedSocket(ws, true);
    const again = await openConnectedSocket(ws, false);
    frame(again, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).not.toBeNull();
    ws.restore();
  });

  it("another server's sign-in does not clear this server's suspect token", async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    await openConnectedSocket(ws, true, 'wss://other.example.com');
    useConnectionLifecycleStore.setState({ savedConnection: SAVED }); // the other server's sign-in re-saved its own
    const back = await openConnectedSocket(ws, false);
    frame(back, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
    ws.restore();
  });

  it('a 4401 on a connection that never authenticated does not make a later invalid_token erase', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws, false);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    const next = await laterAttempt(ws);
    frame(next, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    ws.restore();
  });

  it('invalid_token for the suspect token does not clear a saved connection that belongs to a different server', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    const OTHER = { url: 'wss://other.example.com', token: 'other-token' };
    useConnectionLifecycleStore.setState({ savedConnection: OTHER });
    const next = await openConnectedSocket(ws, false);
    frame(next, { type: 'auth_fail', reason: 'invalid_token' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(OTHER);
    ws.restore();
  });

  it('a different failure reason after a bare 4401 erases nothing', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    const next = await laterAttempt(ws);
    frame(next, { type: 'auth_fail', reason: 'rate_limited' });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(SAVED);
    ws.restore();
  });
});

describe('forgetting a saved connection', () => {
  it('does not clobber a connection saved while the storage wipe was pending', async () => {
    const SecureStore = jest.requireMock('expo-secure-store');
    let releaseWipe: () => void = () => {};
    const wipeGate = new Promise<void>((resolve) => { releaseWipe = resolve; });
    SecureStore.deleteItemAsync.mockImplementation(() => wipeGate);
    const A = { url: 'wss://a.example.com', token: 'tok-a' };
    const B = { url: 'wss://b.example.com', token: 'tok-b' };
    useConnectionLifecycleStore.setState({ savedConnection: A });
    const clearing = useConnectionStore.getState().clearSavedConnection();
    // A different server is paired while A's wipe is still pending.
    useConnectionLifecycleStore.setState({ savedConnection: B });
    releaseWipe();
    await clearing;
    expect(useConnectionLifecycleStore.getState().savedConnection).toEqual(B);
    SecureStore.deleteItemAsync.mockImplementation(() => Promise.resolve());
  });

  it('control: clears the connection that was asked to be forgotten', async () => {
    useConnectionLifecycleStore.setState({ savedConnection: SAVED });
    await useConnectionStore.getState().clearSavedConnection();
    expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
  });
});
