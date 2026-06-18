/**
 * #5597 / #5537 — the connect/reconnect path re-resolves its endpoint per
 * attempt instead of dialing the closure-captured URL forever.
 *
 *  - #5597: a tunnel URL that rotated mid-ladder (live `tunnel_url_changed` push,
 *    or persisted from a prior session into `savedConnection.tunnelUrl`) is
 *    picked up on the very next reconnect/retry — no wait for connectAuto/restart.
 *  - #5537: a dead `ws://` LAN host's health-check retry budget is not burned in
 *    full on the dead LAN URL: the first LAN_FALLBACK_THRESHOLD (2) attempts
 *    retry LAN, then the ladder fast-falls-back to the tunnel.
 *
 * Reuses the fake-WebSocket / fake-timer harness from the reconnect-backoff
 * suite. Math.random is pinned to 0 so each rung delay is exactly RETRY_DELAYS[N].
 */
import type { SavedConnection } from '@chroxy/store-core';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { resetReconnectAttempt } from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';

const RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];

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
    savedConnection: null,
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  randomSpy.mockRestore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

/** The URL the most recently created socket dialed. */
function lastDialedUrl(ws: { instances: FakeSocket[] }): string {
  return ws.instances[ws.instances.length - 1].url;
}

/** Convert a ws(s):// URL to its http(s):// health-probe origin (matches connect()). */
function probeOriginOf(url: string): string {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

// ---------------------------------------------------------------------------
// #5597 — rotated tunnel URL picked up on the next reconnect (socket-close)
// ---------------------------------------------------------------------------

describe('#5597 — socket-close reconnect re-resolves a rotated tunnel URL', () => {
  async function openConnectedSocket(url: string, saved: SavedConnection) {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.getState().setSavedConnection(saved);
    useConnectionStore.getState().connect(url, saved.token, { silent: true });
    await flushPromises();
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    return ws;
  }

  it('dials the rotated tunnelUrl on the next reconnect, not the dead captured URL', async () => {
    const OLD = 'wss://old.trycloudflare.com';
    const NEW = 'wss://new.trycloudflare.com';
    const saved: SavedConnection = { url: OLD, token: 'tok', tunnelUrl: OLD };
    const ws = await openConnectedSocket(OLD, saved);

    // A live tunnel_url_changed push (simulated) repoints the saved record while
    // this socket is still riding the now-dead old tunnel.
    useConnectionLifecycleStore.getState().setSavedConnection({ ...saved, url: NEW, tunnelUrl: NEW });

    // The socket drops; the reconnect must dial the NEW URL.
    ws.instances[0].onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[0]);
    await flushPromises();

    expect(ws.instances.length).toBe(2);
    expect(lastDialedUrl(ws)).toBe(NEW);

    ws.restore();
  });

  it('keeps dialing the same tunnel URL when nothing rotated (no-op case)', async () => {
    const URL = 'wss://stable.trycloudflare.com';
    const saved: SavedConnection = { url: URL, token: 'tok', tunnelUrl: URL };
    const ws = await openConnectedSocket(URL, saved);

    ws.instances[0].onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[0]);
    await flushPromises();

    expect(lastDialedUrl(ws)).toBe(URL);

    ws.restore();
  });

  // A manual connect to a DIFFERENT server (different token) must NOT be
  // redirected back to the stale savedConnection's tunnel URL. savedConnection
  // is only updated on auth_ok, so during the connect-to-server-B window it
  // still holds server A's record — re-resolution is token-scoped to prevent
  // the hijack.
  it('does not redirect a manual connect to a different server (stale savedConnection ignored)', async () => {
    const SERVER_A = 'wss://server-a.trycloudflare.com';
    const SERVER_B = 'wss://server-b.trycloudflare.com';
    // savedConnection still describes server A (token 'tok-a'); we dial server B
    // with a different token before B's auth_ok lands.
    useConnectionLifecycleStore.getState().setSavedConnection({
      url: SERVER_A,
      token: 'tok-a',
      tunnelUrl: SERVER_A,
    });
    global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    const ws = installMockWebSocket();

    useConnectionStore.getState().connect(SERVER_B, 'tok-b', { silent: true });
    await flushPromises();
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });

    // The socket drops; the reconnect must dial SERVER_B, not server A's tunnel.
    ws.instances[0].onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[0]);
    await flushPromises();

    expect(lastDialedUrl(ws)).toBe(SERVER_B);

    ws.restore();
  });
});

// ---------------------------------------------------------------------------
// #5537 — LAN→tunnel fast fallback on the inner health-check retry ladder
// ---------------------------------------------------------------------------

describe('#5537 — dead LAN host fast-falls-back to the tunnel mid health-check ladder', () => {
  const LAN = 'ws://192.168.1.50:8080';
  const TUNNEL = 'wss://abc.trycloudflare.com';

  /**
   * Fetch mock: the LAN origin is unreachable (rejects), the tunnel origin
   * answers `{ status: 'ok' }`. So the health-check ladder fails on every LAN
   * attempt and succeeds the moment it switches to the tunnel.
   */
  function installDeadLanFetch(): jest.Mock {
    const lanOrigin = probeOriginOf(LAN);
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.startsWith(lanOrigin)) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(mockResponse(200, { status: 'ok' }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('retries LAN for two attempts, then opens a socket to the tunnel', async () => {
    const saved: SavedConnection = {
      url: LAN,
      token: 'tok',
      lanUrl: LAN,
      lanVerified: true,
      tunnelUrl: TUNNEL,
    };
    const fetchMock = installDeadLanFetch();
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.getState().setSavedConnection(saved);

    // Initial connect against the (now dead) LAN URL.
    useConnectionStore.getState().connect(LAN, 'tok', { silent: true });
    await flushPromises();

    // Attempt 0 probed LAN and failed → schedule retry at rung 0 (1000ms).
    expect(ws.instances.length).toBe(0);
    jest.advanceTimersByTime(RETRY_DELAYS[0]);
    await flushPromises();
    // Attempt 1 probed LAN again and failed → schedule retry at rung 1 (2000ms).
    expect(ws.instances.length).toBe(0);
    jest.advanceTimersByTime(RETRY_DELAYS[1]);
    await flushPromises();
    // Attempt 2 switched to the tunnel → probe ok → opened a socket to TUNNEL.
    expect(ws.instances.length).toBe(1);
    expect(lastDialedUrl(ws)).toBe(TUNNEL);

    // The first two probes were the LAN origin; the third was the tunnel.
    const probed = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(probed[0]).toContain('192.168.1.50');
    expect(probed[1]).toContain('192.168.1.50');
    expect(probed[2]).toContain('abc.trycloudflare.com');

    ws.restore();
  });

  it('keeps retrying LAN (never reaches a socket) when the record has no tunnel', async () => {
    const saved: SavedConnection = {
      url: LAN,
      token: 'tok',
      lanUrl: LAN,
      lanVerified: true,
      // No tunnelUrl, and url is a ws:// LAN URL → deriveTunnelUrl returns null.
    };
    const fetchMock = installDeadLanFetch();
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.getState().setSavedConnection(saved);

    useConnectionStore.getState().connect(LAN, 'tok', { silent: true });
    await flushPromises();
    // Walk the full ladder — every attempt stays on LAN and fails; no socket.
    for (const delay of RETRY_DELAYS) {
      jest.advanceTimersByTime(delay);
      await flushPromises();
    }
    expect(ws.instances.length).toBe(0);
    // Every probe targeted the LAN origin (no tunnel fallback existed).
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('192.168.1.50');
    }

    ws.restore();
  });

  it('opens a socket immediately when the LAN host is actually reachable (no needless fallback)', async () => {
    const saved: SavedConnection = {
      url: LAN,
      token: 'tok',
      lanUrl: LAN,
      lanVerified: true,
      tunnelUrl: TUNNEL,
    };
    // LAN answers ok — the fallback must NOT trigger.
    global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.getState().setSavedConnection(saved);

    useConnectionStore.getState().connect(LAN, 'tok', { silent: true });
    await flushPromises();

    expect(ws.instances.length).toBe(1);
    expect(lastDialedUrl(ws)).toBe(LAN);

    ws.restore();
  });
});
