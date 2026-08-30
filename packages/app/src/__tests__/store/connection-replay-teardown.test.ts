/**
 * #7456 — the replay window and its live-arrival ledger are per-CONNECTION
 * state, and until now nothing released them on a transport drop.
 *
 * `resetReplayReconcile()` was called from exactly one production path on each
 * client — `auth_ok` — so a socket that dropped mid-replay left the session's
 * window open and its ledger populated until the NEXT successful auth, which on
 * a backgrounded app may never come.
 *
 * Since #7455 the window is a REFCOUNT, which makes this load-bearing rather
 * than merely untidy: a `history_replay_start` with no matching `_end` strands
 * a +1, so every later end decrements from a too-high base and the window never
 * closes again for that session — the ledger is never released and every later
 * prompt is protected forever.
 *
 * Cursors are deliberately NOT cleared here: they are what makes the reconnect
 * a delta replay instead of a full rebuild (#5555.3).
 *
 * Harness mirrors connection-reconnect-backoff.test.ts.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve('dev-id-123')),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import {
  reconcileReplayStart,
  recordHistorySeq,
  resetReplayReconcile,
  noteLivePromptDuringReplay,
  wasPromptLiveDuringReplay,
  getReplayWindowDepth,
  getLiveReplayLedgerSessionIds,
  getHistoryCursor,
  isRebuildInProgress,
} from '@chroxy/store-core';
import { useConnectionStore, __resetDeviceIdCacheForTests } from '../../store/connection';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
import { resetReconnectAttempt } from '../../store/message-handler';
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

function installMockWebSocket(): FakeSocket[] {
  const instances: FakeSocket[] = [];
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
  return instances;
}

const originalFetch = global.fetch;
const originalWebSocket = global.WebSocket;

beforeEach(() => {
  jest.useFakeTimers();
  clearAllCallbacks();
  __resetDeviceIdCacheForTests();
  resetReconnectAttempt();
  resetReplayReconcile({ clearCursors: true });
  (SecureStore.getItemAsync as jest.Mock).mockReset();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('dev-id-123');
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  useConnectionStore.setState({ sessionStates: {}, activeSessionId: null, socket: null });
  useConnectionLifecycleStore.setState({
    connectionPhase: 'disconnected',
    connectionError: null,
    connectionRetryCount: 0,
    wsUrl: null,
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  resetReplayReconcile({ clearCursors: true });
  global.fetch = originalFetch;
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
});

/** Open a connection and return the freshly constructed (current-attempt) socket. */
async function openConnectedSocket(): Promise<FakeSocket> {
  global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));
  const instances = installMockWebSocket();
  useConnectionStore.getState().connect('wss://tunnel.example.com', 'tok', { silent: true });
  await flushPromises();
  useConnectionLifecycleStore.setState({ connectionPhase: 'connected' });
  return instances[instances.length - 1]!;
}

/** Open a replay window for `s1` with one live question inside it. */
function openReplayWindowWithRacer(): void {
  reconcileReplayStart('s1', true, []);
  noteLivePromptDuringReplay('s1', 'live-q');
  recordHistorySeq('s1', 42);
  // Positive controls — the fixture took effect, so the assertions below are
  // about the teardown and not about state that was never there.
  expect(getReplayWindowDepth('s1')).toBe(1);
  expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(true);
  expect(isRebuildInProgress('s1')).toBe(true);
}

describe('transport teardown releases the replay window + live-arrival ledger (#7456)', () => {
  it('socket.onclose releases the window and ledger but keeps the history cursor', async () => {
    const socket = await openConnectedSocket();
    openReplayWindowWithRacer();

    socket.onclose?.({ code: 1006 });

    expect(getReplayWindowDepth('s1')).toBe(0);
    expect(getLiveReplayLedgerSessionIds()).toEqual([]);
    expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(false);
    expect(isRebuildInProgress('s1')).toBe(false);
    expect(getHistoryCursor('s1')).toBe(42);
  });

  it('socket.onerror releases the window and ledger but keeps the history cursor', async () => {
    const socket = await openConnectedSocket();
    openReplayWindowWithRacer();

    socket.onerror?.({ message: 'boom' });

    expect(getReplayWindowDepth('s1')).toBe(0);
    expect(getLiveReplayLedgerSessionIds()).toEqual([]);
    expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(false);
    expect(getHistoryCursor('s1')).toBe(42);
  });

  it('a stale socket close does not tear down the CURRENT attempt state', async () => {
    const stale = await openConnectedSocket();
    // A new attempt supersedes it (bumps the module-level attempt id).
    await openConnectedSocket();
    openReplayWindowWithRacer();

    stale.onclose?.({ code: 1006 });

    expect(getReplayWindowDepth('s1')).toBe(1);
    expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(true);
  });
});
