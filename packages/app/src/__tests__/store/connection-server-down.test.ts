/**
 * #5725 (#5698) — terminal `server_down` reconnect state on mobile.
 *
 * PR #5724 capped the reconnect ladder + added the `server_down` ConnectionPhase
 * on the DASHBOARD. The app previously passed no `maxRung`/`onGaveUp` to
 * `createReconnectScheduler`, so it reconnect-looped forever. This wires the cap
 * (→ `server_down` via `onGaveUp`) plus a `retryConnection` action that resets
 * the ladder and re-dials. Mirrors the fake-WebSocket / fake-timer harness in
 * connection-reconnect-backoff.test.ts.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { resetReconnectAttempt, reconnectAttempt, nextReconnectAttempt } from '../../store/message-handler';
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
    userDisconnected: false,
    savedConnection: null,
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  randomSpy.mockRestore();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

async function openConnectedSocket(ws: { instances: FakeSocket[] }) {
  useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
  await flushPromises();
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
}

describe('#5725 terminal server_down after the reconnect ladder is exhausted', () => {
  it('transitions to server_down once the ladder hits RECONNECT_MAX_RUNG (no infinite loop)', async () => {
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);

    // Drive consecutive drops. Each onclose schedules the next rung; advancing
    // the (jitter-pinned) max delay fires it → connect() → fetch → new socket.
    // After RECONNECT_MAX_RUNG rungs the scheduler gives up and onGaveUp sets
    // the terminal phase instead of arming another retry.
    for (let i = 0; i < 15; i++) {
      if (useConnectionLifecycleStore.getState().connectionPhase === 'server_down') break;
      const socket = ws.instances[ws.instances.length - 1];
      socket.onclose?.({ code: 1006 });
      jest.advanceTimersByTime(8000); // top rung is 8000ms (jitter 0)
      await flushPromises();
      // Mark a freshly-built socket connected so the next drop keeps climbing.
      if (useConnectionLifecycleStore.getState().connectionPhase !== 'server_down') {
        useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
      }
    }

    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('server_down');
    expect(useConnectionLifecycleStore.getState().connectionError ?? '').toMatch(/Server appears to be down/i);

    // Terminal: no further socket is built on its own.
    const settled = ws.instances.length;
    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect(ws.instances.length).toBe(settled);

    ws.restore();
  });

  it('retryConnection resets the ladder and re-dials from server_down', async () => {
    const ws = installMockWebSocket();
    // Arrive in the terminal state with a maxed ladder + a saved connection.
    useConnectionLifecycleStore.setState({
      connectionPhase: 'server_down',
      connectionError: 'Server appears to be down',
      savedConnection: { url: 'wss://tunnel.example.com', token: 'tok' },
    });
    // ACTUALLY climb the ladder first so the reset assertion is load-bearing —
    // otherwise reconnectAttempt is already 0 and the test would pass even if
    // retryConnection stopped resetting it.
    resetReconnectAttempt();
    nextReconnectAttempt();
    nextReconnectAttempt();
    nextReconnectAttempt();
    expect(reconnectAttempt).toBeGreaterThan(0);
    const before = ws.instances.length;

    useConnectionStore.getState().retryConnection();
    await flushPromises();
    jest.advanceTimersByTime(0);
    await flushPromises();

    // The ladder was rewound to the bottom rung…
    expect(reconnectAttempt).toBe(0);
    // …and a fresh dial was attempted (connectAuto → connect → WebSocket).
    expect(ws.instances.length).toBeGreaterThan(before);
    // #6296 — and the terminal phase was actually left: retryConnection's
    // `transitionPhase('connecting', { force: true })` exit is a whitelisted
    // forceable edge (server_down → connecting), so the FSM applied it rather
    // than rejecting it. (Tightening force to a whitelist must not wedge here.)
    expect(useConnectionLifecycleStore.getState().connectionPhase).not.toBe('server_down');

    ws.restore();
  });

  it('keeps server_down sticky against the paired onerror/onclose of the same drop', async () => {
    // Regression: RN fires error → close (or close → error) for ONE transport
    // drop. The give-up sets server_down on the first event; the paired second
    // event must NOT clobber it back to reconnecting/disconnected. Two layers
    // hold the line: the handlers' early-return on server_down, and (since #6286)
    // the FSM rejecting the illegal exit instead of applying it.
    const ws = installMockWebSocket();
    await openConnectedSocket(ws);
    const socket = ws.instances[ws.instances.length - 1];
    // Simulate the ladder having given up (terminal phase set by onGaveUp).
    useConnectionLifecycleStore.setState({
      connectionPhase: 'server_down',
      connectionError: 'Server appears to be down',
    });

    // error → close
    socket.onerror?.({});
    socket.onclose?.({ code: 1006 });
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('server_down');

    // and the reverse close → error ordering on the same terminal state
    socket.onclose?.({ code: 1006 });
    socket.onerror?.({});
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('server_down');

    // No spurious reconnect socket was built either.
    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect(ws.instances.length).toBe(1);

    ws.restore();
  });

  it('retryConnection no-ops without a saved connection', async () => {
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.setState({ connectionPhase: 'server_down', savedConnection: null });
    const before = ws.instances.length;

    useConnectionStore.getState().retryConnection();
    await flushPromises();

    expect(ws.instances.length).toBe(before); // nothing to dial
    ws.restore();
  });

  // #6583 — the health-probe give-up (onProbeGaveUp) must latch the STICKY terminal
  // `server_down`, NOT `disconnected`. App.tsx mounts ConnectScreen only while phase
  // === 'disconnected', and ConnectScreen's mount effect auto-connects on mount — so
  // a probe give-up landing in `disconnected` remounts ConnectScreen → auto-connect →
  // give up → `disconnected` → remount → an endless reconnect loop (observed on a real
  // device after lock/unlock over a dead tunnel). `server_down` keeps ConnectScreen
  // unmounted and shows a stable Retry banner instead.
  it('#6583 — a health-probe give-up latches server_down (not disconnected → remount loop)', async () => {
    const ws = installMockWebSocket();
    // The observed repro is a RECONNECT: a saved record exists (from a prior
    // auth_ok), the phone locks/unlocks over a dead server, and the probe ladder
    // exhausts. With a saved record the give-up must latch the sticky terminal
    // 'server_down' — 'disconnected' would remount ConnectScreen (App.tsx gate)
    // whose mount effect auto-connects the saved record → give up → the loop.
    useConnectionLifecycleStore.setState({
      savedConnection: { url: 'wss://10.0.0.71:8765', token: 'tok' },
    });
    // The /health check fails every attempt → the probe retry ladder exhausts
    // CONNECT_MAX_RETRIES → onProbeGaveUp (the give-up path this fix corrects).
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network unreachable'));

    useConnectionStore.getState().connect('wss://10.0.0.71:8765', 'tok', { silent: true });
    await flushPromises();
    for (let i = 0; i < 12; i++) {
      if (useConnectionLifecycleStore.getState().connectionPhase === 'server_down') break;
      jest.advanceTimersByTime(30_000);
      await flushPromises();
    }

    // Pre-fix this was 'disconnected' (→ ConnectScreen remount → auto-connect loop).
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('server_down');
    expect(useConnectionLifecycleStore.getState().connectionPhase).not.toBe('disconnected');
    // The probe never passed, so no WebSocket was ever built.
    expect(ws.instances.length).toBe(0);

    // #6583 — the terminal state must be STICKY: after give-up, advancing time must
    // NOT kick a fresh probe/socket. Pre-fix, landing in 'disconnected' would remount
    // ConnectScreen (App.tsx gate) → mount auto-connect → new probe → the loop. Here
    // it must stay put with no new connection attempts.
    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('server_down');
    expect(ws.instances.length).toBe(0);

    ws.restore();
  });

  // #6583 review — the give-up gate is SAVED-RECORD-conditional. With NO saved
  // record (a first-time connect that never authenticated), the give-up falls back
  // to 'disconnected' → the connect form, NOT 'server_down'. That's correct on both
  // counts: ConnectScreen's mount auto-connect no-ops without a saved record (so
  // 'disconnected' can't loop), and 'server_down' would strand the user on
  // SessionScreen's server_down UI whose Reconnect (retryConnection) no-ops here.
  it('#6583 — a give-up with NO saved record falls back to disconnected (not server_down)', async () => {
    const ws = installMockWebSocket();
    useConnectionLifecycleStore.setState({ savedConnection: null });
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network unreachable'));

    useConnectionStore.getState().connect('wss://10.0.0.71:8765', 'tok', { silent: true });
    await flushPromises();
    for (let i = 0; i < 12; i++) {
      const phase = useConnectionLifecycleStore.getState().connectionPhase;
      if (phase === 'disconnected' || phase === 'server_down') break;
      jest.advanceTimersByTime(30_000);
      await flushPromises();
    }

    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('disconnected');
    expect(useConnectionLifecycleStore.getState().connectionPhase).not.toBe('server_down');
    // Still no socket — the probe never passed.
    expect(ws.instances.length).toBe(0);

    ws.restore();
  });
});
