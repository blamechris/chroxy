/**
 * Integration test for the message-handler dispatch entry's
 * lastClientActivityAt bump (#3762).
 *
 * Guards against the regression where activity-bearing events
 * (stream_delta, stream_start, etc.) would not reset
 * sessionStates[id].lastClientActivityAt — the timestamp the
 * ActivityIndicator and idle-disconnect timers key off of.
 *
 * isActivityEvent() has unit tests in store-core/utils.test.ts, but
 * the wiring between the dispatch entry and the store update was
 * previously uncovered. This test exercises that wire end-to-end:
 *   - explicit msg.sessionId path
 *   - active-session-fallback path (msg has no sessionId)
 *   - passive events (server_status) must NOT bump the timestamp
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  useNotificationStore: { getState: jest.fn(() => ({ addNotification: jest.fn(), dismissNotification: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/conversations', () => ({
  useConversationStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('@chroxy/store-core', () => ({
  ...jest.requireActual('../../store-core/src/index'),
  parseUserInputMessage: jest.fn((text: string) => ({ type: 'text', content: text })),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
} from '../src/store/message-handler';
import { createEmptySessionState } from '../src/store/utils';
import type { ConnectionState, SessionState } from '../src/store/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-activity-1';
const OTHER_SESSION_ID = 'sess-activity-2';

/** Build a minimal ConnectionState with one or two sessions. */
function createMockState(
  initialActivityAt: number | null,
  opts: { withInactivityWarning?: boolean; twoSessions?: boolean } = {},
): Partial<ConnectionState> {
  const primary: SessionState = {
    ...createEmptySessionState(),
    lastClientActivityAt: initialActivityAt,
  };
  if (opts.withInactivityWarning) {
    primary.inactivityWarning = {
      idleMs: 60_000,
      prefab: "Are you there? Tap to send a quick check-in.",
      receivedAt: 2_000,
    };
  }

  const sessionStates: Record<string, SessionState> = { [SESSION_ID]: primary };
  const sessions: any[] = [{ sessionId: SESSION_ID, name: 'A', provider: 'claude-sdk' }];

  if (opts.twoSessions) {
    sessionStates[OTHER_SESSION_ID] = {
      ...createEmptySessionState(),
      lastClientActivityAt: initialActivityAt,
    };
    sessions.push({ sessionId: OTHER_SESSION_ID, name: 'B', provider: 'claude-sdk' });
  }

  return {
    activeSessionId: SESSION_ID,
    sessions,
    availableProviders: [{ name: 'claude-sdk', capabilities: { sessionRules: true } } as any],
    sessionStates,
    appendTerminalData: jest.fn(),
  } as unknown as Partial<ConnectionState>;
}

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState;
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s;
      state = { ...state, ...patch };
    },
  };
}

const mockCtx = {
  url: 'wss://test.example.com',
  token: 'test-token',
  socket: {} as WebSocket,
  isReconnect: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('message-handler dispatch — lastClientActivityAt (#3762)', () => {
  let store: ReturnType<typeof createMockStore>;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.useFakeTimers();
    clearDeltaBuffers();
    // Pin Date.now() so we can assert the exact value the dispatch entry
    // writes. The fake-timer clock isn't tied to Date.now() in jest 29 unless
    // we explicitly enable 'modern' timers + setSystemTime, so spy instead.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    store = createMockStore(createMockState(/* initialActivityAt */ 100));
    setStore(store);
    setConnectionContext(mockCtx as any);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    clearDeltaBuffers();
    jest.runAllTimers();
    jest.useRealTimers();
    setConnectionContext(null);
  });

  describe('activity events bump lastClientActivityAt', () => {
    it('stream_delta with explicit sessionId bumps lastClientActivityAt', () => {
      handleMessage({
        type: 'stream_delta',
        messageId: 'd1',
        sessionId: SESSION_ID,
        delta: 'hi',
      });

      const ss = store.getState().sessionStates[SESSION_ID]!;
      expect(ss.lastClientActivityAt).toBe(10_000);
    });

    it('stream_delta without sessionId falls back to activeSessionId', () => {
      handleMessage({
        type: 'stream_delta',
        messageId: 'd2',
        delta: 'hello',
      });

      const ss = store.getState().sessionStates[SESSION_ID]!;
      expect(ss.lastClientActivityAt).toBe(10_000);
    });

    it('stream_start, stream_end, tool_start, tool_result, message, result all bump the timestamp', () => {
      const cases = [
        { type: 'stream_start', messageId: 's1', sessionId: SESSION_ID },
        { type: 'stream_end', messageId: 's1', sessionId: SESSION_ID },
        { type: 'tool_start', messageId: 't1', sessionId: SESSION_ID, tool: 'Bash', input: {} },
        { type: 'tool_result', messageId: 't1', sessionId: SESSION_ID, output: '' },
        { type: 'message', messageId: 'm1', sessionId: SESSION_ID, role: 'assistant', content: 'hi' },
        { type: 'result', sessionId: SESSION_ID, cost: 0, duration: 1 },
      ];
      for (let i = 0; i < cases.length; i++) {
        nowSpy.mockReturnValue(20_000 + i);
        handleMessage(cases[i]);
        const ss = store.getState().sessionStates[SESSION_ID]!;
        expect(ss.lastClientActivityAt).toBe(20_000 + i);
      }
    });

    it('explicit sessionId targets that session, not the active one', () => {
      store = createMockStore(createMockState(100, { twoSessions: true }));
      setStore(store);

      nowSpy.mockReturnValue(30_000);
      handleMessage({
        type: 'stream_delta',
        messageId: 'd3',
        sessionId: OTHER_SESSION_ID,
        delta: 'data',
      });

      const target = store.getState().sessionStates[OTHER_SESSION_ID]!;
      const active = store.getState().sessionStates[SESSION_ID]!;
      expect(target.lastClientActivityAt).toBe(30_000);
      // Active session must remain at its previous value — the dispatch
      // entry must not bump the wrong slot when sessionId is explicit.
      expect(active.lastClientActivityAt).toBe(100);
    });

    it('dismisses an outstanding inactivityWarning when activity arrives (#3899)', () => {
      store = createMockStore(createMockState(100, { withInactivityWarning: true }));
      setStore(store);

      handleMessage({
        type: 'stream_delta',
        messageId: 'd4',
        sessionId: SESSION_ID,
        delta: 'x',
      });

      const ss = store.getState().sessionStates[SESSION_ID]!;
      expect(ss.lastClientActivityAt).toBe(10_000);
      expect(ss.inactivityWarning).toBeNull();
    });
  });

  describe('passive events do NOT bump lastClientActivityAt', () => {
    it('server_status leaves lastClientActivityAt unchanged', () => {
      handleMessage({
        type: 'server_status',
        sessionId: SESSION_ID,
        status: 'idle',
      });

      const ss = store.getState().sessionStates[SESSION_ID]!;
      expect(ss.lastClientActivityAt).toBe(100);
    });

    it('pong leaves lastClientActivityAt unchanged', () => {
      handleMessage({ type: 'pong' });
      const ss = store.getState().sessionStates[SESSION_ID]!;
      expect(ss.lastClientActivityAt).toBe(100);
    });

    it('unknown message type leaves lastClientActivityAt unchanged', () => {
      // Use a synthetic unknown type — it will fall through every dispatch
      // branch without touching sessionStates, isolating the negative-path
      // assertion from any per-case handler mutations (e.g. session_list
      // rewriting the entire sessionStates map).
      handleMessage({
        type: 'totally_unknown_type_for_3762',
        sessionId: SESSION_ID,
      });
      const ss = store.getState().sessionStates[SESSION_ID]!;
      expect(ss.lastClientActivityAt).toBe(100);
    });
  });

  describe('edge cases', () => {
    it('activity event with unknown sessionId and no activeSessionId is a no-op', () => {
      store = createMockStore({
        activeSessionId: null,
        sessions: [],
        availableProviders: [],
        sessionStates: {},
        appendTerminalData: jest.fn(),
      } as unknown as ConnectionState);
      setStore(store);

      expect(() => {
        handleMessage({
          type: 'stream_delta',
          messageId: 'orphan',
          sessionId: 'nope',
          delta: 'x',
        });
      }).not.toThrow();
      expect(store.getState().sessionStates).toEqual({});
    });
  });
});
