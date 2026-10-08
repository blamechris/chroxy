/**
 * #8485 (mobile app) — a frame delivered by a SUPERSEDED socket must not touch
 * the store. `disconnect()` only nulled `socket.onclose`, and `connect()` retired
 * only the socket the store already held (written at `auth_ok`), so a socket
 * still mid-handshake could deliver an `auth_ok` (or a state frame) into the
 * NEXT connection. Each test holds the superseded socket's `onmessage` and
 * invokes it AFTER the new socket authenticated. Dashboard analogue:
 * connection-stale-socket.test.ts.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { PONG_TIMEOUT_MS } from '@chroxy/store-core';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import {
  resetReconnectAttempt,
  reconnectAttempt,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
} from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';
import { setEncryptionState, getEncryptionState } from '../../store/message-handler';
import { createKeyPair, deriveSharedKey, encrypt, DIRECTION_SERVER } from '../../utils/crypto';

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
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // pin jitter to identity
  (SecureStore.getItemAsync as jest.Mock).mockReset();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('dev-id-123');
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' })) as unknown as typeof fetch;
  useConnectionStore.setState({ socket: null, sessionStates: {}, activeSessionId: null });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'disconnected',
    connectionError: null,
    connectionRetryCount: 0,
    wsUrl: null,
  });
});

afterEach(() => {
  // Make sure no timer (handshake or reconnect-ladder) survives into the next
  // test — module-level timers persist across tests in the same file.
  useConnectionStore.getState().disconnect();
  randomSpy.mockRestore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

/** Connect, walk through the health check + WS construction, and fire onopen. */
async function openConnected(ws: { instances: FakeSocket[] }, url = 'wss://tunnel.example.com/ws'): Promise<FakeSocket> {
  const before = ws.instances.length;
  useConnectionStore.getState().connect(url, 'tok', { silent: true });
  await flushPromises();
  const socket = ws.instances[before]!;
  socket.readyState = 1;
  socket.onopen?.();
  await flushPromises(); // onopen awaits getDeviceId().then(...) → send + arm
  return socket;
}

const URL_A = 'wss://daemon-a.example.com/ws';
const URL_B = 'wss://daemon-b.example.com/ws';
type Handler = (e: unknown) => void;

async function authOk(socket: FakeSocket): Promise<void> {
  socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
  await flushPromises();
}

describe('#8485 a superseded socket cannot write to the new connection (mobile app)', () => {
  it('control: the CURRENT socket still delivers frames', async () => {
    const ws = installMockWebSocket();
    const a = await openConnected(ws, URL_A);
    await authOk(a);
    expect(useConnectionLifecycleStore.getState().wsUrl).toBe(URL_A);
    ws.restore();
  });

  it('a late frame from A, after B has authenticated, leaves B alone', async () => {
    const ws = installMockWebSocket();
    const a = await openConnected(ws, URL_A);
    await authOk(a);
    const lateA = a.onmessage as Handler;

    const b = await openConnected(ws, URL_B);
    await authOk(b);
    useConnectionLifecycleStore.getState().setServerInfo({ serverMode: null });

    lateA({ data: JSON.stringify({ type: 'server_mode', mode: 'cli' }) });
    expect(useConnectionLifecycleStore.getState().serverMode).toBeNull();
    ws.restore();
  });

  it('a socket still MID-HANDSHAKE when the user switches is retired too', async () => {
    const ws = installMockWebSocket();
    const a = await openConnected(ws, URL_A);
    const lateA = a.onmessage as Handler;

    const b = await openConnected(ws, URL_B);
    await authOk(b);
    expect(useConnectionLifecycleStore.getState().wsUrl).toBe(URL_B);

    lateA({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().wsUrl).toBe(URL_B);
    expect(useConnectionStore.getState().socket).toBe(b as unknown);
    expect(a.close).toHaveBeenCalled();
    ws.restore();
  });

  it('a late VALID encrypted envelope from A leaves the new connection\'s nonce, state and socket alone', async () => {
    const ws = installMockWebSocket();
    const a = await openConnected(ws, URL_A);
    const lateA = a.onmessage as Handler;
    const b = await openConnected(ws, URL_B);
    await authOk(b);

    // B completed its key exchange; the envelope below is VALID for that key at
    // nonce 0, so a guard below decrypt advances recvNonce and a missing one
    // dispatches the payload.
    const clientKp = createKeyPair();
    const serverKp = createKeyPair();
    setEncryptionState({
      sharedKey: deriveSharedKey(serverKp.publicKey, clientKp.secretKey),
      sendNonce: 0,
      recvNonce: 0,
    });
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey);
    const errorsBefore = useConnectionStore.getState().serverErrors.length;
    const envelope = encrypt(JSON.stringify({ type: 'server_error', error: 'from-A' }), serverShared, 0, DIRECTION_SERVER);

    lateA({ data: JSON.stringify(envelope) });

    expect(getEncryptionState()?.recvNonce).toBe(0);
    expect(useConnectionStore.getState().serverErrors.length).toBe(errorsBefore);
    expect(b.close).not.toHaveBeenCalled();

    // Control: the same envelope on the CURRENT socket decrypts and dispatches.
    b.onmessage?.({ data: JSON.stringify(envelope) });
    expect(getEncryptionState()?.recvNonce).toBe(1);
    expect(useConnectionStore.getState().serverErrors.length).toBeGreaterThan(errorsBefore);
    setEncryptionState(null);
    ws.restore();
  });

  it('disconnect() retires the socket, including one that never authenticated', async () => {
    const ws = installMockWebSocket();
    const a = await openConnected(ws, URL_A);
    useConnectionStore.getState().disconnect();
    expect(a.close).toHaveBeenCalled();
    expect(a.onmessage).toBeNull();
    expect(a.onerror).toBeNull();
    expect(a.onclose).toBeNull();
    expect(a.onopen).toBeNull();
    ws.restore();
  });

  it('the CURRENT socket\'s onclose still drives auto-reconnect after a switch', async () => {
    const ws = installMockWebSocket();
    const a = await openConnected(ws, URL_A);
    await authOk(a);
    const b = await openConnected(ws, URL_B);
    await authOk(b);
    const before = ws.instances.length;

    b.readyState = 3;
    b.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(10_000);
    await flushPromises();
    expect(ws.instances.length).toBeGreaterThan(before);
    ws.restore();
  });
});
