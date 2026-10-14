/** #8602: exercise production connect → auth/pair → auth_ok → drop → next auth. */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { createKeyPair, encrypt, DIRECTION_SERVER } from '../../utils/crypto';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { setPendingPairingId, setPendingPairingIdentityKey, getConnectionContext, getEncryptionState, resetReconnectAttempt } from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';

function flushPromises(): Promise<void> {
  return new Promise((resolve) =>
    jest.requireActual<typeof globalThis>('timers').setImmediate(resolve),
  );
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
    close = jest.fn(function (this: FakeSocket) { this.readyState = 3; });
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
  setPendingPairingId(null);
  setPendingPairingIdentityKey(null);
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
  (SecureStore.getItemAsync as jest.Mock).mockReset();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('dev-id-123');
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  useConnectionStore.setState({
    serverErrors: [],
    connectedClients: [],
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
    apiToken: null,
    userDisconnected: false,
    savedConnection: null,
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  setPendingPairingId(null);
  setPendingPairingIdentityKey(null);
  randomSpy.mockRestore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

const URL = 'wss://paired-daemon.example.test/ws';
const ISSUED = 'fixture-paired-device-token';
const MANUAL = 'fixture-manual-token';
let ws: ReturnType<typeof installMockWebSocket>;

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
  ws = installMockWebSocket();
});
afterEach(() => { ws.restore(); });

function frame(socket: FakeSocket, message: Record<string, unknown>): void {
  if (message.type === 'auth_ok' && message.sessionToken && !message.capabilities) {
    message = { ...message, capabilities: { pairedCredentialConfirmation: true } };
  }
  socket.onmessage?.({ data: JSON.stringify(message) });
}
async function open(socket: FakeSocket): Promise<void> {
  socket.readyState = 1;
  socket.onopen?.();
  await flushPromises();
}
async function dial(token: string, url = URL): Promise<FakeSocket> {
  const index = ws.instances.length;
  useConnectionStore.getState().connect(url, token, { silent: true });
  await flushPromises();
  const socket = ws.instances[index];
  expect(socket).toBeDefined();
  await open(socket);
  return socket;
}
function sent(socket: FakeSocket, type: string): Record<string, unknown> {
  const messages = socket.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw) as Record<string, unknown>);
  const result = messages.find(message => message.type === type);
  if (!result) throw new Error(`Missing ${type} transport frame`);
  return result;
}
async function admit(socket: FakeSocket, sessionToken?: string): Promise<void> {
  frame(socket, { type: 'auth_ok', encryption: 'disabled', clientId: 'fixture-client', serverMode: 'cli', ...(sessionToken ? { sessionToken } : {}) });
  if (sessionToken) frame(socket, { type: 'auth_bootstrap', sessionToken });
  await flushPromises();
}
async function reconnect(socket: FakeSocket): Promise<FakeSocket> {
  const index = ws.instances.length;
  socket.readyState = 3;
  socket.onclose?.({ code: 1006 });
  jest.advanceTimersByTime(1000);
  await flushPromises();
  expect(ws.instances).toHaveLength(index + 1);
  const next = ws.instances[index];
  await open(next);
  return next;
}

it.each([false, true])('paired reconnect uses the issued credential; prior manual=%s', async (priorManual) => {
  if (priorManual) {
    const manual = await dial(MANUAL);
    await admit(manual);
    expect(sent(manual, 'auth').token).toBe(MANUAL);
    useConnectionStore.getState().disconnect();
  }
  setPendingPairingId('fixture-one-use-pair-id');
  const paired = await dial('');
  expect(sent(paired, 'pair').pairingId).toBe('fixture-one-use-pair-id');
  await admit(paired, ISSUED);
  expect(useConnectionLifecycleStore.getState().apiToken).toBe(ISSUED);
  expect(useConnectionLifecycleStore.getState().savedConnection?.token).toBe(ISSUED);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith('chroxy_last_token', ISSUED);
  const next = await reconnect(paired);
  expect(next.url).toBe(URL);
  expect(sent(next, 'auth').token).toBe(ISSUED);
});

it('direct manual auth reconnect preserves its admitted credential', async () => {
  const manual = await dial(MANUAL);
  await admit(manual);
  const next = await reconnect(manual);
  expect(sent(next, 'auth').token).toBe(MANUAL);
});

it('adopts a scheduled rotation for the same socket before reconnect', async () => {
  const socket = await dial(MANUAL);
  await admit(socket);
  frame(socket, { type: 'token_rotated', token: 'fixture-rotated-token' });
  const next = await reconnect(socket);
  expect(sent(next, 'auth').token).toBe('fixture-rotated-token');
});

it('keeps socket credential and endpoint when another daemon overwrites saved/global details', async () => {
  setPendingPairingId('fixture-pair-id');
  const socket = await dial('');
  await admit(socket, ISSUED);
  useConnectionLifecycleStore.setState({
    apiToken: 'fixture-other-daemon-token',
    savedConnection: { url: 'wss://other-daemon.example.test/ws', tunnelUrl: 'wss://other-daemon.example.test/ws', token: 'fixture-other-daemon-token' },
  });
  const next = await reconnect(socket);
  expect(next.url).toBe(URL);
  expect(sent(next, 'auth').token).toBe(ISSUED);
});

it('uses the admitted socket token to follow a tunnel endpoint rotation', async () => {
  setPendingPairingId('fixture-pair-id');
  const socket = await dial('');
  await admit(socket, ISSUED);
  const rotatedUrl = 'wss://rotated-paired-daemon.example.test/ws';
  frame(socket, { type: 'tunnel_url_changed', url: rotatedUrl });
  const next = await reconnect(socket);
  expect(next.url).toBe(rotatedUrl);
  expect(sent(next, 'auth').token).toBe(ISSUED);
});

it('deduplicates error → close and preserves the paired credential', async () => {
  setPendingPairingId('fixture-pair-id');
  const socket = await dial('');
  await admit(socket, ISSUED);
  socket.onerror?.({ message: 'fixture transport drop' });
  const next = await reconnect(socket);
  expect(ws.instances).toHaveLength(2);
  expect(sent(next, 'auth').token).toBe(ISSUED);
});

it('ignores stale old-socket auth, rotation and close after a new daemon is admitted', async () => {
  setPendingPairingId('fixture-pair-id');
  const old = await dial('');
  await admit(old, ISSUED);
  const oldFrame = old.onmessage;
  const oldClose = old.onclose;
  const otherUrl = 'wss://current-daemon.example.test/ws';
  const current = await dial('fixture-current-token', otherUrl);
  await admit(current);
  oldFrame?.({ data: JSON.stringify({ type: 'auth_ok', encryption: 'disabled', sessionToken: 'fixture-stale-auth-token' }) });
  oldFrame?.({ data: JSON.stringify({ type: 'token_rotated', token: 'fixture-stale-rotation-token' }) });
  oldClose?.({ code: 1006 });
  jest.advanceTimersByTime(1000);
  await flushPromises();
  expect(ws.instances).toHaveLength(2);
  expect(useConnectionLifecycleStore.getState().savedConnection?.token).toBe('fixture-current-token');
  const next = await reconnect(current);
  expect(next.url).toBe(otherUrl);
  expect(sent(next, 'auth').token).toBe('fixture-current-token');
});

it('missing rotation token remains terminal and does not reconnect automatically', async () => {
  const socket = await dial(MANUAL);
  await admit(socket);
  const oldClose = socket.onclose;
  frame(socket, { type: 'token_rotated' });
  oldClose?.({ code: 1006 });
  jest.advanceTimersByTime(1000);
  await flushPromises();
  expect(ws.instances).toHaveLength(1);
  expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
});

function signedExchange(seed = 1): { publicKey: string; serverKeySig: string; identityKey: string } {
  const exchange = createKeyPair();
  const identity = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  return {
    publicKey: exchange.publicKey,
    identityKey: encodeBase64(identity.publicKey),
    serverKeySig: encodeBase64(nacl.sign.detached(decodeBase64(exchange.publicKey), identity.secretKey)),
  };
}
function encryptedFrame(socket: FakeSocket, message: Record<string, unknown>): void {
  const encryption = getEncryptionState();
  if (!encryption) throw new Error('Expected completed production key exchange');
  frame(socket, encrypt(JSON.stringify(message), encryption.sharedKey, encryption.recvNonce, DIRECTION_SERVER) as unknown as Record<string, unknown>);
}

it('adopts the paired token after a verified discrete key exchange', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  setPendingPairingId('fixture-trusted-pair-id');
  const socket = await dial('');
  const context = getConnectionContext();
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED });
  expect(getEncryptionState()).toBeNull();
  expect(sent(socket, 'key_exchange').publicKey).toBeDefined();
  expect(context?.token).toBe('');
  frame(socket, { type: 'key_exchange_ok', publicKey: exchange.publicKey, serverKeySig: exchange.serverKeySig });
  expect(getEncryptionState()).not.toBeNull();
  expect(context?.token).toBe('');
  expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
  encryptedFrame(socket, { type: 'auth_bootstrap', sessionToken: ISSUED });
  expect(context?.token).toBe(ISSUED);
  expect(useConnectionLifecycleStore.getState().savedConnection?.pinnedIdentityKey).toBe(exchange.identityKey);
  encryptedFrame(socket, { type: 'token_rotated', token: 'fixture-encrypted-rotation' });
  const next = await reconnect(socket);
  expect(sent(next, 'auth').token).toBe('fixture-encrypted-rotation');
});

it('verified eager auth adopts the server-issued token', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  const socket = await dial(MANUAL);
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED,
    serverPublicKey: exchange.publicKey, serverKeySig: exchange.serverKeySig });
  expect(getEncryptionState()).not.toBeNull();
  expect(getConnectionContext()?.token).toBe(MANUAL);
  encryptedFrame(socket, { type: 'auth_bootstrap', sessionToken: ISSUED });
  const next = await reconnect(socket);
  expect(sent(next, 'auth').token).toBe(ISSUED);
});

it.each(['plaintext', 'eager', 'discrete'])('identity refusal on %s never adopts a reconnect credential', async (path) => {
  const trusted = signedExchange();
  const impostor = signedExchange(2);
  setPendingPairingIdentityKey(trusted.identityKey);
  const socket = await dial(MANUAL);
  const context = getConnectionContext();
  frame(socket, { type: 'auth_ok', encryption: path === 'plaintext' ? 'disabled' : 'required', sessionToken: ISSUED,
    ...(path === 'eager' ? { serverPublicKey: impostor.publicKey, serverKeySig: impostor.serverKeySig } : {}) });
  if (path === 'discrete') {
    expect(context?.token).toBe(MANUAL);
    frame(socket, { type: 'key_exchange_ok', publicKey: impostor.publicKey, serverKeySig: impostor.serverKeySig });
  }
  expect(context?.token).toBe(MANUAL);
  expect(getEncryptionState()).toBeNull();
  expect(socket.close).toHaveBeenCalled();
  expect(useConnectionLifecycleStore.getState().userDisconnected).toBe(true);
  socket.onclose?.({ code: 1006 });
  jest.advanceTimersByTime(1000);
  await flushPromises();
  expect(ws.instances).toHaveLength(1);
});

it('discrete handshake drop never adopts a token before identity verification', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  const socket = await dial(MANUAL);
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED });
  expect(getConnectionContext()?.token).toBe(MANUAL);
  const next = await reconnect(socket);
  expect(sent(next, 'auth').token).toBe(MANUAL);
});

it('plaintext re-handshake and rotation after encryption cannot change the socket credential', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  const socket = await dial(MANUAL);
  frame(socket, { type: 'auth_ok', encryption: 'required', serverPublicKey: exchange.publicKey, serverKeySig: exchange.serverKeySig });
  frame(socket, { type: 'auth_ok', sessionToken: ISSUED, encryption: 'disabled' });
  frame(socket, { type: 'token_rotated', token: 'fixture-unencrypted-rotation' });
  expect(getConnectionContext()?.token).toBe(MANUAL);
  const next = await reconnect(socket);
  expect(sent(next, 'auth').token).toBe(MANUAL);
});

it('does not adopt a rotation while the discrete handshake is unverified', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  const socket = await dial(MANUAL);
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED });
  frame(socket, { type: 'token_rotated', token: 'fixture-premature-rotation' });
  expect(getConnectionContext()?.token).toBe(MANUAL);
  const next = await reconnect(socket);
  expect(sent(next, 'auth').token).toBe(MANUAL);
});

it('discrete completion uses this socket token even if another saved record appeared mid-handshake', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  setPendingPairingId('fixture-trusted-pair-id');
  const socket = await dial('');
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED });
  useConnectionLifecycleStore.setState({
    apiToken: 'fixture-other-daemon-token',
    savedConnection: { url: 'wss://other-daemon.example.test/ws', token: 'fixture-other-daemon-token' },
  });
  frame(socket, { type: 'key_exchange_ok', publicKey: exchange.publicKey, serverKeySig: exchange.serverKeySig });
  encryptedFrame(socket, { type: 'auth_bootstrap', sessionToken: ISSUED });
  expect(getConnectionContext()?.token).toBe(ISSUED);
  expect(useConnectionLifecycleStore.getState().savedConnection?.token).toBe(ISSUED);
  const next = await reconnect(socket);
  expect(next.url).toBe(URL);
  expect(sent(next, 'auth').token).toBe(ISSUED);
});

it('a missing discrete exchange key does not admit the proposed credential', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  const socket = await dial(MANUAL);
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED });
  frame(socket, { type: 'key_exchange_ok' });
  expect(getConnectionContext()?.token).toBe(MANUAL);
  expect(getEncryptionState()).toBeNull();
  expect(socket.close).toHaveBeenCalled();
});

it('waits for the post-auth credential before writing paired connection details', async () => {
  setPendingPairingId('fixture-pair-id');
  const socket = await dial('');
  (SecureStore.setItemAsync as jest.Mock).mockClear();
  frame(socket, { type: 'auth_ok', encryption: 'disabled', sessionToken: ISSUED,
    capabilities: { pairedCredentialConfirmation: true } });
  expect(getConnectionContext()?.token).toBe('');
  expect(useConnectionLifecycleStore.getState().apiToken).toBe('');
  expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  frame(socket, { type: 'auth_bootstrap', sessionToken: ISSUED });
  expect(getConnectionContext()?.token).toBe(ISSUED);
  expect(useConnectionLifecycleStore.getState().apiToken).toBe(ISSUED);
  expect(useConnectionLifecycleStore.getState().savedConnection?.token).toBe(ISSUED);
});

it('an older server pairing response refuses without writing credentials', async () => {
  setPendingPairingId('fixture-pair-id');
  const socket = await dial('');
  frame(socket, { type: 'auth_ok', encryption: 'disabled', sessionToken: ISSUED, capabilities: {} });
  expect(socket.close).toHaveBeenCalled();
  expect(getConnectionContext()?.token).toBe('');
  expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
  expect(useConnectionLifecycleStore.getState().userDisconnected).toBe(true);
});

it('requires an encrypted post-auth credential after the discrete handshake', async () => {
  const exchange = signedExchange();
  setPendingPairingIdentityKey(exchange.identityKey);
  setPendingPairingId('fixture-pair-id');
  const socket = await dial('');
  frame(socket, { type: 'auth_ok', encryption: 'required', sessionToken: ISSUED });
  frame(socket, { type: 'auth_bootstrap', sessionToken: ISSUED });
  expect(getConnectionContext()?.token).toBe('');
  expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
  frame(socket, { type: 'key_exchange_ok', publicKey: exchange.publicKey, serverKeySig: exchange.serverKeySig });
  expect(getConnectionContext()?.token).toBe('');
  encryptedFrame(socket, { type: 'auth_bootstrap', sessionToken: ISSUED });
  expect(getConnectionContext()?.token).toBe(ISSUED);
  encryptedFrame(socket, { type: 'auth_bootstrap', sessionToken: 'fixture-later-bootstrap' });
  expect(getConnectionContext()?.token).toBe(ISSUED);
});
