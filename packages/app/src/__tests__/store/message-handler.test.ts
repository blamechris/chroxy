/**
 * Tests for message-handler state cleanup (#832, #844).
 *
 * Uses _testMessageHandler to invoke handleMessage directly
 * with a mock Zustand store.
 */
import { Alert } from 'react-native';
import { _testMessageHandler, setStore, CLIENT_PROTOCOL_VERSION, SUBSCRIBE_SESSIONS_CHUNK_SIZE, clearPermissionSplits, clearDeltaBuffers, resetReplayFlags } from '../../store/message-handler';
import { createEmptySessionState } from '../../store/utils';
import { clearPersistedSession } from '../../store/persistence';
import { setCallback, clearAllCallbacks } from '../../store/imperative-callbacks';
import { useMultiClientStore } from '../../store/multi-client';
import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';
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
  clearAllCallbacks();
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
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'Session 1', idleMs: 600000 });

    const state = store.getState();
    expect(state.activeSessionId).toBe('s2');
    // Active session messages should be from s2
    expect(state.sessionStates['s2'].messages).toEqual(s2State.messages);
  });

  it('sets activeSessionId to null when no sessions remain', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'Session 1' } as any],
      sessionStates: {
        s1: createEmptySessionState(),
      },
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'session_timeout', sessionId: 's1', name: 'Session 1', idleMs: 600000 });

    const state = store.getState();
    expect(state.activeSessionId).toBeNull();
    expect(Object.keys(state.sessionStates)).not.toContain('s1');
  });

  it('calls clearPersistedSession for the timed-out session', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'Test' } as any],
      sessionStates: { s1: createEmptySessionState() },

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
    expect(state.sessionStates['s2'].messages).toEqual(s2State.messages);
  });

  it('sets activeSessionId to null when all sessions removed via empty list', () => {
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
    expect(Object.keys(state.sessionStates)).toHaveLength(0);
  });
});

describe('checkpoint_restored handler', () => {
  it('calls switchSession with serverNotify:false and haptic:false', () => {
    const switchSession = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      switchSession,
    } as any);

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'checkpoint_restored', newSessionId: 's2' });

    expect(switchSession).toHaveBeenCalledWith('s2', { serverNotify: false, haptic: false });
  });

  it('does not call switchSession when newSessionId is missing', () => {
    const switchSession = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      switchSession,
    } as any);

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'checkpoint_restored' });

    expect(switchSession).not.toHaveBeenCalled();
  });

  it('does not call switchSession when newSessionId is empty string', () => {
    const switchSession = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      switchSession,
    } as any);

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'checkpoint_restored', newSessionId: '' });

    expect(switchSession).not.toHaveBeenCalled();
  });

  it('does not call switchSession when newSessionId is whitespace-only', () => {
    const switchSession = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      switchSession,
    } as any);

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'checkpoint_restored', newSessionId: '   ' });

    expect(switchSession).not.toHaveBeenCalled();
  });

  it('does not call switchSession when newSessionId is non-string', () => {
    const switchSession = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      switchSession,
    } as any);

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'checkpoint_restored', newSessionId: 42 });

    expect(switchSession).not.toHaveBeenCalled();
  });
});

describe('session_updated handler (#1381)', () => {
  it('updates session name in store', () => {
    const store = createMockStore({
      sessions: [
        { sessionId: 's1', name: 'Old Name' } as any,
        { sessionId: 's2', name: 'Other' } as any,
      ],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_updated',
      sessionId: 's1',
      name: 'New Name',
    });

    const state = store.getState();
    expect(state.sessions[0].name).toBe('New Name');
    expect(state.sessions[1].name).toBe('Other');
  });

  it('ignores unknown session ids', () => {
    const store = createMockStore({
      sessions: [{ sessionId: 's1', name: 'Original' } as any],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_updated',
      sessionId: 'unknown',
      name: 'Nope',
    });

    expect(store.getState().sessions[0].name).toBe('Original');
  });
});

describe('conversations_list handler', () => {
  it('populates conversationHistory and clears loading flag', () => {
    const store = createMockStore({
      conversationHistory: [],
      conversationHistoryLoading: true,
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    const mockConversations = [
      { conversationId: 'conv-1', projectName: 'project-a', lastModified: Date.now(), preview: 'hello', sizeBytes: 1024 },
      { conversationId: 'conv-2', projectName: 'project-b', lastModified: Date.now(), preview: 'world', sizeBytes: 2048 },
    ];

    _testMessageHandler.handle({
      type: 'conversations_list',
      conversations: mockConversations,
    });

    const state = store.getState();
    expect(state.conversationHistory).toEqual(mockConversations);
    expect(state.conversationHistoryLoading).toBe(false);
  });

  it('falls back to empty array when conversations is not an array', () => {
    const store = createMockStore({
      conversationHistory: [{ conversationId: 'old' } as any],
      conversationHistoryLoading: true,
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'conversations_list',
      conversations: 'invalid',
    });

    const state = store.getState();
    expect(state.conversationHistory).toEqual([]);
    expect(state.conversationHistoryLoading).toBe(false);
  });
});

describe('unknown message type (default case)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    // Reset lifecycle store so serverProtocolVersion doesn't leak across tests
    useConnectionLifecycleStore.getState().reset();
  });

  it('logs warning when server protocol version is newer than client', () => {
    useConnectionLifecycleStore.getState().setServerInfo({ serverProtocolVersion: CLIENT_PROTOCOL_VERSION + 1 });
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'some_future_feature' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown message type "some_future_feature"')
    );
  });

  it('does not log when server protocol version matches client', () => {
    useConnectionLifecycleStore.getState().setServerInfo({ serverProtocolVersion: CLIENT_PROTOCOL_VERSION });
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'some_future_feature' });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not log when server protocol version is null', () => {
    useConnectionLifecycleStore.getState().setServerInfo({ serverProtocolVersion: null });
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'some_future_feature' });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('client_focus_changed follow mode', () => {
  afterEach(() => {
    useMultiClientStore.getState().reset();
  });

  it('auto-switches session when followMode is true and event is from another client', () => {
    useMultiClientStore.getState().setFollowMode(true);
    useMultiClientStore.getState().setMyClientId('client-a');
    const store = createMockStore({
      followMode: true,
      myClientId: 'client-a',
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: { ...createEmptySessionState(), messages: [{ id: 'm1', type: 'response' as const, content: 'hello', timestamp: 1 }] },
      },

      switchSession: jest.fn(),
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'client_focus_changed',
      clientId: 'client-b',
      sessionId: 's2',
      timestamp: Date.now(),
    });

    expect(store.getState().switchSession).toHaveBeenCalledWith('s2');
  });

  it('does NOT auto-switch when followMode is false', () => {
    const store = createMockStore({
      followMode: false,
      myClientId: 'client-a',
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
      },

      switchSession: jest.fn(),
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'client_focus_changed',
      clientId: 'client-b',
      sessionId: 's2',
      timestamp: Date.now(),
    });

    expect(store.getState().switchSession).not.toHaveBeenCalled();
  });

  it('does NOT auto-switch when the focus change is from self', () => {
    useMultiClientStore.getState().setFollowMode(true);
    useMultiClientStore.getState().setMyClientId('client-a');
    const store = createMockStore({
      followMode: true,
      myClientId: 'client-a',
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
      },

      switchSession: jest.fn(),
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'client_focus_changed',
      clientId: 'client-a',
      sessionId: 's2',
      timestamp: Date.now(),
    });

    expect(store.getState().switchSession).not.toHaveBeenCalled();
  });

  it('does NOT auto-switch when already on the target session', () => {
    useMultiClientStore.getState().setFollowMode(true);
    useMultiClientStore.getState().setMyClientId('client-a');
    const store = createMockStore({
      followMode: true,
      myClientId: 'client-a',
      activeSessionId: 's2',
      sessions: [
        { sessionId: 's1', name: 'Session 1' } as any,
        { sessionId: 's2', name: 'Session 2' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: createEmptySessionState(),
      },

      switchSession: jest.fn(),
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'client_focus_changed',
      clientId: 'client-b',
      sessionId: 's2',
      timestamp: Date.now(),
    });

    expect(store.getState().switchSession).not.toHaveBeenCalled();
  });
});

describe('server_mode handler (PTY removal)', () => {
  it('sets serverMode to cli for cli mode', () => {
    const store = createMockStore({
      viewMode: 'chat',
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'server_mode', mode: 'cli' });
    // serverMode now lives in the lifecycle store (canonical source)
    expect(useConnectionLifecycleStore.getState().serverMode).toBe('cli');
  });

  it('sets serverMode to null for unknown mode values', () => {
    const store = createMockStore({
      viewMode: 'chat',
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'server_mode', mode: 'terminal' });
    // serverMode now lives in the lifecycle store (canonical source)
    expect(useConnectionLifecycleStore.getState().serverMode).toBeNull();
  });
});

describe('git result handlers', () => {
  it('dispatches git_status_result to gitStatus callback', () => {
    const cb = jest.fn();
    setCallback('gitStatus', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'git_status_result',
      branch: 'main',
      staged: [{ path: 'a.ts', status: 'modified' }],
      unstaged: [{ path: 'b.ts', status: 'added' }],
      untracked: ['c.ts'],
      error: null,
    });

    expect(cb).toHaveBeenCalledWith({
      branch: 'main',
      staged: [{ path: 'a.ts', status: 'modified' }],
      unstaged: [{ path: 'b.ts', status: 'added' }],
      untracked: ['c.ts'],
      error: null,
    });
  });

  it('does not crash when gitStatus callback is null', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({
        type: 'git_status_result',
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
      });
    }).not.toThrow();
  });

  it('dispatches git_branches_result to gitBranches callback', () => {
    const cb = jest.fn();
    setCallback('gitBranches', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'git_branches_result',
      branches: [{ name: 'main', isCurrent: true, isRemote: false }],
      currentBranch: 'main',
    });

    expect(cb).toHaveBeenCalledWith({
      branches: [{ name: 'main', isCurrent: true, isRemote: false }],
      currentBranch: 'main',
      error: null,
    });
  });

  it('dispatches git_stage_result to gitStage callback', () => {
    const cb = jest.fn();
    setCallback('gitStage', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'git_stage_result' });

    expect(cb).toHaveBeenCalledWith({ error: null });
  });

  it('dispatches git_unstage_result to gitStage callback', () => {
    const cb = jest.fn();
    setCallback('gitStage', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'git_unstage_result' });

    expect(cb).toHaveBeenCalledWith({ error: null });
  });

  it('dispatches git_stage_result with error', () => {
    const cb = jest.fn();
    setCallback('gitStage', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'git_stage_result', error: 'failed to stage' });

    expect(cb).toHaveBeenCalledWith({ error: 'failed to stage' });
  });

  it('dispatches git_commit_result to gitCommit callback', () => {
    const cb = jest.fn();
    setCallback('gitCommit', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'git_commit_result',
      hash: 'abc123',
      message: 'feat: add feature',
    });

    expect(cb).toHaveBeenCalledWith({
      hash: 'abc123',
      message: 'feat: add feature',
      error: null,
    });
  });

  it('dispatches git_commit_result with error', () => {
    const cb = jest.fn();
    setCallback('gitCommit', cb);
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'git_commit_result',
      error: 'nothing to commit',
    });

    expect(cb).toHaveBeenCalledWith({
      hash: null,
      message: null,
      error: 'nothing to commit',
    });
  });
});

describe('permission_request rich notification details', () => {
  it('includes tool, description and inputPreview in session notification', () => {
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

      sessionNotifications: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_request',
      sessionId: 's2',
      requestId: 'req-1',
      tool: 'Bash',
      description: 'Run npm test',
      input: { command: 'npm test' },
    });

    const state = store.getState();
    expect(state.sessionNotifications).toHaveLength(1);
    const notif = state.sessionNotifications[0];
    expect(notif.tool).toBe('Bash');
    expect(notif.description).toBe('Run npm test');
    expect(notif.inputPreview).toBe('npm test');
    expect(notif.requestId).toBe('req-1');
  });

  it('truncates long input previews to 120 chars', () => {
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

      sessionNotifications: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    const longCommand = 'a'.repeat(200);
    _testMessageHandler.handle({
      type: 'permission_request',
      sessionId: 's2',
      requestId: 'req-2',
      tool: 'Bash',
      description: 'Run long command',
      input: { command: longCommand },
    });

    const notif = store.getState().sessionNotifications[0];
    expect(notif.inputPreview!.length).toBeLessThanOrEqual(120);
    expect(notif.inputPreview).toMatch(/\.\.\.$/);
  });

  it('omits inputPreview when no input is provided', () => {
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

      sessionNotifications: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_request',
      sessionId: 's2',
      requestId: 'req-3',
      tool: 'Read',
      description: 'Read a file',
    });

    const notif = store.getState().sessionNotifications[0];
    expect(notif.tool).toBe('Read');
    expect(notif.description).toBe('Read a file');
    expect(notif.inputPreview).toBeUndefined();
  });
});

describe('plan_ready notification', () => {
  it('creates plan notification for non-active session', () => {
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

      sessionNotifications: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'plan_ready',
      sessionId: 's2',
      allowedPrompts: [{ tool: 'Bash', prompt: 'Run tests' }],
    });

    const state = store.getState();
    expect(state.sessionNotifications).toHaveLength(1);
    const notif = state.sessionNotifications[0];
    expect(notif.eventType).toBe('plan');
    expect(notif.sessionId).toBe('s2');
    expect(notif.message).toBe('Plan ready for approval');
  });

  it('does not create notification for active session plan_ready', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Active' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
      },

      sessionNotifications: [],
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'plan_ready',
      sessionId: 's1',
      allowedPrompts: [],
    });

    expect(store.getState().sessionNotifications).toHaveLength(0);
  });
});

describe('session subscription (#1692)', () => {
  it('sends subscribe_sessions after receiving session_list with multiple sessions', () => {
    const mockSend = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

      socket: { readyState: 1, send: mockSend } as any,
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [
        { sessionId: 's1', name: 'Session 1' },
        { sessionId: 's2', name: 'Session 2' },
        { sessionId: 's3', name: 'Session 3' },
      ],
    });

    const calls = mockSend.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const subscribeCalls = calls.filter((c: Record<string, unknown>) => c.type === 'subscribe_sessions');
    expect(subscribeCalls).toHaveLength(1);
    expect(subscribeCalls[0].sessionIds).toEqual(expect.arrayContaining(['s2', 's3']));
    expect(subscribeCalls[0].sessionIds).not.toContain('s1');
  });

  it('does not send subscribe_sessions for single-session list', () => {
    const mockSend = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

      socket: { readyState: 1, send: mockSend } as any,
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'Session 1' }],
    });

    const calls = mockSend.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const subscribeCalls = calls.filter((c: Record<string, unknown>) => c.type === 'subscribe_sessions');
    expect(subscribeCalls).toHaveLength(0);
  });

  it('chunks subscribe_sessions into batches of SUBSCRIBE_SESSIONS_CHUNK_SIZE', () => {
    const mockSend = jest.fn();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

      socket: { readyState: 1, send: mockSend } as any,
    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    // Create enough sessions to require chunking: 1 active + (CHUNK_SIZE + 4) non-active
    const nonActiveCount = SUBSCRIBE_SESSIONS_CHUNK_SIZE + 4;
    const sessions = Array.from({ length: nonActiveCount + 1 }, (_, i) => ({
      sessionId: `s${i + 1}`,
      name: `Session ${i + 1}`,
    }));

    _testMessageHandler.handle({ type: 'session_list', sessions });

    const calls = mockSend.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const subscribeCalls = calls.filter((c: Record<string, unknown>) => c.type === 'subscribe_sessions');
    // non-active IDs should be split into 2 chunks: CHUNK_SIZE + 4
    expect(subscribeCalls).toHaveLength(2);
    expect(subscribeCalls[0].sessionIds).toHaveLength(SUBSCRIBE_SESSIONS_CHUNK_SIZE);
    expect(subscribeCalls[1].sessionIds).toHaveLength(4);
    // Active session s1 should not be in any chunk
    const allIds = subscribeCalls.flatMap((c: Record<string, unknown>) => c.sessionIds as string[]);
    expect(allIds).not.toContain('s1');
  });

  it('handles subscriptions_updated without crashing', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: {},

    });

    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'subscriptions_updated',
      subscribedSessionIds: ['s2', 's3'],
    });
  });
});

describe('user_input cross-client echo', () => {
  it('adds user_input from another client to the session messages', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      myClientId: 'client-a',
      sessions: [{ sessionId: 's1', name: 'Session 1' } as any],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
      },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'user_input',
      sessionId: 's1',
      clientId: 'client-b',
      text: 'Hello from dashboard',
      timestamp: 1000,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('user_input');
    expect(msgs[0].content).toBe('Hello from dashboard');
  });

  it('skips user_input from self (same clientId)', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      myClientId: 'client-a',
      sessions: [{ sessionId: 's1', name: 'Session 1' } as any],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [] },
      },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'user_input',
      sessionId: 's1',
      clientId: 'client-a',
      text: 'My own message',
      timestamp: 1000,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(0);
  });
});

afterAll(() => {
  _testMessageHandler.clearContext();
});

// ---------------------------------------------------------------------------
// Issue #1728 — comprehensive tests for streaming, tool, permission, result
// ---------------------------------------------------------------------------

describe('stream_start handler', () => {
  beforeEach(() => {
    clearDeltaBuffers();
    clearPermissionSplits();
  });

  it('adds a response message and sets streamingMessageId', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'stream_start', messageId: 'msg-1', sessionId: 's1' });

    const ss = store.getState().sessionStates.s1;
    expect(ss.streamingMessageId).toBe('msg-1');
    expect(ss.messages).toHaveLength(1);
    expect(ss.messages[0]).toMatchObject({ id: 'msg-1', type: 'response', content: '' });
  });

  it('reuses existing response message on reconnect replay', () => {
    const existing = { id: 'msg-1', type: 'response' as const, content: 'partial', timestamp: 1 };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [existing], streamingMessageId: null } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'stream_start', messageId: 'msg-1', sessionId: 's1' });

    const ss = store.getState().sessionStates.s1;
    // Should set streamingMessageId without duplicating the message
    expect(ss.streamingMessageId).toBe('msg-1');
    expect(ss.messages).toHaveLength(1);
    expect(ss.messages[0].content).toBe('partial');
  });

  it('ID collision: creates suffixed response message when ID is already used by tool_use', () => {
    const toolMsg = { id: 'msg-1', type: 'tool_use' as const, content: 'Bash: ls', timestamp: 1 };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [toolMsg] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'stream_start', messageId: 'msg-1', sessionId: 's1' });

    const ss = store.getState().sessionStates.s1;
    // Suffixed ID used to avoid clobbering tool_use message
    expect(ss.streamingMessageId).toBe('msg-1-response');
    expect(ss.messages).toHaveLength(2);
    const responseMsg = ss.messages.find((m) => m.id === 'msg-1-response');
    expect(responseMsg).toBeDefined();
    expect(responseMsg?.type).toBe('response');
    // Original tool_use message untouched
    expect(ss.messages[0].id).toBe('msg-1');
    expect(ss.messages[0].type).toBe('tool_use');
  });
});

describe('reconnect replay dedup', () => {
  function setupReconnectReplay(messages: any[]) {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages, streamingMessageId: null } },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);
    // Enter reconnect replay mode (no fullHistory = not a session switch)
    _testMessageHandler.handle({ type: 'history_replay_start', sessionId: 's1' });
    return store;
  }

  afterEach(() => {
    resetReplayFlags();
  });

  it('message handler: preserves new response messages during reconnect', () => {
    const store = setupReconnectReplay([
      { id: 'msg-1', type: 'user_input', content: 'hello', timestamp: 1 },
    ]);

    _testMessageHandler.handle({
      type: 'message', messageType: 'response', content: 'world',
      messageId: 'resp-1', sessionId: 's1', timestamp: 999,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].type).toBe('response');
    expect(msgs[1].content).toBe('world');
  });

  it('message handler: deduplicates response by messageId during reconnect', () => {
    const store = setupReconnectReplay([
      { id: 'resp-1', type: 'response', content: 'existing response', timestamp: 1 },
    ]);

    _testMessageHandler.handle({
      type: 'message', messageType: 'response', content: 'existing response',
      messageId: 'resp-1', sessionId: 's1', timestamp: 9999,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(1);
  });

  it('message handler: deduplicates response with suffixed ID (tool_start collision)', () => {
    const store = setupReconnectReplay([
      { id: 'msg-1', type: 'tool_use', content: 'Bash', timestamp: 1 },
      { id: 'msg-1-response', type: 'response', content: 'done', timestamp: 2 },
    ]);

    _testMessageHandler.handle({
      type: 'message', messageType: 'response', content: 'done',
      messageId: 'msg-1', sessionId: 's1', timestamp: 9999,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(2);
  });

  it('message handler: preserves response when only tool_use exists with same ID (collision without response)', () => {
    const store = setupReconnectReplay([
      { id: 'msg-1', type: 'tool_use', content: 'Bash', timestamp: 1 },
      // No 'msg-1-response' yet — app crashed before stream_end
    ]);

    _testMessageHandler.handle({
      type: 'message', messageType: 'response', content: 'output',
      messageId: 'msg-1', sessionId: 's1', timestamp: 9999,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].type).toBe('response');
    expect(msgs[1].content).toBe('output');
  });

  it('message handler: deduplicates non-response messages by content and timestamp', () => {
    const store = setupReconnectReplay([
      { id: 'sys-1', type: 'system', content: 'hook started', tool: null, options: null, timestamp: 1000 },
    ]);

    // Server replays non-response messages with the original timestamp
    _testMessageHandler.handle({
      type: 'message', messageType: 'system', content: 'hook started',
      sessionId: 's1', timestamp: 1000,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(1);
  });

  it('message handler: allows non-response messages with different timestamps', () => {
    const store = setupReconnectReplay([
      { id: 'sys-1', type: 'system', content: 'hook started', tool: null, options: null, timestamp: 1000 },
    ]);

    // Different timestamp = different message occurrence, should be preserved
    _testMessageHandler.handle({
      type: 'message', messageType: 'system', content: 'hook started',
      sessionId: 's1', timestamp: 2000,
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(2);
  });

  it('tool_start handler: deduplicates by stable messageId during reconnect', () => {
    const store = setupReconnectReplay([
      { id: 'tool-1', type: 'tool_use', content: 'Bash: ls', timestamp: 1 },
    ]);

    _testMessageHandler.handle({
      type: 'tool_start', messageId: 'tool-1', tool: 'Bash',
      input: 'ls', sessionId: 's1',
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(1);
  });

  it('tool_start handler: allows new tools during reconnect', () => {
    const store = setupReconnectReplay([
      { id: 'tool-1', type: 'tool_use', content: 'Bash: ls', timestamp: 1 },
    ]);

    _testMessageHandler.handle({
      type: 'tool_start', messageId: 'tool-2', tool: 'Read',
      input: 'file.ts', sessionId: 's1',
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].id).toBe('tool-2');
  });
});

describe('stream_delta handler', () => {
  beforeEach(() => {
    clearDeltaBuffers();
    clearPermissionSplits();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accumulates delta content after stream_start', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'stream_start', messageId: 'msg-1', sessionId: 's1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'Hello' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: ' world' });
    // Flush deltas via timer
    jest.runAllTimers();

    const ss = store.getState().sessionStates.s1;
    const msg = ss.messages.find((m) => m.id === 'msg-1');
    expect(msg?.content).toBe('Hello world');
  });

  it('ID collision: routes deltas to suffixed response ID', () => {
    const toolMsg = { id: 'msg-1', type: 'tool_use' as const, content: 'ls', timestamp: 1 };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [toolMsg] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'stream_start', messageId: 'msg-1', sessionId: 's1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'Content' });
    jest.runAllTimers();

    const ss = store.getState().sessionStates.s1;
    const responseMsg = ss.messages.find((m) => m.id === 'msg-1-response');
    expect(responseMsg?.content).toBe('Content');
    // tool_use message content unchanged
    const toolUseMsg = ss.messages.find((m) => m.id === 'msg-1');
    expect(toolUseMsg?.content).toBe('ls');
  });
});

describe('stream_end handler', () => {
  beforeEach(() => {
    clearDeltaBuffers();
    clearPermissionSplits();
  });

  it('clears streamingMessageId and flushes pending deltas', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'stream_start', messageId: 'msg-1', sessionId: 's1' });
    _testMessageHandler.handle({ type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'Final text' });
    _testMessageHandler.handle({ type: 'stream_end', messageId: 'msg-1', sessionId: 's1' });

    const ss = store.getState().sessionStates.s1;
    expect(ss.streamingMessageId).toBeNull();
    // Buffered delta flushed synchronously on stream_end
    const msg = ss.messages.find((m) => m.id === 'msg-1');
    expect(msg?.content).toBe('Final text');
  });
});

describe('tool_start handler', () => {
  it('adds a tool_use message to session state', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'tool_start',
      messageId: 'tool-1',
      sessionId: 's1',
      tool: 'Bash',
      toolUseId: 'use-1',
      input: { command: 'ls' },
    });

    const ss = store.getState().sessionStates.s1;
    expect(ss.messages).toHaveLength(1);
    expect(ss.messages[0]).toMatchObject({
      id: 'tool-1',
      type: 'tool_use',
      tool: 'Bash',
      toolUseId: 'use-1',
    });
    expect(ss.messages[0].content).toContain('ls');
  });
});

describe('tool_result handler', () => {
  it('patches the matching tool_use message with the result', () => {
    const toolMsg = {
      id: 'tool-1',
      type: 'tool_use' as const,
      content: 'Bash: ls',
      toolUseId: 'use-1',
      timestamp: 1,
    };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [toolMsg] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'tool_result',
      sessionId: 's1',
      toolUseId: 'use-1',
      result: 'file1.txt\nfile2.txt',
    });

    const ss = store.getState().sessionStates.s1;
    expect(ss.messages[0].toolResult).toBe('file1.txt\nfile2.txt');
  });

  it('skips when toolUseId is missing', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({ type: 'tool_result', sessionId: 's1' });
    }).not.toThrow();
  });
});

describe('result handler', () => {
  beforeEach(() => {
    clearDeltaBuffers();
  });

  it('clears streamingMessageId and sets context usage', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          streamingMessageId: 'msg-1',
          messages: [{ id: 'msg-1', type: 'response' as const, content: 'done', timestamp: 1 }],
        },
      },

      sessionNotifications: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'result',
      sessionId: 's1',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
      cost: 0.002,
      duration: 1500,
    });

    const ss = store.getState().sessionStates.s1;
    expect(ss.streamingMessageId).toBeNull();
    expect(ss.contextUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreation: 10,
      cacheRead: 5,
    });
    expect(ss.lastResultCost).toBe(0.002);
    expect(ss.lastResultDuration).toBe(1500);
  });
});

describe('permission_resolved handler', () => {
  it('marks the permission prompt as answered in session state', () => {
    const permMsg = {
      id: 'perm-1',
      type: 'prompt' as const,
      content: 'Allow bash?',
      requestId: 'req-1',
      timestamp: 1,
    };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: [permMsg] } },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_resolved',
      requestId: 'req-1',
      decision: 'allow',
    });

    const ss = store.getState().sessionStates.s1;
    const msg = ss.messages.find((m) => m.requestId === 'req-1');
    expect(msg?.answered).toBe('allow');
    expect(msg?.options).toBeUndefined();
  });

  it('searches all session states for the matching requestId', () => {
    const permMsg = {
      id: 'perm-2',
      type: 'prompt' as const,
      content: 'Allow write?',
      requestId: 'req-2',
      timestamp: 1,
    };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [
        { sessionId: 's1', name: 'Active' } as any,
        { sessionId: 's2', name: 'Background' } as any,
      ],
      sessionStates: {
        s1: createEmptySessionState(),
        s2: { ...createEmptySessionState(), messages: [permMsg] },
      },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_resolved',
      requestId: 'req-2',
      decision: 'deny',
    });

    const msg = store.getState().sessionStates.s2.messages.find((m) => m.requestId === 'req-2');
    expect(msg?.answered).toBe('deny');
  });

  it('is a no-op when requestId not in any session state', () => {
    const store = createMockStore({
      activeSessionId: null,
      sessions: [],
      sessionStates: {},
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    // Should not throw when no session has the requestId
    _testMessageHandler.handle({
      type: 'permission_resolved',
      requestId: 'req-nonexistent',
      decision: 'allowAlways',
    });

    // No sessions, so nothing to check — just verifying no crash
    expect(store.getState().sessionStates).toEqual({});
  });

  it('clears matching sessionNotification when permission is resolved', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      sessionNotifications: [
        { requestId: 'req-notif', sessionId: 's1', message: 'Allow bash?' } as any,
        { requestId: 'other-req', sessionId: 's1', message: 'Other' } as any,
      ],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_resolved',
      requestId: 'req-notif',
      decision: 'allow',
    });

    const notifs = store.getState().sessionNotifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].requestId).toBe('other-req');
  });
});

describe('permission_expired handler', () => {
  it('clears matching sessionNotification when permission expires', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: {
        s1: {
          ...createEmptySessionState(),
          messages: [
            {
              id: 'perm-exp',
              type: 'prompt' as const,
              content: 'Allow bash?',
              requestId: 'req-exp',
              timestamp: 1,
            },
          ],
        },
      },

      sessionNotifications: [
        { requestId: 'req-exp', sessionId: 's1', message: 'Allow bash?' } as any,
        { requestId: 'keep-me', sessionId: 's1', message: 'Other' } as any,
      ],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_expired',
      requestId: 'req-exp',
      sessionId: 's1',
      message: 'timed out',
    });

    const notifs = store.getState().sessionNotifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].requestId).toBe('keep-me');
  });
});

describe('permission_request message handler', () => {
  it('adds a prompt message to the session with options populated', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      sessionNotifications: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);
    clearPermissionSplits();

    _testMessageHandler.handle({
      type: 'permission_request',
      sessionId: 's1',
      requestId: 'perm-1',
      tool: 'Write',
      description: '/tmp/test.txt',
      input: { path: '/tmp/test.txt' },
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('prompt');
    expect(msgs[0].requestId).toBe('perm-1');
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].options!.map((o: any) => o.value)).toEqual(['allow', 'deny', 'allowSession']);
  });

  it('sets expiresAt from remainingMs', () => {
    const before = Date.now();
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      sessionNotifications: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);
    clearPermissionSplits();

    _testMessageHandler.handle({
      type: 'permission_request',
      sessionId: 's1',
      requestId: 'perm-2',
      tool: 'Bash',
      description: 'ls',
      remainingMs: 60_000,
    });

    const msg = store.getState().sessionStates.s1.messages[0];
    expect(msg.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  });
});

describe('session_context handler', () => {
  it('updates sessionContext with git info from server snapshot', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'session_context',
      sessionId: 's1',
      gitBranch: 'feat/my-branch',
      gitDirty: 2,
      gitAhead: 1,
      projectName: 'my-project',
    });

    const ctx = store.getState().sessionStates.s1.sessionContext;
    expect(ctx).not.toBeNull();
    expect(ctx!.gitBranch).toBe('feat/my-branch');
    expect(ctx!.gitDirty).toBe(2);
    expect(ctx!.gitAhead).toBe(1);
    expect(ctx!.projectName).toBe('my-project');
  });

  it('does nothing when sessionId is not in sessionStates', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({
        type: 'session_context',
        sessionId: 'unknown-session',
        gitBranch: 'main',
        gitDirty: 0,
        gitAhead: 0,
        projectName: 'proj',
      });
    }).not.toThrow();

    // s1's sessionContext remains untouched
    expect(store.getState().sessionStates.s1.sessionContext).toBeNull();
  });
});

describe('user_question handler', () => {
  it('adds a prompt message with question text and options', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      sessionNotifications: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'user_question',
      sessionId: 's1',
      toolUseId: 'q-use-1',
      questions: [{ question: 'Which approach?', options: [{ label: 'Option A' }, { label: 'Option B' }] }],
    });

    const msgs = store.getState().sessionStates.s1.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('prompt');
    expect(msgs[0].content).toBe('Which approach?');
    expect(msgs[0].options).toHaveLength(2);
    expect(msgs[0].options![0].label).toBe('Option A');
    expect(msgs[0].toolUseId).toBe('q-use-1');
  });

  it('skips when questions array is empty', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },

      sessionNotifications: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({ type: 'user_question', sessionId: 's1', questions: [] });

    expect(store.getState().sessionStates.s1.messages).toHaveLength(0);
  });
});

describe('permission_rules_updated handler', () => {
  it('stores rules in session state', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_rules_updated',
      sessionId: 's1',
      rules: [{ tool: 'Bash', decision: 'allow' }],
    });

    expect(store.getState().sessionStates.s1.sessionRules).toEqual([
      { tool: 'Bash', decision: 'allow' },
    ]);
  });

  it('replaces existing rules with the incoming set', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: {
        s1: { ...createEmptySessionState(), sessionRules: [{ tool: 'Write', decision: 'allow' }] },
      },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_rules_updated',
      sessionId: 's1',
      rules: [
        { tool: 'Write', decision: 'allow' },
        { tool: 'Bash', decision: 'allow' },
      ],
    });

    expect(store.getState().sessionStates.s1.sessionRules).toHaveLength(2);
    expect(store.getState().sessionStates.s1.sessionRules![1].tool).toBe('Bash');
  });

  it('stores empty rules array when rules is empty', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: {
        s1: { ...createEmptySessionState(), sessionRules: [{ tool: 'Bash', decision: 'allow' }] },
      },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_rules_updated',
      sessionId: 's1',
      rules: [],
    });

    expect(store.getState().sessionStates.s1.sessionRules).toEqual([]);
  });

  it('falls back to activeSessionId when sessionId is missing', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_rules_updated',
      rules: [{ tool: 'Read', decision: 'allow' }],
    });

    expect(store.getState().sessionStates.s1.sessionRules).toEqual([
      { tool: 'Read', decision: 'allow' },
    ]);
  });

  it('does not crash when rules field is missing', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({
        type: 'permission_rules_updated',
        sessionId: 's1',
      });
    }).not.toThrow();

    expect(store.getState().sessionStates.s1.sessionRules).toEqual([]);
  });
});

describe('permission_timeout handler', () => {
  it('adds a server error banner when permission times out', () => {
    const promptMsg = {
      id: 'p1',
      type: 'prompt' as const,
      content: 'Allow Read file?',
      requestId: 'req-123',
      timestamp: 1,
    };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [promptMsg] },
      },
      serverErrors: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_timeout',
      requestId: 'req-123',
      tool: 'Read',
      sessionId: 's1',
    });

    const state = store.getState();
    expect(state.serverErrors).toHaveLength(1);
    expect(state.serverErrors[0].category).toBe('permission');
    expect(state.serverErrors[0].recoverable).toBe(true);
    expect(state.serverErrors[0].message).toMatch(/auto-denied/i);
    expect(state.serverErrors[0].message).toMatch(/Read/);
  });

  it('marks prompt message as timed out in session messages', () => {
    const promptMsg = {
      id: 'p1',
      type: 'prompt' as const,
      content: 'Allow Write file?',
      requestId: 'req-456',
      options: [{ label: 'Allow', value: 'allow' }],
      timestamp: 1,
    };
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: {
        s1: { ...createEmptySessionState(), messages: [promptMsg] },
      },
      serverErrors: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_timeout',
      requestId: 'req-456',
      tool: 'Write',
      sessionId: 's1',
    });

    const state = store.getState();
    const updatedMsg = state.sessionStates.s1.messages.find((m: any) => m.id === 'p1');
    expect(updatedMsg).toBeDefined();
    expect(updatedMsg!.content).toMatch(/Auto-denied/);
    expect(updatedMsg!.options).toBeUndefined();
  });

  it('dismisses matching session notification banner when permission times out', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
      serverErrors: [],
      sessionNotifications: [
        {
          id: 'notif-1',
          sessionId: 's2',
          sessionName: 'S2',
          eventType: 'permission' as const,
          message: 'permission needed',
          requestId: 'req-789',
          timestamp: 1,
        },
      ],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'permission_timeout',
      requestId: 'req-789',
      tool: 'Bash',
      sessionId: 's1',
    });

    const state = store.getState();
    expect(state.sessionNotifications).toHaveLength(0);
  });

  it('does not crash when requestId is missing', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
      serverErrors: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({
        type: 'permission_timeout',
        tool: 'Read',
      });
    }).not.toThrow();

    // Should still add a server error even without requestId
    expect(store.getState().serverErrors).toHaveLength(1);
  });
});

describe('error handler', () => {
  it('does not throw when receiving an error message', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({
        type: 'error',
        requestId: 'req-abc',
        code: 'HANDLER_ERROR',
        message: 'Something went wrong on the server',
      });
    }).not.toThrow();
  });

  it('shows an alert with the error message', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    _testMessageHandler.handle({
      type: 'error',
      requestId: null,
      code: 'HANDLER_ERROR',
      message: 'Checkpoint creation failed',
    });

    expect(Alert.alert).toHaveBeenCalledWith('Server Error', 'Checkpoint creation failed');
  });

  it('handles error message with missing fields gracefully', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: createEmptySessionState() },
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockContext() as any);

    expect(() => {
      _testMessageHandler.handle({ type: 'error' });
    }).not.toThrow();

    expect(Alert.alert).toHaveBeenCalledWith('Server Error', 'An unexpected server error occurred');
  });
});
