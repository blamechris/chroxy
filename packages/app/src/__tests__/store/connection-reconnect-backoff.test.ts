/**
 * #5555.5 — reconnect backoff on the socket-close/error path.
 *
 * The close/error handlers used to schedule reconnects at a FIXED delay
 * (AUTO_RECONNECT_DELAY=1500ms / ERROR_RECONNECT_DELAY=2000ms), so a flapping
 * tunnel hammered the full handshake every ~1.5–2s. They now climb the shared
 * RETRY_DELAYS ladder ([1000, 2000, 3000, 5000, 8000], jittered) via a
 * module-level counter that RESETS on `auth_ok` (a successful connect), NOT on
 * mere socket-open.
 *
 * Math.random is pinned to 0 so withJitter() is the identity and each rung's
 * delay is exactly RETRY_DELAYS[N].
 *
 * Mirrors the fake-WebSocket / fake-timer harness in
 * connection-audit-phase1.test.ts.
 */
import type { SavedConnection } from '@chroxy/store-core';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import {
  resetReconnectAttempt,
  nextReconnectAttempt,
  reconnectAttempt,
} from '../../store/message-handler';
import { clearAllCallbacks } from '../../store/imperative-callbacks';

// The five-rung backoff ladder (kept in sync with connect()'s RETRY_DELAYS).
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
  // Pin jitter to zero so each rung delay is exactly RETRY_DELAYS[N].
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
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
  randomSpy.mockRestore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Ladder math (pure module-level counter)
// ---------------------------------------------------------------------------

describe('reconnect backoff ladder counter (#5555.5)', () => {
  it('nextReconnectAttempt advances and resetReconnectAttempt rewinds', () => {
    expect(reconnectAttempt).toBe(0);
    expect(nextReconnectAttempt()).toBe(0); // pre-increment index
    expect(nextReconnectAttempt()).toBe(1);
    expect(nextReconnectAttempt()).toBe(2);
    resetReconnectAttempt();
    expect(reconnectAttempt).toBe(0);
    expect(nextReconnectAttempt()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end close-path backoff
// ---------------------------------------------------------------------------

describe('socket-close reconnect backoff (#5555.5)', () => {
  async function openConnectedSocket() {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    return { ws, fetchMock };
  }

  /**
   * Drives one drop → reconnect cycle and asserts the reconnect fires at exactly
   * `expectedDelay` ms (no sooner). Marks the freshly created socket connected so
   * the next drop takes the auto-reconnect branch again.
   */
  async function expectReconnectAt(ws: { instances: FakeSocket[] }, expectedDelay: number) {
    const socket = ws.instances[ws.instances.length - 1];
    const before = ws.instances.length;

    socket.onclose?.({ code: 1006 });

    // One tick short of the rung delay: still no new socket.
    jest.advanceTimersByTime(expectedDelay - 1);
    await flushPromises();
    expect(ws.instances.length).toBe(before);

    // Cross the boundary: the reconnect fires (connect() → fetch → new socket).
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(ws.instances.length).toBe(before + 1);

    // Mark the new socket connected for the next cycle.
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  }

  it('escalates through the RETRY_DELAYS ladder across consecutive drops', async () => {
    const { ws } = await openConnectedSocket();

    // Rung 0 → 1000ms, rung 1 → 2000ms, rung 2 → 3000ms, rung 3 → 5000ms.
    await expectReconnectAt(ws, RETRY_DELAYS[0]);
    await expectReconnectAt(ws, RETRY_DELAYS[1]);
    await expectReconnectAt(ws, RETRY_DELAYS[2]);
    await expectReconnectAt(ws, RETRY_DELAYS[3]);

    ws.restore();
  });

  it('caps at the top rung (8000ms) once the ladder is exhausted', async () => {
    const { ws } = await openConnectedSocket();

    // Walk to the last rung.
    await expectReconnectAt(ws, RETRY_DELAYS[0]);
    await expectReconnectAt(ws, RETRY_DELAYS[1]);
    await expectReconnectAt(ws, RETRY_DELAYS[2]);
    await expectReconnectAt(ws, RETRY_DELAYS[3]);
    // Rung 4 and every subsequent drop clamp at the final 8000ms rung.
    await expectReconnectAt(ws, RETRY_DELAYS[4]);
    await expectReconnectAt(ws, RETRY_DELAYS[4]);

    ws.restore();
  });

  it('does NOT use the old fixed 1500ms delay on the first close', async () => {
    const { ws } = await openConnectedSocket();
    const socket = ws.instances[0];
    const before = ws.instances.length;

    socket.onclose?.({ code: 1006 });
    // At the legacy fixed delay the reconnect would already have fired — assert
    // it has NOT (rung 0 is 1000ms, so by 1000ms it fires; we check that the
    // delay is ladder-driven by confirming it fires at exactly 1000, see above).
    // Here we just confirm 1500ms isn't the gate: it already fired by 1000.
    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(ws.instances.length).toBe(before + 1);

    ws.restore();
  });
});

// ---------------------------------------------------------------------------
// Reset-on-auth_ok (NOT on socket-open)
// ---------------------------------------------------------------------------

describe('backoff ladder resets on auth_ok, not socket-open (#5555.5)', () => {
  async function openConnectedSocket() {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();
    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    return { ws };
  }

  it('a successful auth_ok rewinds the ladder back to the bottom rung', async () => {
    const { ws } = await openConnectedSocket();

    // Two consecutive drops climb to rung 2 (the next drop would be 3000ms).
    const s0 = ws.instances[0];
    s0.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[0]); // rung 0 fires
    await flushPromises();
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });

    const s1 = ws.instances[1];
    s1.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[1]); // rung 1 fires
    await flushPromises();

    // The reconnect opened a fresh socket; drive a real auth_ok through its
    // onmessage so the production handler resets the ladder.
    const s2 = ws.instances[2];
    s2.readyState = 1;
    s2.onopen?.();
    await flushPromises();
    expect(reconnectAttempt).toBe(2); // climbed but not yet reset

    s2.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
    await flushPromises();

    // auth_ok reset the ladder — the next drop schedules at rung 0 (1000ms).
    expect(reconnectAttempt).toBe(0);

    const before = ws.instances.length;
    s2.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[0] - 1);
    await flushPromises();
    expect(ws.instances.length).toBe(before); // not yet — proves it's 1000ms not <1000ms
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(ws.instances.length).toBe(before + 1);

    ws.restore();
  });

  it('socket-open alone does NOT reset the ladder (only auth_ok does)', async () => {
    const { ws } = await openConnectedSocket();

    const s0 = ws.instances[0];
    s0.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(RETRY_DELAYS[0]); // rung 0 fires
    await flushPromises();

    // The reconnect's socket OPENED (onopen) but never authenticated.
    const s1 = ws.instances[1];
    s1.readyState = 1;
    s1.onopen?.();
    await flushPromises();

    // No auth_ok → ladder must NOT have reset; it's at rung 1.
    expect(reconnectAttempt).toBe(1);

    ws.restore();
  });
});

// ---------------------------------------------------------------------------
// #5623 — onclose clears the presence role on every session so a stale
// "Observing"/driver badge doesn't survive the reconnect gap. The server
// re-emits session_role on reconnect/tab-switch, re-establishing the role.
// ---------------------------------------------------------------------------

describe('onclose clears sessionRole/primaryClientId on all sessions (#5623)', () => {
  async function openConnectedSocket() {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
    global.fetch = fetchMock;
    const ws = installMockWebSocket();

    useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
    await flushPromises();
    useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
    return { ws };
  }

  it('nulls sessionRole and primaryClientId across active + background sessions', async () => {
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: {
          messages: [],
          sessionRole: 'observer',
          primaryClientId: 'other-device',
        },
        b: {
          messages: [],
          sessionRole: 'primary',
          primaryClientId: 'me',
        },
      } as never,
    });

    const socket = ws.instances[ws.instances.length - 1];
    socket.onclose?.({ code: 1006 });
    await flushPromises();

    const st = useConnectionStore.getState();
    expect(st.sessionStates.a!.sessionRole).toBeNull();
    expect(st.sessionStates.a!.primaryClientId).toBeNull();
    expect(st.sessionStates.b!.sessionRole).toBeNull();
    expect(st.sessionStates.b!.primaryClientId).toBeNull();

    ws.restore();
  });

  // User-initiated disconnect() nulls socket.onclose, so the onclose clear
  // never runs — the role-clear must be mirrored here too (#5623).
  it('also clears roles on user-initiated disconnect()', async () => {
    const { ws } = await openConnectedSocket();

    useConnectionStore.setState({
      activeSessionId: 'a',
      sessionStates: {
        a: { messages: [], sessionRole: 'observer', primaryClientId: 'other-device' },
        b: { messages: [], sessionRole: 'primary', primaryClientId: 'me' },
      } as never,
    });

    useConnectionStore.getState().disconnect();
    await flushPromises();

    const st = useConnectionStore.getState();
    expect(st.sessionStates.a!.sessionRole).toBeNull();
    expect(st.sessionStates.a!.primaryClientId).toBeNull();
    expect(st.sessionStates.b!.sessionRole).toBeNull();
    expect(st.sessionStates.b!.primaryClientId).toBeNull();

    ws.restore();
  });
});
