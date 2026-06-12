/**
 * Behavioural test for the resume zombie-socket liveness fix (#5633).
 *
 * The bug this guards against: the resume "Case 0" path fires when the socket
 * still claims `readyState === OPEN` after a long background, and (saved-conn
 * case) calls `connectAuto(savedConnection)`. But `connectAuto` had a no-op
 * guard that early-returns when `connected && socket OPEN && currentUrl ===
 * selection.url`. For a TUNNEL connection the selector returns the same tunnel
 * URL with no health probe, so all three conditions held and connectAuto
 * returned WITHOUT tearing down the zombie socket — making the whole liveness
 * fix a no-op in exactly the scenario it targets.
 *
 * This test drives the real AppState listener registered by connection.ts
 * (background → wait one heartbeat cycle → foreground) against a connected
 * tunnel state, and asserts the zombie socket is actually REPLACED: the old
 * socket is closed and a fresh connection attempt (new WebSocket + bumped
 * attempt id) is started.
 *
 * It is written to FAIL against the pre-fix code (connectAuto no-ops, old
 * socket never closes, no new WebSocket) and PASS after the `force` option is
 * threaded through.
 */

import { AppState } from 'react-native';
import type { SavedConnection } from '@chroxy/store-core';

// Capture the AppState 'change' handler that connection.ts registers at import
// time. The spy MUST be installed before connection.ts is first required, so we
// install it here (module-eval, before the lazy require below) and load
// connection.ts via require() afterwards rather than a top-level import.
let appStateHandler: ((state: string) => void) | null = null;
jest
  .spyOn(AppState, 'addEventListener')
  .mockImplementation(((type: string, handler: (state: string) => void) => {
    if (type === 'change') appStateHandler = handler;
    return { remove: jest.fn() };
  }) as typeof AppState.addEventListener);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useConnectionStore } = require('../src/store/connection');
const {
  useConnectionLifecycleStore,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('../src/store/connection-lifecycle');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const messageHandler = require('../src/store/message-handler');

/** Flush pending microtasks (the connectAuto/connect promise chain). */
function flushPromises(): Promise<void> {
  return new Promise((resolve) =>
    jest.requireActual<typeof globalThis>('timers').setImmediate(resolve),
  );
}

const TUNNEL_URL = 'wss://zombie-test.trycloudflare.com';
const HEARTBEAT_INTERVAL_MS = 15_000;

const savedTunnelConnection: SavedConnection = {
  url: TUNNEL_URL,
  tunnelUrl: TUNNEL_URL,
  token: 'tok-zombie',
  // No verified LAN candidate → selectConnectEndpoint returns the tunnel URL as
  // the fallback with NO health probe (the canonical zombie scenario).
};

interface FakeSocket {
  readyState: number;
  url: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: unknown) => void) | null;
  send: jest.Mock;
  close: jest.Mock;
}

const originalFetch = global.fetch;
const originalWebSocket = global.WebSocket;
let newWsInstances: { url: string }[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  newWsInstances = [];

  // selectConnectEndpoint for a tunnel-only record never fetches, but connect()
  // does its own /health GET before opening the WS. Return ok so the path runs.
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'ok' }),
    text: () => Promise.resolve('{"status":"ok"}'),
  } as unknown as Response);

  // Record every NEW socket connect() opens.
  // @ts-expect-error — mock WebSocket constructor
  global.WebSocket = class MockWebSocket {
    static OPEN = 1;
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(url: string) {
      this.url = url;
      newWsInstances.push(this);
    }
  };

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
  global.fetch = originalFetch;
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
});

/** Seed a "connected over the tunnel" state with a zombie socket (claims OPEN). */
function seedConnectedTunnelWithZombieSocket(): FakeSocket {
  const zombie: FakeSocket = {
    readyState: 1, // WebSocket.OPEN — the lie that makes this a zombie
    url: TUNNEL_URL,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: jest.fn(),
    close: jest.fn(),
  };
  useConnectionStore.setState({ socket: zombie as unknown as WebSocket });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'connected',
    wsUrl: TUNNEL_URL,
    apiToken: savedTunnelConnection.token,
    userDisconnected: false,
    savedConnection: savedTunnelConnection,
  });
  return zombie;
}

describe('Resume zombie-socket reconnect — behavioural (#5633)', () => {
  it('registered an AppState change handler', () => {
    expect(appStateHandler).toBeInstanceOf(Function);
  });

  it('REPLACES the zombie socket after a long background even though it still claims OPEN', async () => {
    const handler = appStateHandler;
    if (!handler) throw new Error('AppState handler not captured');

    const zombie = seedConnectedTunnelWithZombieSocket();
    const attemptIdBefore = messageHandler.connectionAttemptId;

    // Background, wait at least one full heartbeat cycle, then foreground.
    handler('background');
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 1_000);
    handler('active');

    // connectAuto → selectConnectEndpoint resolves async, then connect() runs
    // synchronously (bumps attempt id + closes old socket before its fetch).
    await flushPromises();
    await flushPromises();

    // 1) Fresh connection attempt was started (attempt id bumped).
    expect(messageHandler.connectionAttemptId).toBeGreaterThan(attemptIdBefore);

    // 2) The zombie socket was torn down (neutered + closed).
    expect(zombie.close).toHaveBeenCalled();
    expect(zombie.onclose).toBeNull();

    // 3) A brand-new socket was created for the reconnect.
    expect(newWsInstances.length).toBeGreaterThanOrEqual(1);
    expect(newWsInstances[0].url).toBe(TUNNEL_URL);
  });
});
