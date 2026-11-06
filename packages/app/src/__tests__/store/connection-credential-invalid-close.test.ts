/**
 * A server that ends a connection because the pairing token it authenticated
 * with is no longer valid (close code 4401) is not retried with that token: the
 * client forgets the saved credential and lands on the disconnected/unpaired state.
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
import { resetReconnectAttempt, setLastConnectedUrl } from '../../store/message-handler';
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

async function openConnectedSocket(ws: { instances: FakeSocket[] }): Promise<FakeSocket> {
  useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
  await flushPromises();
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  return ws.instances[ws.instances.length - 1];
}

describe('close code 4401 (the credential for this connection is no longer valid)', () => {
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

  it('does not reconnect and forgets the saved credential', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnectedSocket(ws);
    const before = ws.instances.length;
    socket.onclose?.({ code: WS_CLOSE_CREDENTIAL_INVALID });
    socket.onerror?.({});
    await jest.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(ws.instances.length).toBe(before);
    const lifecycle = useConnectionLifecycleStore.getState();
    expect(lifecycle.connectionPhase).toBe('disconnected');
    expect(lifecycle.savedConnection).toBeNull();
    expect(lifecycle.connectionError).toMatch(/pair it again/i);
    ws.restore();
  });
});
