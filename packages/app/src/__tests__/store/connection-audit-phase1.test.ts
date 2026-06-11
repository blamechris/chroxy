/**
 * #5555 — swarm-audit phase-1 connect-path quick wins.
 *
 * Covers the three fixes landed together:
 *   1. Single `/health` probe on the auto-connect path (connectAuto threads the
 *      endpoint selector's fresh probe into connect() so we don't probe twice).
 *   2. getDeviceId() prewarm — the auth frame in onopen is not gated on a cold
 *      SecureStore read.
 *   3. Per-socket reconnect-dedup guard — a paired onclose + onerror for one
 *      transport drop arms exactly one reconnect.
 *
 * Mocks global.fetch + global.WebSocket and expo-secure-store, mirroring the
 * fake-WebSocket / fake-timer patterns in connection-connect.test.ts.
 */
import type { SavedConnection } from '@chroxy/store-core';

// Mock expo-secure-store with real jest.fn()s so getDeviceId()'s keychain read
// is controllable per-test (slow read for the prewarm ordering assertion).
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { clearAllCallbacks } from '../../store/imperative-callbacks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks (promise chains). */
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** Installs a MockWebSocket that records every instance it constructs. */
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

/**
 * Counts probe fetches. Both the endpoint selector (`probeHealth` → GET
 * `…/health`) and connect()'s own pre-WS check (GET of the bare origin) are
 * liveness probes against the same host, so we count every fetch — the whole
 * point of FIX 1 is that exactly one of them runs per connect.
 */
function countHealthCalls(fetchMock: jest.Mock): number {
  return fetchMock.mock.calls.length;
}

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------
const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  clearAllCallbacks();
  __resetDeviceIdCacheForTests();
  (SecureStore.getItemAsync as jest.Mock).mockReset();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('dev-id-123');
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  useConnectionStore.setState({
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
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// FIX 1 — single /health probe on the auto-connect path
// ---------------------------------------------------------------------------

describe('connectAuto() single health probe (#5555)', () => {
  // A verified LAN record makes the selector probe `ws://…/health` once. The
  // probe result is threaded into connect(), which must NOT probe again.
  const lanSaved: SavedConnection = {
    url: 'wss://tunnel.example.com',
    token: 'tok',
    tunnelUrl: 'wss://tunnel.example.com',
    lanUrl: 'ws://192.168.1.50:8765',
    lanVerified: true,
  };

  it('probes /health exactly once across selector + connect()', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    await useConnectionStore.getState().connectAuto(lanSaved, { silent: true });
    await flushPromises();

    // One probe total: the selector's LAN probe. connect() reused it.
    expect(countHealthCalls(fetchMock)).toBe(1);
    // …and the WS was opened against the LAN url (proves we didn't bail out).
    expect(ws.instances.length).toBe(1);
    expect(ws.instances[0].url).toBe('ws://192.168.1.50:8765');

    ws.restore();
  });

  it('still probes once on the tunnel path (no precheck → connect() probes)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    // preferTunnel → selector returns the tunnel with NO healthPrecheck, so
    // connect() runs its own (single) health check.
    await useConnectionStore.getState().connectAuto(lanSaved, {
      silent: true,
      preferTunnel: true,
    });
    await flushPromises();

    expect(countHealthCalls(fetchMock)).toBe(1);
    expect(ws.instances[0].url).toBe('wss://tunnel.example.com');

    ws.restore();
  });

  it('restarting detection still works on the normal (non-precheck) path', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(mockResponse(200, { status: 'restarting', restartEtaMs: 4000 }));
    global.fetch = fetchMock;

    // Direct connect() (no precheck) — the health body says restarting, so the
    // restart branch must fire.
    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();

    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('server_restarting');
    expect(useConnectionStore.getState().restartEtaMs).toBe(4000);
  });

  it('does not honor a stale precheck (older than the freshness window)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    // A precheck timestamped well in the past must be ignored — connect() runs
    // its own probe so we don't open a WS against a host whose liveness is stale.
    useConnectionStore.getState().connect('ws://192.168.1.50:8765', 'tok', {
      silent: true,
      healthPrecheck: { ts: Date.now() - 60_000, status: 'ok' },
    });
    await flushPromises();

    expect(countHealthCalls(fetchMock)).toBe(1);
    ws.restore();
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — getDeviceId() prewarm
// ---------------------------------------------------------------------------

describe('getDeviceId() prewarm (#5555)', () => {
  // getDeviceId() memoizes its result at module scope, so a "cold read"
  // ordering assertion needs a freshly-imported module. jest.isolateModulesAsync
  // gives each test its own registry → a null device-id memo.

  it('kicks off the SecureStore read at connect() start, before WS open', async () => {
    // beforeEach already cleared the device-id memo, so this is a cold read.
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    // Slow SecureStore read so we can observe the auth frame waiting on it.
    const slowRead = deferred<string>();
    (SecureStore.getItemAsync as jest.Mock).mockReturnValue(slowRead.promise);

    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();

    // The prewarm fires inside connect() (before the WS handshake), so the
    // SecureStore read is already in flight by the time the socket exists.
    expect(SecureStore.getItemAsync).toHaveBeenCalled();
    expect(ws.instances.length).toBe(1);

    // onopen can't send the auth frame until the (prewarmed) read resolves.
    ws.instances[0].readyState = 1;
    ws.instances[0].onopen?.();
    await flushPromises();
    expect(ws.instances[0].send).not.toHaveBeenCalled(); // still awaiting SecureStore

    slowRead.resolve('prewarmed-id');
    await flushPromises();

    expect(ws.instances[0].send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse(ws.instances[0].send.mock.calls[0][0] as string);
    expect(frame.type).toBe('auth');
    expect(frame.deviceInfo.deviceId).toBe('prewarmed-id');

    ws.restore();
  });

  it('auth frame resolves instantly when the id is already memoized', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    // The mock resolves immediately; this connect warms the memo.
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('cached-id');
    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();

    const first = ws.instances[ws.instances.length - 1];
    first.readyState = 1;
    first.onopen?.();
    await flushPromises();
    expect(first.send).toHaveBeenCalled();

    ws.restore();
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — per-socket reconnect dedup (ported from dashboard #3624)
// ---------------------------------------------------------------------------

describe('reconnect dedup guard (#5555 / #3624)', () => {
  async function openConnectedSocket() {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();

    // Simulate a fully-established connection so onclose/onerror take the
    // auto-reconnect branch (wasConnected === true).
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    return { ws, fetchMock };
  }

  it('onclose + onerror for one drop arm exactly one reconnect', async () => {
    const { ws } = await openConnectedSocket();
    const socket = ws.instances[0];
    const beforeCount = ws.instances.length;

    // Fire BOTH handlers back-to-back for the same transport drop (error → close
    // is the common browser/RN ordering, but order shouldn't matter).
    socket.onerror?.({ message: 'boom' });
    socket.onclose?.({ code: 1006 });

    // Advance past both delays (ERROR=2000, AUTO=1500) plus margin.
    jest.advanceTimersByTime(5000);
    await flushPromises();

    // Exactly one new socket created by the single reconnect.
    const newSockets = ws.instances.length - beforeCount;
    expect(newSockets).toBe(1);

    ws.restore();
  });

  it('reverse ordering (close → error) also arms exactly one reconnect', async () => {
    const { ws } = await openConnectedSocket();
    const socket = ws.instances[0];
    const beforeCount = ws.instances.length;

    socket.onclose?.({ code: 1006 });
    socket.onerror?.({ message: 'boom' });

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(ws.instances.length - beforeCount).toBe(1);
    ws.restore();
  });

  it('a fresh socket after reconnect can still arm its own retry', async () => {
    const { ws } = await openConnectedSocket();
    const first = ws.instances[0];

    // First drop → one reconnect.
    first.onerror?.({ message: 'boom' });
    first.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(ws.instances.length).toBe(2);
    const second = ws.instances[1];
    // Mark the new socket connected, then drop it — its own per-socket flag is
    // fresh, so it must arm a retry despite the global phase already being
    // 'reconnecting'-ish.
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    second.onerror?.({ message: 'boom again' });
    second.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(ws.instances.length).toBe(3);
    ws.restore();
  });
});
