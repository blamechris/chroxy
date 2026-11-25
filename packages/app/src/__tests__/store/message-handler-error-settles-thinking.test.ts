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

describe('error paths settle open thinking blocks (#8931)', () => {
  it('server_error with a sessionId settles that session only', () => {
    const { th } = setup();
    _testMessageHandler.handle({ type: 'server_error', sessionId: 's1', message: 'boom', recoverable: true });
    expect(th('s1')).toHaveLength(1);
    expect(th('s1')[0]).toMatchObject({ id: 't1', thinkingStreaming: false });
    expect(th('s2')[0]).toMatchObject({ id: 't2', thinkingStreaming: true });
  });

  it('server_error without a sessionId settles the active session only', () => {
    const { th } = setup();
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
