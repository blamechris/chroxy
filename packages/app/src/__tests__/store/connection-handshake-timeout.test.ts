/**
 * #5962 (#5721 parity) — client-side handshake timeout (mobile app).
 *
 * The heartbeat does not start until `auth_ok` is processed, so the handshake
 * window (socket OPEN + `auth`/`pair` sent, awaiting `auth_ok`/`key_exchange_ok`)
 * had no liveness coverage. A dedicated HANDSHAKE_TIMEOUT_MS timer now fires
 * "Handshake failed — reconnecting" and hands off to the normal reconnect ladder
 * instead of a silent stall. These tests drive the production onopen / onmessage /
 * onerror / disconnect paths with a fake socket + fake timers (mirrors the
 * harness in connection-reconnect-backoff.test.ts; the dashboard analogue is
 * connection-handshake-timeout.test.ts).
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
async function openConnected(ws: { instances: FakeSocket[] }): Promise<FakeSocket> {
  const before = ws.instances.length;
  useConnectionStore.getState().connect('wss://tunnel.example.com/ws', 'tok', { silent: true });
  await flushPromises();
  const socket = ws.instances[before]!;
  socket.readyState = 1;
  socket.onopen?.();
  await flushPromises(); // onopen awaits getDeviceId().then(...) → send + arm
  return socket;
}

describe('#5962 client-side handshake timeout (mobile app)', () => {
  it('fires after HANDSHAKE_TIMEOUT_MS when no auth_ok arrives, then reconnects', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnected(ws);
    // The auth handshake frame went out…
    expect(socket.send.mock.calls.some(([d]) => String(d).includes('"type":"auth"'))).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();

    // …but no auth_ok / key_exchange_ok ever completes it.
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    await flushPromises();

    // The wedged socket is dropped and the UX shows the reconnecting state.
    expect(socket.close).toHaveBeenCalled();
    expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('reconnecting');
    expect(useConnectionLifecycleStore.getState().connectionError ?? '').toMatch(/Handshake failed/i);

    // It hands off to the normal reconnect ladder — a fresh socket is built.
    const before = ws.instances.length;
    jest.advanceTimersByTime(2_000); // past the (jitter-pinned) first rung
    await flushPromises();
    expect(ws.instances.length).toBeGreaterThan(before);

    ws.restore();
  });

  it('clears the timer on auth_ok — no spurious fire on a healthy connect', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnected(ws);
    const socketsBefore = ws.instances.length;

    // Drive a real auth_ok through the production onmessage path.
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
    await flushPromises();

    // Past the handshake budget — the timer was cleared, so it must NOT fire:
    // the socket stays open, no reconnect socket is built, and the
    // handshake-timeout error never appears. (Stop short of the 15s+5s heartbeat
    // reaper that auth_ok started, which would close the socket for another reason.)
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 2_000);
    await flushPromises();
    expect(socket.close).not.toHaveBeenCalled();
    expect(ws.instances.length).toBe(socketsBefore); // no reconnect socket
    expect(useConnectionLifecycleStore.getState().connectionError ?? '').not.toMatch(/Handshake failed/i);

    ws.restore();
  });

  it('does not fire after a user-initiated disconnect', async () => {
    const ws = installMockWebSocket();
    await openConnected(ws);
    const socketsBefore = ws.instances.length;

    useConnectionStore.getState().disconnect();
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2);
    await flushPromises();

    // disconnect() cleared the timer; it must not reconnect.
    expect(ws.instances.length).toBe(socketsBefore);
    expect(useConnectionLifecycleStore.getState().connectionPhase).not.toBe('reconnecting');

    ws.restore();
  });

  it('does not schedule a second reconnect when the socket already errored', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnected(ws);

    // A transport error schedules a reconnect AND clears the handshake timer
    // (onerror's teardown clear), so the timeout window is now a no-op.
    socket.onerror?.({});
    await flushPromises();

    // Advancing past the handshake budget adds nothing extra (the timer was
    // cleared; and even if it weren't, scheduleReconnect's per-socket dedupe
    // would suppress a second reconnect). Exactly one reconnect socket appears.
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    jest.advanceTimersByTime(2_000); // let the single scheduled rung fire
    await flushPromises();
    expect(ws.instances.length).toBe(2); // original + exactly one reconnect

    ws.restore();
  });
});

// ---------------------------------------------------------------------------
// #6066 — real-socket reconnect-parity validation after the #6065 connection-
// runtime extraction. These exercise the SAME shared controller as the existing
// cases above, but at the real-socket integration level (drive onopen/onmessage/
// onclose through connect()), to assert the timer mechanics survive the
// extraction without behavior drift.
// ---------------------------------------------------------------------------
describe('#6066 reconnect parity (real socket, mobile app)', () => {
  // (1) The stale handshake timer from the FIRST socket must not also fire after
  //     a reconnect re-enters onopen and re-arms it — exactly one reconnect per
  //     window, not two. (Distinct from the store-core unit test's pure re-arm
  //     check and the dashboard's onerror dedupe: this is the reconnect-re-entry
  //     path through connect().)
  it('handshake timeout does not double-fire on reconnect re-entry', async () => {
    const ws = installMockWebSocket();
    const first = await openConnected(ws);

    // First handshake times out → close + scheduled reconnect.
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    await flushPromises();
    expect(first.close).toHaveBeenCalled();
    const afterFirstTimeout = ws.instances.length;

    // The reconnect rung fires and builds a fresh socket, whose onopen re-arms
    // the handshake timer (clearHandshakeTimer-then-set, so the stale first timer
    // can never also fire).
    jest.advanceTimersByTime(2_000);
    await flushPromises();
    expect(ws.instances.length).toBe(afterFirstTimeout + 1);
    const second = ws.instances[ws.instances.length - 1]!;
    second.readyState = 1;
    second.onopen?.();
    await flushPromises();

    // Advance one full handshake window: the SECOND timer fires once → exactly
    // one further reconnect socket. If the stale first timer had survived the
    // re-arm we'd see two reconnects scheduled in this window.
    const beforeSecondTimeout = ws.instances.length;
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    await flushPromises();
    jest.advanceTimersByTime(8_000); // let the (single) scheduled rung fire
    await flushPromises();
    expect(ws.instances.length).toBe(beforeSecondTimeout + 1); // one reconnect, not two

    ws.restore();
  });

  // (2) BLACK BOX: once connected+authed, an unanswered ping → pong-timeout
  //     reaper closes the dead socket and STOPS the heartbeat (no further pings).
  //     Asserted purely via observable behavior — socket.close() and the ping
  //     send count — with no reliance on any exposed internal `isHeartbeatRunning`
  //     flag (no source change).
  it('pong timeout closes the dead socket and stops the heartbeat', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnected(ws);

    // Complete the handshake so the heartbeat starts (it does NOT start before
    // auth_ok). Past this point pings flow on HEARTBEAT_INTERVAL_MS.
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
    await flushPromises();
    expect(socket.close).not.toHaveBeenCalled();

    // Baseline the send count AFTER auth_ok settles (auth_ok triggers list_*
    // requests), then advance one heartbeat interval → exactly one ping is sent.
    const sendsAfterAuth = socket.send.mock.calls.length;
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await flushPromises();
    const sendsAfterFirstPing = socket.send.mock.calls.length;
    expect(sendsAfterFirstPing).toBe(sendsAfterAuth + 1); // the ping went out
    expect(socket.send.mock.calls.some(([d]) => String(d).includes('"type":"ping"'))).toBe(true);

    // Do NOT answer the pong; advance past the pong timeout → the reaper closes
    // the dead socket.
    jest.advanceTimersByTime(PONG_TIMEOUT_MS);
    await flushPromises();
    expect(socket.close).toHaveBeenCalled();

    // The heartbeat is stopped: advancing two more intervals sends nothing more
    // (observable proof, no internal-flag peek).
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    await flushPromises();
    expect(socket.send.mock.calls.length).toBe(sendsAfterFirstPing);

    ws.restore();
  });

  // (3) The backoff ladder ADVANCES when the reconnect is triggered by a
  //     handshake timeout (not just by a socket close/error). A socket that opens
  //     but never authenticates keeps climbing the ladder.
  it('backoff ladder advances on a handshake-timeout-triggered reconnect', async () => {
    const ws = installMockWebSocket();
    await openConnected(ws);
    expect(reconnectAttempt).toBe(0); // fresh ladder (resetReconnectAttempt in beforeEach)

    // First handshake never completes → the timeout schedules a reconnect, which
    // burns rung 0.
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    await flushPromises();
    jest.advanceTimersByTime(2_000); // rung 0 (1000ms) fires → fresh socket
    await flushPromises();
    expect(reconnectAttempt).toBe(1); // advanced past rung 0

    // The reconnect socket opens but again never authenticates → its handshake
    // also times out and burns rung 1.
    const second = ws.instances[ws.instances.length - 1]!;
    second.readyState = 1;
    second.onopen?.();
    await flushPromises();
    jest.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    await flushPromises();
    jest.advanceTimersByTime(2_000); // rung 1 (2000ms) fires
    await flushPromises();
    expect(reconnectAttempt).toBe(2); // climbed again on a handshake-timeout reconnect

    ws.restore();
  });

  // (4) No fake timer survives a user-initiated disconnect() — the handshake
  //     timer, the heartbeat interval, and the pong-timeout are all cleared, so
  //     nothing leaks into the next test.
  it('leaves no pending timer after disconnect()', async () => {
    const ws = installMockWebSocket();
    const socket = await openConnected(ws);
    // Authenticate so the heartbeat interval is also live (the richest timer set:
    // handshake cleared by auth_ok, heartbeat interval armed, pong-timeout armed
    // after a ping).
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli' }) });
    await flushPromises();
    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // arm the pong-timeout too
    await flushPromises();
    expect(jest.getTimerCount()).toBeGreaterThan(0); // timers are live pre-disconnect

    useConnectionStore.getState().disconnect();
    await flushPromises();
    expect(jest.getTimerCount()).toBe(0); // every timer cleared — no leak

    ws.restore();
  });
});
