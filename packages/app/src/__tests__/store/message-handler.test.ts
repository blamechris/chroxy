/**
 * Tests for message-handler state cleanup (#832, #844).
 *
 * Uses _testMessageHandler to invoke handleMessage directly
 * with a mock Zustand store.
 */
import { Alert } from 'react-native';
import { _testMessageHandler, setStore } from '../../store/message-handler';
import { createEmptySessionState } from '../../store/utils';
import { clearPersistedSession } from '../../store/persistence';
import type { ConnectionState } from '../../store/types';

// Mock persistence to track calls
jest.mock('../../store/persistence', () => ({
  clearPersistedSession: jest.fn(() => Promise.resolve()),
  persistSessionMessages: jest.fn(),
  persistViewMode: jest.fn(),
  persistActiveSession: jest.fn(),
  persistTerminalBuffer: jest.fn(),
  loadPersistedState: jest.fn(),
  loadSessionMessages: jest.fn(),
  clearPersistedState: jest.fn(),
  _resetForTesting: jest.fn(),
}));

// Mock Alert
jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** Create a minimal mock Zustand store */
function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState;
  return {
    getState: () => state,
    setState: (updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      if (typeof updater === 'function') {
        state = { ...state, ...updater(state) };
      } else {
        state = { ...state, ...updater };
      }
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

/** Create a minimal ConnectionContext */
function createMockContext() {
  return {
    socket: { readyState: 1, send: jest.fn() } as any,
    serverUrl: 'wss://test.example.com',
    apiToken: 'test-token',
    connectionId: 'test-conn-1',
    reconnecting: false,
    connectedAt: Date.now(),
    isSessionSwitchReplay: false,
    activeSessionIdAtConnect: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('session_timeout handler', () => {
  it('removes timed-out session from sessionStates and sessions list', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: { ...createEmptySessionState(), messages: [{ id: 'm1', type: 'response', content: 'hello', timestamp: 1 }] },
      },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'Session 1', idleMs: 600000 });

    const state = store.getState();
    expect(state.sessionStates).not.toHaveProperty('s1');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].sessionId).toBe('s2');
  });

  it('switches active session to next available when active session times out', () => {
    const s2State = { ...createEmptySessionState(), messages: [{ id: 'm1', type: 'response' as const, content: 'from s2', timestamp: 1 }] };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: s2State,
      },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'Session 1', idleMs: 600000 });

    const state = store.getState();
    expect(state.activeSessionId).toBe('s2');
    // Flat fields should be synced from s2
    expect(state.messages).toEqual(s2State.messages);
  });

  it('clears flat fields when no sessions remain', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'Session 1' } as any],
      sessionStates: {
        s1: createEmptySessionState(),
      },
      messages: [{ id: 'm1', type: 'response' as const, content: 'test', timestamp: 1 }],
      claudeReady: true,
      activeModel: 'claude-sonnet',
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'Session 1', idleMs: 600000 });

    const state = store.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.claudeReady).toBe(false);
    expect(state.activeModel).toBeNull();
    expect(state.isIdle).toBe(true);
  });

  it('calls clearPersistedSession for the timed-out session', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'Test' } as any],
      sessionStates: { s1: createEmptySessionState() },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'Test', idleMs: 300000 });

    expect(clearPersistedSession).toHaveBeenCalledWith('s1');
  });

  it('shows Alert with session name', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'My Project' } as any],
      sessionStates: { s1: createEmptySessionState() },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'My Project', idleMs: 600000 });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Session Closed',
      'Session "My Project" was closed due to inactivity.'
    );
  });

  it('does not affect other sessions when non-active session times out', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Active' } as any,
        { sessionId: 's2', name: 'Background' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
      },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's2', name: 'Background', idleMs: 600000 });

    const state = store.getState();
    // Active session should remain unchanged
    expect(state.activeSessionId).toBe('s1');
    expect(state.sessionStates).toHaveProperty('s1');
    expect(state.sessionStates).not.toHaveProperty('s2');
    expect(state.sessions).toHaveLength(1);
  });
});

describe('session_list GC handler', () => {
  it('calls clearPersistedSession for sessions removed from list', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
      },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    // Send session_list that only includes s1 (s2 removed)
    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'Session 1' }],
    });

    expect(clearPersistedSession).toHaveBeenCalledWith('s2');
    expect(store.getState().sessionStates).not.toHaveProperty('s2');
  });

  it('does not call clearPersistedSession when no sessions removed', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'Session 1' } as any],
      sessionStates: { s1: createEmptySessionState() },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'Session 1' }],
    });

    expect(clearPersistedSession).not.toHaveBeenCalled();
  });

  it('cleans up multiple removed sessions at once', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'S1' } as any,
        { sessionId: 's2', name: 'S2' } as any,
        { sessionId: 's3', name: 'S3' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
        s3: createEmptySessionState(),
      },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    // Only s1 remains
    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'S1' }],
    });

    expect(clearPersistedSession).toHaveBeenCalledWith('s2');
    expect(clearPersistedSession).toHaveBeenCalledWith('s3');
    expect(clearPersistedSession).toHaveBeenCalledTimes(2);
    const state = store.getState();
    expect(state.sessionStates).not.toHaveProperty('s2');
    expect(state.sessionStates).not.toHaveProperty('s3');
    expect(state.sessionStates).toHaveProperty('s1');
  });

  it('switches active session when active session is removed from list', () => {
    const s2State = { ...createEmptySessionState(), messages: [{ id: 'm1', type: 'response' as const, content: 'from s2', timestamp: 1 }] };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'S1' } as any,
        { sessionId: 's2', name: 'S2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: s2State,
      },
      messages: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    // Remove active session s1, only s2 remains
    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's2', name: 'S2' }],
    });

    const state = store.getState();
    expect(state.activeSessionId).toBe('s2');
    expect(state.messages).toEqual(s2State.messages);
  });

  it('clears flat fields when all sessions removed via empty list', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'S1' } as any,
        { sessionId: 's2', name: 'S2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
      },
      messages: [{ id: 'm1', type: 'response' as const, content: 'test', timestamp: 1 }],
      claudeReady: true,
      activeModel: 'claude-sonnet',
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [],
    });

    expect(clearPersistedSession).toHaveBeenCalledWith('s1');
    expect(clearPersistedSession).toHaveBeenCalledWith('s2');
    expect(clearPersistedSession).toHaveBeenCalledTimes(2);

    const state = store.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.claudeReady).toBe(false);
    expect(state.activeModel).toBeNull();
  });
});

afterAll(() => {
  _testMessageHandler.clearContext();
});
