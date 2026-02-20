/**
 * Tests for the connect() lifecycle — health check, retry logic, and WebSocket setup.
 *
 * Mocks global.fetch and global.WebSocket to exercise the connect() code path
 * without any network I/O. Uses Jest fake timers for retry delay assertions.
 */
import { Alert } from 'react-native';
import { useConnectionStore } from '../../store/connection';

// Spy on Alert.alert — avoids jest.mock('react-native') which triggers native modules
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks (promise chains). */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => jest.requireActual<typeof globalThis>('timers').setImmediate(resolve));
}

/** Helper to create a mock Response */
function mockResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  } as unknown as Response;
}

/** Deferred promise helper */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------
const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  mockAlert.mockClear();
  useConnectionStore.setState({
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    _terminalWriteCallback: null,
    connectionError: null,
    connectionRetryCount: 0,
    serverErrors: [],
    connectedClients: [],
    myClientId: null,
    primaryClientId: null,
    connectionPhase: 'disconnected',
    sessionStates: {},
    activeSessionId: null,
    _directoryListingCallback: null,
    socket: null,
    wsUrl: null,
    shutdownReason: null,
    restartEtaMs: null,
    restartingSince: null,
  });
});

afterEach(() => {
  useConnectionStore.getState().disconnect();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connect() health check', () => {
  it('sets connectionError on fetch timeout (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    global.fetch = jest.fn().mockRejectedValue(abortError);

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });
    await flushPromises();

    expect(useConnectionStore.getState().connectionError).toBe('Server not responding');
  });

  it('sets connectionError on HTTP 500', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(500));

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });
    await flushPromises();

    expect(useConnectionStore.getState().connectionError).toBe('HTTP 500');
  });

  it('sets connectionError on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });
    await flushPromises();

    expect(useConnectionStore.getState().connectionError).toBe('Network error');
  });

  it('transitions to server_restarting on restart response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse(200, { status: 'restarting', restartEtaMs: 5000 }),
    );

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });
    await flushPromises();

    const state = useConnectionStore.getState();
    expect(state.connectionPhase).toBe('server_restarting');
    expect(state.shutdownReason).toBe('restart');
    expect(state.restartEtaMs).toBe(5000);
  });
});

describe('connect() retry exhaustion', () => {
  it('sets disconnected + final error after all retries fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });

    // Flush through all 6 attempts (initial + 5 retries).
    // 15_000ms exceeds max jittered delay: max(RETRY_DELAYS) * 1.5 = 8000 * 1.5 = 12_000ms
    for (let attempt = 0; attempt <= 5; attempt++) {
      await flushPromises();
      if (attempt < 5) {
        jest.advanceTimersByTime(15_000);
      }
    }

    const state = useConnectionStore.getState();
    expect(state.connectionPhase).toBe('disconnected');
    expect(state.connectionError).toBe('Could not reach server');
  });

  it('does not show Alert in silent mode after retries exhausted', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });

    // 15_000ms exceeds max jittered delay: max(RETRY_DELAYS) * 1.5 = 8000 * 1.5 = 12_000ms
    for (let attempt = 0; attempt <= 5; attempt++) {
      await flushPromises();
      if (attempt < 5) {
        jest.advanceTimersByTime(15_000);
      }
    }

    expect(mockAlert).not.toHaveBeenCalled();
  });
});

describe('connect() WebSocket setup', () => {
  it('creates WebSocket after successful health check', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { status: 'ok' }));

    const wsInstances: { url: string }[] = [];
    const OriginalWebSocket = global.WebSocket;
    // @ts-expect-error — mock WebSocket constructor
    global.WebSocket = class MockWebSocket {
      static OPEN = 1;
      url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: unknown) => void) | null = null;
      send = jest.fn();
      close = jest.fn();
      constructor(url: string) {
        this.url = url;
        wsInstances.push(this);
      }
    };

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });
    await flushPromises();

    expect(wsInstances.length).toBeGreaterThanOrEqual(1);
    expect(wsInstances[0].url).toBe('wss://example.com');

    global.WebSocket = OriginalWebSocket;
  });

  it('transitions through connecting phase', () => {
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {}));

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });

    expect(useConnectionStore.getState().connectionPhase).toBe('connecting');
  });
});

describe('connect() attempt cancellation', () => {
  it('stale attempts are ignored when a new connect is called', async () => {
    const firstFetch = deferred<Response>();
    global.fetch = jest.fn().mockReturnValue(firstFetch.promise);

    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });

    // Second connect overrides the attempt ID
    const secondFetch = deferred<Response>();
    global.fetch = jest.fn().mockReturnValue(secondFetch.promise);
    useConnectionStore.getState().connect('wss://example.com', 'tok', { silent: true });

    // Resolve the FIRST fetch with an error — should be ignored (stale attempt)
    firstFetch.reject(new TypeError('Network request failed'));
    await flushPromises();

    // State should still be 'connecting' (from the second connect), not have an error
    const state = useConnectionStore.getState();
    expect(state.connectionPhase).not.toBe('disconnected');
    expect(state.connectionError).toBeNull();
  });
});
