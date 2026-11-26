/**
 * #8931 — server_error and the session_error crash branch end a turn without a
 * stream_end or result; an open thinking block must still settle.
 */
import {
  _testMessageHandler,
  setStore,
  _testResetStore,
  resetAllHandlerState,
} from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import type { ConnectionState } from '../../store/types';

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

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState;
  return {
    getState: () => state,
    setState: (
      updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>),
    ) => {
      state = typeof updater === 'function'
        ? { ...state, ...updater(state) }
        : { ...state, ...updater };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAllHandlerState();
});
afterEach(() => {
  _testResetStore();
});


const think = (id: string, content: string, streaming: boolean) => ({
  id, type: 'thinking' as const, content, timestamp: 1, thinkingStreaming: streaming,
});

function setup() {
  const store = createMockStore({
    activeSessionId: 's1',
    sessions: [],
    serverErrors: [],
    sessionNotifications: [],
    sessionStates: {
      s1: { ...createEmptySessionState(), streamingMessageId: null, messages: [think('t1', '', true)] },
      s2: { ...createEmptySessionState(), streamingMessageId: null, messages: [think('t2', '', true)] },
    } as unknown as ConnectionState['sessionStates'],
  });
  setStore(store as never);
  _testMessageHandler.setContext(createMockConnectionContext());
  const th = (sid: string) =>
    store.getState().sessionStates[sid].messages.filter((m) => m.type === 'thinking');
  return { store, th };
}

function patchSession(
  store: ReturnType<typeof createMockStore>,
  sid: string,
  patch: Record<string, unknown>,
) {
  store.setState((s) => ({
    sessionStates: { ...s.sessionStates, [sid]: { ...s.sessionStates[sid], ...patch } },
  }));
}

describe('error paths settle open thinking blocks (#8931)', () => {
  it('server_error with a sessionId settles that session only', () => {
    const { th } = setup();
    _testMessageHandler.handle({ type: 'server_error', sessionId: 's1', message: 'boom', recoverable: true });
    expect(th('s1')).toHaveLength(1);
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: false });
    expect(th('s2')[0]).toMatchObject({ id: 't2', thinkingStreaming: true });
  });

  // #9336: changed from "settles the active session" with streamingMessageId null.
  // A sessionless error no longer ends a turn that is not the pending send, so the
  // settle case is the pending send placeholder; the mid-stream case is below.
  it('server_error without a sessionId settles the active session only while its send is pending', () => {
    const { store, th } = setup();
    patchSession(store, 's1', { streamingMessageId: 'pending' });
    _testMessageHandler.handle({ type: 'server_error', message: 'boom', recoverable: true });
    expect(th('s1')[0]).toMatchObject({ thinkingStreaming: false });
    expect(th('s2')[0]).toMatchObject({ thinkingStreaming: true });
  });

  it('session_error crash settles the crashed session only', () => {
    const { store, th } = setup();
    _testMessageHandler.handle({ type: 'session_error', category: 'crash', sessionId: 's2', message: 'died' });
    expect(store.getState().sessionStates.s2.health).toBe('crashed');
    expect(th('s2')[0]).toMatchObject({ id: 't2', thinkingStreaming: false });
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: true });
  });

  it('keeps content of a non-empty block and only clears its streaming flag, like result', () => {
    const { store, th } = setup();
    store.setState((s) => ({
      sessionStates: {
        ...s.sessionStates,
        s1: { ...s.sessionStates.s1, messages: [think('t1', 'reasoning', true)] },
      },
    }));
    _testMessageHandler.handle({ type: 'server_error', sessionId: 's1', message: 'boom', recoverable: true });
    expect(th('s1')[0]).toMatchObject({ id: 't1', content: 'reasoning', thinkingStreaming: false });
  });
});

describe('sessionless server_error keeps a live turn (#9336)', () => {
  const errRows = (store: ReturnType<typeof createMockStore>, sid: string) =>
    store.getState().sessionStates[sid].messages.filter((m) => m.type === 'error');

  function midStream() {
    const ctx = setup();
    patchSession(ctx.store, 's1', {
      streamingMessageId: 'resp-1',
      pendingClientMessageId: 'client-1',
      messages: [
        { id: 'resp-1', type: 'response', content: 'hel', timestamp: 1 },
        think('t1', '', true),
      ],
    });
    return ctx;
  }

  it('a tunnel error mid-turn only appends the error row', () => {
    const { store, th } = midStream();
    _testMessageHandler.handle({
      type: 'server_error', category: 'tunnel', message: 'Tunnel connection lost', recoverable: true,
    });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBe('resp-1');
    expect(s1.pendingClientMessageId).toBe('client-1');
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: true });
    expect(errRows(store, 's1')).toHaveLength(1);
    expect(store.getState().serverErrors).toHaveLength(1);
  });

  it('a general sessionless error mid-stream leaves the turn', () => {
    const { store, th } = midStream();
    _testMessageHandler.handle({ type: 'server_error', message: 'Failed to list repos', recoverable: true });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBe('resp-1');
    expect(s1.pendingClientMessageId).toBe('client-1');
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: true });
    expect(errRows(store, 's1')).toHaveLength(1);
  });

  it('a tunnel error while the send is pending leaves the pending turn', () => {
    const { store, th } = setup();
    patchSession(store, 's1', { streamingMessageId: 'pending', pendingClientMessageId: 'client-1' });
    _testMessageHandler.handle({
      type: 'server_error', category: 'tunnel', message: 'Tunnel connection lost', recoverable: true,
    });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBe('pending');
    expect(s1.pendingClientMessageId).toBe('client-1');
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: true });
    expect(errRows(store, 's1')).toHaveLength(1);
  });

  it('a delta still lands on the streaming message after the error row', () => {
    const { store } = setup();
    jest.useFakeTimers();
    try {
      _testMessageHandler.handle({ type: 'stream_start', messageId: 'resp-1', sessionId: 's1' });
      _testMessageHandler.handle({ type: 'stream_delta', sessionId: 's1', messageId: 'resp-1', delta: 'hel' });
      _testMessageHandler.handle({ type: 'server_error', message: 'Failed to list repos', recoverable: true });
      _testMessageHandler.handle({ type: 'stream_delta', sessionId: 's1', messageId: 'resp-1', delta: 'lo' });
      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBe('resp-1');
    expect(s1.messages.find((m) => m.id === 'resp-1')?.content).toBe('hello');
  });

  it('a general sessionless error while the send is pending settles the turn', () => {
    const { store, th } = setup();
    patchSession(store, 's1', { streamingMessageId: 'pending', pendingClientMessageId: 'client-1' });
    _testMessageHandler.handle({ type: 'server_error', message: 'Failed to send', recoverable: true });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBeNull();
    expect(s1.pendingClientMessageId).toBeNull();
    expect(th('s1')[0]).toMatchObject({ thinkingStreaming: false });
    expect(errRows(store, 's1')).toHaveLength(1);
  });

  it('a tagged error still ends that session mid-stream', () => {
    const { store, th } = midStream();
    _testMessageHandler.handle({
      type: 'server_error', sessionId: 's1', category: 'session', message: 'Process exited', recoverable: true,
    });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBeNull();
    expect(s1.pendingClientMessageId).toBeNull();
    expect(th('s1')[0]).toMatchObject({ thinkingStreaming: false });
  });

  it('an unknown sessionId is treated as untagged: mid-stream it only appends the row', () => {
    const { store, th } = midStream();
    _testMessageHandler.handle({
      type: 'server_error', sessionId: 'ghost', category: 'session', message: 'Process exited', recoverable: true,
    });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBe('resp-1');
    expect(s1.pendingClientMessageId).toBe('client-1');
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: true });
    expect(errRows(store, 's1')).toHaveLength(1);
  });

  it('an unknown sessionId while the send is pending settles the active session', () => {
    const { store } = setup();
    patchSession(store, 's1', { streamingMessageId: 'pending', pendingClientMessageId: 'client-1' });
    _testMessageHandler.handle({
      type: 'server_error', sessionId: 'ghost', category: 'session', message: 'Process exited', recoverable: true,
    });
    const s1 = store.getState().sessionStates.s1;
    expect(s1.streamingMessageId).toBeNull();
    expect(s1.pendingClientMessageId).toBeNull();
  });
});
