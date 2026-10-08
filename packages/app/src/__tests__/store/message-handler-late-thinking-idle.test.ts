/**
 * #7393 — a thinking block can reach claude-tui's transcript after its turn's
 * `result` and is then shown on its own thinking stream. On the live smoke
 * (8d6b00095) the session read busy afterwards; the server's `session_activity`
 * ping was the cause and is fixed there. This pins the CLIENT half: a thinking
 * stream_start / stream_delta / stream_end, arriving while the session is idle,
 * lands as a completed thinking message and never touches idle or streaming
 * state (nor the working/active-tool state).
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

describe('a thinking stream that arrives after the turn ended (#7393)', () => {
  it('lands as a completed thinking message and leaves the session idle and not streaming', () => {
    const store = createMockStore({
      activeSessionId: 's1',
      sessions: [],
      sessionStates: { s1: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null } } as ConnectionState['sessionStates'],
    });
    setStore(store as never);
    _testMessageHandler.setContext(createMockConnectionContext());

    _testMessageHandler.handle({ type: 'stream_start', sessionId: 's1', messageId: 'turn-1-thinking-0', thinking: true });
    expect(store.getState().sessionStates.s1.isIdle).toBe(true);
    expect(store.getState().sessionStates.s1.streamingMessageId).toBeNull();
    _testMessageHandler.handle({ type: 'stream_delta', sessionId: 's1', messageId: 'turn-1-thinking-0', delta: 'late reasoning', thinking: true });
    _testMessageHandler.handle({ type: 'stream_end', sessionId: 's1', messageId: 'turn-1-thinking-0', thinking: true, thinkingDurationMs: 900 });

    const ss = store.getState().sessionStates.s1;
    expect(ss.isIdle).toBe(true);
    expect(ss.streamingMessageId).toBeNull();
    expect(ss.activeTools ?? []).toEqual([]);
    const thinking = ss.messages.filter((m) => m.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      id: 'turn-1-thinking-0',
      content: 'late reasoning',
      thinkingStreaming: false,
      thinkingDurationMs: 900,
    });
  });
});
